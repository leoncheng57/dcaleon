// client/lib/events.ts
//
// The adapter. OpenCode `{ info, parts }` messages in, frozen TranscriptEvent
// out. This is the ONLY file in the client that knows what an OpenCode Part
// looks like; see transcript.ts for why that matters.
//
// Shapes here were captured from a live 1.18.19 server rather than from the
// published docs, which lag the binary badly. Notes on the non-obvious bits:
//
//   - `reasoning.text` is plaintext, but `reasoning.metadata.anthropic.signature`
//     is an opaque provider artefact. We read text and drop metadata entirely.
//   - `patch` parts carry `{ hash, files[] }` — a reference, not a diff body.
//   - `file` parts are references with an optional `source.text` range, not
//     uploaded attachments.
//   - `tool.state.running.metadata.output` holds partial output mid-call, which
//     is what makes a live-updating tool row possible.
//   - `step-start` / `step-finish` are bookkeeping, not rows. step-finish is
//     where cost and tokens live.

import type {
  Attachment,
  InterruptedState,
  MessageMode,
  PatchEvent,
  TaskExecution,
  ToolStatus,
  Transcript,
  TranscriptEvent,
  UsageSnapshot,
} from "./transcript.js";
import { splitReminderTags } from "./reminders.js";
import { splitWorkflowTags } from "./workflows.js";

// ── Minimal structural types for what we consume ────────────────────────────
// Intentionally not imported from the SDK: the client bundle should not depend
// on server types, and these are narrower than the generated unions.

interface RawTime {
  start?: number;
  end?: number;
  created?: number;
  completed?: number;
}

interface RawToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: RawTime;
}

export interface RawPart {
  id?: string;
  messageID?: string;
  type?: string;
  // text
  text?: string;
  // tool
  callID?: string;
  tool?: string;
  state?: RawToolState;
  // reasoning
  time?: RawTime;
  // file
  mime?: string;
  filename?: string;
  url?: string;
  source?: { type?: string; path?: string; text?: { value?: string } };
  // patch
  hash?: string;
  files?: string[];
  // compaction
  auto?: boolean;
  // step-finish
  reason?: string;
  cost?: number;
  tokens?: RawTokens;
}

interface RawTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export const PATCH_FILE_METADATA_LIMITS = {
  displayedFiles: 8,
  pathCharacters: 240,
  aggregatePathCharacters: 1_200,
} as const;

function patchFileMetadata(value: unknown): Pick<PatchEvent, "files" | "fileCount" | "filesTruncated"> {
  if (!Array.isArray(value)) return { files: [], fileCount: 0, filesTruncated: false };

  const files: string[] = [];
  let aggregateCharacters = 0;
  let filesTruncated = false;
  const inspectedCount = Math.min(value.length, PATCH_FILE_METADATA_LIMITS.displayedFiles);
  for (let index = 0; index < inspectedCount; index += 1) {
    const candidate = value[index];
    if (typeof candidate !== "string") {
      filesTruncated = true;
      continue;
    }
    const bounded = candidate.slice(0, PATCH_FILE_METADATA_LIMITS.pathCharacters + 1).trim();
    if (!bounded) {
      filesTruncated = true;
      continue;
    }
    const remaining = PATCH_FILE_METADATA_LIMITS.aggregatePathCharacters - aggregateCharacters;
    if (remaining <= 0) {
      filesTruncated = true;
      continue;
    }
    const pathWasTruncated = candidate.length > PATCH_FILE_METADATA_LIMITS.pathCharacters || bounded.length > remaining;
    const display = bounded.slice(0, Math.min(PATCH_FILE_METADATA_LIMITS.pathCharacters, remaining));
    files.push(pathWasTruncated && display.length > 3 ? `${display.slice(0, -3)}...` : display);
    aggregateCharacters += files.at(-1)?.length ?? 0;
    filesTruncated ||= pathWasTruncated;
  }
  filesTruncated ||= files.length < value.length;
  return { files, fileCount: value.length, filesTruncated };
}

export interface RawMessageInfo {
  id?: string;
  role?: string;
  time?: RawTime;
  agent?: string;
  /** Present on some assistant messages only; see `messageMode`. */
  mode?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string };
  cost?: number;
  tokens?: RawTokens;
  finish?: string;
  error?: unknown;
  /** Initiating user message on assistant turns. */
  parentID?: string;
}

export interface RawMessage {
  info?: RawMessageInfo;
  parts?: RawPart[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function iso(epochMs: number | undefined, fallback: number): string {
  return new Date(typeof epochMs === "number" ? epochMs : fallback).toISOString();
}

function duration(time: RawTime | undefined): number | undefined {
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return undefined;
  const ms = time.end - time.start;
  return ms >= 0 ? ms : undefined;
}

function fileAttachment(part: RawPart): Attachment {
  return {
    filename: part.filename || part.source?.path?.split("/").pop() || "file",
    mime: part.mime,
    url: part.url,
    path: part.source?.path,
  };
}

/**
 * A short, safe one-liner describing a tool's arguments.
 *
 * Deliberately conservative: tool inputs are arbitrary and can contain whole
 * file bodies (`content`, `new_str`, `patch`…). We allowlist the small scalar
 * fields that read well inline and skip everything else, rather than
 * stringifying the object and truncating — which is how the predecessor ended
 * up rendering giant JSON blobs into chips.
 */
export function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const preferred = [
    "command",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "subagent_type",
  ];
  for (const key of preferred) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
    }
  }
  return undefined;
}

function shellCommand(part: RawPart): string | undefined {
  if (!part.tool || !(/^(bash|shell)$|terminal/i.test(part.tool))) return undefined;
  const command = part.state?.input?.command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

/**
 * The child session a tool call delegated to, if any.
 *
 * Keyed on `state.metadata.sessionId` rather than on the tool being named
 * "task": the field is what makes a delegation identifiable, it is stable
 * across launch and resume, and it survives the launch tool being renamed.
 */
export function childSessionIdOf(part: RawPart): string | undefined {
  const metadata = part.state?.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const source = metadata as Record<string, unknown>;
  const value = source.sessionId ?? source.sessionID;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface NormalizedTaskMetadata {
  taskExecution?: TaskExecution;
  taskAgent?: string;
  taskModel?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize only fields the task tool itself reports.
 *
 * OpenCode 1.18.21 reports the child model and optional background marker in
 * state metadata. The requested agent is in input.subagent_type. It does not
 * report child effort, so effort is intentionally absent rather than copied
 * from the parent message, which may use a different model configuration.
 */
export function taskMetadataOf(part: RawPart): NormalizedTaskMetadata {
  if (part.type !== "tool" || part.tool !== "task") return {};

  const input = part.state?.input;
  const metadata = part.state?.metadata;
  if (!input || !metadata) return {};

  const taskAgent = nonEmptyString(input.subagent_type);
  const model = metadata.model;
  const modelRecord = model && typeof model === "object" ? model as Record<string, unknown> : undefined;
  const providerID = nonEmptyString(modelRecord?.providerID);
  const taskModel = providerID ? nonEmptyString(modelRecord?.modelID) : undefined;
  const verifiedTask = Boolean(
    nonEmptyString(input.description) &&
    nonEmptyString(input.prompt) &&
    taskAgent &&
    nonEmptyString(metadata.parentSessionId) &&
    nonEmptyString(metadata.sessionId) &&
    providerID &&
    taskModel &&
    (input.background === undefined || typeof input.background === "boolean") &&
    (metadata.background === undefined || metadata.background === true),
  );
  if (!verifiedTask) return {};

  let taskExecution: TaskExecution | undefined;
  if (metadata.background === true || input.background === true) taskExecution = "background";
  else taskExecution = "foreground";

  return {
    ...(taskExecution ? { taskExecution } : {}),
    ...(taskAgent ? { taskAgent } : {}),
    ...(taskModel ? { taskModel } : {}),
  };
}

// ── Sub-agent hand-back notices ─────────────────────────────────────────────
//
// A background child reports back by injecting a USER-role message into its
// parent. Nothing upstream marks it as machine-authored, so left alone it
// renders as a chat bubble attributed to the human — who never typed it.
//
// The signature required here is deliberately narrow: a child session id, a
// word establishing that the message is about delegated work, and an outcome.
// A human prompt satisfying all three is vanishingly unlikely, and the cost of
// a miss is only that a notice keeps rendering the way it does today.

const SESSION_ID_RE = /\bses_[A-Za-z0-9_-]{6,}\b/u;
const DELEGATION_RE = /\b(background|sub-?agent|child session|delegated|task)\b/iu;
const NOTICE_FAILED_RE = /\b(fail(?:s|ed|ure)?|error(?:ed|s)?|abort(?:ed)?|cancell?(?:ed)?|crash(?:ed)?)\b/iu;
const NOTICE_DONE_RE = /\b(complet(?:e|ed|ion)|finish(?:ed)?|done|succe(?:ss|eded|eds))\b/iu;

export interface SubagentNotice {
  childSessionId: string;
  outcome: "completed" | "failed";
}

/** Recognize a machine-authored sub-agent hand-back, or return null. */
export function subagentNotice(text: string): SubagentNotice | null {
  const id = SESSION_ID_RE.exec(text)?.[0];
  if (!id || !DELEGATION_RE.test(text)) return null;
  // Failure is tested first so "failed to complete" is not read as success.
  if (NOTICE_FAILED_RE.test(text)) return { childSessionId: id, outcome: "failed" };
  if (NOTICE_DONE_RE.test(text)) return { childSessionId: id, outcome: "completed" };
  return null;
}

// ── Per-message Plan / Build provenance ─────────────────────────────────────
//
// A conversation can switch modes mid-session, so "which policy produced this
// row?" is a per-message question and cannot be answered by the session's
// current mode. Raw metadata is inconsistent about where the answer lives:
//
//   - User messages name the selected primary agent in `info.agent`.
//   - Some assistant messages carry `info.mode`; others carry only `info.agent`.
//   - `info.agent` is an IDENTITY, so it is frequently an internal or sub-agent
//     name (`general`, `explore`, `compaction`) rather than a mode.
//
// Mode is never inherited from a neighbouring message, the session, or a
// parent: pagination can omit the initiating prompt, and a wrong Plan badge on
// a mutating turn is exactly the misreading this feature exists to prevent.
// Unclassifiable stays neutral.

function exactMode(value: unknown): MessageMode | undefined {
  return value === "plan" || value === "build" ? value : undefined;
}

/**
 * Classify one message's mode, or return undefined to render it neutral.
 *
 * `info.mode` is the primary signal for an assistant turn and `info.agent` is
 * only a fallback, so a recognized mode classifies the row even when the agent
 * naming it is an internal or sub-agent identity. Two consequences of that
 * ordering are worth stating outright rather than discovering later:
 *
 *   - A `compaction` summary, or a child session's `explore` turn, is badged
 *     with whatever mode upstream stamped on it. Neither was authored by the
 *     mode the human selected for their own prompt.
 *   - The badge is PROVENANCE, not a policy guarantee. Per issue #75 a child
 *     can retain a parent's historical Plan denies while reporting Build, so a
 *     Build pill never proves the turn could actually mutate anything.
 *
 * In the live 1.18.21 capture in tests/fixtures, `info.mode` only ever appears
 * alongside an agreeing `info.agent`, so today this ordering and a stricter one
 * produce identical output; it is a forward-compatibility choice.
 *
 * An unrecognized `info.mode` only means we do not know that label, so it falls
 * through to the agent rather than being treated as a disqualification. When
 * both fields are recognized and disagree, neither wins.
 */
export function messageMode(info: RawMessageInfo): MessageMode | undefined {
  const agent = exactMode(info.agent);
  // A user prompt's mode is the primary agent it selected. `info.mode` is not
  // read here: it is not populated for user messages on the observed server.
  if (info.role === "user") return agent;

  const mode = exactMode(info.mode);
  if (mode && agent && mode !== agent) return undefined;
  return mode ?? agent;
}

function toolStatus(raw: string | undefined): ToolStatus {
  switch (raw) {
    case "pending":
    case "running":
    case "completed":
    case "error":
      return raw;
    default:
      // Unknown states are treated as in-flight rather than dropped: the event
      // union has grown before and will again.
      return "running";
  }
}

// ── Part → event ────────────────────────────────────────────────────────────

function normalizePart(
  part: RawPart,
  info: RawMessageInfo,
  index: number,
): TranscriptEvent | null {
  const messageId = part.messageID || info.id || "unknown";
  const id = part.id || `${messageId}:${index}`;
  const created = info.time?.created ?? Date.now();
  const isUser = info.role === "user";
  const mode = messageMode(info);

  switch (part.type) {
    case "text": {
      const text = part.text?.trim();
      if (!text) return null;
      if (isUser) {
        // A sub-agent hand-back is machine-authored; rendering it as a human
        // bubble misattributes it to the user and buries the outcome.
        const notice = subagentNotice(text);
        if (notice) {
          return {
            kind: "status",
            id,
            messageId,
            timestamp: iso(created, created),
            label: notice.outcome === "failed" ? "Sub-agent reported a failure" : "Sub-agent reported completion",
            // A success needs no elaboration — the label says it and the link
            // reaches the work. A failure's reason is the whole point, so it
            // is the one case worth spending a separator line on.
            ...(notice.outcome === "failed" ? { detail: text } : {}),
            childSessionId: notice.childSessionId,
          };
        }
        const split = splitReminderTags(text);
        const workflowSplit = splitWorkflowTags(split.text);
        if (!workflowSplit.text && split.reminders.length === 0 && workflowSplit.workflows.length === 0) return null;
        return {
          kind: "user",
          id,
          messageId,
          timestamp: iso(created, created),
          text: workflowSplit.text,
          reminders: split.reminders,
          workflows: workflowSplit.workflows,
          attachments: [],
          ...(mode ? { mode } : {}),
        };
      }
      return {
        kind: "agent",
        id,
        messageId,
        timestamp: iso(created, created),
        text,
        ...(mode ? { mode } : {}),
      };
    }

    case "reasoning": {
      const text = part.text?.trim();
      // Encrypted-only reasoning yields no text; an empty Thought row is noise.
      // NB: part.metadata (Anthropic signature) is intentionally not read.
      if (!text) return null;
      return {
        kind: "thought",
        id,
        messageId,
        timestamp: iso(part.time?.start, created),
        text,
        durationMs: duration(part.time),
      };
    }

    case "tool": {
      const state = part.state || {};
      const status = toolStatus(state.status);
      const taskMetadata = taskMetadataOf(part);
      const childSessionId = childSessionIdOf(part);
      return {
        kind: "tool",
        id,
        messageId,
        timestamp: iso(state.time?.start, created),
        status,
        name: part.tool || "tool",
        title: state.title,
        detail: toolDetail(state.input),
        commandText: shellCommand(part),
        // While running, partial output hides in state.metadata.output.
        output:
          state.output ??
          (typeof state.metadata?.output === "string" ? state.metadata.output : undefined),
        error: state.error,
        durationMs: duration(state.time),
        attachments: [],
        ...taskMetadata,
        ...(childSessionId ? { childSessionId } : {}),
      };
    }

    case "file": {
      // A file reference attaches to the surrounding turn rather than
      // rendering its own row; callers fold these into the adjacent event.
      return null;
    }

    case "patch": {
      const fileMetadata = patchFileMetadata(part.files);
      const userMessageId = info.role === "assistant" ? nonEmptyString(info.parentID) : undefined;
      return {
        kind: "patch",
        id,
        messageId,
        timestamp: iso(created, created),
        ...fileMetadata,
        ...(userMessageId ? { userMessageId } : {}),
      };
    }

    case "compaction": {
      return {
        kind: "status",
        id,
        messageId,
        timestamp: iso(created, created),
        label: part.auto ? "Context compacted automatically" : "Context compacted",
      };
    }

    // Bookkeeping, never rendered as rows.
    case "step-start":
    case "step-finish":
    case "snapshot":
      return null;

    default:
      // Forward compatibility: the Part union grows between releases and an
      // unknown type must never break the transcript.
      return null;
  }
}

function usageFrom(part: RawPart, messageId: string): UsageSnapshot | null {
  if (part.type !== "step-finish") return null;
  const tokens = part.tokens || {};
  return {
    messageId,
    cost: part.cost ?? 0,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
      total: tokens.total,
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect a run that died without finishing.
 *
 * `isRunning` must come from `GET /session/status`, which only knows about
 * sessions owned by the *current* server process — that is precisely what
 * distinguishes "still working" from "orphaned by a crash".
 *
 * A deliberate user abort produces an identical signature, so callers should
 * describe the state ("this run did not finish") rather than diagnose a cause.
 */
export function detectInterrupted(
  messages: RawMessage[],
  isRunning: boolean,
): InterruptedState {
  if (isRunning || messages.length === 0) return { interrupted: false };

  const last = messages[messages.length - 1]?.info;
  if (!last) return { interrupted: false };

  if (last.role === "user") return { interrupted: true, reason: "never-answered" };
  if (last.role === "assistant" && typeof last.time?.completed !== "number") {
    return { interrupted: true, reason: "incomplete-turn" };
  }
  return { interrupted: false };
}

/** Map one message's parts, folding file references into the turn. */
export function normalizeMessage(message: RawMessage): TranscriptEvent[] {
  const info = message.info || {};
  const parts = message.parts || [];
  const events: TranscriptEvent[] = [];
  const attachments = parts.filter((p) => p.type === "file").map(fileAttachment);

  parts.forEach((part, index) => {
    const event = normalizePart(part, info, index);
    if (event) events.push(event);
  });

  if (attachments.length) {
    // Attach to the first event that can hold files, so a user prompt with a
    // referenced file renders them together.
    const target = events.find((e) => e.kind === "user" || e.kind === "tool");
    if (target && "attachments" in target) target.attachments = attachments;
  }

  // A partial turn can contain useful parts and still fail afterward. Preserve
  // both the work and the turn-level failure instead of hiding the outcome.
  if (info.error) {
    events.push({
      kind: "error",
      id: `${info.id ?? "unknown"}:error`,
      messageId: info.id ?? "unknown",
      timestamp: iso(info.time?.created, Date.now()),
      message:
        typeof info.error === "string"
          ? info.error
          : errorMessage(info.error),
    });
  }

  return events;
}

/** Extract actionable text across the error envelopes shipped by OpenCode versions. */
function errorMessage(input: unknown): string {
  if (!input || typeof input !== "object") return "The agent turn failed.";
  const error = input as Record<string, unknown>;
  for (const candidate of [error.message, error.error, (error.data as Record<string, unknown> | undefined)?.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  try {
    const serialized = JSON.stringify(input);
    if (serialized && serialized !== "{}") return serialized;
  } catch { /* cyclic or otherwise unserializable upstream value */ }
  return "The agent turn failed.";
}

/** Map a full transcript fetch. */
export function normalizeTranscript(
  messages: RawMessage[],
  options: { isRunning?: boolean } = {},
): Transcript {
  const events: TranscriptEvent[] = [];
  const usage: UsageSnapshot[] = [];
  let cumulativeCost = 0;

  for (const message of messages) {
    const messageEvents = normalizeMessage(message);
    const messageId = message.info?.id ?? "unknown";
    const messageUsage: UsageSnapshot[] = [];
    for (const part of message.parts || []) {
      const snapshot = usageFrom(part, messageId);
      if (snapshot) {
        usage.push(snapshot);
        messageUsage.push(snapshot);
      }
    }

    if (message.info?.role === "assistant") {
      const prose = messageEvents.filter((event): event is Extract<TranscriptEvent, { kind: "agent" }> => event.kind === "agent").at(-1);
      const completed = message.info.time?.completed;
      if (prose) {
        prose.metricsStatus = typeof completed === "number" ? "final" : "pending";
        prose.durationStatus = typeof completed === "number" ? "final" : "pending";
        prose.costStatus = typeof completed === "number" ? (messageUsage.length ? "final" : "unavailable") : "pending";
        prose.cumulativeCostStatus = prose.costStatus;
      }
    }

    if (message.info?.role === "assistant" && messageUsage.length > 0) {
      const messageCost = messageUsage.reduce((total, snapshot) => total + snapshot.cost, 0);
      cumulativeCost += messageCost;
      const tokens = messageUsage.reduce<UsageSnapshot["tokens"]>((total, snapshot) => ({
        input: total.input + snapshot.tokens.input,
        output: total.output + snapshot.tokens.output,
        reasoning: total.reasoning + snapshot.tokens.reasoning,
        cacheRead: total.cacheRead + snapshot.tokens.cacheRead,
        cacheWrite: total.cacheWrite + snapshot.tokens.cacheWrite,
        ...(
          total.total === undefined && snapshot.tokens.total === undefined
            ? {}
            : { total: (total.total ?? 0) + (snapshot.tokens.total ?? 0) }
        ),
      }), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
      const created = message.info.time?.created;
      const completed = message.info.time?.completed;
      const durationMs = typeof created === "number" && typeof completed === "number" && completed >= created
        ? completed - created
        : undefined;
      const prose = messageEvents.filter((event): event is Extract<TranscriptEvent, { kind: "agent" }> => event.kind === "agent").at(-1);
      if (prose) {
        prose.messageCost = messageCost;
        prose.cumulativeCost = cumulativeCost;
        if (durationMs !== undefined) prose.messageDurationMs = durationMs;
        prose.inputTokens = tokens.input;
        prose.outputTokens = tokens.output;
        prose.reasoningTokens = tokens.reasoning;
        prose.cacheReadTokens = tokens.cacheRead;
        prose.cacheWriteTokens = tokens.cacheWrite;
      }
    }
    events.push(...messageEvents);
  }

  return {
    events,
    usage,
    interrupted: detectInterrupted(messages, options.isRunning ?? false),
  };
}
