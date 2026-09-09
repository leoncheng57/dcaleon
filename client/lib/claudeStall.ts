import type { RunningActivity } from "./derive.js";
import type { TranscriptEvent } from "./transcript.js";

/**
 * Why a running Claude turn looks stuck, decided from what the page already
 * has. Each arm is worded so the reader knows whether the wait is theirs to
 * end (an approval), the process's (a long tool call, a silent model), or an
 * infrastructure failure that already refused work on their behalf (the
 * approval gate could not be reached).
 *
 * The thresholds are deliberately generous: a genuine `npm test` takes minutes,
 * and a notice that fires on every ordinary pause would train the reader to
 * ignore the one that matters.
 */
export type ClaudeStall =
  | { kind: "approval"; count: number }
  | { kind: "tool"; name: string; detail: string; elapsedMs: number }
  | { kind: "silent"; elapsedMs: number }
  | { kind: "gate-unreachable"; toolName: string };

/** A tool call with no result for this long is worth a sentence, not just a spinner. */
export const TOOL_STALL_MS = 60_000;
/** No frame of any kind for this long while "running" is unusual for a live turn. */
export const SILENT_STALL_MS = 90_000;

const GATE_UNREACHABLE = /approval gate was unreachable/iu;

export function detectClaudeStall(input: {
  running: boolean;
  pendingApprovals: number;
  activity: RunningActivity;
  events: TranscriptEvent[];
  now: number;
}): ClaudeStall | null {
  if (!input.running) return null;
  if (input.pendingApprovals > 0) return { kind: "approval", count: input.pendingApprovals };

  // The approver fails closed when it cannot reach the BFF: the model sees a
  // refusal it did not earn, and from the transcript alone that reads like the
  // agent doing something wrong. Say what actually happened.
  for (let index = input.events.length - 1; index >= 0 && index >= input.events.length - 12; index -= 1) {
    const event = input.events[index];
    if (event.kind === "user") break;
    if (event.kind === "tool" && event.status === "error" && event.error && GATE_UNREACHABLE.test(event.error)) {
      return { kind: "gate-unreachable", toolName: event.name };
    }
  }

  if (!input.activity.since) return null;
  const elapsedMs = input.now - Date.parse(input.activity.since);
  if (input.activity.kind === "tool" && elapsedMs >= TOOL_STALL_MS) {
    return { kind: "tool", name: input.activity.name, detail: input.activity.detail, elapsedMs };
  }
  if (input.activity.kind === "thinking" && elapsedMs >= SILENT_STALL_MS) return { kind: "silent", elapsedMs };
  return null;
}
