import { useDeferredValue, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import {
  api,
  RootSessionLaunchApiError,
  type ManagedChildAgent,
  type ManagedChildAgentSummary,
  type SessionSummary,
  type WorkflowSummary,
} from "../lib/api.js";
import type { AgentMode } from "../lib/agentMode.js";
import { catalogueDefault, type ModelCatalogue, type ModelSelection } from "../lib/models.js";
import {
  buildPlaywrightReviewPrompt,
  genericWorkflowPrompt,
  genericWorkflowValid,
  MANAGED_CHILD_WORKFLOW_ID,
  KNOWN_APP_ROUTES,
  PLAYWRIGHT_CAPTURE_SCOPES,
  PLAYWRIGHT_REVIEW_WORKFLOW_ID,
  PR_SNIPPET_REVIEW_WORKFLOW_ID,
  buildPrSnippetReviewPrompt,
  parsePullRequestNumber,
  SESSION_UPDATE_WORKFLOW_ID,
  START_DCA_SESSION_WORKFLOW_ID,
  isKnownAppRoute,
  type PlaywrightCaptureScope,
} from "../lib/workflows.js";
import { ModelPicker } from "./model-picker.js";

type Stage = "form" | "preview" | "done";

const fieldClass =
  "mt-1.5 w-full rounded-md border border-[var(--color-border-default)] bg-transparent px-3 py-2 text-base leading-relaxed sm:text-sm";

/**
 * The five workflows that still need bespoke fields or a bespoke submit path.
 * Everything else — including every procedure ported out of the retired command
 * catalogue, and any workflow a newer server ships that this build has never
 * heard of — is rendered by the generic argument form and sent into this
 * session. Membership is a list of what is special, not a list of what is
 * supported, so an unknown id degrades to the ordinary behaviour rather than
 * being silently mistaken for a Managed Child launch.
 */
const BESPOKE_WORKFLOW_IDS = new Set<string>([
  PLAYWRIGHT_REVIEW_WORKFLOW_ID,
  PR_SNIPPET_REVIEW_WORKFLOW_ID,
  SESSION_UPDATE_WORKFLOW_ID,
  MANAGED_CHILD_WORKFLOW_ID,
  START_DCA_SESSION_WORKFLOW_ID,
]);

/**
 * The workflow form + preview dialog (issue #167). Every workflow starts here
 * as a form. Cancel never mutates; workflows that support "Apply to composer"
 * only fill the draft; and an explicit Send / Launch / Start on the preview is
 * the only mutation. The preview always shows the exact generated prompt and
 * the trusted server-resolved injector before anything is submitted.
 */
export function WorkflowDialog({
  workflow,
  directory,
  sessionID,
  mode,
  modelCatalogue,
  defaultModel,
  onClose,
  onApplyToComposer,
  onSent,
}: {
  workflow: WorkflowSummary;
  directory: string;
  sessionID: string;
  /** The composer's current mode; used when sending to the current session. */
  mode: AgentMode;
  modelCatalogue: ModelCatalogue | null;
  defaultModel?: ModelSelection;
  onClose: () => void;
  onApplyToComposer: (draft: string, workflowID: string) => void;
  onSent: () => void;
}) {
  const location = useLocation();
  const currentPageRoute = `${location.pathname}${location.search}`;
  const [stage, setStage] = useState<Stage>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The single generic field. One state value serves every workflow that
  // declares an `argument`, which is what keeps a new server workflow from
  // needing a new branch here.
  const [argumentValue, setArgumentValue] = useState("");

  // Playwright review fields.
  const [pullRequest, setPullRequest] = useState("");
  const [route, setRoute] = useState(() => workflow.id === PLAYWRIGHT_REVIEW_WORKFLOW_ID ? currentPageRoute : "");
  const [target, setTarget] = useState("");
  const [scope, setScope] = useState<PlaywrightCaptureScope>("targeted-screenshots");

  // Session update fields.
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsTruncated, setSessionsTruncated] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const deferredSessionQuery = useDeferredValue(sessionQuery);
  const [targetID, setTargetID] = useState("");
  const [message, setMessage] = useState("");

  // Managed child fields. The agent comes from the server catalogue, never a
  // hardcoded pair: `explore` and `general` are equally valid Managed Child
  // agents, and only the catalogue knows which of them can modify files.
  const [objective, setObjective] = useState("");
  const [childAgent, setChildAgent] = useState<ManagedChildAgent>("plan");
  const [childAgents, setChildAgents] = useState<ManagedChildAgentSummary[]>([]);
  const [childAgentError, setChildAgentError] = useState<string | null>(null);
  const [childModel, setChildModel] = useState<ModelSelection | undefined>(
    () => defaultModel ?? (modelCatalogue ? catalogueDefault(modelCatalogue) : undefined),
  );
  const [confirmedBuild, setConfirmedBuild] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [child, setChild] = useState<SessionSummary | null>(null);

  // Independent root session fields.
  const [rootAssignment, setRootAssignment] = useState("");
  const [rootMode, setRootMode] = useState<AgentMode>("plan");
  const [rootModel, setRootModel] = useState<ModelSelection | undefined>(() => defaultModel);
  const [rootIsolated, setRootIsolated] = useState(true);
  const [rootConfirmedBuild, setRootConfirmedBuild] = useState(false);
  const [rootSession, setRootSession] = useState<SessionSummary | null>(null);
  const [rootDirectory, setRootDirectory] = useState<string | null>(null);
  const [rootFailureStage, setRootFailureStage] = useState<"worktree" | "session" | "prompt" | null>(null);
  const [rootAttempted, setRootAttempted] = useState(false);
  const [rootIdempotencyKey] = useState(() => crypto.randomUUID());
  const rootAttemptedRef = useRef(false);

  const dialogRef = useRef<HTMLElement>(null);
  const firstFieldRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => (firstFieldRef.current ?? dialogRef.current)?.focus());
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    if (workflow.id !== SESSION_UPDATE_WORKFLOW_ID) return;
    let cancelled = false;
    setSessions(null);
    setSessionsError(null);
    api.sessions(directory, { limit: 25, search: deferredSessionQuery.trim() || undefined })
      .then((result) => {
        if (cancelled) return;
        setSessions(result.sessions.filter((session) => session.id !== sessionID));
        setSessionsTruncated(result.truncated);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setSessionsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [deferredSessionQuery, directory, sessionID, workflow.id]);

  useEffect(() => {
    if (workflow.id !== MANAGED_CHILD_WORKFLOW_ID) return;
    let cancelled = false;
    setChildAgents([]);
    setChildAgentError(null);
    api.managedChildAgents(directory)
      .then(({ agents }) => {
        if (cancelled) return;
        setChildAgents(agents);
        // Default to a read-only agent so the safe choice is never the one
        // that needs an authorization the human has not given yet.
        setChildAgent((current) => agents.some((agent) => agent.id === current)
          ? current
          : agents.find((agent) => agent.access === "read-only")?.id ?? agents[0]?.id ?? current);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setChildAgentError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [directory, workflow.id]);

  useEffect(() => {
    if (!childModel && modelCatalogue) setChildModel(defaultModel ?? catalogueDefault(modelCatalogue));
  }, [childModel, defaultModel, modelCatalogue]);

  const rootModelValid = Boolean(rootModel && modelCatalogue?.models.some((model) =>
    model.providerID === rootModel.providerID
    && model.modelID === rootModel.modelID
    && model.status !== "disabled"
    && model.status !== "unavailable"
    && (!rootModel.variant || model.variants.includes(rootModel.variant))));

  useEffect(() => {
    if (workflow.id !== START_DCA_SESSION_WORKFLOW_ID || !modelCatalogue || !rootModel) return;
    const available = modelCatalogue.models.some((model) =>
      model.providerID === rootModel.providerID
      && model.modelID === rootModel.modelID
      && model.status !== "disabled"
      && model.status !== "unavailable"
      && (!rootModel.variant || model.variants.includes(rootModel.variant)));
    if (!available) setRootModel(undefined);
  }, [modelCatalogue, rootModel, workflow.id]);

  const targetSession = sessions?.find((session) => session.id === targetID);
  // Send in the TARGET session's own mode: a hardcoded "build" would restore
  // write access to a session its owner left in Plan. A target whose agent is
  // neither plan nor build still 409s server-side, and that error is shown.
  const targetMode: AgentMode = targetSession?.agent === "plan" ? "plan" : "build";

  const selectedChildAgent = childAgents.find((agent) => agent.id === childAgent);
  // Authorization is derived from the catalogue's access, not from an agent id
  // spelled into this file: `general` can modify too, and a fourth agent added
  // upstream must not silently arrive unauthorized.
  const requiresChildAuthorization = selectedChildAgent?.access === "can-modify";
  const childAgentLabel = (agent: ManagedChildAgentSummary) =>
    `${agent.id[0].toUpperCase()}${agent.id.slice(1)} · ${agent.access}`;

  // Only the number survives parsing, so a pasted link from another repository
  // cannot redirect the review or the posted comment (see parsePullRequestNumber).
  const pullRequestNumber = parsePullRequestNumber(pullRequest);
  const routeInvalid = route.trim().startsWith("/") && !isKnownAppRoute(route);

  // Every workflow except the three with their own submit path is sent into
  // THIS session. Extracted once so the submit branch, the apply note, the
  // mode note and the buttons cannot drift apart.
  const sendsIntoThisSession = workflow.id !== SESSION_UPDATE_WORKFLOW_ID
    && workflow.id !== MANAGED_CHILD_WORKFLOW_ID
    && workflow.id !== START_DCA_SESSION_WORKFLOW_ID;
  const isGeneric = !BESPOKE_WORKFLOW_IDS.has(workflow.id);

  const generatedPrompt =
    workflow.id === PLAYWRIGHT_REVIEW_WORKFLOW_ID
      ? (route.trim() && target.trim() ? buildPlaywrightReviewPrompt({ route, target, scope }) : "")
      : workflow.id === PR_SNIPPET_REVIEW_WORKFLOW_ID
        ? (pullRequestNumber === null ? "" : buildPrSnippetReviewPrompt(pullRequestNumber))
      : workflow.id === SESSION_UPDATE_WORKFLOW_ID
        ? message.trim()
      : workflow.id === MANAGED_CHILD_WORKFLOW_ID
        ? objective.trim()
      : workflow.id === START_DCA_SESSION_WORKFLOW_ID
        ? rootAssignment.trim()
        // Typed text is the prompt; a workflow that collects nothing uses the
        // fixed server-supplied prompt instead.
        : genericWorkflowPrompt(workflow, argumentValue);

  const formValid =
    workflow.id === PLAYWRIGHT_REVIEW_WORKFLOW_ID
      ? Boolean(route.trim() && target.trim())
      : workflow.id === PR_SNIPPET_REVIEW_WORKFLOW_ID
        ? pullRequestNumber !== null
      : workflow.id === SESSION_UPDATE_WORKFLOW_ID
        ? Boolean(targetSession && message.trim())
      : workflow.id === START_DCA_SESSION_WORKFLOW_ID
        ? Boolean(rootAssignment.trim() && rootAssignment.length <= 100_000 && rootModelValid)
      : workflow.id === MANAGED_CHILD_WORKFLOW_ID
        // No catalogue means no verified agent, so there is nothing safe to launch.
        ? Boolean(objective.trim() && objective.length <= 100_000 && childModel && selectedChildAgent)
        : genericWorkflowValid(workflow, argumentValue);

  const confirmReady = formValid && !busy
    && (workflow.id !== MANAGED_CHILD_WORKFLOW_ID || !requiresChildAuthorization || confirmedBuild)
    && (workflow.id !== START_DCA_SESSION_WORKFLOW_ID || (!rootAttempted && (rootMode !== "build" || rootConfirmedBuild)));

  const submit = async (action: "send" | "launch") => {
    if (workflow.id === START_DCA_SESSION_WORKFLOW_ID && rootAttemptedRef.current) return;
    setBusy(true);
    setError(null);
    try {
      if (sendsIntoThisSession) {
        // Sent in THIS session's current mode. A write is stopped by the
        // session's own policy rather than having write access quietly
        // restored here (decision 9). The ported procedures used to declare
        // `agent: plan` in their own frontmatter; that guarantee does not
        // survive the move, which is why the preview says so out loud.
        await api.prompt(directory, sessionID, generatedPrompt, { mode }, undefined, undefined, undefined, workflow.id);
        onSent();
        onClose();
        return;
      }
      if (workflow.id === SESSION_UPDATE_WORKFLOW_ID) {
        if (!targetSession) return;
        await api.prompt(directory, targetSession.id, generatedPrompt, { mode: targetMode }, undefined, undefined, undefined, workflow.id);
        setStage("done");
        return;
      }
      if (workflow.id === START_DCA_SESSION_WORKFLOW_ID) {
        if (!rootModel) return;
        rootAttemptedRef.current = true;
        setRootAttempted(true);
        const result = await api.startDcaSession(directory, {
          sourceSessionID: sessionID,
          prompt: generatedPrompt,
          mode: rootMode,
          model: rootModel,
          ...(rootMode === "build" ? { authorization: "modify" as const } : {}),
          isolated: rootIsolated,
          idempotencyKey: rootIdempotencyKey,
          workflow: workflow.id,
        });
        setRootSession(result.session);
        setRootDirectory(result.session.directory);
        onSent();
        setStage("done");
        return;
      }
      if (action === "launch") {
        if (!selectedChildAgent) return;
        const result = await api.createManagedChild(directory, sessionID, {
          prompt: generatedPrompt,
          // The agent and its authorization both come from the server
          // catalogue, so every can-modify agent carries the explicit
          // authorization the confirmation checkbox above already gates.
          agent: selectedChildAgent.id,
          ...(requiresChildAuthorization ? { authorization: "modify" as const } : {}),
          model: childModel,
          idempotencyKey,
          workflow: workflow.id,
        });
        setChild(result.session);
        onSent();
        setStage("done");
      }
    } catch (cause) {
      if (cause instanceof RootSessionLaunchApiError) {
        setRootFailureStage(cause.stage);
        setRootSession(cause.session ?? null);
        setRootDirectory(cause.directory ?? cause.session?.directory ?? null);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const sessionLink = (id: string, targetDirectory = directory) => `/sessions/${encodeURIComponent(id)}?directory=${encodeURIComponent(targetDirectory)}`;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center sm:p-4" data-testid="composer-workflow-dialog" data-workflow={workflow.id}>
      <button type="button" className="absolute inset-0 bg-[var(--color-background-overlay)]" aria-label="Close workflow" onClick={busy ? undefined : onClose} data-testid="composer-workflow-scrim" />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-workflow-title"
        tabIndex={-1}
        className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-[var(--color-border-default)] bg-[var(--color-background-surface-raised)] p-4 shadow-xl sm:max-w-xl sm:rounded-xl sm:p-5"
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="composer-workflow-title" className="text-lg font-semibold">{workflow.title}</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{workflow.description}</p>
          </div>
          <Button size="sm" variant="ghost" className="min-h-11 min-w-11" disabled={busy} onClick={onClose} data-testid="composer-workflow-close">Close</Button>
        </div>

        {stage === "form" && (
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => { event.preventDefault(); if (formValid) setStage("preview"); }}
          >
            {workflow.id === PR_SNIPPET_REVIEW_WORKFLOW_ID && (
              <label className="block text-sm font-medium">
                Pull request <span className="font-normal text-[var(--color-text-muted)]">(required)</span>
                <input
                  ref={(node) => { firstFieldRef.current = node; }}
                  type="text"
                  inputMode="numeric"
                  value={pullRequest}
                  onChange={(event) => setPullRequest(event.target.value)}
                  placeholder="253, #253, or a pull request URL"
                  className={fieldClass}
                  data-testid="composer-workflow-field-pull-request"
                />
                <span className="mt-1 block text-[11px] font-normal text-[var(--color-text-muted)]">
                  The repository comes from this project directory. A pasted URL contributes only its number.
                </span>
                {pullRequest.trim() && pullRequestNumber === null && (
                  <span className="mt-1 block text-[11px] font-normal text-[var(--color-text-danger)]" data-testid="composer-workflow-pull-request-invalid">
                    Enter a pull request number, like 253.
                  </span>
                )}
              </label>
            )}
            {workflow.id === PLAYWRIGHT_REVIEW_WORKFLOW_ID && <>
              <label className="block text-sm font-medium">
                Target route or component <span className="font-normal text-[var(--color-text-muted)]">(required)</span>
                <input
                  ref={(node) => { firstFieldRef.current = node; }}
                  type="text"
                  value={route}
                  onChange={(event) => setRoute(event.target.value)}
                  placeholder="/sessions/ses_123?directory=… or the composer card"
                  className={fieldClass}
                  data-testid="composer-workflow-field-route"
                />
                <span className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => setRoute(currentPageRoute)} data-testid="composer-workflow-use-current-page">Use current page</Button>
                  <select
                    aria-label="Known app route"
                    value={KNOWN_APP_ROUTES.includes(route as (typeof KNOWN_APP_ROUTES)[number]) ? route : ""}
                    onChange={(event) => { if (event.target.value) setRoute(event.target.value); }}
                    className="min-h-11 rounded-md border border-[var(--color-border-default)] bg-transparent px-2 text-sm"
                    data-testid="composer-workflow-known-route"
                  >
                    <option value="">Choose a known route</option>
                    {KNOWN_APP_ROUTES.map((knownRoute) => <option key={knownRoute} value={knownRoute}>{knownRoute}</option>)}
                  </select>
                </span>
                <span className="mt-1 block text-[11px] font-normal text-[var(--color-text-muted)]">Use a known root-relative route, or enter a component description when navigation is not the point.</span>
                {routeInvalid && <span className="mt-1 block text-[11px] font-normal text-[var(--color-text-danger)]" data-testid="composer-workflow-route-invalid">This is not a known app route. Use a listed route or enter a component description without a leading slash.</span>}
              </label>
              <label className="block text-sm font-medium">
                Desired state or interaction <span className="font-normal text-[var(--color-text-muted)]">(required)</span>
                <textarea
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  rows={3}
                  placeholder="What should be true, or what should be exercised?"
                  className={`${fieldClass} min-h-20 resize-y`}
                  data-testid="composer-workflow-field-target"
                />
              </label>
              <label className="block text-sm font-medium">
                Capture scope <span className="font-normal text-[var(--color-text-muted)]">(default: targeted screenshots)</span>
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as PlaywrightCaptureScope)}
                  className={fieldClass}
                  data-testid="composer-workflow-field-scope"
                >
                  {PLAYWRIGHT_CAPTURE_SCOPES.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-[var(--color-text-muted)]">
                The review stays focused: no full deployment, no complete screenshot regeneration.
              </p>
            </>}

            {isGeneric && (workflow.argument
              ? <label className="block text-sm font-medium">
                {workflow.argument.label} <span className="font-normal text-[var(--color-text-muted)]">({workflow.argument.required ? "required" : "optional"} — this text becomes the prompt)</span>
                <textarea
                  ref={(node) => { firstFieldRef.current = node; }}
                  value={argumentValue}
                  onChange={(event) => setArgumentValue(event.target.value)}
                  rows={5}
                  maxLength={workflow.argument.maxLength}
                  placeholder={workflow.argument.placeholder}
                  className={`${fieldClass} min-h-28 resize-y`}
                  data-testid="composer-workflow-field-argument"
                />
                {workflow.argument.hint && (
                  <span className="mt-1 block text-[11px] font-normal text-[var(--color-text-muted)]" data-testid="composer-workflow-argument-hint">{workflow.argument.hint}</span>
                )}
              </label>
              // Deliberately no fields, and so no firstFieldRef: focus falls
              // back to the dialog itself, which is what the effect already does
              // when the ref is null.
              : workflow.prompt
                ? <p className="text-sm text-[var(--color-text-muted)]" data-testid="composer-workflow-no-fields">
                  No input needed. Confirm to preview the exact prompt and trusted procedure below.
                </p>
                // A workflow that declares neither a field nor a fixed prompt
                // has nothing to send. Say that instead of offering a dead
                // Preview button with no explanation.
                : <Alert variant="danger" data-testid="composer-workflow-unsendable">This workflow supplies no prompt and collects no input, so there is nothing to send. It may need a newer version of this app.</Alert>)}

            {workflow.id === SESSION_UPDATE_WORKFLOW_ID && <>
              <div>
                <label className="block text-sm font-medium">Target session <span className="font-normal text-[var(--color-text-muted)]">(required, current project only)</span>
                  <input
                    ref={(node) => { firstFieldRef.current = node; }}
                    type="search"
                    value={sessionQuery}
                    onChange={(event) => setSessionQuery(event.target.value)}
                    placeholder="Search session title or id"
                    className={fieldClass}
                    data-testid="composer-workflow-session-search"
                  />
                </label>
                <div className="mt-2 max-h-52 space-y-1 overflow-y-auto" role="listbox" aria-label="Matching sessions" data-testid="composer-workflow-session-results">
                  {sessions === null && <p className="p-3 text-sm text-[var(--color-text-muted)]">Loading sessions…</p>}
                  {(sessions ?? []).map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      role="option"
                      aria-selected={targetID === session.id}
                      onClick={() => setTargetID(session.id)}
                      className={`w-full rounded-md border p-3 text-left ${targetID === session.id ? "border-[var(--color-border-info)] bg-[var(--color-background-surface-info-muted)]" : "border-[var(--color-border-default)]"}`}
                      data-testid="composer-workflow-session-option"
                      data-session-id={session.id}
                    >
                      <span className="block truncate text-sm font-medium">{session.title}</span>
                      <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-[var(--color-text-muted)]">
                        <span className="font-mono">{session.id}</span>
                        <span>{session.parentID ? "Child" : "Root"}</span>
                        <span>{session.running ? "Running" : "Idle"}</span>
                        <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
                      </span>
                    </button>
                  ))}
                </div>
                {sessionsTruncated && <p className="mt-1 text-xs text-[var(--color-text-warning)]" data-testid="composer-workflow-sessions-truncated">Showing the first 25 matches. Refine your search to find sessions outside this bounded result.</p>}
              </div>
              {sessionsError && <Alert variant="danger">Could not list sessions: {sessionsError}</Alert>}
              {sessions?.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">No other sessions exist in this project.</p>}
              <label className="block text-sm font-medium">
                Message <span className="font-normal text-[var(--color-text-muted)]">(required — sent exactly as written)</span>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={5}
                  placeholder="The update to deliver to the target session…"
                  className={`${fieldClass} min-h-28 resize-y`}
                  data-testid="composer-workflow-field-message"
                />
              </label>
            </>}

            {workflow.id === START_DCA_SESSION_WORKFLOW_ID && <>
              <label className="block text-sm font-medium">Assignment <span className="font-normal text-[var(--color-text-muted)]">(required, becomes the new root session's first prompt)</span>
                <textarea
                  ref={(node) => { firstFieldRef.current = node; }}
                  value={rootAssignment}
                  onChange={(event) => setRootAssignment(event.target.value)}
                  rows={6}
                  maxLength={100_000}
                  className={`${fieldClass} min-h-32 resize-y`}
                  placeholder="Describe the independent work to complete…"
                  data-testid="composer-workflow-root-assignment"
                />
              </label>
              <div className="rounded-md border border-[var(--color-border-default)] p-3 text-sm" data-testid="composer-workflow-root-directory">
                <p className="font-medium">Project directory (locked)</p>
                <p className="mt-1 break-all font-mono text-xs text-[var(--color-text-muted)]">{directory}</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">The browser cannot choose another path in this workflow.</p>
              </div>
              <label className="flex min-h-11 items-center gap-3 rounded-md border border-[var(--color-border-default)] p-3 text-sm">
                <input type="checkbox" checked={rootIsolated} onChange={(event) => setRootIsolated(event.target.checked)} className="h-5 w-5" data-testid="composer-workflow-root-isolated" />
                <span><strong>Isolated workspace</strong> (recommended and enabled by default)</span>
              </label>
              <fieldset>
                <legend className="text-sm font-medium">Mode</legend>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {(["plan", "build"] as const).map((candidate) => <button
                    key={candidate}
                    type="button"
                    aria-pressed={rootMode === candidate}
                    onClick={() => { setRootMode(candidate); setRootConfirmedBuild(false); }}
                    className={`min-h-11 rounded-md border px-3 text-sm font-semibold ${rootMode === candidate ? "border-[var(--color-border-info)] bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]" : "border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`}
                    data-testid={`composer-workflow-root-mode-${candidate}`}
                  >{candidate === "plan" ? "Plan · read-only" : "Build · can modify"}</button>)}
                </div>
              </fieldset>
              <div>
                <p className="mb-1.5 text-sm font-medium">Model <span className="font-normal text-[var(--color-text-muted)]">(defaults to the current composer model)</span></p>
                <ModelPicker catalogue={modelCatalogue} value={rootModel} onChange={setRootModel} testId="composer-workflow-root-model" label="Root session model" disabled={busy} portalLayer="nested" />
                {!rootModelValid && <Alert variant="danger" data-testid="composer-workflow-root-model-invalid">The current composer model is unavailable for this project. Select an available model before continuing.</Alert>}
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]">
                <li>Creates an independent root session with no parentID.</li>
                <li>Does not change or navigate away from this source session.</li>
                <li>No task card, Managed Child relationship, provenance record, or automatic hand-back is created.</li>
              </ul>
            </>}

            {workflow.id === MANAGED_CHILD_WORKFLOW_ID && <>
              <label className="block text-sm font-medium">
                Objective <span className="font-normal text-[var(--color-text-muted)]">(required — becomes the child's first prompt)</span>
                <textarea
                  ref={(node) => { firstFieldRef.current = node; }}
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  rows={6}
                  maxLength={100_000}
                  placeholder="Describe the work this child should complete…"
                  className={`${fieldClass} min-h-32 resize-y`}
                  data-testid="composer-workflow-field-objective"
                />
              </label>
              <fieldset>
                <legend className="text-sm font-medium">Agent <span className="font-normal text-[var(--color-text-muted)]">(default: a read-only agent)</span></legend>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {childAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      aria-pressed={childAgent === agent.id}
                      className={`min-h-11 rounded-md border px-3 text-sm font-semibold ${
                        childAgent === agent.id
                          ? "border-[var(--color-border-info)] bg-[var(--color-background-surface-info-muted)] text-[var(--color-text-info)]"
                          : "border-[var(--color-border-default)] text-[var(--color-text-muted)]"
                      }`}
                      // Changing the agent always clears the consent: an
                      // authorization given for one agent is not an
                      // authorization for the next one.
                      onClick={() => { setChildAgent(agent.id); setConfirmedBuild(false); }}
                      data-testid={`composer-workflow-mode-${agent.id}`}
                    >
                      {childAgentLabel(agent)}
                    </button>
                  ))}
                </div>
                {selectedChildAgent?.description && (
                  <p className="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-agent-description">{selectedChildAgent.description}</p>
                )}
              </fieldset>
              {childAgentError && (
                <Alert variant="danger" data-testid="composer-workflow-agent-error">Agent catalogue unavailable: {childAgentError}</Alert>
              )}
              <div>
                <p className="mb-1.5 text-sm font-medium">Model <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></p>
                <ModelPicker
                  catalogue={modelCatalogue}
                  value={childModel}
                  onChange={setChildModel}
                  testId="composer-workflow-model"
                  label="Child model"
                  disabled={busy}
                  // Without this the picker portals to z-[90] and renders
                  // BEHIND this z-[95] dialog; "nested" also inerts the parent.
                  portalLayer="nested"
                />
              </div>
              <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-managed-notes">
                <li>The child runs in its own independent transcript.</li>
                <li>Its Plan/Build policy is fixed at creation time.</li>
                <li>No native task card appears in this session.</li>
                <li>No automatic hand-back occurs — you read results in the child's transcript.</li>
              </ul>
            </>}

            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-default)] pt-4">
              <Button type="button" variant="secondary" disabled={busy} onClick={onClose} data-testid="composer-workflow-cancel">Cancel</Button>
              <Button type="submit" disabled={!formValid || busy || routeInvalid} data-testid="composer-workflow-preview">Preview and confirm</Button>
            </div>
          </form>
        )}

        {stage === "preview" && (
          <div className="mt-5 space-y-4">
            {workflow.id === SESSION_UPDATE_WORKFLOW_ID && targetSession && (
              <div className="rounded-md border border-[var(--color-border-default)] p-3 text-sm">
                <p className="font-medium" data-testid="composer-workflow-target-title">{targetSession.title}</p>
                <p className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-target-id">{targetSession.id}</p>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">Will be sent in {targetMode} mode (the target session's current mode).</p>
              </div>
            )}
            {workflow.id === MANAGED_CHILD_WORKFLOW_ID && (
              <div className="rounded-md border border-[var(--color-border-default)] p-3 text-xs text-[var(--color-text-muted)]">
                <p data-testid="composer-workflow-agent-summary"><span className="font-medium text-[var(--color-text-default)]">Agent:</span> {selectedChildAgent ? childAgentLabel(selectedChildAgent) : "unavailable"} (fixed at creation)</p>
                <p className="mt-1"><span className="font-medium text-[var(--color-text-default)]">Model:</span> {childModel ? `${childModel.providerID}/${childModel.modelID}${childModel.variant ? `/${childModel.variant}` : ""}` : "project default"}</p>
                <p className="mt-1">Independent transcript · no native task card · no automatic hand-back.</p>
              </div>
            )}
            {workflow.id === START_DCA_SESSION_WORKFLOW_ID && (
              <div className="rounded-md border border-[var(--color-border-default)] p-3 text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-root-summary">
                <p><span className="font-medium text-[var(--color-text-default)]">Root session:</span> no parentID</p>
                <p className="mt-1"><span className="font-medium text-[var(--color-text-default)]">Directory:</span> {rootIsolated ? "new isolated worktree under this project" : directory}</p>
                <p className="mt-1"><span className="font-medium text-[var(--color-text-default)]">Mode:</span> {rootMode}</p>
                <p className="mt-1"><span className="font-medium text-[var(--color-text-default)]">Model:</span> {rootModel ? `${rootModel.providerID}/${rootModel.modelID}${rootModel.variant ? `/${rootModel.variant}` : ""}` : "unavailable"}</p>
              </div>
            )}
            <div>
              <p className="text-sm font-medium">Exact prompt</p>
              <pre className="thin-scrollbar mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-muted)] p-3 font-sans text-xs leading-relaxed" data-testid="composer-workflow-prompt-preview">{generatedPrompt}</pre>
            </div>
            {/*
              * The injector window is the whole trust story (decision 21): the
              * contract is that the user can read the exact trusted content
              * before submitting. `max-h-48` was sized when the longest shipped
              * injector was 19 lines; the ported procedures run to ~160, so it
              * showed about 5% of `system-design-artifacts` — technically
              * scrollable, but not read-before-send in any honest sense. It
              * stays scrollable and bounded (the dialog must not become one
              * unbroken page), in `dvh` so a mobile URL bar cannot shrink it
              * below what it promises.
              */}
            <details open data-testid="composer-workflow-injector">
              <summary className="cursor-pointer text-sm font-medium">Trusted injector — server-resolved from id "{workflow.id}"</summary>
              <pre className="thin-scrollbar mt-1.5 max-h-[60dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border-default)] p-3 font-sans text-xs leading-relaxed text-[var(--color-text-muted)]" data-testid="composer-workflow-injector-body">{workflow.injector}</pre>
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Appended by the server exactly as shown. The browser only names the workflow id.</p>
            </details>
            {sendsIntoThisSession && <>
              <p className="text-xs text-[var(--color-text-muted)]">"Apply to composer" only fills the message box for further editing — nothing is sent until you press Send.</p>
              {/*
                * Stated rather than assumed. The procedures ported out of the
                * retired command catalogue used to pin their own agent in
                * frontmatter (`agent: plan` for the read-only ones); a workflow
                * carries no declarative mode, so the session's current mode is
                * what governs. Dropping that silently would be the expensive
                * direction to be wrong in.
                */}
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-mode-note">
                Sent in this session's current mode. Right now that is <strong>{mode}</strong>, so a Plan session stops at any write this asks for rather than gaining write access here.
              </p>
            </>}
            {workflow.id === PR_SNIPPET_REVIEW_WORKFLOW_ID && (
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-post-note">
                This posts one comment on the pull request, so a Plan session will stop at the write rather than post.
              </p>
            )}
            {workflow.id === SESSION_UPDATE_WORKFLOW_ID && (
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="composer-workflow-accepted-note">Delivery is asynchronous: POST /session/{"{target}"}/prompt_async answers 204 for <strong>accepted</strong>, not completed.</p>
            )}
            {workflow.id === MANAGED_CHILD_WORKFLOW_ID && requiresChildAuthorization && (
              <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] p-3 text-sm" data-testid="composer-workflow-build-confirmation">
                <input
                  type="checkbox"
                  checked={confirmedBuild}
                  onChange={(event) => setConfirmedBuild(event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0"
                  data-testid="composer-workflow-build-confirm"
                />
                <span>This child may modify files even when this session is in Plan. I am authorizing that independent {selectedChildAgent ? childAgentLabel(selectedChildAgent) : "modify"} access.</span>
              </label>
            )}
            {workflow.id === START_DCA_SESSION_WORKFLOW_ID && rootMode === "build" && (
              <label className="flex min-h-11 items-start gap-3 rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-warning-muted)] p-3 text-sm" data-testid="composer-workflow-root-build-confirmation">
                <input type="checkbox" checked={rootConfirmedBuild} onChange={(event) => setRootConfirmedBuild(event.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" data-testid="composer-workflow-root-build-confirm" />
                <span>This independent root session may modify files. I authorize Build access in its selected workspace.</span>
              </label>
            )}
            {error && <Alert variant="danger" data-testid="composer-workflow-error">{error}</Alert>}
            {rootAttempted && error && <p className="text-xs text-[var(--color-text-danger)]" data-testid="composer-workflow-root-attempt-guidance">
              {rootFailureStage
                ? <>Failed during <span data-testid="composer-workflow-root-failure-stage">{rootFailureStage === "worktree" ? "worktree creation" : rootFailureStage === "session" ? "session creation" : "opening prompt submission"}</span>. </>
                : <>The launch result is ambiguous, so a worktree or session may already exist. </>}
              Do not retry blindly. Inspect the Hub, session list, and project worktrees first. This form permits one launch attempt; close and reopen it only when you intend to make an explicit new attempt. Same-process duplicate submissions share one cached outcome, but that cache does not survive a BFF restart.
            </p>}
            {rootSession && rootFailureStage === "prompt" && <Link to={sessionLink(rootSession.id, rootDirectory ?? rootSession.directory)} className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border-default)] px-3 text-sm underline-offset-2 hover:underline" data-testid="composer-workflow-open-partial-session">Open the session that may remain</Link>}
            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-default)] pt-4">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setError(null); setStage("form"); }} data-testid="composer-workflow-back">Back</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={onClose} data-testid="composer-workflow-cancel">Cancel</Button>
              {sendsIntoThisSession && <>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => onApplyToComposer(generatedPrompt, workflow.id)} data-testid="composer-workflow-apply">Apply to composer</Button>
                <Button type="button" disabled={!confirmReady} onClick={() => void submit("send")} data-testid="composer-workflow-send">{busy ? "Sending…" : "Send"}</Button>
              </>}
              {workflow.id === SESSION_UPDATE_WORKFLOW_ID && (
                <Button type="button" disabled={!confirmReady} onClick={() => void submit("send")} data-testid="composer-workflow-send">{busy ? "Sending…" : "Send to session"}</Button>
              )}
              {workflow.id === MANAGED_CHILD_WORKFLOW_ID && (
                <Button type="button" disabled={!confirmReady} onClick={() => void submit("launch")} data-testid="composer-workflow-launch">{busy ? "Launching…" : "Launch Managed Child"}</Button>
              )}
              {workflow.id === START_DCA_SESSION_WORKFLOW_ID && (
                <Button type="button" disabled={!confirmReady} onClick={() => void submit("launch")} data-testid="composer-workflow-root-start">{busy ? "Starting…" : "Start session"}</Button>
              )}
            </div>
          </div>
        )}

        {stage === "done" && (
          <div className="mt-5 space-y-4" data-testid="composer-workflow-done">
            {workflow.id === SESSION_UPDATE_WORKFLOW_ID && targetSession && (
              <Alert variant="success">
                Update accepted by "{targetSession.title}" ({targetSession.id}). Accepted means queued, not completed — the target session works through it on its own time.
              </Alert>
            )}
            {workflow.id === MANAGED_CHILD_WORKFLOW_ID && child && (
              <Alert variant="success">
                Managed child launched: "{child.title}" ({child.id}). It runs in its own transcript with its policy fixed at creation; no task card was added here and no automatic hand-back will occur.
              </Alert>
            )}
            {workflow.id === START_DCA_SESSION_WORKFLOW_ID && rootSession && (
              <Alert variant="success">
                Root session accepted: "{rootSession.title}" ({rootSession.id}) in {rootSession.directory}. It has no parent and runs independently; this source session was not changed or navigated away.
              </Alert>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border-default)] pt-4">
              {workflow.id === SESSION_UPDATE_WORKFLOW_ID && targetSession && (
                <Link to={sessionLink(targetSession.id)} className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border-default)] px-3 text-sm underline-offset-2 hover:underline" data-testid="composer-workflow-open-session" onClick={onClose}>Open target session</Link>
              )}
              {workflow.id === MANAGED_CHILD_WORKFLOW_ID && child && (
                <Link to={sessionLink(child.id)} className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border-default)] px-3 text-sm underline-offset-2 hover:underline" data-testid="composer-workflow-open-session" onClick={onClose}>Open child session</Link>
              )}
              {workflow.id === START_DCA_SESSION_WORKFLOW_ID && rootSession && (
                <Link to={sessionLink(rootSession.id, rootSession.directory)} className="inline-flex min-h-11 items-center rounded-md border border-[var(--color-border-default)] px-3 text-sm underline-offset-2 hover:underline" data-testid="composer-workflow-open-session" onClick={onClose}>Open new root session</Link>
              )}
              <Button type="button" onClick={onClose} data-testid="composer-workflow-done-close">Close</Button>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
