import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronRight, Pin, Search } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { AgentModeToggle } from "../components/agent-mode-toggle.js";
import { AutoPermissionsControl } from "../components/auto-permissions-control.js";
import { ModelPicker } from "../components/model-picker.js";
import { StatusPill, runningState } from "../components/status-pill.js";
import {
  api,
  formatCost,
  type DiscoveredProject,
  type HealthResponse,
  type SessionSummary,
  type Worktree,
} from "../lib/api.js";
import type { AgentMode } from "../lib/agentMode.js";
import { buildAttentionSummary } from "../lib/hubAttention.js";
import { catalogueDefault, sameModel, type ModelCatalogue, type ModelSelection } from "../lib/models.js";
import { splitProjectWorkspace } from "../lib/projectPath.js";
import {
  MAX_VISIBLE_RECENT_SESSIONS,
  readRecentSessionOpens,
  recentDirectories,
  recentlyActiveSessions,
  recentlyOpenedSessions,
} from "../lib/recentSessions.js";
import {
  buildSessionTree,
  isSubagentSession,
  MAX_SESSION_DEPTH,
  sessionTreeKey,
  type SessionTreeNode,
} from "../lib/subagents.js";
import { useNotificationCenter } from "../lib/useNotificationCenter.js";

const DIRECTORY_KEY = "opencode.directory.v1";
const POLL_MS = 10_000;
// Recents fan out across projects, so they refresh on their own slower timer
// rather than riding the per-directory session poll.
const RECENTS_POLL_MS = 60_000;

/**
 * Marks a session that another session delegated to.
 *
 * Worth the pixels: in one audited project 124 of 149 sessions were children,
 * so without this an unbroken list of similarly-named rows gives no clue which
 * ones a human actually started.
 */
/**
 * `managed` is the server-validated managed-human metadata (decision #19). A
 * human authorized that child directly, so it reads as work someone started
 * rather than another neutral `sub` in a wall of them; a child with no such
 * metadata keeps the neutral pill instead of being relabelled on a guess.
 */
export function SubagentPill({ managed = false }: { managed?: boolean }) {
  return (
    <span
      className={
        managed
          ? "inline-flex shrink-0 items-center rounded-full bg-[var(--color-background-surface-info-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-info)]"
          : "inline-flex shrink-0 items-center rounded-full bg-[var(--color-background-surface-neutral-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)]"
      }
      title={managed ? "Launched as a Managed Child by a human" : "Delegated by another session"}
      data-testid="opencode-subagent-pill"
      data-managed={managed ? "true" : "false"}
    >
      {managed ? "Managed Child" : "sub"}
    </span>
  );
}

interface SessionTreeListProps {
  sessions: SessionSummary[];
  selected?: SessionSummary[];
  testId: string;
  projectLabel?: (directory: string) => string;
  showCost?: boolean;
}

function SessionTreeList({ sessions, selected, testId, projectLabel, showCost = false }: SessionTreeListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = buildSessionTree(sessions, selected);

  const renderNode = (node: SessionTreeNode, depth: number) => {
    const { session, children } = node;
    const key = sessionTreeKey(session);
    const isExpanded = expanded.has(key);
    const childLabel = `${children.length} ${children.length === 1 ? "child session" : "child sessions"}`;
    return (
      <li key={key} data-testid={testId === "opencode-session-list" ? "opencode-session-row" : `${testId}-item`} data-depth={depth}>
        <div
          className="flex min-w-0 items-stretch border-b border-[var(--color-border-default)]"
          style={{ paddingLeft: `${Math.min(depth, MAX_SESSION_DEPTH) * 0.75}rem` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className="flex min-h-11 w-20 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-background-action-ghost-hover)] hover:text-[var(--color-text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "Hide" : "Show"} ${childLabel} for ${session.title}`}
              data-testid={`${testId}-disclosure`}
            >
              <ChevronRight aria-hidden="true" className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
              <span data-testid="opencode-session-child-count">{children.length} sub</span>
            </button>
          ) : (
            <span className={`${depth > 0 ? "w-20" : "w-4"} shrink-0`} aria-hidden="true" />
          )}
          <Link
            to={`/sessions/${session.id}?directory=${encodeURIComponent(session.directory)}`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm hover:bg-[var(--hh-row-hover)] sm:gap-3"
            data-testid={`${testId}-row`}
          >
            <StatusPill status={runningState(session.running)} />
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {isSubagentSession(session) && <SubagentPill managed={Boolean(session.managed)} />}
            {projectLabel && (
              <span
                className="max-w-[30%] shrink-0 truncate text-[11px] text-[var(--color-text-muted)] sm:max-w-[40%]"
                title={session.directory}
                data-testid={`${testId}-project`}
              >
                {projectLabel(session.directory)}
              </span>
            )}
            {showCost && session.cost > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">
                {formatCost(session.cost)}
              </span>
            )}
          </Link>
        </div>
        {children.length > 0 && isExpanded && (
          <ul role="group">{children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return <ul data-testid={testId}>{tree.map((node) => renderNode(node, 0))}</ul>;
}

export function HubPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Notification records already fetched app-wide (nav badge, popover); the
  // needs-attention band reuses them rather than fetching its own copy.
  const { records: notificationRecords } = useNotificationCenter();

  // Directory is the project selector for every API call, so it lives in the
  // URL (shareable, refresh-safe) and falls back to the last one used.
  const directory = params.get("directory") ?? localStorage.getItem(DIRECTORY_KEY) ?? "";
  const [directoryInput, setDirectoryInput] = useState(directory);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [isolated, setIsolated] = useState(false);
  const [mode, setMode] = useState<AgentMode>("build");
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [modelCatalogue, setModelCatalogue] = useState<ModelCatalogue | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | undefined>();
  const [initialModel, setInitialModel] = useState<ModelSelection | undefined>();
  const [modelError, setModelError] = useState<string | null>(null);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [projects, setProjects] = useState<DiscoveredProject[] | null>(null);
  const [pinnedDirectories, setPinnedDirectories] = useState<string[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [pinsSaving, setPinsSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [recents, setRecents] = useState<SessionSummary[] | null>(null);
  const recentOpens = readRecentSessionOpens(localStorage);

  // The projects this browser knows about, newest first. The BFF unions this
  // with the shared pins, so a fresh browser still sees pinned projects.
  const recentScope = [...new Set([
    ...(directory ? [directory] : []),
    ...recentDirectories(recentOpens),
  ])];
  // Effects cannot depend on a fresh array every render; key on the content.
  const recentScopeKey = recentScope.join("\n");
  const recentLookupKey = recentOpens.map((entry) => entry.id).join("\n");

  useEffect(() => {
    if (directory) localStorage.setItem(DIRECTORY_KEY, directory);
  }, [directory]);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    Promise.all([api.projects(), api.projectPins()])
      .then(([discovery, pins]) => {
        setProjectsRoot(discovery.root);
        setProjects(discovery.projects);
        setPinnedDirectories(pins.directories);
        setProjectError(null);
      })
      .catch((e: Error) => {
        setProjects([]);
        setProjectError(e.message);
      });
  }, []);

  // In-flight guard: the interval keeps firing while a slow list call is
  // outstanding, and stacking requests against a wedged upstream helps nobody.
  const activeDirectory = useRef(directory);
  activeDirectory.current = directory;
  const inFlight = useRef<string | null>(null);
  const refresh = useCallback(() => {
    if (!directory || inFlight.current === directory) return;
    inFlight.current = directory;
    api
      .sessions(directory)
      .then((r) => {
        if (activeDirectory.current !== directory) return;
        setSessions(r.sessions);
        setError(null);
      })
      .catch((e: Error) => {
        if (activeDirectory.current === directory) setError(e.message);
      })
      .finally(() => {
        if (inFlight.current === directory) inFlight.current = null;
      });
  }, [directory]);

  useEffect(() => {
    if (!directory) return;
    setSessions(null);
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [directory, refresh]);

  useEffect(() => {
    if (!directory) return;
    void api.worktrees(directory).then((result) => setWorktrees(result.worktrees)).catch(() => setWorktrees([]));
  }, [directory]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const directories = recentScopeKey ? recentScopeKey.split("\n") : [];
      const lookups = recentLookupKey ? recentLookupKey.split("\n") : [];
      api
        .recentSessions(directories, lookups, MAX_VISIBLE_RECENT_SESSIONS)
        // An empty panel is a better failure than a stuck spinner: recents are
        // a convenience, and the full session list below is still authoritative.
        .then((result) => { if (!cancelled) setRecents(result.sessions); })
        .catch(() => { if (!cancelled) setRecents([]); });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, RECENTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [recentScopeKey, recentLookupKey]);

  useEffect(() => {
    setModelCatalogue(null);
    setSelectedModel(undefined);
    setInitialModel(undefined);
    setModelError(null);
    if (!directory) return;
    let cancelled = false;
    void api.models(directory).then((catalogue) => {
      if (cancelled) return;
      const defaultModel = catalogueDefault(catalogue);
      setModelCatalogue(catalogue);
      setSelectedModel(defaultModel);
      setInitialModel(defaultModel);
      setModelError(defaultModel ? null : "No enabled models are configured for this project.");
    }).catch((cause: Error) => {
      if (!cancelled) setModelError(`Model catalogue unavailable: ${cause.message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  const selectDirectory = (next: string) => {
    if (!next) return;
    setDirectoryInput(next);
    setSessions(null);
    setParams({ directory: next });
  };

  const applyDirectory = () => selectDirectory(directoryInput.trim());

  const togglePin = async (projectDirectory: string) => {
    if (pinsSaving) return;
    const next = pinnedDirectories.includes(projectDirectory)
      ? pinnedDirectories.filter((item) => item !== projectDirectory)
      : [...pinnedDirectories, projectDirectory];
    setPinsSaving(true);
    setProjectError(null);
    try {
      const result = await api.saveProjectPins(next);
      setPinnedDirectories(result.directories);
    } catch (e) {
      setProjectError((e as Error).message);
    } finally {
      setPinsSaving(false);
    }
  };

  const create = async () => {
    if (!prompt.trim() || !directory) return;
    setCreating(true);
    setError(null);
    try {
      const model = selectedModel && !sameModel(selectedModel, initialModel) ? selectedModel : undefined;
      const { session } = await api.createSession({ directory, prompt, isolated, mode, model });
      navigate(`/sessions/${session.id}?directory=${encodeURIComponent(session.directory)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const projectByDirectory = new Map((projects ?? []).map((project) => [project.directory, project]));
  for (const pinnedDirectory of pinnedDirectories) {
    if (projectByDirectory.has(pinnedDirectory)) continue;
    const beneathRoot = projectsRoot && (
      pinnedDirectory.startsWith(`${projectsRoot}/`) || pinnedDirectory.startsWith(`${projectsRoot}\\`)
    );
    const relativePath = beneathRoot ? pinnedDirectory.slice(projectsRoot.length + 1) : pinnedDirectory;
    projectByDirectory.set(pinnedDirectory, {
      name: relativePath.split(/[\\/]/).filter(Boolean).at(-1) ?? pinnedDirectory,
      relativePath,
      directory: pinnedDirectory,
      kind: "directory",
    });
  }
  const pinOrder = new Map(pinnedDirectories.map((item, index) => [item, index]));
  const normalizedSearch = projectSearch.trim().toLocaleLowerCase();
  const visibleProjects = [...projectByDirectory.values()]
    .filter((project) =>
      !normalizedSearch ||
      project.name.toLocaleLowerCase().includes(normalizedSearch) ||
      project.relativePath.toLocaleLowerCase().includes(normalizedSearch))
    .sort((left, right) => {
      const leftPin = pinOrder.get(left.directory);
      const rightPin = pinOrder.get(right.directory);
      if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
      if (leftPin !== undefined) return -1;
      if (rightPin !== undefined) return 1;
      return left.name.localeCompare(right.name) || left.relativePath.localeCompare(right.relativePath);
    });
  const selectedProject = projectByDirectory.get(directory);
  const showOtherWorkspace = Boolean(directory && projects && !selectedProject);
  const hasRunningSession = sessions?.some((session) => session.running) ?? false;
  const recentlyOpened = recents ? recentlyOpenedSessions(recents, recentOpens) : [];
  const recentlyActive = recents ? recentlyActiveSessions(recents) : [];
  // Cross-project, like Recents: running sessions and unresolved notification
  // sessions, both already fetched for other surfaces on this page.
  const attention = buildAttentionSummary(recents ?? [], notificationRecords);

  // Recents span projects, so every row needs a project label — two sessions
  // called "Fix the tests" are otherwise indistinguishable. Discovery only
  // covers PROJECTS_DIR, so worktrees and ad-hoc paths fall back to a basename.
  const projectLabel = (sessionDirectory: string) =>
    projectByDirectory.get(sessionDirectory)?.name
    ?? sessionDirectory.split(/[\\/]/).filter(Boolean).at(-1)
    ?? sessionDirectory;

  const recentList = (items: SessionSummary[], emptyMessage: string, testId: string) => (
    items.length === 0 ? (
      <p className="px-4 py-5 text-sm text-[var(--color-text-muted)]" data-testid={`${testId}-empty`}>
        {emptyMessage}
      </p>
    ) : (
      <SessionTreeList
        sessions={recents ?? []}
        selected={items}
        testId={testId}
        projectLabel={projectLabel}
      />
    )
  );

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6" data-testid="opencode-hub">
      <header className="flex flex-wrap items-end gap-3 pt-2">
        <div>
          <h1 className="text-[1.6rem] font-bold tracking-tight">What should the agent do?</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            One OpenCode server, every project. Pick a directory to scope the session.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="beta">beta</Badge>
          {health && (
            <span
              className="text-xs text-[var(--color-text-muted)]"
              data-testid="opencode-upstream-badge"
              title={health.upstream.url}
            >
              {health.upstream.reachable
                ? `agent ${health.upstream.version ?? "?"}`
                : "agent unreachable"}
            </span>
          )}
        </div>
      </header>

      {health && !health.upstream.reachable && (
        <Alert variant="danger" data-testid="opencode-upstream-down">
          Cannot reach the OpenCode server at {health.upstream.url}. Start one with{" "}
          <code>opencode serve --port 4096</code>.
        </Alert>
      )}
      {health?.upstream.versionMatches === false && (
        <Alert variant="warning" data-testid="opencode-version-skew">
          Server is {health.upstream.version}, this client targets {health.upstream.expected}.
          Response shapes may differ.
        </Alert>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
      {modelError && <Alert variant="danger" data-testid="opencode-model-error">{modelError}</Alert>}
      {projectError && <Alert variant="warning" data-testid="opencode-projects-error">Project picker: {projectError}</Alert>}

      {!attention.isEmpty && (
        <section
          className="overflow-hidden rounded-xl border border-[var(--color-text-warning)] bg-[var(--color-background-surface-warning-muted)]"
          data-testid="opencode-needs-attention"
        >
          <h2 className="flex items-center gap-2 border-b border-[var(--color-text-warning)] px-4 py-2 text-sm font-semibold text-[var(--color-text-warning)]">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
            Needs attention
          </h2>
          <ul>
            {attention.rows.map((row) => {
              // One row per session: a session that is both running and has
              // an unresolved notification carries both `session` and
              // `notification` here, rendered together rather than as two
              // separate rows.
              const title = row.session?.title ?? row.notification?.label ?? "";
              const route = row.session
                ? `/sessions/${row.session.id}?directory=${encodeURIComponent(row.session.directory)}`
                : row.notification?.route;
              const content = (
                <>
                  {row.running && <StatusPill status="running" />}
                  {row.notification && (
                    <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-background-surface-danger-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-danger)]">notif active</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {row.notification && (
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                      {row.notification.chips.map((chip) => `${chip.count} ${chip.kind}`).join(", ")}
                    </span>
                  )}
                  {row.session && (
                    <span className="max-w-[35%] shrink-0 truncate text-[11px] text-[var(--color-text-muted)]" title={row.session.directory}>
                      {projectLabel(row.session.directory)}
                    </span>
                  )}
                </>
              );
              return (
                <li key={row.key} data-testid="opencode-attention-row" data-running={row.running} data-notify={Boolean(row.notification)}>
                  {route ? (
                    <Link
                      to={route}
                      className="flex min-h-11 items-center gap-2 border-b border-[var(--color-text-warning)] px-4 py-2 text-sm last:border-b-0 hover:bg-[var(--hh-row-hover)]"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="flex min-h-11 items-center gap-2 border-b border-[var(--color-text-warning)] px-4 py-2 text-sm last:border-b-0">
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {recents !== null && (
        <section className="grid overflow-hidden rounded-xl border border-[var(--color-border-default)] sm:grid-cols-2" data-testid="opencode-recent-sessions">
          <div className="min-w-0 sm:border-r sm:border-[var(--color-border-default)]">
            <h2 className="border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold">Recently opened</h2>
            <div className="thin-scrollbar max-h-80 overflow-y-auto">
              {recentList(recentlyOpened, "Open a session to keep it handy here.", "opencode-recently-opened")}
            </div>
          </div>
          <div className="min-w-0 border-t border-[var(--color-border-default)] sm:border-t-0">
            <h2 className="border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold">Recently active</h2>
            <div className="thin-scrollbar max-h-80 overflow-y-auto">
              {recentList(recentlyActive, "No recent sessions in your pinned or recently opened projects.", "opencode-recently-active")}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-[var(--color-border-default)] p-4 sm:p-5" data-testid="opencode-new-task">
        <h2 className="mb-3 text-sm font-semibold">New task</h2>
        {directory && (() => {
          const { project, workspace } = splitProjectWorkspace(selectedProject?.relativePath ?? directory);
          return (
            <div className="mb-3 text-xs text-[var(--color-text-muted)]" data-testid="opencode-selected-directory" title={directory}>
              <p className="truncate">Project: <span className="text-[var(--color-text-default)]">{project}</span></p>
              {workspace && (
                <p className="truncate" data-testid="opencode-selected-workspace">Workspace: <span className="text-[var(--color-text-default)]">{workspace}</span></p>
              )}
            </div>
          );
        })()}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="What should the agent do?"
          className="mb-2 w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2 text-sm"
          data-testid="opencode-prompt"
        />
        {hasRunningSession && !isolated && (
          <Alert variant="warning" data-testid="opencode-session-collision-warning">
            Another agent is running in this workspace. Starting here may cause overlapping changes.
          </Alert>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AgentModeToggle mode={mode} onChange={setMode} testId="opencode-hub-mode" />
          <ModelPicker
            catalogue={modelCatalogue}
            value={selectedModel}
            onChange={setSelectedModel}
            testId="opencode-hub-model"
            label="Session model"
            disabled={!directory}
          />
          <Button
            onClick={() => void create()}
            disabled={creating || !prompt.trim() || !directory || !selectedModel}
            data-testid="opencode-start"
          >
            {creating ? "Starting…" : "Start agent"}
          </Button>
          {!directory && (
            <span className="text-[11px] text-[var(--color-text-muted)]">
              Set a project directory first.
            </span>
          )}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} data-testid="opencode-isolated-workspace" />
          Isolated workspace (creates an OpenCode worktree before the agent starts)
        </label>
        {directory && (
          <div className="mt-3">
            <AutoPermissionsControl directory={directory} testId="opencode-hub-auto-permissions" />
          </div>
        )}
      </section>

      {/* Rendered outside the collapsed picker below (default-closed) so an
          undiscovered URL workspace stays visible and actionable with zero
          interaction, matching the always-visible selected-directory summary
          in New Task above. */}
      {showOtherWorkspace && (
        <div
          className="flex min-w-0 items-stretch overflow-hidden rounded-xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-info-muted)]"
          data-testid="opencode-other-workspace"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-2 text-left"
            onClick={() => selectDirectory(directory)}
            aria-pressed="true"
            data-testid="opencode-project-select-other"
          >
            <span className="max-w-[45%] shrink-0 truncate text-xs font-semibold">Other workspace</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={directory}>{directory}</span>
          </button>
          <button
            type="button"
            className="m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-background-action-ghost-hover)] hover:text-[var(--color-text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
            onClick={() => void togglePin(directory)}
            disabled={pinsSaving}
            aria-label={`${pinOrder.has(directory) ? "Unpin" : "Pin"} other workspace`}
            aria-pressed={pinOrder.has(directory)}
            data-testid="opencode-project-pin-other"
          >
            <Pin aria-hidden="true" className="h-4 w-4" fill={pinOrder.has(directory) ? "currentColor" : "none"} />
          </button>
        </div>
      )}

      <details className="rounded-xl border border-[var(--color-border-default)]" data-testid="opencode-project-picker">
        <summary className="cursor-pointer list-none p-4 sm:p-5" data-testid="opencode-project-picker-toggle">
          <h2 className="inline text-sm font-semibold">1. Project</h2>
          <span className="ml-2 text-xs text-[var(--color-text-muted)]">{visibleProjects.length} projects</span>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">Pinned projects stay first on every device.</p>
        </summary>
        <div className="border-t border-[var(--color-border-default)] p-4 pt-3 sm:p-5 sm:pt-3">
          <label className="relative mb-3 block min-w-0" htmlFor="project-search">
            <span className="sr-only">Search projects</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              id="project-search"
              type="search"
              value={projectSearch}
              onChange={(event) => setProjectSearch(event.target.value)}
              placeholder="Search projects"
              className="h-10 w-full rounded-md border border-[var(--color-border-default)] bg-transparent pl-9 pr-3 text-sm"
              data-testid="opencode-project-search"
            />
          </label>

          {projects === null ? (
            <div className="py-6"><LoadingIndicator /></div>
          ) : (
            <div
              className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-[var(--color-border-default)] divide-y divide-[var(--color-border-default)]"
              data-testid="opencode-project-list"
            >
              {visibleProjects.map((project) => {
                const selected = project.directory === directory;
                const pinned = pinOrder.has(project.directory);
                return (
                  <div
                    key={project.directory}
                    className={
                      selected
                        ? "flex min-w-0 items-stretch bg-[var(--color-background-surface-info-muted)]"
                        : "flex min-w-0 items-stretch bg-[var(--color-background-surface)] hover:bg-[var(--hh-row-hover)]"
                    }
                    data-testid="opencode-project-card"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-2 text-left"
                      onClick={() => selectDirectory(project.directory)}
                      aria-pressed={selected}
                      data-testid="opencode-project-select"
                    >
                      <span className="max-w-[45%] shrink-0 truncate text-xs font-semibold">{project.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={project.relativePath}>{project.relativePath}</span>
                    </button>
                    <button
                      type="button"
                      className="m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-background-action-ghost-hover)] hover:text-[var(--color-text-default)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
                      onClick={() => void togglePin(project.directory)}
                      disabled={pinsSaving}
                      aria-label={`${pinned ? "Unpin" : "Pin"} ${project.name}`}
                      aria-pressed={pinned}
                      data-testid="opencode-project-pin"
                    >
                      <Pin aria-hidden="true" className="h-4 w-4" fill={pinned ? "currentColor" : "none"} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {projects !== null && visibleProjects.length === 0 && (
            <p className="py-5 text-center text-sm text-[var(--color-text-muted)]" data-testid="opencode-projects-empty">
              No projects match your search.
            </p>
          )}

          <details className="mt-3" data-testid="opencode-directory-advanced">
            <summary className="w-fit cursor-pointer text-xs font-medium text-[var(--color-text-action-ghost)]" data-testid="opencode-directory-advanced-toggle">
              Enter another path
            </summary>
            <label className="mb-1 mt-3 block text-xs text-[var(--color-text-muted)]" htmlFor="directory">
              Workspace directory (absolute path)
            </label>
            <div className="flex min-w-0 gap-2">
              <input
                id="directory"
                value={directoryInput}
                onChange={(e) => setDirectoryInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && applyDirectory()}
                placeholder="/Users/you/Projects/my-repo"
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border-default)] bg-transparent p-2 text-sm"
                data-testid="opencode-directory-input"
              />
              <Button variant="secondary" onClick={applyDirectory} data-testid="opencode-directory-apply">
                Use
              </Button>
            </div>
          </details>
        </div>
      </details>

      {directory && worktrees.length > 0 && (
        <details className="rounded-xl border border-[var(--color-border-default)]" data-testid="opencode-worktree-list">
          <summary className="cursor-pointer list-none border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold" data-testid="opencode-worktree-list-toggle">
            2. Workspace <span className="font-normal text-[var(--color-text-muted)]">({worktrees.length})</span>
          </summary>
          <ul className="max-h-72 divide-y divide-[var(--color-border-default)] overflow-y-auto">
            {worktrees.map((worktree) => (
              <li key={worktree.directory} className="flex min-w-0 items-center gap-2 p-3 text-sm">
                <Link to={`/opencode?directory=${encodeURIComponent(worktree.directory)}`} className="min-w-0 flex-1 truncate underline" data-testid="opencode-worktree-open">{worktree.name}</Link>
                <Button size="sm" variant="secondary" onClick={() => { if (window.confirm(`Hard-reset and clean ${worktree.name}?`)) void api.resetWorktree(directory, worktree.directory); }} data-testid="opencode-worktree-reset">Reset</Button>
                <Button size="sm" variant="danger" onClick={() => { if (window.confirm(`Force-delete ${worktree.name} and its branch?`)) void api.deleteWorktree(directory, worktree.directory).then(() => setWorktrees((items) => items.filter((item) => item.directory !== worktree.directory))); }} data-testid="opencode-worktree-delete">Delete</Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!directory ? (
        <p className="rounded-xl border border-[var(--color-border-default)] p-6 text-sm text-[var(--color-text-muted)]">
          Pick a project directory to list its sessions.
        </p>
      ) : (
        <details className="rounded-xl border border-[var(--color-border-default)]" data-testid="opencode-sessions-picker">
          <summary className="cursor-pointer list-none border-b border-[var(--color-border-default)] px-4 py-2 text-sm font-semibold" data-testid="opencode-sessions-picker-toggle">
            3. Existing sessions {sessions !== null && <span className="font-normal text-[var(--color-text-muted)]">({sessions.length})</span>}
          </summary>
          {sessions === null ? (
            <div className="p-6">
              <LoadingIndicator />
            </div>
          ) : sessions.length === 0 ? (
            <p className="p-6 text-sm text-[var(--color-text-muted)]" data-testid="opencode-sessions-empty">
              No sessions in this directory yet — start one above.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <SessionTreeList sessions={sessions} testId="opencode-session-list" showCost />
            </div>
          )}
        </details>
      )}
    </main>
  );
}
