import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, Download, Eye, FolderOpen, GitBranch, GitMerge, ListChecks, ListTree, OctagonX, RefreshCw, Send, Sparkles, Trash2, X } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { RunningIndicator, Transcript } from "../components/transcript.js";
import { AgentModeToggle } from "../components/agent-mode-toggle.js";
import { ModelPicker } from "../components/model-picker.js";
import { ClaudeFilesDrawer } from "../components/claude-files-drawer.js";
import { ClaudeRunLogDrawer } from "../components/claude-runlog-drawer.js";
import { ClaudeUsageIndicator } from "../components/claude-usage-indicator.js";
import { ClaudeWorkflowDialog } from "../components/claude-workflow-dialog.js";
import { ReminderPicker } from "../components/reminder-picker.js";
import { WorkflowPicker } from "../components/workflow-picker.js";
import { api, type ClaudeChanges, type ClaudePrStatus, type ClaudeSessionSummary, type ReminderSummary, type WorkflowSummary } from "../lib/api.js";
import type { ModelCatalogue, ModelSelection } from "../lib/models.js";
import {
  MANAGED_CHILD_WORKFLOW_ID,
  PLAYWRIGHT_REVIEW_WORKFLOW_ID,
  PR_SNIPPET_REVIEW_WORKFLOW_ID,
  SESSION_UPDATE_WORKFLOW_ID,
  START_DCA_SESSION_WORKFLOW_ID,
} from "../lib/workflows.js";
import { collapseActionGroups, runningActivity } from "../lib/derive.js";
import { serializeSessionJson, serializeShareMarkdown, shareFilename } from "../lib/sessionSharing.js";
import { referenceCandidatesFromEvents, type WorkspaceTarget } from "../lib/fileReferences.js";
import { WorkspaceReferenceProvider } from "../lib/workspaceReferences.js";
import { PUBLIC_SIMULATOR } from "../lib/runtime.js";
import type { AgentMode } from "../lib/agentMode.js";
import type { TranscriptEvent } from "../lib/transcript.js";

function claudeModelCatalogue(modelIds: string[]): ModelCatalogue {
  return {
    models: modelIds.map((id) => ({
      providerID: "anthropic",
      providerName: "Anthropic",
      modelID: id,
      name: id,
      status: "active",
      limits: {},
      capabilities: { image: false, reasoning: true },
      variants: [],
    })),
    defaultModel: modelIds[0] ? { providerID: "anthropic", modelID: modelIds[0] } : undefined,
  };
}

function downloadText(name: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

const POLL_MS = 3_000;
const INITIAL_DIFF_LINES = 400;
/**
 * Workflows whose submit path is an OpenCode route (another session, a managed
 * child, a new DCA session, the two review capture flows). They have no Claude
 * equivalent, so the Claude picker offers only the generic-argument workflows
 * whose whole contract is "typed text + trusted injector".
 */
const OPENCODE_ONLY_WORKFLOWS = new Set<string>([
  PLAYWRIGHT_REVIEW_WORKFLOW_ID,
  PR_SNIPPET_REVIEW_WORKFLOW_ID,
  SESSION_UPDATE_WORKFLOW_ID,
  MANAGED_CHILD_WORKFLOW_ID,
  START_DCA_SESSION_WORKFLOW_ID,
]);
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
  const [busy, setBusy] = useState<"merge" | "discard" | "pr" | null>(null);
  const [visible, setVisible] = useState(INITIAL_DIFF_LINES);
  const [pr, setPr] = useState<ClaudePrStatus | null>(null);
  const isWorktree = session.isolation === "worktree";

  const loadPr = useCallback(async () => {
    if (!session.prUrl) return;
    try { setPr((await api.claudePrStatus(session.id)).pr); } catch { /* status is best-effort */ }
  }, [session.id, session.prUrl]);
  useEffect(() => { void loadPr(); }, [loadPr]);

  const openPr = async () => {
    setBusy("pr");
    setError("");
    try {
      await api.openClaudePr(session.id);
      onMutated();
      await loadPr();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

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
      {isWorktree && !changes?.gone && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-default)] p-3" data-testid="claude-reviews">
          {session.prUrl || pr ? (
            <>
              <a className="text-sm font-medium text-[var(--color-text-info)] underline" href={pr?.url ?? session.prUrl} target="_blank" rel="noreferrer" data-testid="claude-pr-link">PR #{pr?.number ?? ""} {pr?.title ?? "open"}</a>
              {pr && <Badge variant="neutral" data-testid="claude-pr-pipeline">{pr.state}{pr.pipeline ? ` · ${pr.pipeline}` : ""}</Badge>}
              <Button size="sm" variant="ghost" onClick={() => void loadPr()} data-testid="claude-pr-refresh"><RefreshCw aria-hidden="true" size={14} className="mr-1" /> Refresh</Button>
              {pr?.checks?.length ? (
                <ul className="mt-1 w-full space-y-0.5 text-xs" data-testid="claude-pr-checks">
                  {pr.checks.slice(0, 20).map((check) => (
                    <li key={check.id} className="flex items-center gap-2"><span className="w-16 shrink-0 text-[var(--color-text-muted)]">{check.status}</span><a className="truncate underline" href={check.webUrl} target="_blank" rel="noreferrer">{check.name}</a></li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled={busy !== null || session.running || !changes || changes.files.length === 0} onClick={() => void openPr()} data-testid="claude-open-pr"><GitBranch aria-hidden="true" size={14} className="mr-1" /> {busy === "pr" ? "Opening PR..." : "Push & open PR"}</Button>
              <span className="text-xs text-[var(--color-text-muted)]">Pushes {session.branch} to origin and opens a GitHub PR. Needs a github.com origin and GITHUB_TOKEN.</span>
            </>
          )}
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
  const [filesOpen, setFilesOpen] = useState(false);
  const [runlogOpen, setRunlogOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [modelCatalogue, setModelCatalogue] = useState<ModelCatalogue | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | undefined>();
  const [planMode, setPlanMode] = useState(true);
  const [fileTarget, setFileTarget] = useState<WorkspaceTarget | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [resolved, setResolved] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [reminderCatalogue, setReminderCatalogue] = useState<ReminderSummary[]>([]);
  const [selectedReminder, setSelectedReminder] = useState("");
  const [workflowCatalogue, setWorkflowCatalogue] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowSummary | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const askedRefs = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const scrollInitialized = useRef(false);
  const [newActivity, setNewActivity] = useState(false);
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
    setFileTarget(null);
    setCollapsedGroups({});
    setResolved(new Map());
    askedRefs.current = new Set();
    setSelectedReminder("");
    setSelectedWorkflow("");
    setActiveWorkflow(null);
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

  // The configured models, so a turn can be sent on a different one without
  // changing the session's mode/permission (fixed at creation).
  useEffect(() => {
    void api.claudeConfig().then((config) => {
      const catalogue = claudeModelCatalogue(config.models);
      setModelCatalogue(catalogue);
      setSelectedModel(catalogue.defaultModel);
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (session?.mode === "build") setPlanMode(false);
  }, [session?.mode]);

  // Playbooks. Reminders are scoped by the session's cwd server-side (a
  // repository-scoped reminder only appears when this session's origin
  // matches), so they reload per session; a failed fetch drops the catalogue
  // rather than leaving another session's scoped entries on screen. Workflows
  // are global, minus the ones that only make sense against an OpenCode session.
  useEffect(() => {
    let cancelled = false;
    void api.claudeReminders(id).then((result) => { if (!cancelled) setReminderCatalogue(result.reminders); })
      .catch(() => { if (!cancelled) setReminderCatalogue([]); });
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    void api.workflows().then((result) => {
      if (!cancelled) setWorkflowCatalogue(result.workflows.filter((workflow) => !OPENCODE_ONLY_WORKFLOWS.has(workflow.id)));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (!scrollInitialized.current || following.current) {
      scroller.scrollTop = scroller.scrollHeight;
      scrollInitialized.current = true;
      setNewActivity(false);
    } else {
      setNewActivity(true);
    }
  }, [events]);

  const updateFollow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 96;
    following.current = nearBottom;
    if (nearBottom) setNewActivity(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current = true;
    setNewActivity(false);
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  const items = useMemo(() => collapseActionGroups(events), [events]);
  const activity = useMemo(() => runningActivity(events), [events]);

  // File references: collect paths the transcript mentions and validate them
  // server-side so an inline `path:line` span becomes a button. The resolved
  // map is built locally (the opencode /workspace/references route is
  // directory-scoped and rejects the Claude worktree root), one bounded batch
  // per new candidate — a failing path is remembered, not retried each poll.
  // Stabilise by content: events is a fresh array on every poll, so a plain
  // memo over `events` would hand the effect a new candidate array each tick,
  // re-run it, and abort the in-flight validation before it settles. Keying on
  // the joined content keeps identity stable until the candidates truly change.
  const candidateKey = useMemo(() => referenceCandidatesFromEvents(events, "").join("\n"), [events]);
  const candidates = useMemo(() => (candidateKey ? candidateKey.split("\n") : []), [candidateKey]);
  useEffect(() => {
    let cancelled = false;
    const pending = candidates.filter((path) => !askedRefs.current.has(path));
    if (pending.length === 0) return;
    for (const path of pending) askedRefs.current.add(path);
    // Not aborted on re-run: a completed validation is worth keeping even if a
    // later batch supersedes it. `cancelled` only blocks a stale setState.
    void api.claudeReferences(id, pending).then((result) => {
      if (cancelled) return;
      setResolved((previous) => {
        const next = new Map(previous);
        for (const reference of result.references) {
          if (reference.status === "file") next.set(reference.path, reference.resolvedPath ?? reference.path);
        }
        return next;
      });
    }).catch(() => {
      // A failed batch un-marks its paths so a later render can retry them.
      for (const path of pending) askedRefs.current.delete(path);
    });
    return () => { cancelled = true; };
  }, [candidates, id]);
  const openTarget = useCallback((target: WorkspaceTarget) => {
    setFileTarget(target);
    setFilesOpen(true);
  }, []);
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((previous) => ({ ...previous, [groupId]: !previous[groupId] }));
  }, []);
  // A merged/discarded worktree session is finished: its cwd is gone.
  const worktreeClosed = session?.isolation === "worktree" && events.some((event) => event.kind === "status" && (event.label === "Merged into project" || event.label === "Worktree discarded"));

  const sendText = async (text: string) => {
    if (!text || sending || worktreeClosed) return;
    setSending(true);
    setError("");
    try {
      await api.promptClaude(id, text, {
        modelOverride: selectedModel?.modelID || undefined,
        plan: planMode,
        reminder: selectedReminder || undefined,
        workflow: selectedWorkflow || undefined,
      });
      setSelectedReminder("");
      setSelectedWorkflow("");
      await refresh();
    } catch (cause) {
      setDraft(text);
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const send = () => {
    const text = draft.trim();
    if (!text || worktreeClosed) return;
    setDraft("");
    if (sending || session?.running) {
      setQueued(text);
      return;
    }
    void sendText(text);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  const cancel = async () => {
    setQueued(null);
    try {
      await api.cancelClaude(id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!session?.running && !sending && queued) {
      const text = queued;
      setQueued(null);
      void sendText(text);
    }
  }, [session?.running, sending, queued]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-background-base)]" data-testid="claude-conversation">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
        <Link to="/claude" className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]" data-testid="claude-back">Claude lab</Link>
        <span aria-hidden="true">/</span>
        <strong className="min-w-0 truncate text-sm">{session?.title ?? "Conversation"}</strong>
        <Badge variant="neutral">{session?.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>
        {session?.workspaceLabel && <Badge variant="neutral">{session.workspaceLabel}</Badge>}
        {session?.branch && <Badge variant="neutral" data-testid="claude-branch"><GitBranch aria-hidden="true" size={12} className="mr-1 inline" />{session.branch}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <ClaudeUsageIndicator />
          <Button size="sm" variant="secondary" onClick={() => setFilesOpen(true)} data-testid="claude-open-files"><FolderOpen aria-hidden="true" className="mr-1" size={14} /> Files</Button>
          <Button size="sm" variant="secondary" onClick={() => setRunlogOpen(true)} data-testid="claude-open-runlog"><ListTree aria-hidden="true" className="mr-1" size={14} /> Run log</Button>
          <Button size="sm" variant="secondary" onClick={() => setChangesOpen(true)} disabled={worktreeClosed} data-testid="claude-open-changes"><ListChecks aria-hidden="true" className="mr-1" size={14} /> Changes</Button>
          <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)} disabled={events.length === 0} data-testid="claude-open-export"><Download aria-hidden="true" className="mr-1" size={14} /> Export</Button>
          <Button size="sm" variant="ghost" disabled title="Live preview is coming soon" data-testid="claude-preview-soon"><Eye aria-hidden="true" className="mr-1" size={14} /> Preview <span className="ml-1 rounded bg-[var(--color-background-surface-neutral-muted)] px-1 text-[10px] uppercase">Beta</span></Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} onScroll={updateFollow} className="h-full overflow-y-auto px-4 py-5 sm:px-8" data-testid="claude-transcript">
          <div className="mx-auto max-w-4xl">
            {events.length === 0 && !error && <div className="py-20 text-center"><Sparkles aria-hidden="true" className="mx-auto mb-3 text-[var(--color-text-muted)]" /><p className="text-sm text-[var(--color-text-muted)]">{planMode ? "Ask Claude to inspect this workspace. Switch to Build to allow file changes." : "Ask Claude to make a change. It runs without pausing to ask; review the result under Changes."}</p></div>}
            <WorkspaceReferenceProvider directory={id} resolved={resolved} onOpen={openTarget}>
              <Transcript items={items} wrap collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} />
            </WorkspaceReferenceProvider>
            {session?.running && <div className="mt-5"><RunningIndicator activity={activity} /></div>}
            <div ref={bottom} />
          </div>
        </div>
        {newActivity && (
          <button
            type="button"
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 py-1.5 text-xs font-medium shadow-lg transition-colors hover:bg-[var(--color-background-surface-neutral-muted)]"
            onClick={jumpToLatest}
            data-testid="claude-jump-to-latest"
          >
            <ArrowDown aria-hidden="true" size={13} />
            New activity
          </button>
        )}
      </div>
      <form className="shrink-0 border-t border-[var(--color-border-default)] bg-[var(--color-background-surface)] px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(event) => { event.preventDefault(); void send(); }} data-testid="claude-composer">
        <div className="mx-auto max-w-3xl">
          {session && (
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2" data-testid="claude-mode-toggle">
                <AgentModeToggle
                  mode={planMode ? "plan" : "build"}
                  onChange={(mode) => setPlanMode(mode === "plan")}
                  disabled={session.running}
                  testId="claude-composer-mode"
                />
                <ModelPicker
                  catalogue={modelCatalogue}
                  value={selectedModel}
                  onChange={setSelectedModel}
                  testId="claude-composer-model"
                  label="Model"
                  disabled={session.running}
                  midConversation={events.length > 0}
                />
              </div>
          )}
          {error && <p className="mb-2 text-xs text-[var(--color-text-danger)]" role="alert">{error}</p>}
          {queued && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface-info-muted)] px-3 py-2" data-testid="claude-queued-banner">
              <div className="min-w-0 flex-1">
                <span className="text-[11px] font-medium text-[var(--color-text-info)]">Queued — will send when the current turn finishes</span>
                <p className="mt-0.5 line-clamp-3 text-xs text-[var(--color-text-default)]">{queued}</p>
              </div>
              <button type="button" className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]" onClick={() => { setQueued(null); setDraft(queued); }} aria-label="Cancel queued message" data-testid="claude-queued-dismiss"><X aria-hidden="true" size={14} /></button>
            </div>
          )}
          <div className="min-w-0 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] transition-colors focus-within:border-[var(--color-border-focus)]" data-testid="claude-composer-card">
            <textarea
              ref={composerRef}
              className="thin-scrollbar block max-h-64 min-h-24 w-full resize-none border-0 bg-transparent p-3 text-base text-[var(--color-text-default)] outline-none placeholder:text-[var(--color-text-muted)] sm:min-h-16 sm:p-2.5 sm:text-sm"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keyDown}
              placeholder={worktreeClosed ? "This worktree session is finished." : "Send a follow-up…"}
              disabled={!session || worktreeClosed}
              rows={1}
              data-testid="claude-prompt"
            />
            <div className="flex min-w-0 items-center gap-2 border-t border-[var(--color-border-default)] px-2 py-2 sm:py-1">
              {reminderCatalogue.length > 0 && (
                <ReminderPicker catalogue={reminderCatalogue} value={selectedReminder} onChange={setSelectedReminder} />
              )}
              {workflowCatalogue.length > 0 && (
                <WorkflowPicker catalogue={workflowCatalogue} attached={selectedWorkflow} onDetach={() => setSelectedWorkflow("")} onPick={setActiveWorkflow} />
              )}
              <span className="flex-1" aria-hidden="true" />
              {session?.running && <Button size="sm" className="min-h-11 shrink-0 sm:min-h-8" type="button" variant="danger" onClick={() => void cancel()} data-testid="claude-cancel"><OctagonX aria-hidden="true" size={15} className="mr-1" /> Stop</Button>}
              <Button size="sm" className="min-h-11 shrink-0 sm:min-h-8" type="submit" disabled={!draft.trim() || sending || !session || worktreeClosed || !!queued} data-testid="claude-send">{session?.running ? "Queue" : "Send"}</Button>
            </div>
          </div>
        </div>
      </form>
      {activeWorkflow && (
        <ClaudeWorkflowDialog
          workflow={activeWorkflow}
          onClose={() => setActiveWorkflow(null)}
          onApplyToComposer={(draftText, workflowID) => {
            setDraft(draftText);
            setSelectedWorkflow(workflowID);
            setActiveWorkflow(null);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
        />
      )}
      {changesOpen && session && <ChangesDrawer session={session} onClose={() => setChangesOpen(false)} onMutated={() => void refresh()} />}
      {filesOpen && <ClaudeFilesDrawer sessionId={id} target={fileTarget} onClose={() => { setFilesOpen(false); setFileTarget(null); }} />}
      {runlogOpen && <ClaudeRunLogDrawer events={events} title={session?.title ?? "claude-session"} onClose={() => setRunlogOpen(false)} />}
      {exportOpen && (
        <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[28rem]" role="dialog" aria-modal="true" aria-label="Export transcript" data-testid="claude-export">
          <header className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-2">
            <Download aria-hidden="true" size={16} /><strong className="text-sm">Export transcript</strong>
            <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setExportOpen(false)} data-testid="claude-export-close"><X aria-hidden="true" size={15} /> Close</Button>
          </header>
          <div className="grid gap-2 p-4 text-sm">
            <p className="text-[var(--color-text-muted)]">Download this conversation. Runs entirely in your browser — nothing is published.</p>
            <Button variant="secondary" onClick={() => downloadText(shareFilename(session?.title ?? "claude-session", "md"), serializeShareMarkdown(session?.title ?? "Claude session", events, { kind: "session" }), "text/markdown")} data-testid="claude-export-md">Download Markdown</Button>
            <Button variant="secondary" onClick={() => downloadText(shareFilename(session?.title ?? "claude-session", "json"), serializeSessionJson(session?.title ?? "Claude session", events), "application/json")} data-testid="claude-export-json">Download JSON</Button>
          </div>
        </section>
      )}
    </main>
  );
}
