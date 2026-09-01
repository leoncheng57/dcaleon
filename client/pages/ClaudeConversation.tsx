import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Sparkles, OctagonX, Send } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { RunningIndicator, Transcript } from "../components/transcript.js";
import { api, type ClaudeSessionSummary } from "../lib/api.js";
import { collapseActionGroups } from "../lib/derive.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";
import type { TranscriptEvent } from "../lib/transcript.js";

const POLL_MS = 3_000;

export function ClaudeConversationPage() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<ClaudeSessionSummary | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef<string | null>(null);
  const sessionScope = useRef(id);

  const load = async (targetId: string) => {
    if (refreshInFlight.current) {
      refreshQueued.current = targetId;
      return;
    }
    refreshInFlight.current = true;
    try {
      const result = await api.claudeSession(targetId);
      if (sessionScope.current !== targetId) return;
      setSession(result.session);
      setEvents(result.events);
      setSending(false);
      setError("");
    } catch (cause) {
      if (sessionScope.current !== targetId) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      refreshInFlight.current = false;
      const queued = refreshQueued.current;
      refreshQueued.current = null;
      if (queued) void load(queued);
    }
  };
  const refresh = () => load(id);

  useEffect(() => {
    sessionScope.current = id;
    refreshQueued.current = null;
    setSession(null);
    setEvents([]);
    void refresh();
    if (PUBLIC_SIMULATOR) return;
    // Durable truth is the poll; the stream is only a "something changed" nudge.
    // Unlike the DSH page this keeps the interval, so a dropped SSE cannot leave
    // the transcript stale — it degrades to poll latency instead.
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, POLL_MS);
    const source = new EventSource(api.claudeEventsUrl(id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("update", () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 250);
    });
    source.addEventListener("ready", () => void refresh());
    source.onerror = () => undefined; // EventSource owns bounded reconnect; the poll remains authoritative.
    return () => {
      clearInterval(poll);
      clearTimeout(timer);
      source.close();
    };
  }, [id]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [events, session?.running]);
  const items = useMemo(() => collapseActionGroups(events), [events]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || session?.running) return;
    setSending(true);
    setDraft("");
    setError("");
    try {
      await api.promptClaude(id, text);
      await refresh();
    } catch (cause) {
      setDraft(text);
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const cancel = async () => {
    try {
      await api.cancelClaude(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-background-base)]" data-testid="claude-conversation">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
        <Link to="/claude" className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]" data-testid="claude-back">Claude lab</Link>
        <span aria-hidden="true">/</span>
        <strong className="min-w-0 truncate text-sm">{session?.title ?? "Conversation"}</strong>
        <Badge variant="neutral">{session?.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>
        <Badge variant="neutral">{session?.presetId ?? "Loading"}</Badge>
      </header>
      {error && <div className="shrink-0 p-3"><Alert variant="danger">{error}</Alert></div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8" data-testid="claude-transcript">
        <div className="mx-auto max-w-4xl">
          {events.length === 0 && !error && <div className="py-20 text-center"><Sparkles aria-hidden="true" className="mx-auto mb-3 text-[var(--color-text-muted)]" /><p className="text-sm text-[var(--color-text-muted)]">Ask Claude to inspect this allowlisted workspace. A read-only preset cannot modify files.</p></div>}
          <Transcript items={items} wrap collapsedGroups={{}} onToggleGroup={() => undefined} />
          {session?.running && <div className="mt-5"><RunningIndicator activity={{ kind: "thinking", since: session.updatedAt }} /></div>}
          <div ref={bottom} />
        </div>
      </div>
      <form className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(event) => { event.preventDefault(); void send(); }} data-testid="claude-composer">
        <div className="mx-auto flex max-w-4xl items-end gap-2">
          <textarea className="min-h-11 max-h-40 flex-1 resize-y rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3 py-2 text-sm" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="Ask Claude to inspect the workspace..." disabled={!session || session.running} data-testid="claude-prompt" />
          {session?.running ? <Button type="button" variant="danger" onClick={() => void cancel()} data-testid="claude-cancel"><OctagonX aria-hidden="true" size={15} className="mr-1" /> Stop</Button> : <Button type="submit" disabled={!draft.trim() || sending || !session} data-testid="claude-send"><Send aria-hidden="true" size={15} className="mr-1" /> Send</Button>}
        </div>
      </form>
    </main>
  );
}
