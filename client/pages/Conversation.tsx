import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Boxes, ChevronDown, FolderOpen, GitPullRequest, Info, MessageSquareText, OctagonX, PersonStanding, Share2, WrapText } from "lucide-react";

import { Alert } from "../ds/alert.js";
import { Badge } from "../ds/badge.js";
import { Button } from "../ds/button.js";
import { LoadingIndicator } from "../ds/loading-indicator.js";
import { SessionShell } from "../components/session-shell.js";
import { SessionOverflowMenu } from "../components/session-overflow-menu.js";
import { SessionInspector } from "../components/session-inspector.js";
import { WorkspacePanels } from "../components/workspace-panels.js";
import { AgentModeToggle } from "../components/agent-mode-toggle.js";
import { AutoPermissionsControl } from "../components/auto-permissions-control.js";
import { ModelPicker } from "../components/model-picker.js";
import { QuestionRequest } from "../components/question-request.js";
import { ReminderPicker } from "../components/reminder-picker.js";
import { ShareExportDialog } from "../components/share-export-dialog.js";
import { WorkflowDialog } from "../components/workflow-dialog.js";
import { WorkflowPicker } from "../components/workflow-picker.js";
import { api, ApiError, formatCost, type ReminderSummary, type SessionSummary, type WorkflowSummary } from "../lib/api.js";
import { foreignAgentFromSession, latestModeMessageID, modeFromSession, type AgentMode } from "../lib/agentMode.js";
import { MAX_IMAGE_ATTACHMENTS, readImageAttachment, selectImageFiles, type ImageAttachment } from "../lib/attachments.js";
import { createComposerCollapseGuard } from "../lib/composerCollapse.js";
import { composerEnterAction } from "../lib/composerKeys.js";
import { collapseActionGroups, extractSessionLinks, mergeEvents, runningActivity } from "../lib/derive.js";
import { normalizeTranscript, type RawMessage } from "../lib/events.js";
import { parseInspectorTab, type InspectorTab } from "../lib/inspectorTabs.js";
import { referenceCandidatesFromEvents, type WorkspaceTarget } from "../lib/fileReferences.js";
import { WorkspaceReferenceProvider, useWorkspaceReferences } from "../lib/workspaceReferences.js";
import { useSessionStream } from "../lib/useSessionStream.js";
import type { TranscriptEvent } from "../lib/transcript.js";
import type { ShareTarget } from "../lib/sessionSharing.js";
import { recordRecentSessionOpen } from "../lib/recentSessions.js";
import {
  catalogueDefault,
  currentModelFromMessages,
  latestModelMessageID,
  modelKey,
  sameModel,
  sameModelID,
  type ModelCatalogue,
  type ModelSelection,
} from "../lib/models.js";
import { useTranscriptFollow } from "../lib/useTranscriptFollow.js";

const WRAP_KEY = "opencode.wrapOutput.v1";
const APP_NAME = "DCA";

/**
 * Session overflow items. Mirrors `nav-overflow-menu.tsx` so the two overflow
 * surfaces in the app look and behave the same; the class string is duplicated
 * rather than shared because `client/ds/` has no dropdown primitive yet and
 * extracting one would also have to absorb the notification popover and the
 * picker dialogs. See the pull request body for that follow-up.
 */
export function ConversationPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const directory = params.get("directory") ?? "";
  const panelParam = parseInspectorTab(params.get("panel"));

  useEffect(() => {
    if (directory && id) recordRecentSessionOpen(localStorage, directory, id);
  }, [directory, id]);

  const stream = useSessionStream(directory, id);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [wrap, setWrap] = useState(() => localStorage.getItem(WRAP_KEY) !== "off");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"files" | "changes">("files");
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [requestedInspectorTab, setRequestedInspectorTab] = useState<InspectorTab | undefined>();
  const appliedPanelScope = useRef("");
  const [contextLimit, setContextLimit] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [reminderCatalogue, setReminderCatalogue] = useState<ReminderSummary[]>([]);
  const [selectedReminder, setSelectedReminder] = useState("");
  const [workflowCatalogue, setWorkflowCatalogue] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowSummary | null>(null);
  const [mode, setMode] = useState<AgentMode>("build");
  const [agentIdentityKnown, setAgentIdentityKnown] = useState(false);
  // A session driven by an arbitrary roster agent (issue #52, narrowed):
  // identity is preserved and displayed, never remapped to Plan/Build.
  const [foreignAgent, setForeignAgent] = useState<string | null>(null);
  // null = unchecked, true/false = live roster verdict. Only true enables send.
  const [foreignAgentAvailable, setForeignAgentAvailable] = useState<boolean | null>(null);
  const derivedModeMessage = useRef<string | undefined>(undefined);
  const modeSelectionDirty = useRef(false);
  const [replyingPermission, setReplyingPermission] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [modelCatalogue, setModelCatalogue] = useState<ModelCatalogue | null>(null);
  const [currentModel, setCurrentModel] = useState<ModelSelection | undefined>();
  const [selectedModel, setSelectedModel] = useState<ModelSelection | undefined>();
  const [modelError, setModelError] = useState<string | null>(null);
  const derivedModelMarker = useRef<string | undefined>(undefined);
  const modelSelectionDirty = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const composerCardRef = useRef<HTMLFormElement | null>(null);
  const [autoSafetyOpen, setAutoSafetyOpen] = useState(false);
  const collapseGuard = useRef(createComposerCollapseGuard());
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stopTriggerRef = useRef<HTMLButtonElement | null>(null);
  const stopDialogRef = useRef<HTMLElement | null>(null);
  const [parent, setParent] = useState<SessionSummary | null>(null);

  useEffect(() => {
    if (session?.title) document.title = `${session.title} | ${APP_NAME}`;
  }, [session?.title]);

  useEffect(() => {
    const protectDraft = (event: Event) => {
      if (draft.trim() || attachments.length) event.preventDefault();
    };
    window.addEventListener("opencode:before-app-refresh", protectDraft);
    return () => window.removeEventListener("opencode:before-app-refresh", protectDraft);
  }, [draft, attachments.length]);

  // Keep event identity stable across polls so memoised rows do not churn.
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const eventScope = useRef(`${directory}\0${id}`);
  const transcript = useMemo(
    () => normalizeTranscript(stream.messages as RawMessage[], { isRunning: stream.running }),
    [stream.messages, stream.running],
  );
  useEffect(() => {
    if (!panelParam) return;
    const scope = `${id}:${panelParam}`;
    if (appliedPanelScope.current === scope) return;
    appliedPanelScope.current = scope;
    setRequestedInspectorTab(panelParam);
    if (panelParam === "reviews" || panelParam === "catalog" || window.matchMedia("(max-width: 1023.98px)").matches) {
      setInspectorOpen(true);
    }
  }, [id, panelParam]);
  useEffect(() => {
    const scope = `${directory}\0${id}`;
    setEvents((previous) => {
      if (eventScope.current !== scope) {
        eventScope.current = scope;
        return transcript.events;
      }
      return mergeEvents(previous, transcript.events);
    });
  }, [directory, id, transcript.events]);

  useEffect(() => {
    if (!stream.loaded) return;
    const managedAgent = session?.managed?.requestedAgent;
    const marker = `${session?.agent ?? ""}:${managedAgent ?? ""}:${latestModeMessageID(stream.messages as RawMessage[]) ?? ""}`;
    if (marker === derivedModeMessage.current) return;
    derivedModeMessage.current = marker;
    if (managedAgent) {
      modeSelectionDirty.current = false;
      setAgentIdentityKnown(true);
      setForeignAgent(null);
      setMode(managedAgent === "plan" || managedAgent === "explore" ? "plan" : "build");
      return;
    }
    const persistedMode = modeFromSession(session?.agent, stream.messages as RawMessage[]);
    if (persistedMode) {
      setForeignAgent(null);
      setAgentIdentityKnown(true);
      if (modeSelectionDirty.current && persistedMode !== mode) return;
      modeSelectionDirty.current = false;
      setMode(persistedMode);
      return;
    }
    // Not Plan/Build: a consistent foreign identity is promptable with its own
    // agent once the live roster confirms the agent still exists.
    const foreign = foreignAgentFromSession(session?.agent, stream.messages as RawMessage[]) ?? null;
    setForeignAgent(foreign);
    setAgentIdentityKnown(false);
  }, [mode, session?.agent, session?.managed?.requestedAgent, stream.loaded, stream.messages]);

  useEffect(() => {
    if (!foreignAgent || !directory) {
      setForeignAgentAvailable(null);
      return;
    }
    let cancelled = false;
    setForeignAgentAvailable(null);
    void api.sessionAgents(directory)
      .then((result) => {
        if (cancelled) return;
        setForeignAgentAvailable(result.agents.some((agent) => agent.id === foreignAgent));
      })
      .catch(() => {
        // Roster unavailable = agent unverifiable = keep the composer closed.
        if (!cancelled) setForeignAgentAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, foreignAgent]);

  const selectMode = (nextMode: AgentMode) => {
    modeSelectionDirty.current = true;
    setMode(nextMode);
  };

  useEffect(() => {
    if (!stream.loaded) return;
    const persisted = currentModelFromMessages(stream.messages as RawMessage[], session?.model);
    const marker = `${latestModelMessageID(stream.messages as RawMessage[]) ?? "session"}:${persisted ? `${modelKey(persisted)}:${persisted.variant ?? ""}` : ""}`;
    if (marker === derivedModelMarker.current) return;
    derivedModelMarker.current = marker;
    setCurrentModel(persisted);
    if (modelSelectionDirty.current && !sameModel(persisted, selectedModel)) return;
    modelSelectionDirty.current = false;
    setSelectedModel(persisted);
  }, [selectedModel, session?.model, stream.loaded, stream.messages]);

  const selectModel = (model: ModelSelection) => {
    modelSelectionDirty.current = true;
    setSelectedModel(model);
  };

  useEffect(() => {
    if (!directory || !id) return;
    let cancelled = false;
    api
      .session(directory, id)
      .then((r) => !cancelled && setSession(r.session))
      .catch(() => undefined)
      .finally(() => !cancelled && setSessionLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [directory, id, stream.running]);

  useEffect(() => {
    if (!directory || !id) return;
    void api.modelLimit(directory, id).then((result) => setContextLimit(result.context)).catch(() => setContextLimit(null));
  }, [directory, id]);

  // A sub-agent transcript is meaningless without the work that spawned it,
  // and the parent id alone is not navigable in the UI. Resolve it to a title
  // so the banner can name the session it links to; a failure degrades to the
  // link without a title rather than hiding the route back.
  const parentID = session?.parentID;
  useEffect(() => {
    setParent(null);
    if (!directory || !parentID) return;
    let cancelled = false;
    void api.session(directory, parentID)
      .then((result) => !cancelled && setParent(result.session))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [directory, parentID]);

  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    void api.models(directory).then((catalogue) => {
      if (cancelled) return;
      setModelCatalogue(catalogue);
      setModelError(null);
    }).catch((cause: Error) => {
      if (!cancelled) setModelError(`Model catalogue unavailable: ${cause.message}`);
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  useEffect(() => {
    if (!modelCatalogue || !stream.loaded || !sessionLoaded || currentModel || selectedModel) return;
    if (currentModelFromMessages(stream.messages as RawMessage[], session?.model)) return;
    const fallback = catalogueDefault(modelCatalogue);
    if (fallback) {
      setCurrentModel(fallback);
      setSelectedModel(fallback);
    }
  }, [currentModel, modelCatalogue, selectedModel, session?.model, sessionLoaded, stream.loaded, stream.messages]);

  // Reminders are directory-scoped, so this must re-run when the project
  // changes. With an empty dependency array a repository-scoped reminder
  // fetched for project A stayed on screen after switching to project B.
  useEffect(() => {
    let cancelled = false;
    if (!directory) {
      setReminderCatalogue([]);
      return;
    }
    void api.reminders(directory).then((result) => {
      if (!cancelled) setReminderCatalogue(result.reminders);
    }).catch(() => {
      // Fail closed: dropping the stale catalogue is the safe outcome, because
      // keeping it would leave another project's scoped reminders on screen.
      if (!cancelled) setReminderCatalogue([]);
    });
    return () => {
      cancelled = true;
    };
  }, [directory]);

  useEffect(() => {
    let cancelled = false;
    void api.workflows().then((result) => {
      if (!cancelled) setWorkflowCatalogue(result.workflows);
    }).catch(() => {
      // Workflows are not directory-scoped; an unreachable catalogue only
      // hides the picker.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => collapseActionGroups(events), [events]);
  const activity = useMemo(() => runningActivity(events), [events]);
  const sessionLinkCount = useMemo(() => extractSessionLinks(events).total, [events]);

  // Reference validation is derived from the transcript rather than from
  // rendering, so a streaming turn produces one batched request per new set of
  // paths instead of one per rendered code span.
  const referenceCandidates = useMemo(
    () => referenceCandidatesFromEvents(events, directory),
    [directory, events],
  );
  const resolvedReferences = useWorkspaceReferences(directory, referenceCandidates);
  // Opening a file must not change the route or the transcript scroll: the
  // drawer is an overlay and the transcript stays mounted underneath it.
  const openWorkspaceTarget = useCallback((target: WorkspaceTarget) => {
    setWorkspaceTarget(target);
    setWorkspaceTab("files");
    setWorkspaceOpen(true);
  }, []);
  // The change modal offers this when historical detail is unavailable, so it
  // must land on the working-tree diff rather than the file browser.
  const openWorkspaceChanges = useCallback(() => {
    setWorkspaceTarget(null);
    setWorkspaceTab("changes");
    setWorkspaceOpen(true);
  }, []);
  const clearWorkspaceTarget = useCallback(() => setWorkspaceTarget(null), []);
  const latestUsage = transcript.usage.at(-1);
  const contextTokens = latestUsage
    ? latestUsage.tokens.input + latestUsage.tokens.output + latestUsage.tokens.reasoning + latestUsage.tokens.cacheRead + latestUsage.tokens.cacheWrite
    : 0;
  const selectedModelDetails = modelCatalogue?.models.find((model) => sameModelID(model, selectedModel));
  const displayedContextLimit = selectedModelDetails?.limits.context ?? contextLimit;

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((state) => ({ ...state, [groupId]: !state[groupId] }));
  }, []);
  const exportMessage = useCallback((event: Extract<TranscriptEvent, { kind: "user" | "agent" }>) => {
    setShareTarget({ kind: "message", messageId: event.messageId, role: event.kind === "user" ? "user" : "assistant" });
  }, []);

  const toggleWrap = () => {
    setWrap((value) => {
      localStorage.setItem(WRAP_KEY, value ? "off" : "on");
      return !value;
    });
  };

  const dismissStopConfirmation = useCallback(() => {
    if (stopping) return;
    if ((window.history.state as { opencodeStopConfirmation?: boolean } | null)?.opencodeStopConfirmation) {
      window.history.back();
    } else {
      setStopConfirmOpen(false);
    }
  }, [stopping]);

  useEffect(() => {
    if (!stopConfirmOpen) return;
    if (!(window.history.state as { opencodeStopConfirmation?: boolean } | null)?.opencodeStopConfirmation) {
      window.history.pushState({ opencodeStopConfirmation: true }, "");
    }
    const onPopState = () => setStopConfirmOpen(false);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismissStopConfirmation();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    stopDialogRef.current?.focus();
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
      stopTriggerRef.current?.focus();
    };
  }, [dismissStopConfirmation, stopConfirmOpen]);

  const stopRun = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await api.abort(directory, id);
      stream.refresh();
      setStopConfirmOpen(false);
      if ((window.history.state as { opencodeStopConfirmation?: boolean } | null)?.opencodeStopConfirmation) {
        window.history.back();
      }
    } catch (error) {
      setStopError(`Could not stop the run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStopping(false);
    }
  };

  // Follow live output only while the reader remains near the bottom. Depending
  // on the event array (not its length) also covers a streaming row growing in
  // place rather than only newly appended rows.
  const follow = useTranscriptFollow(events, `${directory}\0${id}`);

  // The composer grows with its content instead of showing a resize grabber.
  // `min-h-24` still floors the box, so a one-line draft keeps the same 96px
  // target the mobile layout is measured against.
  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const foreignReady = foreignAgent !== null && foreignAgentAvailable === true;
  const canPrompt = agentIdentityKnown || foreignReady;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setComposerError(null);
    try {
      const modelOverride = selectedModel && !sameModel(selectedModel, currentModel) ? selectedModel : undefined;
      await api.prompt(
        directory,
        id,
        text,
        foreignReady && foreignAgent ? { agent: foreignAgent } : { mode },
        modelOverride,
        attachments,
        selectedReminder || undefined,
        selectedWorkflow || undefined,
      );
      setDraft("");
      setAttachments([]);
      // Per-message choices: never let a reminder or a workflow injector
      // silently ride on later turns.
      setSelectedReminder("");
      setSelectedWorkflow("");
      if (modelOverride) {
        setCurrentModel(modelOverride);
        modelSelectionDirty.current = false;
      }
      stream.refresh();
    } catch (error) {
      if (error instanceof ApiError &&
          (error.code === "SESSION_AGENT_UNKNOWN" || error.code === "SESSION_AGENT_UNSUPPORTED" ||
            error.code === "SESSION_AGENT_MISMATCH" || error.code === "SESSION_AGENT_UNAVAILABLE")) {
        setComposerError(error.message);
      } else {
        setComposerError(`Could not send the prompt: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setSending(false);
    }
  };

  // Policy lives in composerKeys.ts so the coarse-pointer and IME branches are
  // unit tested; this only wires it to the DOM event.
  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerEnterAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
      },
      {
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
        // `send()` has no re-entry guard and prompt_async returns as soon as
        // the turn is queued, so a fast double Enter would post two turns.
        canSubmit: canPrompt && !sending && draft.trim().length > 0,
      },
    );
    if (action.preventDefault) event.preventDefault();
    if (action.submit) void send();
  };

  const replyToPermission = async (requestId: string, reply: "once" | "always" | "reject") => {
    setReplyingPermission(requestId);
    setPermissionError(null);
    try {
      await stream.replyPermission(requestId, reply);
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error));
    } finally {
      setReplyingPermission(null);
    }
  };

  const addAttachments = (files: Iterable<File>) => {
    const selection = selectImageFiles(files, attachments.length);
    setAttachmentError(selection.error);
    if (!selection.files.length) return;
    void Promise.all(selection.files.map(readImageAttachment))
      .then((next) => setAttachments((items) => [...items, ...next].slice(0, MAX_IMAGE_ATTACHMENTS)))
      .catch(() => setAttachmentError("Could not read the selected image."));
  };

  if (!directory) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Alert variant="danger">A `directory` query parameter is required to open a session.</Alert>
      </main>
    );
  }

  return (
    <SessionShell
      browserSessionID={id}
      testIds={{
        root: "opencode-conversation",
        title: "opencode-session-title",
        transcript: "opencode-transcript",
        jumpToLatest: "opencode-jump-to-latest",
        composerCard: "opencode-composer-card",
        textarea: "opencode-composer",
        send: "opencode-send",
        actions: "opencode-mobile-conversation-actions",
      }}
      header={{
        backLink: (
          <Link to={`/opencode?directory=${encodeURIComponent(directory)}`} className="hidden shrink-0 text-sm underline sm:inline">
            ← Sessions
          </Link>
        ),
        title: session?.title ?? "Session",
        badges: (
          <>
          {/* A validated Managed Child was authorized by a human; an ordinary
              delegated child keeps the neutral badge. */}
          {parentID && (session?.managed
            ? <Badge variant="info" data-testid="opencode-subagent-badge" data-managed="true">Managed Child</Badge>
            : <Badge variant="neutral" data-testid="opencode-subagent-badge" data-managed="false">sub</Badge>)}
          {stream.running && <Badge variant="info">running</Badge>}
          {stream.running && <button
            ref={stopTriggerRef}
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--color-text-danger)] hover:bg-[var(--color-background-surface-danger-muted)]"
            onClick={() => { setStopError(null); setStopConfirmOpen(true); }}
            aria-label="Stop running agent"
            title="Stop running agent"
            data-testid="opencode-mobile-stop-open"
          >
            <OctagonX aria-hidden="true" className="h-4 w-4" />
          </button>}
          </>
        ),
        stats: (
          <div className="hidden min-w-0 items-center gap-2 text-xs tabular-nums text-[var(--color-text-muted)] sm:flex">
            {session && session.cost > 0 && <span data-testid="opencode-session-cost">{formatCost(session.cost)}</span>}
            {contextTokens > 0 && (
              <span data-testid="opencode-context-tokens" title="Latest turn context tokens">
                context {Intl.NumberFormat(undefined, { notation: "compact" }).format(contextTokens)}
                {displayedContextLimit ? ` / ${Math.round((contextTokens / displayedContextLimit) * 100)}%` : ""}
              </span>
            )}
          </div>
        ),
        actions: (
          <>
          <Button
            size="md"
            variant="ghost"
            className="min-h-11 min-w-12 px-0"
            onClick={() => { setWorkspaceTab("files"); setWorkspaceOpen(true); }}
            aria-label="Open workspace"
            title="Open workspace"
            data-testid="opencode-mobile-workspace-open"
          >
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="md"
            variant="ghost"
            className="relative min-h-11 min-w-12 px-0"
            onClick={() => {
              setRequestedInspectorTab("reviews");
              setInspectorOpen(true);
            }}
            aria-label={sessionLinkCount ? `Open reviews, ${sessionLinkCount} ${sessionLinkCount === 1 ? "link" : "links"}` : "Open reviews"}
            title="Open reviews"
            data-testid="opencode-mobile-reviews-open"
          >
            <GitPullRequest aria-hidden="true" className="h-3.5 w-3.5" />
            {sessionLinkCount > 0 && (
              <span
                aria-hidden
                data-testid="opencode-mobile-reviews-count"
                className="absolute right-1 top-1 inline-flex min-w-[1rem] items-center justify-center px-1 py-0.5 text-[9px] font-semibold leading-none text-[var(--color-text-muted)]"
              >
                {sessionLinkCount}
              </span>
            )}
          </Button>
          <AutoPermissionsControl
            directory={directory}
            testId="opencode-mobile-auto-permissions"
            variant="pill"
            trailing={
              <Button size="md" variant="ghost" className="min-h-9 min-w-9 rounded-lg px-0" onClick={() => setAutoSafetyOpen(true)} aria-label="Auto permissions safety" title="Auto permissions safety" data-testid="opencode-mobile-auto-permissions-info">
                <Info aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <Button
            size="md"
            variant="ghost"
            className="min-h-11 min-w-12 px-0"
            onClick={() => {
              setRequestedInspectorTab("runlog");
              setInspectorOpen(true);
            }}
            aria-label="Open run log"
            title="Open run log"
            data-testid="opencode-mobile-runlog-open"
          >
            <PersonStanding aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <SessionOverflowMenu
            testIds={{ root: "opencode-mobile-session-menu", trigger: "opencode-mobile-session-menu-trigger", panel: "opencode-mobile-session-menu-panel" }}
            items={[
              { id: "wrap", label: wrap ? "Disable wrapping" : "Enable wrapping", icon: <WrapText aria-hidden="true" size={15} />, onSelect: toggleWrap, testId: "opencode-mobile-wrap-toggle" },
              { id: "share", label: "Share", icon: <Share2 aria-hidden="true" size={15} />, onSelect: () => setShareTarget({ kind: "session" }), testId: "opencode-mobile-share-export-open" },
              { id: "catalog", label: "Catalog", icon: <Boxes aria-hidden="true" size={15} />, onSelect: () => { setRequestedInspectorTab("catalog"); setInspectorOpen(true); }, testId: "opencode-mobile-catalog-open" },
            ]}
          />
          </>
        ),
      }}
      banners={(
        <>
      {parentID && (
        <div className="px-3 pt-2 sm:px-4 sm:pt-3" data-testid="opencode-parent-link">
          <p className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            Delegated by{" "}
            <Link
              to={`/sessions/${parentID}?directory=${encodeURIComponent(directory)}`}
              className="font-semibold text-[var(--color-text-info)] underline-offset-2 hover:underline"
              data-testid="opencode-parent-open"
            >
              {parent?.title ?? "the parent session"}
            </Link>
            . Follow-ups here do not reach the parent.
          </p>
        </div>
      )}

      {/* R2: OpenCode never persists "running" state, so a crash mid-turn is
          invisible unless derived. We surface it and let the human decide —
          Resume prefills the composer rather than auto-sending, because
          replaying an interrupted turn can redo destructive work. */}
      {transcript.interrupted.interrupted && (
        <div className="px-4 pt-3" data-testid="opencode-interrupted">
          <Alert variant="warning">
            <span className="font-medium">
              {transcript.interrupted.reason === "never-answered"
                ? "This prompt was never answered."
                : "This run did not finish."}
            </span>{" "}
            The agent is not working on it now.{" "}
            <button
              type="button"
              className="underline"
              data-testid="opencode-resume"
              onClick={() => setDraft("Continue where you left off.")}
            >
              Resume
            </button>{" "}
            to put a follow-up in the composer.
          </Alert>
        </div>
      )}

      {stream.error && (
        <div className="px-4 pt-3">
          <Alert variant="danger" data-testid="opencode-error-banner">
            {stream.error}
          </Alert>
        </div>
      )}
      {modelError && (
        <div className="px-4 pt-3">
          <Alert variant="warning" data-testid="opencode-model-error">{modelError}</Alert>
        </div>
      )}

      {stream.permissions.map((permission) => (
        <div className="px-4 pt-3" key={permission.id} data-testid="opencode-permission-request">
          <Alert variant="warning">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-sm"><strong>{permission.permission}</strong> needs approval{permission.patterns.length ? `: ${permission.patterns.join(", ")}` : ""}</span>
              <Button size="sm" disabled={replyingPermission !== null} onClick={() => void replyToPermission(permission.id, "once")} data-testid="opencode-permission-once">{replyingPermission === permission.id ? "Approving..." : "Allow once"}</Button>
              <Button size="sm" variant="secondary" disabled={replyingPermission !== null} onClick={() => void replyToPermission(permission.id, "always")} data-testid="opencode-permission-always">Always</Button>
              <Button size="sm" variant="danger" disabled={replyingPermission !== null} onClick={() => void replyToPermission(permission.id, "reject")} data-testid="opencode-permission-reject">Reject</Button>
            </div>
          </Alert>
        </div>
      ))}
      {permissionError && (
        <div className="px-4 pt-3" data-testid="opencode-permission-error">
          <Alert variant="danger">Could not answer the permission request: {permissionError}</Alert>
        </div>
      )}
        </>
      )}
      prompts={stream.questions.length > 0 ? stream.questions.map((request) => (
        <QuestionRequest key={request.id} directory={directory} sessionID={id} request={request} onResolved={stream.refresh} />
      )) : undefined}
      transcript={{
        items,
        wrap,
        collapsedGroups,
        onToggleGroup: toggleGroup,
        onExport: exportMessage,
        directory,
        sessionId: id,
        onOpenWorkspaceChanges: openWorkspaceChanges,
        referenceProvider: (children) => (
          <WorkspaceReferenceProvider directory={directory} resolved={resolvedReferences} onOpen={openWorkspaceTarget}>{children}</WorkspaceReferenceProvider>
        ),
        loaded: stream.loaded,
        running: stream.running,
        activity,
        loadingState: <LoadingIndicator />,
        emptyState: (
          <p className="py-16 text-center text-sm text-[var(--color-text-muted)]">
            No transcript events yet.
          </p>
        ),
      }}
      scroll={{
        scrollerRef: follow.scrollerRef,
        contentRef: follow.contentRef,
        onScroll: follow.onScroll,
        showNewActivity: follow.newActivity,
        onJumpToLatest: follow.jumpToLatest,
        beforeTranscript: (
          <>
            {stream.loaded && stream.hasEarlier && (
              <div className="mb-6 flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={stream.loadingEarlier}
                  onClick={() => void stream.loadEarlier()}
                  aria-label="Load earlier transcript messages"
                  data-testid="opencode-load-earlier"
                >
                  {stream.loadingEarlier ? "Loading earlier..." : "Load earlier"}
                </Button>
              </div>
            )}
            {stream.loadEarlierError && (
              <div className="mb-6" role="alert" data-testid="opencode-load-earlier-error">
                <Alert variant="danger">Could not load earlier messages: {stream.loadEarlierError}</Alert>
              </div>
            )}
          </>
        ),
      }}
      composer={{
        draft,
        onDraftChange: setDraft,
        composerRef,
        onKeyDown: submitOnEnter,
        onFocus: () => {
                setComposerCollapsed(false);
                collapseGuard.current.markComposerFocus();
              },
        onBlur: () => {
                requestAnimationFrame(() => {
                  if (collapseGuard.current.shouldCollapseOnBlur({
                    narrowViewport: window.matchMedia("(max-width: 639.98px)").matches,
                    focusInsideComposer: composerCardRef.current?.contains(document.activeElement) ?? false,
                  })) {
                    setComposerCollapsed(true);
                  }
                });
              },
        onPaste: (event) => {
                const images = [...event.clipboardData.items]
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (images.length) addAttachments(images);
              },
        placeholder: "Send a follow-up…",
        disabled: false,
        onSubmit: () => void send(),
        submitLabel: sending ? "Sending…" : "Send",
        submitDisabled: !canPrompt || sending || !draft.trim(),
        wrapperRef: composerCardRef,
        onControlsPointerDownCapture: () => collapseGuard.current.markControlInteraction(),
        collapsedBar: composerCollapsed ? (
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--color-border-default)] px-3 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)]"
              onClick={() => {
                setComposerCollapsed(false);
                requestAnimationFrame(() => composerRef.current?.focus());
              }}
              data-testid="opencode-composer-expand"
            >
              <MessageSquareText aria-hidden="true" className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">{draft.trim() || "Write a follow-up"}</span>
              {attachments.length > 0 && <span className="text-xs">{attachments.length} attached</span>}
            </button>
        ) : undefined,
        modeControl: (
          <>
            {session?.managed ? (
              <div className="flex min-h-10 items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)] px-3 text-sm" data-testid="opencode-managed-child-agent-fixed">
                Managed Child · <span className="ml-1 font-semibold">{session.managed.requestedAgent[0].toUpperCase() + session.managed.requestedAgent.slice(1)}</span>
              </div>
            ) : foreignAgent ? (
              // Identity is preserved, never remapped: the session's own agent
              // is the only prompt identity offered here (issue #52, narrowed).
              <div className="flex min-h-10 items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)] px-3 text-sm" data-testid="opencode-session-agent-fixed" data-available={foreignAgentAvailable === null ? "checking" : String(foreignAgentAvailable)}>
                Agent · <span className="ml-1 font-semibold">{foreignAgent}</span>
              </div>
            ) : (
              <AgentModeToggle mode={agentIdentityKnown ? mode : undefined} onChange={selectMode} disabled={!agentIdentityKnown} testId="opencode-composer-mode" />
            )}
          </>
        ),
        modelPicker: (
            <ModelPicker
              catalogue={modelCatalogue}
              value={selectedModel}
              onChange={selectModel}
              testId="opencode-composer-model"
              label="Model"
              midConversation={transcript.events.length > 0}
            />
        ),
        controlsRowEnd: (
          <>
            <button
              type="button"
              className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)]"
              onClick={() => setComposerCollapsed(true)}
              aria-label="Collapse composer"
              title="Collapse composer"
              data-testid="opencode-composer-collapse"
            >
              <ChevronDown aria-hidden="true" className="h-4 w-4" />
            </button>
            <span className={`${!canPrompt || selectedModel && !sameModel(selectedModel, currentModel) ? "block" : "hidden"} basis-full text-[11px] text-[var(--color-text-muted)]`} data-testid="opencode-current-model">
              {canPrompt
                ? "switches next message"
                : foreignAgent && foreignAgentAvailable === false
                  ? `Agent "${foreignAgent}" is not available on the connected server; the session cannot be prompted from here.`
                  : foreignAgent
                    ? `Verifying agent "${foreignAgent}" against the live roster…`
                    : "Agent identity unavailable; continue in the TUI or create a web session"}
            </span>
          </>
        ),
        beforeTextarea: (
          <>
          {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map((attachment, index) => <button key={`${attachment.filename}-${index}`} type="button" onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))} className="rounded border border-[var(--color-border-default)] px-2 py-1 text-xs" data-testid="opencode-attachment-chip">{attachment.filename} x</button>)}</div>}
          {attachments.length > 0 && selectedModelDetails && !selectedModelDetails.capabilities.image && (
            <p className="mb-2 text-xs text-[var(--color-text-warning)]" data-testid="opencode-model-image-warning">
              The selected model does not advertise image support.
            </p>
          )}
          {attachmentError && <p className="mb-2 text-xs text-[var(--color-text-danger)]" role="alert" data-testid="opencode-attachment-error">{attachmentError}</p>}
          {composerError && <p className="mb-2 text-xs text-[var(--color-text-danger)]" role="alert" data-testid="opencode-composer-error">{composerError}</p>}
          </>
        ),
        bottomRailStart: (
          <>
              <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-md px-2.5 text-xs font-semibold text-[var(--color-text-muted)] hover:bg-[var(--hh-row-hover)] hover:text-[var(--color-text-default)] sm:min-h-8" data-testid="opencode-attach-label">
                Attach
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="sr-only" data-testid="opencode-attach" onChange={(event) => {
                  addAttachments(event.target.files ?? []);
                  event.target.value = "";
                }} />
              </label>
              {reminderCatalogue.length > 0 && (
                <ReminderPicker
                  catalogue={reminderCatalogue}
                  value={selectedReminder}
                  onChange={setSelectedReminder}
                />
              )}
              {workflowCatalogue.length > 0 && (
                <WorkflowPicker
                  catalogue={workflowCatalogue}
                  attached={selectedWorkflow}
                  onDetach={() => setSelectedWorkflow("")}
                  onPick={setActiveWorkflow}
                />
              )}
          </>
        ),
      }}
      inspector={{
        desktop: (
        <SessionInspector
          directory={directory}
          sessionID={id}
          events={events}
          todos={stream.todos}
          todosLoaded={stream.todosLoaded}
          todosError={stream.todosError}
          requestedTab={requestedInspectorTab}
          mobileOpen={inspectorOpen}
          onMobileClose={() => setInspectorOpen(false)}
          modelCatalogue={modelCatalogue}
          defaultModel={selectedModel}
        />
        ),
      }}
      overlays={(
        <>
      {workspaceOpen && (
        <WorkspacePanels
          directory={directory}
          onClose={() => setWorkspaceOpen(false)}
          target={workspaceTarget}
          onTargetConsumed={clearWorkspaceTarget}
          initialTab={workspaceTab}
        />
      )}
      {autoSafetyOpen && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-start sm:p-4 sm:pt-[10vh]" data-testid="opencode-mobile-auto-permissions-safety-sheet">
          <button type="button" className="absolute inset-0 bg-[var(--color-background-overlay)]" aria-label="Close auto permissions safety" onClick={() => setAutoSafetyOpen(false)} data-testid="opencode-mobile-auto-permissions-safety-scrim" />
          <section className="relative w-full rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-xl" role="dialog" aria-modal="true" aria-label="Auto permissions safety">
            <div className="flex items-center gap-2"><h2 className="text-sm font-semibold">Auto permissions safety</h2><button type="button" className="ml-auto min-h-11 min-w-11 rounded text-sm" onClick={() => setAutoSafetyOpen(false)} aria-label="Close auto permissions safety" data-testid="opencode-mobile-auto-permissions-safety-close">Close</button></div>
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">Auto permissions approves every asked permission once, including arbitrary shell commands, external-directory access, and repeated requests from a doom loop. This affects every session using this project directory and resets to off when the BFF restarts.</p>
          </section>
        </div>
      )}
      {stopConfirmOpen && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4" data-testid="opencode-stop-confirmation">
          <button type="button" className="absolute inset-0 bg-[var(--color-background-overlay)] disabled:cursor-wait" aria-label="Keep running" disabled={stopping} onClick={dismissStopConfirmation} data-testid="opencode-stop-confirmation-scrim" />
          <section ref={stopDialogRef} tabIndex={-1} className="relative w-full rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-md sm:rounded-xl" role="dialog" aria-modal="true" aria-labelledby="stop-confirmation-title">
            <h2 id="stop-confirmation-title" className="text-base font-semibold">Stop this run?</h2>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">The agent will stop immediately. Its current work may be incomplete.</p>
            {stopError && <p className="mt-3 text-sm text-[var(--color-text-danger)]" role="alert" data-testid="opencode-stop-error">{stopError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="secondary" disabled={stopping} onClick={dismissStopConfirmation} data-testid="opencode-stop-keep-running">Keep running</Button>
              <Button type="button" variant="danger" disabled={stopping} onClick={() => void stopRun()} data-testid="opencode-stop-confirm">{stopping ? "Stopping..." : "Stop agent"}</Button>
            </div>
          </section>
        </div>
      )}
      {activeWorkflow && (
        <WorkflowDialog
          workflow={activeWorkflow}
          directory={directory}
          sessionID={id}
          mode={mode}
          modelCatalogue={modelCatalogue}
          defaultModel={selectedModel}
          onClose={() => setActiveWorkflow(null)}
          onApplyToComposer={(draftText, workflowID) => {
            setDraft(draftText);
            setSelectedWorkflow(workflowID);
            setActiveWorkflow(null);
            setComposerCollapsed(false);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          onSent={() => stream.refresh()}
        />
      )}
      {shareTarget && session && (
        <ShareExportDialog
          directory={directory}
          sessionID={id}
          title={session?.title ?? "Session"}
          events={events}
          target={shareTarget}
          session={session}
          onSessionChange={setSession}
          onClose={() => setShareTarget(null)}
        />
      )}
        </>
      )}
    />
  );
}
