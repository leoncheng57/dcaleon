import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { GitBranch, GitMerge, ListChecks, OctagonX, RefreshCw, Send, Sparkles, Trash2, X } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { RunningIndicator, Transcript } from "../components/transcript.js";
import { api, type ClaudeChanges, type ClaudeSessionSummary } from "../lib/api.js";
import { collapseActionGroups } from "../lib/derive.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";
import type { TranscriptEvent } from "../lib/transcript.js";

const POLL_MS = 3_000;
const INITIAL_DIFF_LINES = 400;
const DIFF_LINE_STEP = 400;

function DiffLine({ line }: { line: string }) {
  const className = line.startsWith("+") && !line.startsWith("+++")
    ? "text-[var(--color-text-success)]"
    : line.startsWith("-") && !line.startsWith("---")
      ? "text-[var(--color-text-danger)]"
      : line.startsWith("@@") || line.startsWith("diff --git")
        ? "text-[var(--color-text-info)]"
        : undefined;
  return <span className={cn("block min-w-max", className)}>{line || " "}</span>;
}

/**
 * What this session changed. Direct sessions show the project's working-tree
 * diff; worktree sessions show everything since the branch's base commit, and
 * offer Merge / Discard. Fetched on open and on demand — the diff is read from
 * git each time, never cached, so it always reflects disk.
 */
function ChangesDrawer({ session, onClose, onMutated }: { session: ClaudeSessionSummary; onClose: () => void; onMutated: () => void }) {
  const [changes, setChanges] = useState<ClaudeChanges | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"merge" | "discard" | null>(null);
  const [visible, setVisible] = useState(INITIAL_DIFF_LINES);
  const isWorktree = session.isolation === "worktree";

  const load = useCallback(async () => {
    try {
      setChanges(await api.claudeChanges(session.id));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [session.id]);
  useEffect(() => { void load(); }, [load]);

  const lines = useMemo(() => (changes?.diff ? changes.diff.split("\n") : []), [changes?.diff]);
  const shown = Math.min(visible, lines.length);

  const merge = async () => {
    if (!window.confirm(`Merge ${session.branch ?? "this session's branch"} into the project? The worktree is removed afterwards.`)) return;
    setBusy("merge");
    try {
      await api.mergeClaude(session.id);
      onMutated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    if (!window.confirm("Discard this session's worktree and branch? Its changes are lost unless you merged them.")) return;
    setBusy("discard");
    try {
      await api.discardClaude(session.id);
      onMutated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[46rem]" role="dialog" aria-modal="true" aria-label="Session changes" data-testid="claude-changes">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] p-2">
        <ListChecks aria-hidden="true" size={16} />
        <strong className="text-sm">Changes</strong>
        {session.branch && <Badge variant="neutral"><GitBranch aria-hidden="true" size={12} className="mr-1 inline" />{session.branch}</Badge>}
        <Badge variant="neutral">{isWorktree ? "vs. base commit" : "working tree vs. HEAD"}</Badge>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => void load()} data-testid="claude-changes-refresh"><RefreshCw aria-hidden="true" size={14} className="mr-1" /> Refresh</Button>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="claude-changes-close"><X aria-hidden="true" size={15} /> Close</Button>
        </div>
      </header>
      {error && <div className="p-3"><Alert variant="danger">{error}</Alert></div>}
      {changes?.gone && <div className="p-3"><Alert variant="warning">This session's worktree has been removed (merged or discarded). Nothing left to show.</Alert></div>}
      {changes && !changes.gone && (
        <>
          <div className="border-b border-[var(--color-border-default)] p-3 text-sm" data-testid="claude-changes-files">
            {changes.files.length === 0
              ? <p className="text-[var(--color-text-muted)]">No changes yet.</p>
              : <ul className="grid gap-1 font-mono text-xs">{changes.files.map((file) => <li key={file.path} className="flex gap-2"><span className="w-6 shrink-0 text-[var(--color-text-muted)]">{file.status}</span><span className="min-w-0 truncate">{file.path}</span></li>)}</ul>}
          </div>
          <pre className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-[var(--color-background-surface)] p-3 font-mono text-[11px] leading-5" data-testid="claude-changes-diff">
            <code>{lines.slice(0, shown).map((line, index) => <DiffLine key={index} line={line} />)}</code>
          </pre>
          {(lines.length > shown || changes.truncated) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-default)] p-2.5 text-[11px] text-[var(--color-text-muted)]">
              {lines.length > shown && <Button size="sm" variant="secondary" onClick={() => setVisible((value) => value + DIFF_LINE_STEP)} data-testid="claude-changes-more">Load {Math.min(DIFF_LINE_STEP, lines.length - shown).toLocaleString()} more lines</Button>}
              {changes.truncated && <span>Diff truncated by the server; review the rest with git.</span>}
            </div>
          )}
        </>
      )}
      {isWorktree && !changes?.gone && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-default)] p-3">
          <Button size="sm" disabled={busy !== null || session.running || !changes || changes.files.length === 0} onClick={() => void merge()} data-testid="claude-merge">
            <GitMerge aria-hidden="true" size={14} className="mr-1" /> {busy === "merge" ? "Merging..." : "Merge into project"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void discard()} data-testid="claude-discard">
            <Trash2 aria-hidden="true" size={14} className="mr-1" /> {busy === "discard" ? "Discarding..." : "Discard worktree"}
          </Button>
          <span className="text-xs text-[var(--color-text-muted)]">Merge refuses if the project has uncommitted changes of your own.</span>
        </footer>
      )}
    </section>
  );
}

export function ClaudeConversationPage() {
  const { id = "" } = useParams();
  const [session, setSession] = useState<ClaudeSessionSummary | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
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
  // A merged/discarded worktree session is finished: its cwd is gone.
  const worktreeClosed = session?.isolation === "worktree" && events.some((event) => event.kind === "status" && (event.label === "Merged into project" || event.label === "Worktree discarded"));

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || session?.running || worktreeClosed) return;
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
        {session?.workspaceLabel && <Badge variant="neutral">{session.workspaceLabel}</Badge>}
        {session?.branch && <Badge variant="neutral" data-testid="claude-branch"><GitBranch aria-hidden="true" size={12} className="mr-1 inline" />{session.branch}</Badge>}
        <div className="ml-auto flex gap-1">
          {session?.mode === "build" && (
            <Button size="sm" variant="secondary" onClick={() => setChangesOpen(true)} disabled={worktreeClosed} data-testid="claude-open-changes"><ListChecks aria-hidden="true" className="mr-1" size={14} /> Changes</Button>
          )}
        </div>
      </header>
      {error && <div className="shrink-0 p-3"><Alert variant="danger">{error}</Alert></div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8" data-testid="claude-transcript">
        <div className="mx-auto max-w-4xl">
          {events.length === 0 && !error && <div className="py-20 text-center"><Sparkles aria-hidden="true" className="mx-auto mb-3 text-[var(--color-text-muted)]" /><p className="text-sm text-[var(--color-text-muted)]">{session?.mode === "build" ? "Ask Claude to make a change. It runs without pausing to ask; review the result under Changes." : "Ask Claude to inspect this allowlisted workspace. A read-only preset cannot modify files."}</p></div>}
          <Transcript items={items} wrap collapsedGroups={{}} onToggleGroup={() => undefined} />
          {session?.running && <div className="mt-5"><RunningIndicator activity={{ kind: "thinking", since: session.updatedAt }} /></div>}
          <div ref={bottom} />
        </div>
      </div>
      <form className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(event) => { event.preventDefault(); void send(); }} data-testid="claude-composer">
        <div className="mx-auto flex max-w-4xl items-end gap-2">
          <textarea className="min-h-11 max-h-40 flex-1 resize-y rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-base)] px-3 py-2 text-sm" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder={worktreeClosed ? "This worktree session is finished." : "Ask Claude..."} disabled={!session || session.running || worktreeClosed} data-testid="claude-prompt" />
          {session?.running ? <Button type="button" variant="danger" onClick={() => void cancel()} data-testid="claude-cancel"><OctagonX aria-hidden="true" size={15} className="mr-1" /> Stop</Button> : <Button type="submit" disabled={!draft.trim() || sending || !session || worktreeClosed} data-testid="claude-send"><Send aria-hidden="true" size={15} className="mr-1" /> Send</Button>}
        </div>
      </form>
      {changesOpen && session && <ChangesDrawer session={session} onClose={() => setChangesOpen(false)} onMutated={() => void refresh()} />}
    </main>
  );
}
