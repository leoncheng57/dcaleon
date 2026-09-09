// client/lib/derive.ts
//
// Backend-neutral derivations over TranscriptEvent[]. Nothing here knows what
// OpenCode is — that is the point. These are the functions that survived the
// migration from the OpenHands runner unchanged in spirit, and they will
// survive the next one too.

import type { ToolEvent, TranscriptEvent } from "./transcript.js";

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * Fingerprint of everything that can change about an event after first sight.
 *
 * CRITICAL: OpenCode tool parts **mutate in place** — a call goes
 * pending → running → completed and its `output` grows as it streams. The
 * predecessor's log was append-only, so it could treat "is this id new?" as
 * "did anything change?". Doing that here freezes tool chips at `running`
 * forever. Compare content, not just presence.
 *
 * Mode is part of the prose fingerprints for the same reason: a first sight of
 * a message can lack the metadata that classifies it, and without mode here a
 * later authoritative fetch would leave the row rendering neutral forever.
 */
function fingerprint(event: TranscriptEvent): string {
  switch (event.kind) {
    case "tool":
      return `${event.status}|${event.output ?? ""}|${event.error ?? ""}|${event.durationMs ?? ""}|${event.commandText ?? ""}`;
    case "user":
      return `${event.mode ?? ""}|${event.text}|${event.reminders.map((reminder) => `${reminder.name}:${reminder.body}`).join("|")}|${event.workflows.map((workflow) => `${workflow.name}:${workflow.body}`).join("|")}`;
    case "agent":
      // Metrics arrive AFTER the prose: the row is created on the first text
      // frame with `metricsStatus: "pending"` and stamped final by the result
      // frame with the same text. Leaving them out here kept the client's copy
      // of the row frozen at "cost pending" until the page was remounted.
      return `${event.mode ?? ""}|${event.model ?? ""}|${event.metricsStatus ?? ""}|${event.messageCost ?? ""}|${event.cumulativeCost ?? ""}|${event.messageDurationMs ?? ""}|${event.text}`;
    case "thought":
      return event.text;
    case "patch":
      return `${event.files.join("|")}|${event.fileCount}|${event.filesTruncated}|${event.userMessageId ?? ""}`;
    case "status":
      return `${event.label}|${event.detail ?? ""}`;
    case "error":
      return event.message;
  }
}

/**
 * Reconcile a freshly normalized transcript with what we already have.
 *
 * Returns the SAME array reference when nothing changed, so downstream
 * `useMemo`/`memo` boundaries do not invalidate on every poll.
 */
export function mergeEvents(
  previous: TranscriptEvent[],
  incoming: TranscriptEvent[],
): TranscriptEvent[] {
  if (incoming.length === 0) return previous.length === 0 ? previous : [];

  const previousById = new Map(previous.map((event) => [event.id, event]));
  const byId = new Map<string, TranscriptEvent>();

  let changed = previous.length !== incoming.length;
  for (const [index, event] of incoming.entries()) {
    if (previous[index]?.id !== event.id) changed = true;
    const existing = previousById.get(event.id);
    if (!existing || fingerprint(existing) !== fingerprint(event)) {
      changed = true;
      byId.set(event.id, event);
    } else {
      byId.set(event.id, existing);
    }
  }
  if (!changed) return previous;

  // The upstream message and part arrays are authoritative chronology. Several
  // parts in one assistant message share a timestamp, so sorting by id would
  // move edit milestones away from the prose and tools that surround them.
  return incoming.map((event) => byId.get(event.id) ?? event);
}

// ── Grouping ────────────────────────────────────────────────────────────────

export type DisplayItem =
  | { type: "event"; id: string; event: TranscriptEvent }
  | { type: "actionGroup"; id: string; calls: ToolEvent[] };

/**
 * Only finished, successful calls collapse. Errors and in-flight calls stay
 * visible — nothing important should hide behind a chevron.
 */
function isCollapsible(event: TranscriptEvent): event is ToolEvent {
  // A delegation stays visible even when it succeeded: it is the only route
  // from a parent transcript to the child that did the work, and folding it
  // into "3 actions completed" makes that work unreachable from here.
  return event.kind === "tool" && event.status === "completed" && event.name !== "task" && !event.childSessionId;
}

/**
 * Fold consecutive successful tool calls into one "N actions completed" row.
 *
 * The group id is keyed on the FIRST call, which never changes as the run
 * grows across polls — that is what keeps a user's expand/collapse choice
 * stable while the agent is still working.
 */
export function collapseActionGroups(
  events: TranscriptEvent[],
  minGroupSize = 2,
): DisplayItem[] {
  const out: DisplayItem[] = [];
  let run: ToolEvent[] = [];

  const flush = (): void => {
    if (run.length >= minGroupSize) {
      out.push({ type: "actionGroup", id: `group-${run[0].id}`, calls: run });
    } else {
      out.push(...run.map((event) => ({ type: "event" as const, id: event.id, event })));
    }
    run = [];
  };

  for (const event of events) {
    if (isCollapsible(event)) {
      run.push(event);
      continue;
    }
    flush();
    out.push({ type: "event", id: event.id, event });
  }
  flush();
  return out;
}

// ── Running activity ────────────────────────────────────────────────────────

export type RunningActivity =
  | { kind: "tool"; name: string; detail: string; since: string | null }
  | { kind: "thinking"; since: string | null };

/**
 * What the agent appears to be doing right now.
 *
 * An unfinished call deeper in history is stale, not running — hence the
 * `break` rather than a full scan.
 */
export function runningActivity(events: TranscriptEvent[]): RunningActivity {
  let latest: string | null = null;
  for (const event of events) {
    if (!latest || event.timestamp > latest) latest = event.timestamp;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "status" || event.kind === "patch") continue; // milestones are not activity
    if (event.kind === "tool" && (event.status === "running" || event.status === "pending")) {
      return {
        kind: "tool",
        name: event.name,
        detail: event.detail ?? event.title ?? "",
        since: event.timestamp,
      };
    }
    break;
  }
  return { kind: "thinking", since: latest };
}

// ── Command audit ───────────────────────────────────────────────────────────

export type CommandCategory = "command" | "edit" | "read" | "other";

export interface CommandEntry {
  /** Equals the transcript row's data-event-id, so jump-to-event works. */
  id: string;
  category: CommandCategory;
  activityKind: "tool" | "change" | "failure";
  name: string;
  text: string;
  timestamp: string;
  status: "ok" | "error" | "pending";
  outputPreview?: string;
  /** Present only when a shell command was captured exactly enough to replay. */
  commandText?: string;
  /** Present only for applied patch events. */
  fileCount?: number;
  fileSummary?: string;
}

export function serializeCommands(commands: CommandEntry[]): string {
  return ["#!/usr/bin/env bash", "set -euo pipefail", "", ...commands
    .filter((command) => command.category === "command" && command.commandText)
    .flatMap((command) => [`# ${command.status} at ${command.timestamp}`, command.commandText!, ""])].join("\n");
}

// Narrow on purpose: a loose /file/ would swallow unrelated tools. Anything
// unmatched falls through to "other" and is still listed, so a miss only
// affects filtering, never visibility.
const COMMAND_TOOLS = /^(bash|shell)$|terminal/i;
const EDIT_TOOLS = /^(edit|write|patch|apply_patch)$|str_replace/i;
const READ_TOOLS = /^(read|grep|glob|list|webfetch|websearch)$/i;
function categorize(name: string): CommandCategory {
  if (COMMAND_TOOLS.test(name)) return "command";
  if (EDIT_TOOLS.test(name)) return "edit";
  if (READ_TOOLS.test(name)) return "read";
  return "other";
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/**
 * The audit trail, derived from the same events the transcript renders — so
 * the two views can never disagree about what the agent did.
 */
export function extractCommands(events: TranscriptEvent[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const event of events) {
    if (event.kind === "tool") {
      const category = categorize(event.name);
      out.push({
        id: event.id,
        category,
        activityKind: "tool",
        name: event.name,
        text: event.detail ?? event.title ?? event.name,
        timestamp: event.timestamp,
        status:
          event.status === "completed" ? "ok" : event.status === "error" ? "error" : "pending",
        ...(event.output || event.error
          ? { outputPreview: firstLine(event.output ?? event.error ?? "").slice(0, 120) }
          : {}),
        ...(category === "command" && event.commandText ? { commandText: event.commandText } : {}),
      });
      continue;
    }

    if (event.kind === "patch") {
      const fileSummary = event.files.length
        ? `${event.files.join(", ")}${event.filesTruncated ? ", …" : ""}`
        : undefined;
      out.push({
        id: event.id,
        category: "edit",
        activityKind: "change",
        name: "patch",
        text: fileSummary ?? `Changed ${event.fileCount} ${event.fileCount === 1 ? "file" : "files"}`,
        timestamp: event.timestamp,
        status: "ok",
        fileCount: event.fileCount,
        ...(fileSummary ? { fileSummary } : {}),
      });
      continue;
    }

    if (event.kind === "error") {
      out.push({
        id: event.id,
        category: "other",
        activityKind: "failure",
        name: "error",
        text: event.message,
        timestamp: event.timestamp,
        status: "error",
      });
    }
  }
  return out;
}

// ── Merge-request detection ─────────────────────────────────────────────────

// Bounded deliberately: matches end at the iid, so query strings, fragments,
// tab segments (/diffs, /files) and trailing punctuation are never captured.
// ')' and ']' are excluded so markdown-wrapped links terminate correctly.
const MR_URL_RE =
  /https?:\/\/[^\s)\]>"']+\/-\/merge_requests\/\d+|https?:\/\/github\.com\/[^\s)\]>"'/]+\/[^\s)\]>"'/]+\/pull\/\d+/g;

function scanText(text: string | undefined, seen: Set<string>, out: string[]): void {
  if (!text) return;
  for (const match of text.matchAll(MR_URL_RE)) {
    const url = match[0].replace(/\/+$/, "");
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
}

/** Every free-text field of an event that may carry a hyperlink. Patches are skipped on purpose. */
function eventTexts(event: TranscriptEvent): Array<string | undefined> {
  switch (event.kind) {
    case "user":
    case "agent":
    case "thought":
      return [event.text];
    case "tool":
      return [event.detail, event.title, event.output, event.error];
    case "status":
      return [event.label, event.detail];
    case "error":
      return [event.message];
    default:
      return [];
  }
}

/** Merge-request / pull-request URLs the agent mentioned, in first-seen order. */
export function extractMrUrls(events: TranscriptEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) for (const text of eventTexts(event)) scanText(text, seen, out);
  return out;
}

// ── Session link index ──────────────────────────────────────────────────────

// Same terminator set as MR_URL_RE so markdown-wrapped links end cleanly. '<'
// is excluded so an HTML-ish transcript fragment cannot swallow the tag.
const LINK_URL_RE = /https?:\/\/[^\s)\]>"'<]+/g;
const GITHUB_ISSUE_PATH_RE = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;
// Anchored at the start but open at the end, so a review URL carrying a tab
// segment or query string still collapses to the same bounded identity that
// extractMrUrls produces.
const REVIEW_URL_PREFIX_RE =
  /^https?:\/\/[^\s)\]>"']+\/-\/merge_requests\/\d+|^https?:\/\/github\.com\/[^\s)\]>"'/]+\/[^\s)\]>"'/]+\/pull\/\d+/;
const NOTION_HOST_RE = /(^|\.)notion\.so$|(^|\.)notion\.site$|(^|\.)notion\.com$/;

export type SessionLinkKind = "review" | "issue" | "notion" | "other";

export interface SessionLink {
  url: string;
  kind: SessionLinkKind;
  host: string;
  label: string;
  /** Present only for GitHub issues. */
  issue?: { owner: string; repo: string; number: number };
}

export interface SessionLinkIndex {
  /** Review URLs, kept as plain strings so ReviewCard keeps its existing contract. */
  reviews: string[];
  issues: SessionLink[];
  notion: SessionLink[];
  /** Remaining hosts, alphabetical; links inside a host stay in first-seen order. */
  other: Array<{ host: string; links: SessionLink[] }>;
  /** Unique canonical links across every group. */
  total: number;
}

/**
 * Trailing sentence punctuation and slashes are dropped, the fragment is
 * discarded so two anchors into one document dedupe together, and anything
 * that is not HTTP(S) is rejected outright rather than rendered as a link.
 */
function canonicalLink(raw: string): URL | null {
  const trimmed = raw.replace(/[.,;:!?'"]+$/, "").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  return parsed;
}

function canonicalHref(parsed: URL): string {
  return parsed.toString().replace(/\/$/, "");
}

function notionLabel(parsed: URL): string {
  const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  const name = slug.replace(/-?[0-9a-f]{32}$/i, "").replace(/[-_]+/g, " ").trim();
  return name || parsed.hostname;
}

function genericLabel(parsed: URL): string {
  const path = parsed.pathname.replace(/\/+$/, "");
  return path && path !== "/" ? `${parsed.hostname}${path}${parsed.search}` : parsed.hostname;
}

function classify(parsed: URL, href: string): SessionLink {
  const host = parsed.hostname;
  const issue = host === "github.com" ? GITHUB_ISSUE_PATH_RE.exec(parsed.pathname) : null;
  if (issue) {
    return {
      url: href,
      kind: "issue",
      host,
      label: `${issue[1]}/${issue[2]}#${issue[3]}`,
      issue: { owner: issue[1], repo: issue[2], number: Number(issue[3]) },
    };
  }
  if (NOTION_HOST_RE.test(host)) return { url: href, kind: "notion", host, label: notionLabel(parsed) };
  return { url: href, kind: "other", host, label: genericLabel(parsed) };
}

/**
 * Every safe hyperlink in the transcript, deduplicated by canonical URL and
 * grouped for the Reviews panel. Recognized groups come first; remaining hosts
 * are alphabetical so the panel does not reshuffle as a session grows.
 */
export function extractSessionLinks(events: TranscriptEvent[]): SessionLinkIndex {
  const seen = new Set<string>();
  const reviews: string[] = [];
  const issues: SessionLink[] = [];
  const notion: SessionLink[] = [];
  const others: SessionLink[] = [];

  for (const event of events) {
    for (const text of eventTexts(event)) {
      if (!text) continue;
      for (const match of text.matchAll(LINK_URL_RE)) {
        const review = REVIEW_URL_PREFIX_RE.exec(match[0]);
        if (review) {
          const href = review[0].replace(/\/+$/, "");
          if (seen.has(href)) continue;
          seen.add(href);
          reviews.push(href);
          continue;
        }
        const parsed = canonicalLink(match[0]);
        if (!parsed) continue;
        const href = canonicalHref(parsed);
        if (seen.has(href)) continue;
        seen.add(href);
        const link = classify(parsed, href);
        if (link.kind === "issue") issues.push(link);
        else if (link.kind === "notion") notion.push(link);
        else others.push(link);
      }
    }
  }

  const byHost = new Map<string, SessionLink[]>();
  for (const link of others) {
    const bucket = byHost.get(link.host);
    if (bucket) bucket.push(link);
    else byHost.set(link.host, [link]);
  }

  return {
    reviews,
    issues,
    notion,
    other: [...byHost.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, links]) => ({ host, links })),
    total: seen.size,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** "3.2s" under a minute, "2m 05s" above it. */
export function formatDurationMs(ms: number | undefined): string | null {
  if (typeof ms !== "number" || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** Relative label for a timestamp, e.g. "just now", "4m ago". */
export function formatRelative(timestamp: string, now = Date.now()): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatClockTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
