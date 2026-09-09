import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeApprovalStore } from "../server/claude/approvals.js";
import { approvalDetail, bindClaudeApprovalEvents, decisionLabel, publicApproval } from "../server/claude/approvalBridge.js";
import { ClaudeSessionStore } from "../server/claude/store.js";
import { NotificationService } from "../server/notifications/service.js";
import { HistoryStore } from "../server/notifications/history.js";
import { normalizePreferences, PreferenceStore } from "../server/notifications/preferences.js";
import type { EventBus, OpencodeEvent } from "../server/opencode/events.js";

const temporary: string[] = [];
const opened: ClaudeSessionStore[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(opened.splice(0).map((instance) => instance.flush()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-bridge-"));
  temporary.push(root);
  const store = new ClaudeSessionStore(path.join(root, "ledger.json"));
  opened.push(store);
  await store.load();
  const session = store.create({
    presetId: "opus-build", workspaceId: "ws", workspaceLabel: "WS", mode: "build", isolation: "worktree",
    directory: "/tmp/state/worktrees/abc", projectDirectory: "/tmp/project", title: "Fix the gate",
  });
  const approvals = new ClaudeApprovalStore();
  const bus = new EventEmitter() as EventBus;
  const events: OpencodeEvent[] = [];
  bus.on("event", (event: OpencodeEvent) => events.push(event));
  const unbind = bindClaudeApprovalEvents(bus, approvals, store);
  return { root, store, session, approvals, bus, events, unbind };
}

describe("Claude approval bridge", () => {
  it("turns an ask into a permission.asked event filed under the PROJECT directory and nudges the session stream", async () => {
    const { store, session, approvals, events } = await fixture();
    const nudged: string[] = [];
    store.on("update", (id: string) => nudged.push(id));

    const decision = approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "toolu_1", input: { command: "git status --short" } });

    const asked = events.find((event) => event.type === "permission.asked");
    expect(asked).toMatchObject({
      // The worktree cwd is never the key: the toggle and the inbox are scoped to the project.
      directory: "/tmp/project",
      properties: { sessionID: session.id, permission: "Bash", patterns: ["git status --short"], always: ["Bash"] },
    });
    expect(typeof asked?.properties.id).toBe("string");
    // The seeding event precedes it so the service treats the id as a titled root.
    expect(events[0]).toMatchObject({ type: "session.updated", directory: "/tmp/project", properties: { info: { id: session.id, title: "Fix the gate" } } });
    expect(nudged).toEqual([session.id]);

    approvals.reply(String(asked!.properties.id), "once");
    expect(await decision).toMatchObject({ behavior: "allow" });
    expect(events.at(-1)).toMatchObject({ type: "permission.replied", directory: "/tmp/project", properties: { requestID: asked!.properties.id, sessionID: session.id, reply: "once" } });
    // The decision is written into the transcript so a later reader sees why the call went ahead.
    expect(session.events.at(-1)).toMatchObject({ kind: "status", label: "Approved Bash once" });
  });

  it("words a rejection, an 'always', and a timeout differently on the transcript", async () => {
    const { session, approvals } = await fixture();
    const first = approvals.ask({ sessionId: session.id, toolName: "Write", toolUseId: "t1", input: { file_path: "/tmp/project/a.txt", content: "SECRET BODY" } });
    approvals.reply(approvals.list(session.id)[0].id, "reject", "not that file");
    await first;
    const second = approvals.ask({ sessionId: session.id, toolName: "Edit", toolUseId: "t2", input: {} });
    approvals.reply(approvals.list(session.id)[0].id, "always");
    await second;
    const labels = session.events.filter((event) => event.kind === "status").map((event) => event.kind === "status" ? [event.label, event.detail] : []);
    expect(labels).toEqual([
      ["Denied Write", "not that file"],
      ["Approved Edit for the rest of this session", undefined],
    ]);
    // A Write's content never reaches the transcript or the event: only its path does.
    expect(JSON.stringify(session.events)).not.toContain("SECRET BODY");
  });

  it("ignores an ask for a session this store does not know, and stops after unbind", async () => {
    const { session, approvals, events, unbind } = await fixture();
    const unknown = approvals.ask({ sessionId: "claude-nope", toolName: "Bash", toolUseId: "t9", input: {} });
    expect(events).toEqual([]);
    approvals.cancelSession("claude-nope");
    await unknown;
    unbind();
    const later = approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "t10", input: {} });
    approvals.cancelSession(session.id);
    await later;
    expect(events).toEqual([]);
  });

  it("files an auto-approved call as permission.asked too, so the service can record it as suppressed", async () => {
    const { session, approvals, events } = await fixture();
    approvals.autoApprove = () => true;
    await approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "t1", input: { command: "ls" } });
    expect(events.filter((event) => event.type === "permission.asked")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "permission.asked", properties: { permission: "Bash", metadata: { autoApproved: true } } });
  });

  it("summarises tool input for a human without leaking file bodies", () => {
    expect(approvalDetail("Bash", { command: "npm test" })).toBe("npm test");
    expect(approvalDetail("Write", { file_path: "/w/a.txt", content: "x".repeat(10_000) })).toBe("/w/a.txt");
    expect(approvalDetail("Grep", { pattern: "TODO", path: "src" })).toBe("src");
    expect(approvalDetail("mcp__x__y", { alpha: 1, beta: 2 })).toBe("alpha, beta");
    expect(approvalDetail("Bash", {})).toBeUndefined();
    expect(approvalDetail("Bash", { command: "a".repeat(5_000) })!.length).toBe(2_000);
    const request = { id: "r1", sessionId: "s", toolName: "Write", toolUseId: "t", input: { file_path: "/w/a.txt", content: "PRIVATE" }, createdAt: 5 };
    expect(publicApproval(request)).toEqual({ id: "r1", toolName: "Write", detail: "/w/a.txt", createdAt: 5 });
    expect(JSON.stringify(publicApproval(request))).not.toContain("PRIVATE");
    expect(decisionLabel("Bash", { behavior: "deny", message: "no" })).toBe("Denied Bash");
  });
});

let sequence = 0;
function service(bus: EventBus, options: { autoPermissions?: boolean; pendingLookup?: (directory: string, pending: { id: string; sessionID: string }) => Promise<boolean> } = {}) {
  const lookup = vi.fn(async () => { throw new Error("must not look up a Claude session upstream"); });
  const history = new HistoryStore(path.join(os.tmpdir(), `dca-claude-bridge-${process.pid}-${(sequence += 1)}-${Date.now()}.json`));
  const preferences = { read: async () => normalizePreferences({ ntfy: { enabled: true, server: "https://ntfy.sh", topic: "team" }, parkedPermissionSeconds: 5 }) } as PreferenceStore;
  const instance = new NotificationService(
    { baseUrl: "http://opencode.test" }, bus, preferences, history, "https://ide.example.test",
    () => options.autoPermissions ?? false, lookup, undefined, async () => undefined,
    options.pendingLookup as never,
  );
  instance.start();
  return { history, instance, lookup };
}

describe("Claude approval bridge → notification lane", () => {
  it("delivers a Claude ask as a permission notification titled for Claude, linking to the Claude surface", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, approvals, bus } = await fixture();
    const { history, instance, lookup } = service(bus);

    const decision = approvals.ask({ sessionId: session.id, toolName: "Write", toolUseId: "t1", input: { file_path: "/tmp/project/a.txt" } });
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    const [record] = await history.list();
    expect(record).toMatchObject({
      kind: "permission", sessionID: session.id, directory: "/tmp/project", sessionTitle: "Fix the gate",
      title: "Claude needs permission", displayBody: "Needs approval to run Write",
      click: `https://ide.example.test/claude/sessions/${session.id}`,
    });
    expect(record.delivery.suppressed).toBeUndefined();
    expect(record.delivery.ntfy).toBe("sent");
    expect(lookup).not.toHaveBeenCalled();
    const outbound = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((outbound.headers as Record<string, string>).Title).toBe("Fix the gate");
    expect(String(outbound.body)).toContain("Needs approval to run Write");

    approvals.reply(record.requestID!, "once");
    await decision;
    instance.stop();
  });

  it("records, never delivers, when the project's auto-permissions toggle answered first", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, approvals, bus } = await fixture();
    approvals.autoApprove = () => true;
    const { history, instance } = service(bus, { autoPermissions: true });

    expect(await approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "t1", input: { command: "ls" } })).toMatchObject({ behavior: "allow" });
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    expect((await history.list())[0]).toMatchObject({ kind: "permission", delivery: { suppressed: "auto-permissions" } });
    expect(fetchMock).not.toHaveBeenCalled();
    instance.stop();
  });

  it("escalates a parked Claude ask by consulting the approval store, and stands down once it is answered", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { session, approvals, bus } = await fixture();
    const pendingLookup = vi.fn(async (_directory: string, pending: { id: string; sessionID: string }) => approvals.list(pending.sessionID).some((item) => item.id === pending.id));
    const { history, instance } = service(bus, { pendingLookup });

    const decision = approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "t1", input: { command: "rm -rf build" } });
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    // parkedPermissionSeconds is 5 (the floor) in this fixture: the escalation fires against OUR store, not OpenCode's /permission.
    await vi.waitFor(async () => expect((await history.list()).map((record) => record.kind).sort()).toEqual(["parked", "permission"]), { timeout: 8_000 });
    expect(pendingLookup).toHaveBeenCalled();
    expect((await history.list()).find((record) => record.kind === "parked")).toMatchObject({ title: "Claude is parked", sessionID: session.id });

    // Answering settles it; a second ask answered promptly never escalates.
    approvals.reply(approvals.list(session.id)[0].id, "reject");
    await decision;
    const second = approvals.ask({ sessionId: session.id, toolName: "Bash", toolUseId: "t2", input: { command: "ls" } });
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(3));
    approvals.reply(approvals.list(session.id)[0].id, "once");
    await second;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect((await history.list()).filter((record) => record.kind === "parked")).toHaveLength(1);
    instance.stop();
  }, 20_000);
});
