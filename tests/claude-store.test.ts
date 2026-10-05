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
    const beforeCompletion = instance.transcript(session).read().page.cursor;
    instance.applyFrame(session.id, { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: "file body" },
    ] } });
    expect(instance.transcript(session).read({ since: beforeCompletion }).events).toEqual([
      expect.objectContaining({ kind: "tool", status: "completed", output: "file body" }),
    ]);
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02, usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 } });

    const kinds = session.events.map((event) => event.kind);
    expect(kinds).toEqual(["user", "thought", "tool", "agent"]);
    const tool = session.events.find((event) => event.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", name: "Read", status: "completed", output: "file body" });
    expect(session.events.find((event) => event.kind === "agent")).toMatchObject({
      metricsStatus: "final", costStatus: "final", cumulativeCostStatus: "final",
      messageCost: 0.02, cumulativeCost: 0.02, inputTokens: 12, outputTokens: 4, cacheReadTokens: 8,
    });
    expect(session.running).toBe(false);
    expect(session.started).toBe(true);
  });

  it("captures the TodoWrite checklist, replaces it wholesale, and bounds what it keeps", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "plan it");
    // Never called => absent, which is a different answer from an empty list.
    expect(session.todos).toBeUndefined();

    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_todo_1", name: "TodoWrite", input: { todos: [
        { content: "Trace the option list", status: "completed", priority: "high" },
        { content: "Wire the panel", status: "in_progress", priority: "medium" },
      ] } },
    ] } });
    expect(session.todos).toEqual([
      { content: "Trace the option list", status: "completed", priority: "high" },
      { content: "Wire the panel", status: "in_progress", priority: "medium" },
    ]);

    // The CLI resends the whole list, so the newest call replaces rather than
    // merges: a dropped row must not be resurrected.
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_todo_2", name: "TodoWrite", input: { todos: [{ content: "Wire the panel", status: "completed", priority: "medium" }] } },
    ] } });
    expect(session.todos).toEqual([{ content: "Wire the panel", status: "completed", priority: "medium" }]);

    // Unusable rows are skipped, missing fields default, and content is capped.
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_todo_3", name: "TodoWrite", input: { todos: [
        { content: "   " }, null, "nope", { status: "pending" },
        { activeForm: "Falling back to activeForm" },
        { content: "x".repeat(900), status: "pending", priority: "low" },
      ] } },
    ] } });
    expect(session.todos).toEqual([
      { content: "Falling back to activeForm", status: "pending", priority: "medium" },
      { content: "x".repeat(500), status: "pending", priority: "low" },
    ]);

    // An explicit clear is recorded as an empty list, not as "never reported".
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_todo_4", name: "TodoWrite", input: { todos: [] } },
    ] } });
    expect(session.todos).toEqual([]);

    // A malformed payload leaves the last good list alone.
    instance.applyFrame(session.id, { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_todo_5", name: "TodoWrite", input: { todos: "not a list" } },
    ] } });
    expect(session.todos).toEqual([]);
  });

  it("builds the checklist from TaskCreate / TaskUpdate results, as CLI 2.1.28x emits them", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "plan it");
    const call = (id: string, name: string, input: unknown) =>
      instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, content: string, toolUseResult?: unknown, isError = false) =>
      instance.applyFrame(session.id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}) });

    // A create learns its id from the result, not the call: nothing lands until then.
    call("tu_c1", "TaskCreate", { subject: "  alpha step  ", description: "Alpha task" });
    expect(session.todos).toBeUndefined();
    result("tu_c1", "Task #1 created successfully: alpha step", { task: { id: "1", subject: "alpha step" } });
    // Falls back to the result text when the structured result is missing.
    call("tu_c2", "TaskCreate", { subject: "beta step" });
    result("tu_c2", "Task #2 created successfully: beta step");
    call("tu_c3", "TaskCreate", { subject: "gamma step" });
    result("tu_c3", "Task #3 created successfully: gamma step", { task: { id: "3", subject: "gamma step" } });
    expect(session.todos).toEqual([
      { id: "1", content: "alpha step", status: "pending", priority: "medium" },
      { id: "2", content: "beta step", status: "pending", priority: "medium" },
      { id: "3", content: "gamma step", status: "pending", priority: "medium" },
    ]);

    call("tu_u1", "TaskUpdate", { taskId: "1", status: "completed" });
    result("tu_u1", "Updated task #1 status");
    call("tu_u2", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "beta, renamed" });
    result("tu_u2", "Updated task #2 status, subject");
    call("tu_u3", "TaskUpdate", { taskId: "3", status: "deleted" });
    result("tu_u3", "Updated task #3 deleted");
    // A failed update moves nothing; an update to an unknown id is ignored.
    call("tu_u4", "TaskUpdate", { taskId: "1", status: "pending" });
    result("tu_u4", "Task not found", undefined, true);
    call("tu_u5", "TaskUpdate", { taskId: "99", status: "completed" });
    result("tu_u5", "Updated task #99 status");
    expect(session.todos).toEqual([
      { id: "1", content: "alpha step", status: "completed", priority: "medium" },
      { id: "2", content: "beta, renamed", status: "in_progress", priority: "medium" },
    ]);

    // The list survives into the next turn so its updates still find their rows.
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0 });
    instance.startRun(session, "keep going");
    call("tu_u6", "TaskUpdate", { taskId: "2", status: "completed" });
    result("tu_u6", "Updated task #2 status");
    expect(session.todos?.map((todo) => todo.status)).toEqual(["completed", "completed"]);
  });

  it("accumulates authoritative per-turn cost without recomputing earlier rows", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "one");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "first" }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.001 });
    instance.startRun(session, "two");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "second" }] } });
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.002 });
    expect(session.events.filter((event) => event.kind === "agent")).toMatchObject([
      { messageCost: 0.001, cumulativeCost: 0.001 },
      { messageCost: 0.002, cumulativeCost: 0.003 },
    ]);
  });

  it("keeps attached playbooks as chips on the user row and announces every way a turn ends", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    const finished: Array<{ id: string; outcome: string }> = [];
    instance.on("finished", ({ session: ended, outcome }) => finished.push({ id: ended.id, outcome }));

    instance.startRun(session, "cite the lines", {
      reminders: [{ name: "cite-file-lines", body: "Cite path:line." }],
      workflows: [{ name: "goal", body: "Restate the goal." }],
    });
    const user = session.events.find((event) => event.kind === "user");
    // The human's own words, never the sentinel blocks; the chips carry the rest.
    expect(user).toMatchObject({ text: "cite the lines", reminders: [{ name: "cite-file-lines", body: "Cite path:line." }], workflows: [{ name: "goal", body: "Restate the goal." }] });
    expect(session.title).toBe("cite the lines");
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 });

    instance.startRun(session, "again");
    expect(instance.cancel(session)).toBe(true);
    instance.startRun(session, "and again");
    instance.applyFrame(session.id, { type: "error", subtype: "spawn_failed" });

    expect(finished).toEqual([
      { id: session.id, outcome: "completed" },
      { id: session.id, outcome: "cancelled" },
      { id: session.id, outcome: "failed" },
    ]);
  });

  it("auto-titles a default session from its first prompt, then leaves it alone", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    expect(session.title).toBe("New Claude conversation");
    instance.startRun(session, "  Refactor the auth guard\nand add tests  ");
    // First non-empty line, whitespace-collapsed, capped.
    expect(session.title).toBe("Refactor the auth guard");
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0 });
    // A second turn does not overwrite the derived title.
    instance.startRun(session, "now do something else entirely");
    expect(session.title).toBe("Refactor the auth guard");
  });

  it("keeps an explicit title instead of deriving one from the prompt", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws", title: "My named session" });
    instance.startRun(session, "first prompt text");
    expect(session.title).toBe("My named session");
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

  it("names the model on the prose row from the assistant frame, keeping the first one it saw", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "b", workspaceId: "ws", workspaceLabel: "WS", mode: "build", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.applyFrame(session.id, { type: "assistant", message: { model: "claude-opus-4-1-20250805", content: [{ type: "text", text: "Hello" }] } });
    instance.applyFrame(session.id, { type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "again" }] } });
    const prose = session.events.find((event) => event.kind === "agent");
    expect(prose).toMatchObject({ kind: "agent", text: "Hello\n\nagain", model: "claude-opus-4-1-20250805" });
    // A frame without a model (the mock, an older CLI) leaves the row unlabelled rather than inventing one.
    const other = instance.create({ presetId: "b", workspaceId: "ws", workspaceLabel: "WS", mode: "build", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(other, "y");
    instance.applyFrame(other.id, { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } });
    expect(other.events.find((event) => event.kind === "agent")).not.toHaveProperty("model");
  });

  it("nudges SSE subscribers for a known session without persisting anything", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "b", workspaceId: "ws", workspaceLabel: "WS", mode: "build", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    const updates: string[] = [];
    instance.on("update", (id: string) => updates.push(id));
    instance.nudge(session.id);
    instance.nudge("claude-unknown");
    expect(updates).toEqual([session.id]);
  });

  it("fails a running turn closed when the process exits with no result", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.handleExit(session.id, { code: 134, stderr: "file system sandbox blocked open()" });
    expect(session.running).toBe(false);
    expect(session.events.at(-1)).toMatchObject({ kind: "error", message: "Claude process exited before completing the turn (exit code 134): file system sandbox blocked open()" });
  });

  it("marks an externally signalled process as interrupted and resumable", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "x");
    instance.handleExit(session.id, { signal: "SIGTERM" });
    expect(session).toMatchObject({ running: false, interrupted: true });
    expect(session.events.at(-1)).toMatchObject({ kind: "status", label: "Claude turn interrupted" });
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
    expect(tools.map((event) => event.kind === "tool" && event.detail)).toEqual(["src/a.ts", "src/a.ts", "src/b.ts", "npm test"]);
    expect(tools[3]).toMatchObject({ name: "Bash", detail: "npm test", commandText: "npm test" });
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
    expect(reloaded?.events.at(-1)).toMatchObject({ metricsStatus: "final", costStatus: "unavailable" });
    const interrupted = second.get(midTurn.id);
    // No process survives a restart, so a running session must not spin forever.
    expect(interrupted?.running).toBe(false);
    expect(interrupted?.interrupted).toBe(true);
    expect(interrupted?.events.at(-1)).toMatchObject({ kind: "status", label: "Interrupted by a server restart" });
  });

  it("replaces the agent event object on text append so the transcript index detects the change", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "hello");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "first part" }] } });

    // Cache the transcript index entry (simulates a mid-turn client fetch).
    const index = instance.transcript(session);
    const firstRead = index.read();
    const cachedAgent = firstRead.events.find((event) => event.kind === "agent");
    expect(cachedAgent).toMatchObject({ text: "first part" });
    const cursor = firstRead.page.cursor;

    // A second assistant frame appends text.
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "second part" }] } });

    // The delta after the cursor must surface the updated agent event.
    const delta = instance.transcript(session).read({ since: cursor });
    const updatedAgent = delta.events.find((event) => event.kind === "agent");
    expect(updatedAgent).toBeDefined();
    expect(updatedAgent!).toMatchObject({ text: "first part\n\nsecond part" });
  });

  it("replaces the agent event object when stamping result metrics so the transcript index detects the change", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    instance.startRun(session, "hello");
    instance.applyFrame(session.id, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } });

    // Cache the transcript index entry before result arrives.
    const index = instance.transcript(session);
    const firstRead = index.read();
    const cursor = firstRead.page.cursor;
    const preProse = firstRead.events.find((event) => event.kind === "agent");
    expect(preProse).toMatchObject({ metricsStatus: "pending" });

    // Result frame stamps metrics.
    instance.applyFrame(session.id, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 50 } });

    // The delta must surface the metrics update.
    const delta = instance.transcript(session).read({ since: cursor });
    const updatedProse = delta.events.find((event) => event.kind === "agent");
    expect(updatedProse).toBeDefined();
    expect(updatedProse!).toMatchObject({ metricsStatus: "final", messageCost: 0.05 });
  });

  it("durably interrupts running turns during graceful shutdown", async () => {
    const { instance } = await store();
    const session = instance.create({ presetId: "ro", workspaceId: "ws", workspaceLabel: "WS", mode: "read-only", isolation: "direct", directory: "/tmp/ws", projectDirectory: "/tmp/ws" });
    const finished = vi.fn();
    instance.on("finished", finished);
    instance.startRun(session, "long task");
    expect(instance.interruptRunning()).toBe(1);
    expect(session).toMatchObject({ running: false, interrupted: true });
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({ outcome: "interrupted" }));
  });
});
