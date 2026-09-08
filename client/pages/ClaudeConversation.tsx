import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Download, Eye, FolderOpen, GitBranch, GitMerge, GitPullRequest, Info, ListChecks, OctagonX, PersonStanding, RefreshCw, Send, Sparkles, Trash2, X } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { cn } from "../ds/utils.js";
import { AgentModeToggle } from "../components/agent-mode-toggle.js";
import { ModelPicker } from "../components/model-picker.js";
import { ClaudeFilesDrawer } from "../components/claude-files-drawer.js";
import { SessionInspector } from "../components/session-inspector.js";
import { ClaudeUsageIndicator } from "../components/claude-usage-indicator.js";
import { ClaudeWorkflowDialog } from "../components/claude-workflow-dialog.js";
import { SessionShell } from "../components/session-shell.js";
import { SessionOverflowMenu } from "../components/session-overflow-menu.js";
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
import type { InspectorTab } from "../lib/inspectorTabs.js";
import { serializeSessionJson, serializeShareMarkdown, shareFilename } from "../lib/sessionSharing.js";
import { referenceCandidatesFromEvents, type WorkspaceTarget } from "../lib/fileReferences.js";
import { WorkspaceReferenceProvider } from "../lib/workspaceReferences.js";

import { useTranscriptFollow } from "../lib/useTranscriptFollow.js";
import { useClaudeTranscript } from "../lib/useClaudeTranscript.js";
import { ClaudeHistoryDrawer } from "../components/claude-history-drawer.js";
import { MAX_IMAGE_ATTACHMENTS, readImageAttachment, selectImageFiles, type ImageAttachment } from "../lib/attachments.js";

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

interface QueuedClaudePrompt {
  id: string;
  text: string;
  attachments: ImageAttachment[];
}

// A queue belongs to a Claude session, not to one mounting of its page. Keeping
// it at module scope means an in-app trip to the hub and back cannot silently
// discard follow-ups. A full page reload remains an explicit process boundary;
// image data can be larger than browser storage quotas, so pretending it is
// durably persisted would be less honest than retaining it for this app run.
const queuedPromptsBySession = new Map<string, QueuedClaudePrompt[]>();
let queuedPromptSequence = 0;

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
  const transcript = useClaudeTranscript(id);
  const { session, events, error, setError } = transcript;
  const refresh = () => transcript.refresh();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [runlogOpen, setRunlogOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [requestedInspectorTab, setRequestedInspectorTab] = useState<InspectorTab | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoSafetyOpen, setAutoSafetyOpen] = useState(false);
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
  const [queued, setQueued] = useState<QueuedClaudePrompt[]>(() => [...(queuedPromptsBySession.get(id) ?? [])]);
  const [queuePaused, setQueuePaused] = useState(false);
  const askedRefs = useRef<Set<string>>(new Set());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    setQueued([...(queuedPromptsBySession.get(id) ?? [])]);
    setQueuePaused(false);
    setFileTarget(null);
    setCollapsedGroups({});
    setResolved(new Map());
    askedRefs.current = new Set();
    setSelectedReminder("");
    setSelectedWorkflow("");
    setActiveWorkflow(null);
    setHistoryOpen(false);
    setRunlogOpen(false);
    setExportOpen(false);
  }, [id]);
  useEffect(() => { if (session) setSending(false); }, [session]);

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
  const follow = useTranscriptFollow(events, id);

  const items = useMemo(() => collapseActionGroups(events), [events]);

  const activity = useMemo(() => runningActivity(events), [events]);

  // File references: collect paths the transcript mentions and validate them
  // server-side so an inline `path:line` span becomes a button. The resolved
  // map is built locally (the opencode /workspace/references route is
  // directory-scoped and rejects the Claude worktree root), one bounded batch
  // per new candidate — a failing path is remembered, not retried each poll.
  // Validate resident pages as they are read. Older pages are validated on demand. Keep
  // validation stable when an update changes prose but not its referenced paths.
  const candidateKey = useMemo(() => referenceCandidatesFromEvents(events, "").join("\n"), [events]);
  const candidates = useMemo(() => (candidateKey ? candidateKey.split("\n") : []), [candidateKey]);
  useEffect(() => {
    let cancelled = false;
    const resident = new Set(candidates);
    askedRefs.current = new Set([...askedRefs.current].filter((path) => resident.has(path)));
    setResolved((previous) => [...previous.keys()].every((path) => resident.has(path)) ? previous : new Map([...previous].filter(([path]) => resident.has(path))));
    const pending = candidates.filter((path) => !askedRefs.current.has(path));
    if (pending.length === 0) return;
    // Not aborted on re-run: a completed validation is worth keeping even if a
    // later batch supersedes it. `cancelled` only blocks a stale setState.
    void api.claudeReferences(id, pending).then((result) => {
      if (cancelled) return;
      for (const path of pending) askedRefs.current.add(path);
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
  useEffect(() => {
    const resident = new Set(items.map((item) => item.id));
    setCollapsedGroups((previous) => Object.keys(previous).every((key) => resident.has(key)) ? previous : Object.fromEntries(Object.entries(previous).filter(([key]) => resident.has(key))));
  }, [items]);
  const openTarget = useCallback((target: WorkspaceTarget) => {
    setFileTarget(target);
    setFilesOpen(true);
  }, []);
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((previous) => ({ ...previous, [groupId]: !(previous[groupId] ?? true) }));
  }, []);
  // A merged/discarded worktree session is finished: its cwd is gone.
  const worktreeClosed = !!session?.worktreeClosed;

  const addAttachments = (files: Iterable<File>) => {
    const selection = selectImageFiles(files, attachments.length);
    setAttachmentError(selection.error ?? "");
    if (!selection.files.length) return;
    void Promise.all(selection.files.map(readImageAttachment))
      .then((next) => setAttachments((items) => [...items, ...next].slice(0, MAX_IMAGE_ATTACHMENTS)))
      .catch(() => setAttachmentError("Could not read the selected image."));
  };

  const sendText = async (text: string, images: ImageAttachment[] = [], fromQueue = false) => {
    if (!text || sending || worktreeClosed) return;
    setSending(true);
    setError("");
    try {
      await api.promptClaude(id, text, {
        modelOverride: selectedModel?.modelID || undefined,
        plan: planMode,
        reminder: selectedReminder || undefined,
        workflow: selectedWorkflow || undefined,
        images,
      });
      setSelectedReminder("");
      setSelectedWorkflow("");
      await refresh();
    } catch (cause) {
      setDraft(text);
      setAttachments(images);
      if (fromQueue) setQueuePaused(true);
      setSending(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const updateQueue = useCallback((update: (current: QueuedClaudePrompt[]) => QueuedClaudePrompt[]) => {
    setQueued((current) => {
      const next = update(current);
      if (next.length > 0) queuedPromptsBySession.set(id, next);
      else queuedPromptsBySession.delete(id);
      return next;
    });
  }, [id]);
  const send = () => {
    const text = draft.trim();
    if (!text || worktreeClosed) return;
    setDraft("");
    if (sending || session?.running) {
      const item = { id: `${id}:${Date.now()}:${queuedPromptSequence++}`, text, attachments };
      updateQueue((current) => [...current, item]);
      setAttachments([]);
      return;
    }
    const images = attachments;
    setAttachments([]);
    setQueuePaused(false);
    void sendText(text, images);
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

  useEffect(() => {
    if (session && !session.running && !sending && !queuePaused && queued.length > 0) {
      const [{ text, attachments: images }] = queued;
      updateQueue((current) => current.slice(1));
      void sendText(text, images, true);
    }
  }, [session, sending, queuePaused, queued, updateQueue]);

  const exportTranscript = async (format: "md" | "json") => {
    setExporting(true);
    try {
      const complete = await api.claudeExport(id);
      const title = session?.title ?? "Claude session";
      downloadText(shareFilename(title, format), format === "md" ? serializeShareMarkdown(title, complete.events, { kind: "session" }) : serializeSessionJson(title, complete.events), format === "md" ? "text/markdown" : "application/json");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  };

  return (
    <SessionShell
      browserSessionID={id}
      testIds={{
        root: "claude-conversation",
        transcript: "claude-transcript",
        jumpToLatest: "claude-jump-to-latest",
        composerForm: "claude-composer",
        composerCard: "claude-composer-card",
        textarea: "claude-prompt",
        send: "claude-send",
        controlsRow: "claude-mode-toggle",
      }}
      header={{
        backLink: <Link to="/claude" className="hidden shrink-0 text-sm underline sm:inline" data-testid="claude-back">← Claude lab</Link>,
        title: session?.title ?? "Conversation",
        badges: (
          <>
            <Badge variant="neutral">{session?.mode === "build" ? "Build · may edit files" : "Read only"}</Badge>
            {session?.workspaceLabel && <Badge variant="neutral">{session.workspaceLabel}</Badge>}
            {session?.branch && <Badge variant="neutral" data-testid="claude-branch"><GitBranch aria-hidden="true" size={12} className="mr-1 inline" />{session.branch}</Badge>}
            {session?.running && <Badge variant="info">running</Badge>}
            {session?.running && (
              <button
                type="button"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--color-text-danger)] hover:bg-[var(--color-background-surface-danger-muted)]"
                onClick={() => void cancel()}
                aria-label="Stop running agent"
                title="Stop running agent"
                data-testid="claude-stop"
              >
                <OctagonX aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </>
        ),
        stats: <ClaudeUsageIndicator tokenUsage={session?.tokenUsage} />,
        actions: (
          <>
            <Button size="md" variant="ghost" className="min-h-11 min-w-12 px-0" onClick={() => setFilesOpen(true)} aria-label="Open files" title="Files" data-testid="claude-open-files"><FolderOpen aria-hidden="true" className="h-3.5 w-3.5" /></Button>
            <Button size="md" variant="ghost" className="min-h-11 min-w-12 px-0" onClick={() => setChangesOpen(true)} disabled={worktreeClosed} aria-label="Open changes" title="Changes" data-testid="claude-open-changes"><ListChecks aria-hidden="true" className="h-3.5 w-3.5" /></Button>
            {session?.prUrl && (
              <Button size="md" variant="ghost" className="min-h-11 min-w-12 px-0" onClick={() => setChangesOpen(true)} aria-label="Open pull request status" title="Reviews" data-testid="claude-open-reviews"><GitPullRequest aria-hidden="true" className="h-3.5 w-3.5" /></Button>
            )}
            <div className="flex items-center gap-0.5 rounded-full border border-[var(--color-border-default)] px-1 opacity-50" title="Auto permissions always on — Claude runs non-interactively" data-testid="claude-auto-permissions-group">
              <button type="button" role="switch" aria-checked={true} aria-label="Auto permissions (always on)" disabled className="flex min-h-9 min-w-[4.5rem] items-center justify-center rounded-full disabled:opacity-50" data-testid="claude-auto-permissions-toggle">
                <span aria-hidden="true" className="relative h-7 w-16 rounded-full border border-current text-[var(--color-text-muted)]">
                  <span className="absolute left-1 top-1 h-[1.125rem] w-[1.125rem] translate-x-9 rounded-full bg-current" />
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold">ON</span>
                </span>
              </button>
              <div className="flex shrink-0">
                <Button size="md" variant="ghost" className="min-h-9 min-w-9 rounded-lg px-0" onClick={() => setAutoSafetyOpen(true)} aria-label="Auto permissions safety" title="Auto permissions safety" data-testid="claude-auto-permissions-info">
                  <Info aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <Button
              size="md"
              variant="ghost"
              className={cn("min-h-11 min-w-12 px-0", !sidebarOpen && "text-[var(--color-text-muted)] opacity-50")}
              onClick={() => {
                setRunlogOpen(true);
              }}
              aria-label={sidebarOpen && requestedInspectorTab === "runlog" ? "Close run log" : "Open run log"}
              title={sidebarOpen && requestedInspectorTab === "runlog" ? "Close run log" : "Open run log"}
              data-testid="claude-open-runlog"
            >
              <PersonStanding aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
            <SessionOverflowMenu
              testIds={{ root: "claude-session-menu", trigger: "claude-session-menu-trigger", panel: "claude-session-menu-panel" }}
              items={[
                { id: "export", label: "Export transcript", icon: <Download aria-hidden="true" size={15} />, onSelect: () => setExportOpen(true), disabled: events.length === 0, testId: "claude-open-export" },
                { id: "preview", label: "Live preview", icon: <Eye aria-hidden="true" size={15} />, onSelect: () => undefined, disabled: true, title: "Live preview is coming soon", testId: "claude-preview-soon" },
              ]}
            />
          </>
        ),
      }}
      transcript={{
        items,
        virtualized: true,
        wrap: true,
        collapsedGroups,
        collapseCompletedByDefault: true,
        onToggleGroup: toggleGroup,
        referenceProvider: (children) => (
          <WorkspaceReferenceProvider directory={id} resolved={resolved} onOpen={openTarget}>{children}</WorkspaceReferenceProvider>
        ),
        loaded: session !== null || !!error,
        running: !!session?.running,
        activity,
        emptyState: !error ? (
          <div className="py-20 text-center">
            <Sparkles aria-hidden="true" className="mx-auto mb-3 text-[var(--color-text-muted)]" />
            <p className="text-sm text-[var(--color-text-muted)]">{planMode ? "Ask Claude to inspect this workspace. Switch to Build to allow file changes." : "Ask Claude to make a change. It runs without pausing to ask; review the result under Changes."}</p>
          </div>
        ) : null,
      }}
      scroll={{
        scrollerRef: follow.scrollerRef,
        contentRef: follow.contentRef,
        onScroll: () => {
          follow.onScroll();
          const scroller = follow.scrollerRef.current;
          if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 96) transcript.pin();
        },
        showNewActivity: follow.newActivity || !!transcript.after,
        onJumpToLatest: () => { void transcript.refresh("latest").then(() => follow.jumpToLatest()); },
        beforeTranscript: (
          <div className="mb-5 flex flex-wrap items-center gap-2" data-testid="claude-history-controls"
            data-total-events={transcript.total} data-resident-events={events.length}
            data-resident-pages={Math.max(Math.ceil(events.length / 50), Math.ceil(transcript.residentBytes / (128 * 1024)))}
            data-resident-bytes={transcript.residentBytes}
            data-refresh-bytes={transcript.diagnostics.current.payloadBytes}
            data-reconcile-ms={transcript.diagnostics.current.reconcileMs}
            data-refresh-count={transcript.diagnostics.current.requests}>
            {transcript.before && <Button size="sm" className="min-h-11 sm:min-h-8" disabled={transcript.loadingHistory} onClick={() => void transcript.refresh("before")} data-testid="claude-load-earlier">Load earlier</Button>}
            {transcript.after && <Button size="sm" className="min-h-11 sm:min-h-8" disabled={transcript.loadingHistory} onClick={() => void transcript.refresh("after")} data-testid="claude-load-newer">Load newer</Button>}
            <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => setHistoryOpen(true)} data-testid="claude-search-history">Search history</Button>
            <span className="text-xs text-[var(--color-text-muted)]">{events.length} of {transcript.total} events loaded</span>
          </div>
        ),
      }}
      composer={{
        draft,
        onDraftChange: setDraft,
        composerRef,
        onPaste: (event) => {
          const images = [...event.clipboardData.items]
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (images.length) addAttachments(images);
        },
        onKeyDown: keyDown,
        placeholder: worktreeClosed ? "This worktree session is finished." : "Send a follow-up…",
        disabled: !session || worktreeClosed,
        onSubmit: () => void send(),
        submitLabel: session?.running ? "Queue" : "Send",
        submitDisabled: !draft.trim() || sending || !session || worktreeClosed,
        modeControl: session ? (
          <AgentModeToggle
            mode={planMode ? "plan" : "build"}
            onChange={(mode) => setPlanMode(mode === "plan")}
            disabled={session.running}
            testId="claude-composer-mode"
          />
        ) : null,
        modelPicker: session ? (
          <ModelPicker
            catalogue={modelCatalogue}
            value={selectedModel}
            onChange={setSelectedModel}
            testId="claude-composer-model"
            label="Model"
            disabled={session.running}
            midConversation={events.length > 0}
          />
        ) : null,
        beforeTextarea: (
          <>
            {error && <p className="mb-2 text-xs text-[var(--color-text-danger)]" role="alert">{error}</p>}
            {session?.interrupted && !session.running && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] px-3 py-2" data-testid="claude-interrupted-banner">
                <p className="min-w-0 flex-1 text-xs">This turn was interrupted. Resume explicitly after checking whether its last tool action completed.</p>
                <Button type="button" size="sm" variant="secondary" onClick={() => { setDraft("Continue the interrupted turn from where you left off. First verify the last tool action before repeating it."); composerRef.current?.focus(); }} data-testid="claude-resume">Resume</Button>
              </div>
            )}
            {queued.length > 0 && (
              <div className="mb-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface-info-muted)] px-3 py-2" data-testid="claude-queued-banner">
                <div className="text-[11px] font-medium text-[var(--color-text-info)]">
                  {queued.length} queued — {queuePaused ? "paused after a failed send" : "one will send after each completed turn"}
                </div>
                <ol className="mt-1 space-y-1">
                  {queued.map((item, index) => (
                    <li key={item.id} className="flex min-w-0 items-start gap-2" data-testid="claude-queued-item">
                      <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]">{index + 1}.</span>
                      <p className="min-w-0 flex-1 line-clamp-2 text-xs text-[var(--color-text-default)]">
                        {item.text}
                        {item.attachments.length > 0 && <span className="ml-1 text-[var(--color-text-muted)]">· {item.attachments.length} image{item.attachments.length === 1 ? "" : "s"}</span>}
                      </p>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-default)]"
                        onClick={() => {
                          updateQueue((current) => current.filter((candidate) => candidate.id !== item.id));
                          setDraft(item.text);
                          setAttachments(item.attachments);
                          composerRef.current?.focus();
                        }}
                        aria-label={`Cancel queued message ${index + 1}`}
                        data-testid="claude-queued-dismiss"
                      >
                        <X aria-hidden="true" size={14} />
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map((attachment, index) => <button key={`${attachment.filename}-${index}`} type="button" onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="rounded border border-[var(--color-border-default)] px-2 py-1 text-xs" data-testid="claude-attachment-chip">{attachment.filename} x</button>)}</div>}
            {attachmentError && <p className="mb-2 text-xs text-[var(--color-text-danger)]" role="alert" data-testid="claude-attachment-error">{attachmentError}</p>}
          </>
        ),
        bottomRailStart: (
          <>
            <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-md px-2.5 text-xs font-semibold text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)] sm:min-h-8" data-testid="claude-attach-label">
              Attach
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="sr-only" data-testid="claude-attach" onChange={(event) => { addAttachments(event.target.files ?? []); event.target.value = ""; }} />
            </label>
            {reminderCatalogue.length > 0 && (
              <ReminderPicker catalogue={reminderCatalogue} value={selectedReminder} onChange={setSelectedReminder} />
            )}
            {workflowCatalogue.length > 0 && (
              <WorkflowPicker catalogue={workflowCatalogue} attached={selectedWorkflow} onDetach={() => setSelectedWorkflow("")} onPick={setActiveWorkflow} />
            )}
          </>
        ),
        bottomRailEnd: session?.running ? (
          <Button size="sm" className="min-h-11 shrink-0 sm:min-h-8" type="button" variant="danger" onClick={() => void cancel()} data-testid="claude-cancel"><OctagonX aria-hidden="true" size={15} className="mr-1" /> Stop</Button>
        ) : null,
      }}
      inspector={sidebarOpen ? {
        desktop: (
          <SessionInspector
            directory={id}
            sessionID={id}
            events={events}
            runLogOverride={<Button onClick={() => setRunlogOpen(true)} data-testid="claude-inspector-runlog">Open complete run log</Button>}
            requestedTab={requestedInspectorTab}
            mobileOpen={inspectorOpen}
            onMobileClose={() => setInspectorOpen(false)}
          />
        ),
      } : undefined}
      overlays={(
        <>
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
          {runlogOpen && <ClaudeHistoryDrawer key={`actions-${id}`} sessionId={id} actions onClose={() => setRunlogOpen(false)} />}
          {historyOpen && <ClaudeHistoryDrawer key={`search-${id}`} sessionId={id} onClose={() => setHistoryOpen(false)} />}
          {exportOpen && (
            <section className="fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-background-surface)] shadow-xl sm:left-auto sm:w-[28rem]" role="dialog" aria-modal="true" aria-label="Export transcript" data-testid="claude-export">
              <header className="flex items-center gap-2 border-b border-[var(--color-border-default)] p-2">
                <Download aria-hidden="true" size={16} /><strong className="text-sm">Export transcript</strong>
                <Button className="ml-auto" size="sm" variant="ghost" onClick={() => setExportOpen(false)} data-testid="claude-export-close"><X aria-hidden="true" size={15} /> Close</Button>
              </header>
              <div className="grid gap-2 p-4 text-sm">
                <p className="text-[var(--color-text-muted)]">Download the complete retained conversation from the server. Nothing is published.</p>
                <Button variant="secondary" disabled={exporting} onClick={() => void exportTranscript("md")} data-testid="claude-export-md">Download Markdown</Button>
                <Button variant="secondary" disabled={exporting} onClick={() => void exportTranscript("json")} data-testid="claude-export-json">Download JSON</Button>
              </div>
            </section>
          )}
          {autoSafetyOpen && (
            <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-start sm:p-4 sm:pt-[10vh]" data-testid="claude-auto-permissions-safety-sheet">
              <button type="button" className="absolute inset-0 bg-[var(--color-background-overlay)]" aria-label="Close auto permissions safety" onClick={() => setAutoSafetyOpen(false)} data-testid="claude-auto-permissions-safety-scrim" />
              <section className="relative w-full rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-xl" role="dialog" aria-modal="true" aria-label="Auto permissions safety">
                <div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Auto permissions safety</h2><button type="button" className="ml-auto min-h-11 min-w-11 rounded text-sm" onClick={() => setAutoSafetyOpen(false)} aria-label="Close auto permissions safety" data-testid="claude-auto-permissions-safety-close">Close</button></div>
                <p className="mt-3 text-sm text-[var(--color-text-muted)]">Auto permissions approves every asked permission once, including arbitrary shell commands, external-directory access, and repeated requests from a doom loop. This affects every session using this project directory and resets to off when the BFF restarts.</p>
              </section>
            </div>
          )}
        </>
      )}
    />
  );
}
