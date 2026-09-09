// client/lib/transcript.ts
//
// THE FROZEN CONTRACT.
//
// Everything the transcript UI renders is one of these. No React component may
// import OpenCode SDK types or touch a raw `Part` — the entire mapping lives in
// events.ts, and this file is the wall between them.
//
// This is not ceremony. The predecessor (custom-dca-ide-with-openhands) kept
// exactly this seam, and it is the single reason migrating from the OpenHands
// agent-server to OpenCode was a ~360-line adapter rewrite instead of a rebuild:
// ~74% of the transcript stack never knew the backend had changed. Keep it.
//
// Rules:
//   - Add a field here only if a row component actually renders it.
//   - Never leak provider-specific shapes (Anthropic signatures, encrypted
//     reasoning blobs, raw tool metadata) into this layer.
//   - Every event carries a stable `id` and an ISO `timestamp` so merge,
//     grouping and scroll anchoring work without backend knowledge.

/** Discriminator for the row a transcript entry renders as. */
export type TranscriptKind = "user" | "agent" | "thought" | "tool" | "patch" | "status" | "error";

/**
 * Primary agent mode a prose message was produced under.
 *
 * Structurally identical to `AgentMode` in lib/agentMode.ts and deliberately
 * declared separately: that module reads raw OpenCode messages, and importing
 * it here would put a backend-aware module on the frozen contract's import
 * graph. Two words is a cheaper price than that seam.
 *
 * Absent means "not established", never "neither" — see `messageMode` in
 * events.ts for why missing metadata is never inferred away.
 */
export type MessageMode = "plan" | "build";
export type MetricStatus = "pending" | "final" | "estimated" | "unavailable";

interface TranscriptBase {
  /** Stable across refetches. Used for React keys, dedupe and scroll anchors. */
  id: string;
  /** ISO 8601. Derived from the backend's epoch millis. */
  timestamp: string;
  kind: TranscriptKind;
  /** Owning message — lets the UI group consecutive parts of one turn. */
  messageId: string;
}

/** A prompt from the human. */
export interface UserEvent extends TranscriptBase {
  kind: "user";
  text: string;
  /** Per-message reminder blocks split from the persisted text sentinel. */
  reminders: Array<{ name: string; body: string }>;
  /** Trusted workflow injector blocks split from the persisted text sentinel. */
  workflows: Array<{ name: string; body: string }>;
  /** Files the user referenced or attached, if any. */
  attachments: Attachment[];
  /** Mode this prompt was sent under, when the backend states it exactly. */
  mode?: MessageMode;
}

/** Assistant prose. */
export interface AgentEvent extends TranscriptBase {
  kind: "agent";
  text: string;
  /** Mode this response was produced under, when the backend states it exactly. */
  mode?: MessageMode;
  /**
   * Model id that produced this prose, as the runtime reported it
   * (`claude-opus-4-1-20250805`, `anthropic/claude-opus-5`). Shown beside the
   * cost figures because a per-turn override or a preset change is otherwise
   * invisible on the row it affected.
   */
  model?: string;
  /** Runtime-neutral provenance for the compact per-message accounting row. */
  metricsStatus?: "pending" | "final";
  costStatus?: MetricStatus;
  cumulativeCostStatus?: MetricStatus;
  durationStatus?: MetricStatus;
  /** Finalised accounting, attached only to the turn's last prose row. */
  messageCost?: number;
  cumulativeCost?: number;
  messageDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Model reasoning. Rendered as a collapsible "Thought" row.
 *
 * Only ever carries readable text. Providers also return opaque artefacts
 * alongside it (Anthropic ships a `signature`, OpenAI an `encrypted_content`);
 * those are dropped in the adapter and must never reach this type.
 */
export interface ThoughtEvent extends TranscriptBase {
  kind: "thought";
  text: string;
  /** Milliseconds spent reasoning, when the backend reports both bounds. */
  durationMs?: number;
}

export type ToolStatus = "pending" | "running" | "completed" | "error";
export type TaskExecution = "foreground" | "background";

/**
 * A tool call and its result as ONE event.
 *
 * OpenCode returns the call and its output in a single object, so unlike the
 * OpenHands runner there is no action/observation pairing step and no
 * correlation id to match up. That simplification is load-bearing — do not
 * reintroduce a split.
 */
export interface ToolEvent extends TranscriptBase {
  kind: "tool";
  status: ToolStatus;
  /** Tool name, e.g. "bash", "edit", "task". */
  name: string;
  /** Human-readable label from the backend, e.g. a command or file path. */
  title?: string;
  /** One-line summary of the arguments, safe to render inline. */
  detail?: string;
  /** Exact shell command for explicit .sh export; never rendered or shared. */
  commandText?: string;
  /** Tool output. Present when completed; partial while running. */
  output?: string;
  /** Error text when `status === "error"`. */
  error?: string;
  durationMs?: number;
  /** Files this call produced or referenced. */
  attachments: Attachment[];
  /** Verified task execution metadata, flattened at the backend boundary. */
  taskExecution?: TaskExecution;
  taskAgent?: string;
  taskModel?: string;
  /**
   * Session this call delegated work to, when it started a sub-agent.
   *
   * Rendered as a link to the child transcript. Without it a delegation is an
   * opaque "task" chip and the work it started is unreachable from the place
   * that started it.
   */
  childSessionId?: string;
}

/** A file-edit milestone. Full patches are fetched only when this row is opened. */
export interface PatchEvent extends TranscriptBase {
  kind: "patch";
  /** Bounded display names; never the raw upstream array. */
  files: string[];
  /** Total names reported upstream, including names omitted from `files`. */
  fileCount: number;
  /** At least one name was omitted or shortened for display. */
  filesTruncated: boolean;
  /** Initiating user message, stated directly by the assistant message. */
  userMessageId?: string;
}

/** Lifecycle markers rendered as separators: compaction, retries, snapshots. */
export interface StatusEvent extends TranscriptBase {
  kind: "status";
  label: string;
  /** Extra context, e.g. which files a patch touched. */
  detail?: string;
  /** Sub-agent session this marker reports on, when it is a hand-back notice. */
  childSessionId?: string;
}

/** A turn-level failure. */
export interface ErrorEvent extends TranscriptBase {
  kind: "error";
  message: string;
}

export type TranscriptEvent =
  | UserEvent
  | AgentEvent
  | ThoughtEvent
  | ToolEvent
  | PatchEvent
  | StatusEvent
  | ErrorEvent;

/** A file referenced by a message or produced by a tool. */
export interface Attachment {
  filename: string;
  mime?: string;
  /** Backend-resolvable location. Not necessarily an http URL. */
  url?: string;
  /** Absolute path when the reference points into the workspace. */
  path?: string;
}

/**
 * Token and cost accounting for one completed step.
 *
 * Kept out of TranscriptEvent because it drives the status bar, not a row.
 * The context-window *denominator* is not served with this — it comes from
 * the model catalogue (`Model.limit.context`), so the gauge is computed
 * client-side rather than read off a field.
 */
export interface UsageSnapshot {
  messageId: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    /** Backend-reported total; absent while a turn is still in flight. */
    total?: number;
  };
}

/** Everything one transcript fetch yields. */
export interface Transcript {
  events: TranscriptEvent[];
  /** Newest-last, matching `events` order. Drives the status bar. */
  usage: UsageSnapshot[];
  /**
   * True when the last message is an assistant turn that never completed and
   * the session is not currently running anywhere.
   *
   * OpenCode never persists "running" state (the session table has no status
   * column), so a crash mid-turn is invisible unless the UI derives it. We
   * surface it and let the human decide — see AGENTS.md decision #5.
   */
  interrupted: InterruptedState;
}

export type InterruptedState =
  | { interrupted: false }
  /** An assistant turn started and never finished. */
  | { interrupted: true; reason: "incomplete-turn" }
  /** A user prompt was never answered at all. */
  | { interrupted: true; reason: "never-answered" };
