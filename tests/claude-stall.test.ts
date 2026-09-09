import { describe, expect, it } from "vitest";

import { detectClaudeStall, SILENT_STALL_MS, TOOL_STALL_MS } from "../client/lib/claudeStall.js";
import { runningActivity } from "../client/lib/derive.js";
import type { ToolEvent, TranscriptEvent } from "../client/lib/transcript.js";

const T0 = 1_787_000_000_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

function tool(id: string, over: Partial<ToolEvent>): ToolEvent {
  return { kind: "tool", id, messageId: id, timestamp: at(0), status: "running", name: "Bash", attachments: [], ...over };
}
const user: TranscriptEvent = { kind: "user", id: "u", messageId: "u", timestamp: at(0), text: "go", reminders: [], workflows: [], attachments: [] };

function detect(events: TranscriptEvent[], over: Partial<Parameters<typeof detectClaudeStall>[0]> = {}) {
  return detectClaudeStall({ running: true, pendingApprovals: 0, activity: runningActivity(events), events, now: T0 + 10_000, ...over });
}

describe("detectClaudeStall", () => {
  it("says nothing for an idle session or a turn that is simply working", () => {
    expect(detect([user, tool("t", {})], { running: false })).toBeNull();
    expect(detect([user, tool("t", {})])).toBeNull();
  });

  it("puts a pending approval first: the wait is the reader's to end", () => {
    const stalled = [user, tool("t", { timestamp: at(0) })];
    expect(detect(stalled, { pendingApprovals: 2, now: T0 + TOOL_STALL_MS * 10 })).toEqual({ kind: "approval", count: 2 });
  });

  it("names a tool call that has run past the threshold, with its detail and elapsed time", () => {
    const events = [user, tool("t", { name: "Bash", detail: "npm test", timestamp: at(0) })];
    expect(detect(events, { now: T0 + TOOL_STALL_MS - 1 })).toBeNull();
    expect(detect(events, { now: T0 + TOOL_STALL_MS })).toEqual({ kind: "tool", name: "Bash", detail: "npm test", elapsedMs: TOOL_STALL_MS });
  });

  it("reports silence when no event of any kind has arrived for long enough", () => {
    const events: TranscriptEvent[] = [user, { kind: "agent", id: "a", messageId: "a", timestamp: at(0), text: "thinking about it" }];
    expect(detect(events, { now: T0 + SILENT_STALL_MS - 1 })).toBeNull();
    expect(detect(events, { now: T0 + SILENT_STALL_MS })).toEqual({ kind: "silent", elapsedMs: SILENT_STALL_MS });
  });

  it("recognises the approver's fail-closed refusal and says the call was refused, not approved", () => {
    const events = [
      user,
      tool("t1", { status: "error", error: "denied by dcaleon: the approval gate was unreachable (fetch failed)", name: "Write" }),
      tool("t2", { status: "completed", name: "Bash" }),
    ];
    expect(detect(events)).toEqual({ kind: "gate-unreachable", toolName: "Write" });
    // A refusal from an EARLIER turn is history, not the current stall.
    expect(detect([...events, user, tool("t3", {})])).toBeNull();
    // A human rejection is not an infrastructure failure.
    expect(detect([user, tool("t4", { status: "error", error: "denied by dcaleon: the user rejected this tool call" })])).toBeNull();
  });
});

describe("shortModelLabel", () => {
  it("drops the provider prefix and a trailing release date, keeping the id otherwise", async () => {
    const { shortModelLabel } = await import("../client/components/transcript.js");
    expect(shortModelLabel("claude-opus-4-1-20250805")).toBe("claude-opus-4-1");
    expect(shortModelLabel("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(shortModelLabel("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(shortModelLabel("mock-claude-4-20260101")).toBe("mock-claude-4");
    // Eight digits that are not a date suffix (no separator) survive.
    expect(shortModelLabel("model12345678")).toBe("model");
    expect(shortModelLabel("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});
