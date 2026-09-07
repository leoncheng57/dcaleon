import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ClaudeSessionSummary, type ClaudeTranscriptResponse } from "./api.js";
import { mergeEvents } from "./derive.js";
import { PUBLIC_SIMULATOR } from "./runtime.js";
import type { TranscriptEvent } from "./transcript.js";

export const CLAUDE_RESIDENT_LIMIT = 150;
export const CLAUDE_RESIDENT_BYTES = 384 * 1024;
const EMPTY: TranscriptEvent[] = [];
const eventBytes = new WeakMap<TranscriptEvent, number>();
function sizeOf(event: TranscriptEvent): number {
  const cached = eventBytes.get(event);
  if (cached !== undefined) return cached;
  const size = new TextEncoder().encode(JSON.stringify(event)).length;
  eventBytes.set(event, size);
  return size;
}
type State = {
  session: ClaudeSessionSummary | null; events: TranscriptEvent[]; cursor?: string;
  boundaries: Record<string, string>; before: string | null; after: string | null;
  order: Record<string, number>;
  total: number; pinned: boolean;
  residentBytes: number;
};
export const initialClaudeTranscript = (): State => ({ session: null, events: EMPTY, boundaries: {}, order: {}, before: null, after: null, total: 0, pinned: false, residentBytes: 0 });
const initial = initialClaudeTranscript;

export function reconcileClaude(state: State, result: ClaudeTranscriptResponse, direction: "refresh" | "before" | "after" | "latest"): State {
  const page = result.page;
  const delta = page?.delta && !page.reset && direction === "refresh";
  if (delta && result.events.length === 0 && page.cursor === state.cursor && page.total === state.total && JSON.stringify(state.session) === JSON.stringify(result.session)) return state;
  let events: TranscriptEvent[];
  let before = page?.before ?? null;
  let after = page?.after ?? null;
  let pinned = state.pinned;
  if (delta) {
    const updates = new Map(result.events.map((event) => [event.id, event]));
    const known = new Set(state.events.map((event) => event.id));
    const lastOrder = state.order[state.events.at(-1)?.id ?? ""] ?? -1;
    const additions = result.events.filter((event) => !known.has(event.id) && (page.order[event.id] ?? Infinity) > lastOrder);
    const merged = state.events.map((event) => updates.get(event.id) ?? event);
    events = mergeEvents(state.events, pinned ? merged : [...merged, ...additions]);
    before = state.before;
    after = pinned && additions.length ? state.boundaries[state.events.at(-1)?.id ?? ""] ?? state.after : state.after;
  } else if ((direction === "before" || direction === "after") && !page?.reset) {
    const combined = direction === "before" ? [...result.events, ...state.events] : [...state.events, ...result.events];
    events = [...new Map(combined.map((event) => [event.id, event])).values()];
    before = direction === "before" ? before : state.before;
    after = direction === "after" ? after : state.after;
    pinned = true;
  } else {
    events = mergeEvents(state.events, result.events.slice(-50));
    pinned = false;
  }
  const boundaries = { ...state.boundaries, ...page?.boundaries };
  const limit = pinned ? CLAUDE_RESIDENT_LIMIT : 50;
  if (events.length > limit) {
    if (direction === "before" || (pinned && delta)) {
      events = events.slice(0, limit);
      after = boundaries[events.at(-1)!.id];
    } else {
      events = events.slice(-limit);
      before = boundaries[events[0].id];
    }
  }
  // A page can stop early on its byte budget; do not accumulate arbitrarily many
  // of those smaller pages just because fewer than 150 events are resident.
  let bytes = events.reduce((sum, event) => sum + sizeOf(event), 0);
  while (bytes > CLAUDE_RESIDENT_BYTES && events.length > 1) {
    const keepStart = direction === "before" || (pinned && delta);
    const removed = keepStart ? events.at(-1)! : events[0];
    bytes -= sizeOf(removed);
    events = keepStart ? events.slice(0, -1) : events.slice(1);
    if (keepStart) after = boundaries[events.at(-1)!.id];
    else before = boundaries[events[0].id];
  }
  return {
    session: JSON.stringify(state.session) === JSON.stringify(result.session) ? state.session : result.session,
    events, cursor: (direction === "before" || direction === "after") && !page?.reset ? state.cursor : page?.cursor, before, after, pinned,
    boundaries: Object.fromEntries(events.map((event) => [event.id, boundaries[event.id]])),
    order: Object.fromEntries(events.map((event) => [event.id, page?.order[event.id] ?? state.order[event.id]])),
    total: page?.total ?? result.events.length,
    residentBytes: bytes,
  };
}

export function useClaudeTranscript(id: string) {
  const [state, setState] = useState<State>(initial);
  const [error, setError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const current = useRef(state);
  const scope = useRef(id);
  const request = useRef<AbortController | null>(null);
  const queued = useRef(false);
  const lastRefresh = useRef(0);
  const diagnostics = useRef({ payloadBytes: 0, reconcileMs: 0, requests: 0 });

  const load = useCallback(async (direction: "refresh" | "before" | "after" | "latest" = "refresh") => {
    if (!PUBLIC_SIMULATOR && document.hidden) return;
    if (request.current) {
      if (direction === "refresh") { queued.current = true; return; }
      request.current.abort();
    }
    const controller = new AbortController();
    request.current = controller;
    const previous = current.current;
    const query = direction === "refresh" && previous.cursor ? { since: previous.cursor }
      : direction === "before" && previous.before ? { before: previous.before }
      : direction === "after" && previous.after ? { after: previous.after } : {};
    setLoadingHistory(direction === "before" || direction === "after");
    try {
      const result = await api.claudeSession(id, query, controller.signal);
      if (controller.signal.aborted || scope.current !== id || (!PUBLIC_SIMULATOR && document.hidden)) return;
      const started = performance.now();
      const next = reconcileClaude(current.current, result, direction);
      diagnostics.current = { payloadBytes: new TextEncoder().encode(JSON.stringify(result)).length, reconcileMs: performance.now() - started, requests: diagnostics.current.requests + 1 };
      current.current = next;
      setState(next);
      setError("");
      lastRefresh.current = Date.now();
    } catch (cause) {
      if (!controller.signal.aborted && scope.current === id) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoadingHistory(false);
        if (queued.current) { queued.current = false; void load(); }
      }
    }
  }, [id]);

  useEffect(() => {
    scope.current = id;
    current.current = initial();
    setState(current.current);
    setError("");
    queued.current = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const suspend = () => {
      source?.close(); source = undefined;
      clearTimeout(timer); clearInterval(poll);
      request.current?.abort(); request.current = null;
      queued.current = false;
    };
    const resume = () => {
      if (document.hidden && !PUBLIC_SIMULATOR) return;
      void load();
      if (PUBLIC_SIMULATOR) return;
      source = new EventSource(api.claudeEventsUrl(id));
      let ready = false;
      source.addEventListener("ready", () => {
        // First open accompanies the load above; reconnect needs bounded recovery.
        if (ready) void load("latest");
        ready = true;
      });
      source.addEventListener("update", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 250);
      });
      poll = setInterval(() => {
        if (Date.now() - lastRefresh.current >= (current.current.session?.running ? 3_000 : 30_000)) void load();
      }, 3_000);
    };
    const visibility = () => { suspend(); if (!document.hidden) resume(); };
    resume();
    document.addEventListener("visibilitychange", visibility);
    return () => { suspend(); document.removeEventListener("visibilitychange", visibility); };
  }, [id, load]);

  const pin = useCallback(() => {
    if (!current.current.pinned) { current.current = { ...current.current, pinned: true }; setState(current.current); }
  }, []);
  return { ...state, error, setError, refresh: load, loadingHistory, pin, diagnostics };
}
