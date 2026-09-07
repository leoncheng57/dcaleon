import { randomUUID } from "node:crypto";
import type { ClaudeTranscriptEvent } from "./store.js";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_PAGE_BYTES = 128 * 1024;
const FIELD_LIMIT = 8_000;

/** Limit oversized CLI output in the reading view; explicit export keeps the original. */
function preview(event: ClaudeTranscriptEvent): ClaudeTranscriptEvent {
  let limit = FIELD_LIMIT;
  let serialized: string;
  do {
    serialized = JSON.stringify(event, (_key, value: unknown) =>
      typeof value === "string" && value.length > limit
        ? `${value.slice(0, limit)}\n[Preview shortened; download the transcript for the complete text.]`
        : Array.isArray(value) ? value.slice(0, 50) : value);
    limit = Math.floor(limit / 2);
  } while (Buffer.byteLength(serialized) > TRANSCRIPT_PAGE_BYTES / 4 && limit >= 32);
  return JSON.parse(serialized);
}

type Entry = { original: ClaudeTranscriptEvent; event: ClaudeTranscriptEvent; revision: number; bytes: number };
type Cursor = { epoch: string; kind: "sync" | "page"; value: number | string };
export type ClaudeActionCategory = "edit" | "command" | "read" | "failure" | "other";
export function matchesClaudeAction(event: ClaudeTranscriptEvent, category?: ClaudeActionCategory): boolean {
  if (!["tool", "patch", "error"].includes(event.kind)) return false;
  if (!category) return true;
  if (category === "failure") return event.kind === "error" || (event.kind === "tool" && event.status === "error");
  if (event.kind === "patch") return category === "edit";
  if (event.kind !== "tool") return category === "other";
  const selected = /^(bash|shell)$|terminal/i.test(event.name) ? "command"
    : /^(edit|write|patch|apply_patch)$|str_replace/i.test(event.name) ? "edit"
      : /^(read|grep|glob|list|webfetch|websearch)$/i.test(event.name) ? "read" : "other";
  return selected === category;
}
export class TranscriptCursorError extends Error {}

/** Session-local index. Event objects must be replaced when updated, never mutated. */
export class ClaudeTranscriptIndex {
  private epoch = randomUUID();
  private revision = 0;
  private entries: Entry[] = [];
  private byId = new Map<string, Entry>();

  sync(events: ClaudeTranscriptEvent[]): void {
    // Retention/replacement invalidates positional reads and incremental cursors.
    if (this.entries.some((entry, i) => events[i]?.id !== entry.event.id)) {
      this.epoch = randomUUID();
      this.byId.clear();
    }
    this.entries = events.map((original) => {
      const previous = this.byId.get(original.id);
      if (previous?.original === original) return previous;
      const event = preview(original);
      const entry = { original, event, revision: ++this.revision, bytes: Buffer.byteLength(JSON.stringify(event)) };
      this.byId.set(original.id, entry);
      return entry;
    });
  }

  private cursor(kind: Cursor["kind"], value: Cursor["value"]): string {
    return Buffer.from(JSON.stringify({ epoch: this.epoch, kind, value })).toString("base64url");
  }

  private decode(raw: string, kind: Cursor["kind"]): Cursor | null {
    if (raw.length > 512 || !/^[\w-]+$/.test(raw)) throw new TranscriptCursorError("Invalid transcript cursor");
    let cursor: Cursor;
    try { cursor = JSON.parse(Buffer.from(raw, "base64url").toString()); }
    catch { throw new TranscriptCursorError("Invalid transcript cursor"); }
    if (!cursor || cursor.kind !== kind || typeof cursor.epoch !== "string" ||
      (kind === "sync" ? !Number.isSafeInteger(cursor.value) || Number(cursor.value) < 0 : typeof cursor.value !== "string")) {
      throw new TranscriptCursorError("Invalid transcript cursor");
    }
    return cursor.epoch === this.epoch ? cursor : null;
  }

  read(query: { before?: string; after?: string; since?: string; q?: string; actions?: boolean; category?: ClaudeActionCategory } = {}) {
    let reset = false;
    let delta = false;
    let candidates = this.entries;
    if (query.q) {
      const needle = query.q.toLowerCase();
      // Search the ORIGINAL strings, including beyond the displayed preview.
      candidates = candidates.filter((entry) => JSON.stringify(entry.original).toLowerCase().includes(needle));
    }
    if (query.actions) candidates = candidates.filter(({ event }) => matchesClaudeAction(event, query.category));
    const source = candidates;
    const total = candidates.length;
    if (query.since) {
      const cursor = this.decode(query.since, "sync");
      if (!cursor || Number(cursor.value) > this.revision) reset = true;
      else {
        const changes = candidates.filter((entry) => entry.revision > Number(cursor.value));
        if (changes.length > TRANSCRIPT_PAGE_SIZE || changes.reduce((sum, entry) => sum + entry.bytes, 0) > TRANSCRIPT_PAGE_BYTES) reset = true;
        else { candidates = changes; delta = true; }
      }
    }
    const pageCursor = query.before ?? query.after;
    if (pageCursor) {
      const cursor = this.decode(pageCursor, "page");
      const at = cursor ? candidates.findIndex((entry) => entry.event.id === cursor.value) : -1;
      if (at < 0) reset = true;
      else if (query.before) candidates = candidates.slice(0, at);
      else candidates = candidates.slice(at + 1);
    }
    const fromStart = !!query.after && !reset;
    const selected: Entry[] = [];
    let bytes = 0;
    const ordered = fromStart || delta ? candidates : [...candidates].reverse();
    for (const entry of ordered) {
      if (selected.length >= TRANSCRIPT_PAGE_SIZE || (selected.length > 0 && bytes + entry.bytes > TRANSCRIPT_PAGE_BYTES)) break;
      selected.push(entry); bytes += entry.bytes;
    }
    if (!fromStart && !delta) selected.reverse();
    const first = selected[0];
    const last = selected.at(-1);
    return {
      events: selected.map((entry) => entry.event),
      page: {
        total, limit: TRANSCRIPT_PAGE_SIZE, delta, reset,
        cursor: this.cursor("sync", this.revision),
        before: first && source[0] !== first ? this.cursor("page", first.event.id) : null,
        after: last && source.at(-1) !== last ? this.cursor("page", last.event.id) : null,
        // Boundary cursors permit navigation after a client evicts a page.
        first: first ? this.cursor("page", first.event.id) : null,
        last: last ? this.cursor("page", last.event.id) : null,
        boundaries: Object.fromEntries(selected.map((entry) => [entry.event.id, this.cursor("page", entry.event.id)])),
        order: Object.fromEntries(selected.map((entry) => [entry.event.id, this.entries.indexOf(entry)])),
      },
    };
  }
}
