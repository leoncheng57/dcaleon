// client/components/transcript.tsx
//
// Transcript row components. Every one of these consumes ONLY the frozen
// TranscriptEvent contract — none of them imports an SDK type or touches a raw
// OpenCode Part. That wall is what made this migration a small adapter rewrite
// instead of a rebuild; see client/lib/transcript.ts.

import { memo, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { ChangeModal } from "./change-modal.js";
import { LinkifiedText, Markdown } from "../ds/markdown.js";
import { Badge } from "../ds/badge.js";
import { FileReference } from "../ds/file-reference.js";
import { cn } from "../ds/utils.js";
import { useWorkspaceAttachmentReference } from "../lib/workspaceReferences.js";
import { formatClockTime, formatDurationMs, formatRelative, type DisplayItem, type RunningActivity } from "../lib/derive.js";
import type {
  Attachment,
  AgentEvent,
  ErrorEvent,
  MessageMode,
  PatchEvent,
  StatusEvent,
  ThoughtEvent,
  ToolEvent,
  ToolStatus,
  TranscriptEvent,
  UserEvent,
} from "../lib/transcript.js";

// ── Shared bits ─────────────────────────────────────────────────────────────

function TimeLabel({ timestamp, className }: { timestamp: string; className?: string }) {
  if (!timestamp) return null;
  const display = formatRelative(timestamp) || formatClockTime(timestamp);
  if (!display) return null;
  return (
    <time
      dateTime={timestamp}
      title={new Date(timestamp).toLocaleString()}
      className={cn(
        "shrink-0 whitespace-nowrap text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-70",
        className,
      )}
      data-testid="opencode-event-time"
    >
      {display}
    </time>
  );
}

function formatMessageCost(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
}

function MessageMetrics({ event }: { event: AgentEvent }) {
  if (!event.metricsStatus && event.messageCost === undefined && event.cumulativeCost === undefined) return null;
  const pending = event.metricsStatus === "pending";
  const duration = event.messageDurationMs === undefined ? null : formatDurationMs(event.messageDurationMs);
  const cost = event.messageCost === undefined ? "cost unavailable" : `${formatMessageCost(event.messageCost)} message`;
  const cumulative = event.cumulativeCost === undefined ? "session total unavailable" : `${formatMessageCost(event.cumulativeCost)} session`;
  const durationLabel = duration ?? (pending ? "latency pending" : "latency unavailable");
  const status = pending ? "pending" : "final";
  return (
    <details className="group text-[10px] tabular-nums text-[var(--color-text-muted)] opacity-70" data-testid="opencode-message-metrics">
      <summary className="cursor-pointer list-none whitespace-nowrap [&::-webkit-details-marker]:hidden">
        <span className="sr-only">Message metrics: </span>
        <span title="Total agent turn duration">{durationLabel}</span><span aria-hidden> · </span>
        <span title="Cost of this agent message">{pending ? "cost pending" : cost}</span>
        <span aria-hidden> · </span>
        <span title="Cumulative session cost">{pending ? "session total pending" : cumulative}</span>
        <span aria-hidden> · </span><span>{status}</span>
      </summary>
      <pre className="mt-1 max-w-full overflow-x-auto text-right font-mono text-[10px] leading-relaxed" data-testid="opencode-message-metrics-diagram">{`prompt -> agent turn -> response
   |---- ${durationLabel} ----|
   +-> ${pending ? "cost pending" : cost}
       +-> ${pending ? "session total pending" : cumulative}

tokens: ${event.inputTokens ?? "unavailable"} in + ${event.outputTokens ?? "unavailable"} out + ${event.reasoningTokens ?? "unavailable"} reasoning
cache:  ${event.cacheReadTokens ?? "unavailable"} read + ${event.cacheWriteTokens ?? "unavailable"} write
status: ${status}`}</pre>
    </details>
  );
}

/**
 * One attachment chip.
 *
 * A workspace path the server confirmed is readable becomes a control that
 * opens the file; anything else keeps the inert chip it has always been. The
 * control still never carries `Attachment.url` — it carries a validated
 * workspace path, and opening it goes through the read route like any other
 * file. See the note on `Attachments` for why the URL is untouchable.
 */
function AttachmentChip({ item }: { item: Attachment }) {
  const reference = useWorkspaceAttachmentReference(item.path);
  if (reference) {
    return (
      <FileReference
        path={reference.target.path}
        onOpen={reference.open}
        testId="opencode-attachment-reference"
        className="inline-flex items-center gap-1 rounded-full text-[11px] no-underline"
      >
        <span aria-hidden>📎</span>
        <span className="max-w-48 truncate">{item.filename}</span>
      </FileReference>
    );
  }
  return (
    <span
      title={item.path ?? item.filename}
      className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]"
      data-testid="opencode-attachment-chip-inert"
    >
      <span aria-hidden>📎</span>
      <span className="max-w-48 truncate">{item.filename}</span>
    </span>
  );
}

/**
 * Attachments render as filename chips, never as <img src={url}>.
 *
 * `Attachment.url` is explicitly "not necessarily an http URL" and can point
 * anywhere the agent referenced. Inlining it would turn a transcript into an
 * SSRF / tracking-pixel surface. Only a self-contained data: image is safe to
 * display, and even then we gate on the mime type.
 */
function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="opencode-attachments">
      {items.map((item, index) => {
        const inlineable =
          item.mime?.startsWith("image/") && item.url?.startsWith("data:image/");
        if (inlineable) {
          return (
            <img
              key={`${item.filename}-${index}`}
              src={item.url}
              alt={item.filename}
              className="max-h-64 max-w-full rounded-lg border border-[var(--color-border-default)] object-contain"
            />
          );
        }
        return <AttachmentChip key={`${item.filename}-${index}`} item={item} />;
      })}
    </div>
  );
}

/**
 * Link from a delegation to the session that ran it.
 *
 * Rendered as a sibling of the tool chip rather than inside it: the chip is a
 * disclosure button, and nesting an anchor in a button is invalid and breaks
 * keyboard activation of both.
 *
 * Without `directory` there is no addressable route — every session route is
 * project-scoped — so the link is omitted rather than pointing somewhere wrong.
 */
function SubagentLink({
  directory,
  sessionId,
  label,
}: {
  directory?: string;
  sessionId: string;
  label: string;
}) {
  if (!directory) return null;
  return (
    <Link
      to={`/sessions/${sessionId}?directory=${encodeURIComponent(directory)}`}
      className="ml-1.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-info)] underline-offset-2 hover:underline"
      title={sessionId}
      data-testid="opencode-subagent-link"
    >
      {label} →
    </Link>
  );
}

function TaskPills({ event }: { event: ToolEvent }) {
  const pills = [
    event.taskExecution && { label: event.taskExecution === "background" ? "Background" : "Foreground", variant: "info" as const },
    event.taskAgent && { label: `Agent: ${event.taskAgent}`, variant: "neutral" as const },
    event.taskModel && { label: event.taskModel, variant: "neutral" as const },
  ].filter((value): value is { label: string; variant: "info" | "neutral" } => Boolean(value));
  if (pills.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" data-testid="opencode-task-metadata">
      {pills.map((pill, index) => (
        <Badge key={`${pill.label}-${index}`} variant={pill.variant} className="max-w-full normal-case">
          <span className="truncate">{pill.label}</span>
        </Badge>
      ))}
    </div>
  );
}

// ── Plan / Build provenance ─────────────────────────────────────────────────
//
// Only prose rows are marked. Thoughts, tools, task cards, separators and
// errors belong to the same message and could be tinted from `messageId`, but
// they are operational detail rather than the thing a reader is attributing —
// and painting half the transcript in two colours costs more legibility than
// the extra provenance buys.
//
// Two cues per row: an accent rail and a text pill. The pill is what carries
// the meaning; colour alone must never have to.
//
// The message body is deliberately NOT tinted. A full-width wash behind prose
// competes with the content it is annotating — markdown already uses surface
// fills for code blocks and tables, and a second background underneath them
// flattens that hierarchy. A rail marks the row just as unambiguously while
// leaving the reading surface alone.

const MODE_LABEL: Record<MessageMode, string> = { plan: "Plan", build: "Build" };

/**
 * Accent rail for the message body.
 *
 * On the inline-start edge for both roles, including the right-aligned user
 * bubble: a consistent edge is what lets a reader scan a long transcript for
 * mode changes without re-reading each row.
 */
const MODE_RAIL: Record<MessageMode, string> = {
  plan: "border-l-4 border-[var(--color-border-plan)]",
  build: "border-l-4 border-[var(--color-border-build)]",
};

const MODE_PILL: Record<MessageMode, string> = {
  plan: "border-[var(--color-border-plan)] bg-[var(--color-background-surface-plan-muted)] text-[var(--color-text-plan)]",
  build: "border-[var(--color-border-build)] bg-[var(--color-background-surface-build-muted)] text-[var(--color-text-build)]",
};

/**
 * The mode label.
 *
 * Rendered on its own compact line rather than inline with the prose so a long
 * message keeps its full measure — assistant markdown already fights for
 * horizontal space at 390px.
 */
function ModePill({ mode }: { mode: MessageMode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-px text-[10px] font-semibold uppercase tracking-wide",
        MODE_PILL[mode],
      )}
      data-testid="opencode-message-mode"
      data-mode={mode}
    >
      {/* Screen readers get the field name, not just the value: "Plan" alone
          reads as a stray noun next to a message. */}
      <span className="sr-only">Message mode: </span>
      {MODE_LABEL[mode]}
    </span>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

function ShareAction({ event, onShare }: { event: UserEvent | AgentEvent; onShare?: (event: UserEvent | AgentEvent) => void }) {
  if (!onShare || (event.kind === "agent" && !event.text.trim())) return null;
  return (
    <button
      type="button"
      className="min-h-8 rounded px-2 py-0.5 text-[10px] text-[var(--color-text-muted)] underline-offset-2 hover:underline pointer-coarse:min-h-10"
      onClick={() => onShare(event)}
      aria-label={`Share ${event.kind === "user" ? "your" : "assistant"} message`}
      data-testid={`opencode-${event.kind}-share`}
    >
      Share
    </button>
  );
}

function UserBubble({ event, onExport }: { event: UserEvent; onExport?: (event: UserEvent | AgentEvent) => void }) {
  return (
    <div
      className="flex flex-col items-end gap-1"
      data-kind="user"
      data-testid="opencode-user-message"
      {...(event.mode ? { "data-mode": event.mode } : {})}
    >
      {event.reminders.map((reminder, index) => (
        <details
          open
          key={`${reminder.name}-${index}`}
          className="max-w-[90%] rounded-lg border border-[var(--color-border-default)] p-2 text-left text-[11px] text-[var(--color-text-muted)] sm:max-w-[75%]"
          data-testid="opencode-manual-reminder"
        >
          <summary className="cursor-pointer font-medium" data-testid="opencode-manual-reminder-toggle">
            reminder attached - {reminder.name}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans leading-relaxed">{reminder.body}</pre>
        </details>
      ))}
      {event.workflows.map((workflow, index) => (
        <details
          open
          key={`${workflow.name}-${index}`}
          className="max-w-[90%] rounded-lg border border-[var(--color-border-default)] p-2 text-left text-[11px] text-[var(--color-text-muted)] sm:max-w-[75%]"
          data-testid="opencode-manual-workflow"
        >
          <summary className="cursor-pointer font-medium" data-testid="opencode-manual-workflow-toggle">
            workflow attached - {workflow.name}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans leading-relaxed">{workflow.body}</pre>
        </details>
      ))}
      {event.mode && <ModePill mode={event.mode} />}
      {(event.text || event.attachments.length > 0) && (
        <div
          className={cn(
            // The 90%/75% ceilings are load-bearing: they are what stops a
            // pasted stack trace from spanning the whole viewport.
            "max-w-[90%] rounded-2xl bg-[var(--color-background-muted)] px-4 py-2.5 text-sm sm:max-w-[75%]",
            event.mode && MODE_RAIL[event.mode],
          )}
          data-testid="opencode-user-message-body"
        >
          {event.text && <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed"><LinkifiedText text={event.text} /></pre>}
          <Attachments items={event.attachments} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <ShareAction event={event} onShare={onExport} />
        <TimeLabel timestamp={event.timestamp} />
      </div>
    </div>
  );
}

function AgentProse({ event, onExport }: { event: AgentEvent; onExport?: (event: UserEvent | AgentEvent) => void }) {
  return (
    <div
      className="min-w-0 max-w-full text-sm leading-relaxed"
      data-kind="agent"
      data-testid="opencode-agent-message"
      {...(event.mode ? { "data-mode": event.mode } : {})}
    >
      {event.mode && (
        <div className="mb-1">
          <ModePill mode={event.mode} />
        </div>
      )}
      {/* min-w-0 survives the rail wrapper so the markdown renderer keeps its
          own overflow handling for wide code blocks and tables. */}
      <div
        className={cn("min-w-0 max-w-full", event.mode && `${MODE_RAIL[event.mode]} pl-3`)}
        data-testid="opencode-agent-message-body"
      >
        <Markdown source={event.text} />
      </div>
      <div className="mt-1 flex flex-wrap items-start justify-end gap-x-2">
        <ShareAction event={event} onShare={onExport} />
        <TimeLabel timestamp={event.timestamp} />
        <MessageMetrics event={event} />
      </div>
    </div>
  );
}

export function ThoughtRow({
  text,
  durationMs,
  live = false,
}: {
  text: string;
  durationMs?: number;
  live?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
  const hasMore = text.trim() !== firstLine;
  const duration = formatDurationMs(durationMs);

  return (
    <div data-kind="thought" data-testid={live ? "opencode-thought-live" : "opencode-thought"}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] italic text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span className="shrink-0 font-medium not-italic">Thought</span>
        {/* The predecessor could not show this: OpenHands persisted only a
            completion timestamp, so any figure would have been invented.
            OpenCode reports both bounds. */}
        {duration && (
          <span className="shrink-0 tabular-nums opacity-70 not-italic">{duration}</span>
        )}
        {!expanded && firstLine && (
          <span className="truncate opacity-80">
            {firstLine}
            {hasMore ? "…" : ""}
          </span>
        )}
        {live && <span className="shrink-0 not-italic opacity-60">▍</span>}
      </button>
      {expanded && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l border-[var(--color-border-default)] pl-3 text-[11px] italic leading-relaxed text-[var(--color-text-muted)]">
          {text}
        </div>
      )}
    </div>
  );
}

const TOOL_BULLET: Record<ToolStatus, string> = {
  pending: "text-[var(--color-text-muted)]",
  running: "text-[var(--color-text-info)] animate-pulse",
  completed: "text-[var(--color-text-success)]",
  error: "text-[var(--color-text-danger)]",
};

export function ToolCallRow({ event, wrap, directory }: { event: ToolEvent; wrap: boolean; directory?: string }) {
  const [expanded, setExpanded] = useState(false);
  const failed = event.status === "error";
  const duration = formatDurationMs(event.durationMs);
  const preClass = wrap ? "whitespace-pre-wrap break-words" : "thin-scrollbar overflow-x-auto";

  if (event.name === "task") {
    return (
      <div
        data-kind="tool"
        data-testid="opencode-task-card"
        data-status={event.status}
        {...(event.childSessionId ? { "data-child-session": event.childSessionId } : {})}
        className={cn(
          "min-w-0 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-muted)] p-2.5",
          failed && "border-[var(--color-border-danger)]",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${event.status}: ${expanded ? "Collapse" : "Expand"} task ${event.title ?? event.detail ?? "output"}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
            data-testid="opencode-task-toggle"
          >
            <span aria-hidden>{expanded ? "▾" : "▸"}</span>
            <span className={TOOL_BULLET[event.status]} aria-hidden>●</span>
            <span className="shrink-0 font-semibold">Task</span>
            <span className="min-w-0 truncate font-medium text-[var(--color-text-default)]" data-testid="opencode-tool-summary">
              {event.title ?? event.detail ?? "Delegated work"}
            </span>
            {duration && <span className="shrink-0 tabular-nums opacity-70" title="Execution time">{duration}</span>}
            <TimeLabel timestamp={event.timestamp} />
          </button>
          {event.childSessionId && (
            <SubagentLink directory={directory} sessionId={event.childSessionId} label="Open subagent" />
          )}
        </div>
        <div className="mt-2">
          <TaskPills event={event} />
        </div>
        {expanded && (
          <div className="mt-2 space-y-1">
            {event.detail && event.title && <pre className={cn("rounded bg-[var(--color-background-surface)] p-2 font-mono text-[11px]", preClass)}><code>{event.detail}</code></pre>}
            <pre className={cn("rounded p-2 font-mono text-[11px]", preClass, failed ? "bg-[var(--color-background-surface-danger-muted)]" : "bg-[var(--color-background-surface)]")}>
              <code>{event.error ?? event.output ?? "(no output)"}</code>
            </pre>
            <Attachments items={event.attachments} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-kind="tool"
      data-testid="opencode-tool"
      data-status={event.status}
      {...(event.childSessionId ? { "data-child-session": event.childSessionId } : {})}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded bg-[var(--color-background-muted)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]",
          failed && "border border-[var(--color-border-danger)]",
        )}
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span className={TOOL_BULLET[event.status]} aria-hidden>
          ●
        </span>
        <span className="shrink-0 font-medium">{event.name}</span>
        {event.title ? (
          <span className="min-w-0 truncate" data-testid="opencode-tool-summary">
            {event.title}
          </span>
        ) : event.detail ? (
          <span className="min-w-0 truncate font-mono" data-testid="opencode-tool-detail">
            {event.detail}
          </span>
        ) : null}
        {duration && (
          <span
            className="shrink-0 tabular-nums opacity-70"
            title="Execution time"
            data-testid="opencode-tool-duration"
          >
            {duration}
          </span>
        )}
        <TimeLabel timestamp={event.timestamp} />
      </button>
      {event.childSessionId && (
        <SubagentLink directory={directory} sessionId={event.childSessionId} label="Open sub-agent" />
      )}

      {expanded && (
        <div className="mt-1 space-y-1">
          {event.detail && event.title && (
            <pre
              className={cn(
                "rounded bg-[var(--color-background-muted)] p-2 font-mono text-[11px]",
                preClass,
              )}
            >
              <code>{event.detail}</code>
            </pre>
          )}
          <pre
            className={cn(
              "rounded p-2 font-mono text-[11px]",
              preClass,
              failed
                ? "bg-[var(--color-background-surface-danger-muted)]"
                : "bg-[var(--color-background-muted)] opacity-90",
            )}
          >
            <code>{event.error ?? event.output ?? "(no output)"}</code>
          </pre>
          <Attachments items={event.attachments} />
        </div>
      )}
    </div>
  );
}

function StatusSeparator({ event, directory }: { event: StatusEvent; directory?: string }) {
  return (
    <div
      className="flex items-center gap-3 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] opacity-70"
      data-kind="status"
      data-testid="opencode-status-separator"
      {...(event.childSessionId ? { "data-child-session": event.childSessionId } : {})}
    >
      <span className="h-px flex-1 bg-[var(--color-border-default)]" aria-hidden />
      <span className="min-w-0 break-words text-center [overflow-wrap:anywhere]">
        {event.label}
        {event.detail && <span className="opacity-70"> · {event.detail}</span>}
        {event.timestamp && (
          <>
            {" · "}
            <time dateTime={event.timestamp}>{formatClockTime(event.timestamp)}</time>
          </>
        )}
        {event.childSessionId && (
          <SubagentLink directory={directory} sessionId={event.childSessionId} label="Open sub-agent" />
        )}
      </span>
      <span className="h-px flex-1 bg-[var(--color-border-default)]" aria-hidden />
    </div>
  );
}

/**
 * A file-edit milestone.
 *
 * Deliberately renders no patch body: issue #134 established that a normal
 * turn and an oversized turn must behave identically, and only one of those
 * can ever be shown inline. The card states what changed and opens the one
 * modal that explains its own scope.
 */
function ChangedFilesCard({
  event,
  directory,
  sessionId,
  onOpenWorkspaceChanges,
}: {
  event: PatchEvent;
  directory?: string;
  sessionId?: string;
  onOpenWorkspaceChanges?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const canOpen = Boolean(directory && sessionId && event.userMessageId);
  const countLabel = event.fileCount === 1 ? "1 file changed" : `${event.fileCount} files changed`;

  // A session or turn change invalidates whatever the modal was showing.
  useEffect(() => setOpen(false), [directory, event.userMessageId, sessionId]);

  return (
    <section
      className="min-w-0 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-3"
      data-kind="patch"
      data-testid="opencode-changed-files-card"
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-xs font-semibold">{countLabel}</h3>
            <TimeLabel timestamp={event.timestamp} />
          </div>
          {(event.files.length > 0 || event.filesTruncated) && (
            <p className="mt-1 break-words font-mono text-[11px] leading-5 text-[var(--color-text-muted)]" data-testid="opencode-changed-files-names">
              {event.files.map((file, index) => <span key={`${file}-${index}`}>{index > 0 ? ", " : ""}{file}</span>)}
              {event.files.length < event.fileCount && <span>{event.files.length > 0 ? ", " : ""}+{event.fileCount - event.files.length} more</span>}
              {event.filesTruncated && event.files.length === event.fileCount && <span> (names truncated)</span>}
            </p>
          )}
        </div>
        {canOpen ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="min-h-9 shrink-0 self-start rounded-md border border-[var(--color-border-default)] px-3 text-xs font-medium hover:bg-[var(--color-background-muted)] pointer-coarse:min-h-11"
            data-testid="opencode-turn-diff-toggle"
          >
            View changes
          </button>
        ) : (
          <span className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-turn-diff-unavailable">
            Detailed changes unavailable
          </span>
        )}
      </div>
      {open && canOpen && (
        <ChangeModal
          directory={directory!}
          sessionId={sessionId!}
          event={event}
          onClose={() => setOpen(false)}
          onOpenWorkspaceChanges={onOpenWorkspaceChanges}
        />
      )}
    </section>
  );
}

function ErrorCard({ event }: { event: ErrorEvent }) {
  return (
    <div
      className="rounded-xl border border-[var(--color-border-danger)] bg-[var(--color-background-surface-danger-muted)] p-3 text-sm"
      data-kind="error"
      data-testid="opencode-error"
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-danger)]">
        <span>Error</span>
        <TimeLabel timestamp={event.timestamp} className="text-[var(--color-text-danger)]" />
      </div>
      <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">{event.message}</pre>
    </div>
  );
}

function ActionGroupRow({
  calls,
  wrap,
  expanded,
  onToggle,
  directory,
}: {
  calls: ToolEvent[];
  wrap: boolean;
  expanded: boolean;
  onToggle: () => void;
  directory?: string;
}) {
  const last = calls[calls.length - 1];
  return (
    <div
      data-kind="action-group"
      data-testid="opencode-action-group"
      data-event-ids={JSON.stringify(calls.map((call) => call.id))}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="opencode-action-group-toggle"
        className="inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span>{calls.length} actions completed</span>
        <TimeLabel timestamp={last.timestamp} />
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5 border-l border-[var(--color-border-default)] pl-3">
          {calls.map((call) => (
            <div key={call.id} data-event-id={call.id} tabIndex={-1}>
              <ToolCallRow event={call} wrap={wrap} directory={directory} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TranscriptRow = memo(function TranscriptRow({ event, wrap, onExport, directory, sessionId, onOpenWorkspaceChanges }: { event: TranscriptEvent; wrap: boolean; onExport?: (event: UserEvent | AgentEvent) => void; directory?: string; sessionId?: string; onOpenWorkspaceChanges?: () => void }) {
  switch (event.kind) {
    case "user":
      return <UserBubble event={event} onExport={onExport} />;
    case "agent":
      return <AgentProse event={event} onExport={onExport} />;
    case "thought":
      return <ThoughtRow text={event.text} durationMs={event.durationMs} />;
    case "tool":
      return <ToolCallRow event={event} wrap={wrap} directory={directory} />;
    case "patch":
      return <ChangedFilesCard event={event} directory={directory} sessionId={sessionId} onOpenWorkspaceChanges={onOpenWorkspaceChanges} />;
    case "status":
      return <StatusSeparator event={event} directory={directory} />;
    case "error":
      return <ErrorCard event={event} />;
    default:
      // Forward compatibility: an unknown kind renders nothing rather than
      // crashing the transcript.
      return null;
  }
});

export function RunningIndicator({ activity }: { activity: RunningActivity }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = activity.since ? formatDurationMs(now - Date.parse(activity.since)) : null;
  const detail =
    activity.kind === "tool" ? activity.detail.replace(/\s+/g, " ").trim() : "";

  return (
    <div className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-running">
      <div className="flex items-center gap-2">
        <svg
          className="shrink-0 animate-spin"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        {activity.kind === "tool" ? (
          <span className="min-w-0 truncate" data-testid="opencode-running-tool">
            Running {activity.name}
            {detail && (
              <>
                : <code className="font-mono text-[11px]">{detail.length > 90 ? `${detail.slice(0, 90)}…` : detail}</code>
              </>
            )}
            {elapsed && <span className="opacity-70"> ({elapsed})</span>}
          </span>
        ) : (
          <span data-testid="opencode-running-thinking">
            Thinking…
            {elapsed && <span className="opacity-70"> no new events for {elapsed}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

/** Vertical rhythm: related actions sit tight, turns get room to breathe. */
function rowSpacing(previous: DisplayItem | undefined, item: DisplayItem): string {
  if (!previous) return "";
  const isAction = (candidate: DisplayItem) =>
    candidate.type === "actionGroup" ||
    (candidate.type === "event" && candidate.event.kind === "tool");
  if (isAction(previous) && isAction(item)) return "mt-1.5";
  if (item.type === "event" && (item.event.kind === "status" || item.event.kind === "patch")) return "mt-5";
  return "mt-6";
}

export const Transcript = memo(function Transcript({
  items,
  wrap,
  collapsedGroups,
  collapseCompletedByDefault = false,
  onToggleGroup,
  onExport,
  directory,
  sessionId,
  onOpenWorkspaceChanges,
}: {
  items: DisplayItem[];
  wrap: boolean;
  collapsedGroups: Record<string, boolean>;
  collapseCompletedByDefault?: boolean;
  onToggleGroup: (id: string) => void;
  onExport?: (event: UserEvent | AgentEvent) => void;
  /** Project scope, required to build links to delegated child sessions. */
  directory?: string;
  /** Session scope, required for lazy per-turn diff requests. */
  sessionId?: string;
  /** Opens the working-tree diff when historical detail is unavailable. */
  onOpenWorkspaceChanges?: () => void;
}) {
  return (
    <>
      {items.map((item, index) => (
        <div
          key={item.id}
          data-transcript-item={item.id}
          data-event-id={item.type === "actionGroup" ? undefined : item.id}
          tabIndex={item.type === "actionGroup" ? undefined : -1}
          className={rowSpacing(items[index - 1], item)}
        >
          {item.type === "actionGroup" ? (
            <ActionGroupRow
              calls={item.calls}
              wrap={wrap}
              expanded={!(collapsedGroups[item.id] ?? collapseCompletedByDefault)}
              onToggle={() => onToggleGroup(item.id)}
              directory={directory}
            />
          ) : (
            <TranscriptRow event={item.event} wrap={wrap} onExport={onExport} directory={directory} sessionId={sessionId} onOpenWorkspaceChanges={onOpenWorkspaceChanges} />
          )}
        </div>
      ))}
    </>
  );
});
