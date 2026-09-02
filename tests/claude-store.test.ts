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
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
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
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_9", name: "Bash" }] } });
    instance.applyFrame(session.id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_9", is_error: true, content: "boom" }] } });
    const tool = session.events.find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ status: "error", error: "boom" });
  });

  it("surfaces a permission denial as a status row instead of dropping it", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.applyFrame(session.id, { type: "system", subtype: "permission_denied", tool_name: "Bash", message: "rm blocked" });
    const status = session.events.find((event) => event.kind === "status");
    expect(status).toMatchObject({ kind: "status", label: "Permission denied: Bash" });
  });

  it("fails a running turn closed when the process exits with no result", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.handleExit(session.id);
    expect(session.running).toBe(false);
    expect(session.events.some((event) => event.kind === "error")).toBe(true);
  });

  it("persists only bounded run metadata, never prompt or output", async () => {
    const { instance, ledger } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
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
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "stay running");
    expect(instance.cancel(session)).toBe(true);
    expect(session.running).toBe(false);
    expect(session.events.at(-1)).toMatchObject({ kind: "status", label: "Cancelled by user" });
  });
  it("records what a tool touched and emits one patch row per turn for edited files", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "b", workspaceId: "ws", workspaceLabel: "WS", mode: "build", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "edit things");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/ws/src/a.ts" } },
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/tmp/ws/src/a.ts" } },
      { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/tmp/ws/src/b.ts" } },
      { type: "tool_use", id: "t4", name: "Bash", input: { command: "npm test" } },
    ] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 });
    const tools = session.events.filter((event) => event.kind === "tool");
    expect(tools.map((event) => event.kind === "tool" && event.detail)).toEqual(["src/a.ts", "src/a.ts", "src/b.ts", undefined]);
    expect(tools[3]).toMatchObject({ name: "Bash", commandText: "npm test" });
    const patch = session.events.find((event) => event.kind === "patch");
    // Read does not count as an edit; Edit + Write on two files do.
    expect(patch).toMatchObject({ kind: "patch", files: ["src/a.ts", "src/b.ts"], fileCount: 2, filesTruncated: false });
  });

  it("emits no patch row for a turn that edited nothing", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "look");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/ws/x" } }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false });
    expect(session.events.some((event) => event.kind === "patch")).toBe(false);
  });

  it("survives a restart: sessions reload from disk and a mid-turn session is marked interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-durable-"));
    temporary.push(root);
    const ledger = path.join(root, "ledger.json");
    const sessionsFile = path.join(root, "sessions.json");
    const first = new ClaudeSessionStore(ledger, sessionsFile);
    opened.push(first);
    await first.load();
    const finished = first.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws", title: "done one" });
    first.startRun(finished, "hello");
    first.applyFrame(finished.id, { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    first.applyFrame(finished.id, { type: "result", subtype: "success", is_error: false });
    const midTurn = first.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws", title: "mid turn" });
    first.startRun(midTurn, "still going");
    await first.flush();

    // A new process boots against the same files.
    const second = new ClaudeSessionStore(ledger, sessionsFile);
    opened.push(second);
    await second.load();
    const reloaded = second.get(finished.id);
    expect(reloaded?.title).toBe("done one");
    expect(reloaded?.started).toBe(true);
    expect(reloaded?.events.map((event) => event.kind)).toEqual(["user", "agent"]);
    const interrupted = second.get(midTurn.id);
    // No process survives a restart, so a running session must not spin forever.
    expect(interrupted?.running).toBe(false);
    expect(interrupted?.events.at(-1)).toMatchObject({ kind: "status", label: "Interrupted by a server restart" });
  });
});
