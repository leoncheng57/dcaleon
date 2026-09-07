import { describe, expect, it } from "vitest";
import { ClaudeTranscriptIndex, TRANSCRIPT_PAGE_BYTES, matchesClaudeAction } from "../server/claude/transcript.js";
import { extractCommands } from "../client/lib/derive.js";
import type { ClaudeTranscriptEvent } from "../server/claude/store.js";
import { initialClaudeTranscript, reconcileClaude } from "../client/lib/useClaudeTranscript.js";

const prose = (index: number): ClaudeTranscriptEvent => ({ id: `e-${index}`, messageId: `m-${index}`, timestamp: "2026-09-07T12:00:00Z", kind: "agent", text: `Event ${index}` });
const session = { id: "s", title: "Test", running: false } as any;

describe("bounded Claude transcript", () => {
  it("pages in both directions without gaps or duplicates", () => {
    const index = new ClaudeTranscriptIndex();
    const events = Array.from({ length: 232 }, (_, i) => prose(i));
    index.sync(events);
    const tail = index.read();
    expect(tail.events).toEqual(events.slice(-50));
    let page = tail;
    let all = [...page.events];
    while (page.page.before) { page = index.read({ before: page.page.before }); all = [...page.events, ...all]; }
    expect(all).toEqual(events);
    expect(index.read({ after: page.page.last! }).events).toEqual(events.slice(32, 82));
  });

  it("transfers only changed tools and appended events and preserves unchanged row identities", () => {
    const index = new ClaudeTranscriptIndex();
    const events: ClaudeTranscriptEvent[] = Array.from({ length: 232 }, (_, i) => prose(i));
    events[220] = { ...prose(220), kind: "tool", name: "Bash", status: "running", attachments: [] };
    index.sync(events);
    const tail = index.read();
    let state = reconcileClaude(initialClaudeTranscript(), { session, ...tail }, "latest");
    const before = state.events;
    state = reconcileClaude(state, { session, ...index.read({ since: tail.page.cursor }) }, "refresh");
    expect(state.events).toBe(before);
    events[220] = { ...events[220] as Extract<ClaudeTranscriptEvent, { kind: "tool" }>, status: "completed", output: "finished" };
    events.push(prose(232));
    index.sync(events);
    const delta = index.read({ since: tail.page.cursor });
    expect(delta.events.map((event) => event.id)).toEqual(["e-220", "e-232"]);
    state = reconcileClaude(state, { session, ...delta }, "refresh");
    expect(state.events).toHaveLength(50);
    expect(state.events[0]).toBe(before[1]);
    expect(state.events.find((event) => event.id === "e-220")).toMatchObject({ status: "completed", output: "finished" });
  });

  it("keeps a reader's history bounded and recovers newer pages without losing concurrent updates", () => {
    const index = new ClaudeTranscriptIndex();
    const events = Array.from({ length: 400 }, (_, i) => prose(i));
    index.sync(events);
    let state = reconcileClaude(initialClaudeTranscript(), { session, ...index.read() }, "latest");
    const originalCursor = state.cursor;
    for (let i = 0; i < 4; i++) state = reconcileClaude(state, { session, ...index.read({ before: state.before! }) }, "before");
    expect(state.events).toHaveLength(150);
    expect(state.cursor).toBe(originalCursor);
    expect(state.events[0].id).toBe("e-150");
    events.push(prose(400)); index.sync(events);
    const pinned = state.events;
    state = reconcileClaude(state, { session, ...index.read({ since: state.cursor }) }, "refresh");
    expect(state.events).toBe(pinned);
    expect(state.after).toBeTruthy();
    state = reconcileClaude(state, { session, ...index.read({ after: state.after! }) }, "after");
    expect(state.events.at(-1)?.id).toBe("e-349");
    expect(state.events).toHaveLength(150);
  });

  it("does not append an old tool update to the newest page", () => {
    const index = new ClaudeTranscriptIndex();
    const events = Array.from({ length: 232 }, (_, i) => prose(i));
    index.sync(events);
    const state = reconcileClaude(initialClaudeTranscript(), { session, ...index.read() }, "latest");
    events[0] = { ...prose(0), text: "changed old event" }; index.sync(events);
    const next = reconcileClaude(state, { session, ...index.read({ since: state.cursor }) }, "refresh");
    expect(next.events).toBe(state.events);
  });

  it("bounds large output and falls back to a bounded tail on overflow, restart or retention", () => {
    const index = new ClaudeTranscriptIndex();
    let events = Array.from({ length: 232 }, (_, i) => ({ ...prose(i), text: "x".repeat(100_000) }));
    index.sync(events);
    const tail = index.read();
    expect(Buffer.byteLength(JSON.stringify(tail.events))).toBeLessThan(TRANSCRIPT_PAGE_BYTES + 100);
    expect(tail.events.length).toBeLessThan(50);
    events = [...events.slice(1), prose(232) as typeof events[number]]; index.sync(events);
    const reset = index.read({ since: tail.page.cursor });
    expect(reset.page.reset).toBe(true);
    expect(reset.page.delta).toBe(false);
    const restarted = new ClaudeTranscriptIndex(); restarted.sync(events);
    expect(restarted.read({ before: tail.page.before! }).page.reset).toBe(true);
    const cursor = index.read().page.cursor;
    events.push(...Array.from({ length: 51 }, (_, i) => prose(i + 233) as typeof events[number])); index.sync(events);
    expect(index.read({ since: cursor }).page.reset).toBe(true);
    expect(() => index.read({ since: "%%%" })).toThrow("Invalid transcript cursor");
  });

  it("searches full original output and filters old actions without loading prose", () => {
    const index = new ClaudeTranscriptIndex();
    const events: ClaudeTranscriptEvent[] = Array.from({ length: 232 }, (_, i) => prose(i));
    events[0] = { ...prose(0), text: `${"x".repeat(9_000)} needle at the end` };
    events[1] = { ...prose(1), kind: "tool", name: "Bash", commandText: "echo historical", status: "completed", attachments: [] };
    index.sync(events);
    expect(index.read({ q: "needle" }).events.map((event) => event.id)).toEqual(["e-0"]);
    expect(index.read({ actions: true }).events.map((event) => event.id)).toEqual(["e-1"]);
  });

  it("caps resident bytes even when large UTF-8 events fill pages before the row limit", () => {
    const index = new ClaudeTranscriptIndex();
    index.sync(Array.from({ length: 232 }, (_, i) => ({ ...prose(i), text: "界".repeat(10_000) })));
    let state = reconcileClaude(initialClaudeTranscript(), { session, ...index.read() }, "latest");
    for (let i = 0; i < 10; i++) state = reconcileClaude(state, { session, ...index.read({ before: state.before! }) }, "before");
    expect(state.residentBytes).toBeLessThanOrEqual(384 * 1024);
    expect(state.events.length).toBeLessThan(50);
    expect(state.after).toBeTruthy();
  });

  it("keeps server action categories aligned with command export", () => {
    for (const name of ["Bash", "shell", "terminal", "Read", "Write", "Edit", "apply_patch", "str_replace_editor", "grep", "glob", "webfetch", "websearch", "MultiEdit", "custom"]) {
      const event: ClaudeTranscriptEvent = { ...prose(0), kind: "tool", name, status: "completed", attachments: [] };
      const category = extractCommands([event])[0].category;
      expect(matchesClaudeAction(event, category)).toBe(true);
      for (const other of ["edit", "read", "command", "other"] as const) expect(matchesClaudeAction(event, other)).toBe(other === category);
    }
  });
});
