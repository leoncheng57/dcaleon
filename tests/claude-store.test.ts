import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeSessionStore } from "../server/claude/store.js";

const temporary: string[] = [];
const opened: ClaudeSessionStore[] = [];
afterEach(async () => {
  // Settle the fire-and-forget ledger writes before removing their directory.
  await Promise.all(opened.splice(0).map((instance) => instance.flush()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-store-"));
  temporary.push(root);
  const ledger = path.join(root, "ledger.json");
  const instance = new ClaudeSessionStore(ledger);
  opened.push(instance);
  await instance.load();
  return { instance, ledger };
}

describe("Claude session store", () => {
  it("renders assistant text, thinking, and a correlated tool call from stream-json", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "do the thing");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "thinking", thinking: "let me look" },
      { type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } },
    ] } });
    instance.applyFrame(session.id, { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "file body" },
    ] } });
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02 });

    const kinds = session.events.map((event) => event.kind);
    expect(kinds).toEqual(["user", "thought", "tool", "agent"]);
    const tool = session.events.find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", name: "Read", status: "completed", output: "file body" });
    expect(session.running).toBe(false);
    expect(session.started).toBe(true);
  });

  it("marks a tool call errored when its result is an error", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "x");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_9", name: "Bash" }] } });
    instance.applyFrame(session.id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_9", is_error: true, content: "boom" }] } });
    const tool = session.events.find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ status: "error", error: "boom" });
  });

  it("surfaces a permission denial as a status row instead of dropping it", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "x");
    instance.applyFrame(session.id, { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "rm blocked" });
    const status = session.events.find((event) => event.kind === "status");
    expect(status).toMatchObject({ kind: "status", label: "Permission denied: Bash" });
  });

  it("fails a running turn closed when the process exits with no result", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "x");
    instance.handleExit(session.id);
    expect(session.running).toBe(false);
    expect(session.events.some((event) => event.kind === "error")).toBe(true);
  });

  it("persists only bounded run metadata, never prompt or output", async () => {
    const { instance, ledger } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "SECRET PROMPT CONTENT");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "SECRET MODEL OUTPUT" }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05 });
    await instance.flush();
    await vi.waitFor(async () => expect(await readFile(ledger, "utf8")).toContain('"outcome": "completed"'));
    const content = await readFile(ledger, "utf8");
    expect(content).not.toContain("SECRET PROMPT CONTENT");
    expect(content).not.toContain("SECRET MODEL OUTPUT");
    expect(content).toContain('"taskClass": "conversation"');
    expect(content).toContain('"costUsd": 0.05');
  });

  it("records a cancellation as human intervention", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", mode: "read-only" });
    instance.startRun(session, "stay running");
    expect(instance.cancel(session)).toBe(true);
    expect(session.running).toBe(false);
    expect(session.events.at(-1)).toMatchObject({ kind: "status", label: "Cancelled by user" });
  });
});
