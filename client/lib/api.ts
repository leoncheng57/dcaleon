// client/lib/api.ts — typed fetch helpers for our BFF (/api).
//
// Same-origin, no auth headers: the BFF holds the OpenCode credential so the
// browser never sees it.

import type { RawMessage } from "./events.js";
import type { AgentMode } from "./agentMode.js";
import type { ModelCatalogue, ModelSelection } from "./models.js";

export type ManagedChildAgent = "plan" | "build" | "explore" | "general";
export type ManagedChildAccess = "read-only" | "can-modify";
export interface ManagedChildAgentSummary { id: ManagedChildAgent; description?: string; access: ManagedChildAccess }

export interface SessionSummary {
  id: string;
  title: string;
  directory: string;
  /** Present when another session delegated this one — i.e. it is a sub-agent. */
  parentID?: string;
  /** Non-archived children in the same directory. Zero for a leaf session. */
  childCount: number;
  agent?: string;
  model?: ModelSelection;
  managed?: {
    origin: "managed-human";
    requestedAgent: ManagedChildAgent;
    requestedMode?: AgentMode;
    requestedModel?: ModelSelection;
    background: true;
    policySource: "creation-permission";
    effectivePolicyObserved: boolean;
    authorization: "read-only" | "modify";
  };
  managedConfigurationPresent?: true;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  shareUrl?: string;
  running: boolean;
}

export interface Todo {
  content: string;
  status: string;
  priority: string;
}

/** Mirrors `server/opencode/subagents.ts`; see there for how each is derived. */
export type SubagentState = "launched" | "running" | "completed" | "failed" | "unknown";

export type SubagentEvidence =
  | "session-status"
  | "child-transcript"
  | "parent-completion"
  | "parent-task-part"
  | "launch-only"
  | "no-terminal-evidence";

export interface SubagentTask {
  sessionID: string;
  parentID: string;
  title: string;
  agent?: string;
  origin?: "native-task" | "managed-human";
  requestedMode?: AgentMode;
  requestedAgent?: ManagedChildAgent;
  requestedModel?: ModelSelection;
  /** Model the task tool resolved for a native child; provenance only. */
  model?: { providerID: string; modelID: string };
  policySource?: "creation-permission";
  effectivePolicyObserved?: boolean;
  description?: string;
  state: SubagentState;
  evidence: SubagentEvidence;
  background: boolean;
  present: boolean;
  createdAt: string;
  updatedAt: string;
  cost: number;
  detail?: string;
}

/**
 * A machine-authored instruction this app itself sent to a child session.
 * Explicit send-time audit data — never inferred from transcript wording.
 */
export interface InstructionRecord {
  id: string;
  at: number;
  source: "managed-child-launch" | "managed-child-prompt";
  directory: string;
  targetSessionID: string;
  parentSessionID?: string;
  targetAgent?: string;
  text: string;
  truncated?: true;
  delivery: "acknowledged" | "rejected";
  reason?: string;
}

export interface SubagentReport {
  parentID: string;
  tasks: SubagentTask[];
  capabilities: { backgroundSubagents: boolean; managedChildren: boolean };
  truncated: boolean;
  /** Newest first; covers only instructions this app sent (issue #91). */
  instructions: InstructionRecord[];
}

export interface HealthResponse {
  healthy: boolean;
  upstream: {
    url: string;
    reachable: boolean;
    version?: string;
    expected?: string;
    versionMatches?: boolean;
    error?: string;
  };
  events?: { connected: boolean };
}

export type DshPresetMode = "read-only" | "build";
export interface DshPresetSummary { id: string; label: string; provider: string; model: string; fingerprint: string; mode: DshPresetMode }
export interface DshWorkspaceSummary { id: string; label: string }
export interface DshSessionSummary {
  id: string;
  title: string;
  presetId: string;
  workspaceId: string;
  mode: DshPresetMode;
  createdAt: string;
  updatedAt: string;
  running: boolean;
}
export interface DshConfigResponse {
  enabled: true;
  configured: boolean;
  protocol: 1;
  sdkVersion: string;
  sandbox: "seatbelt" | "test-unsafe";
  trajectory: { sensitiveDetailEnabled: boolean; fullExportEnabled: boolean };
  presets: DshPresetSummary[];
  workspaces: DshWorkspaceSummary[];
}

export type ClaudePresetMode = "read-only" | "build";
export interface ClaudePresetSummary {
  id: string;
  label: string;
  model: string;
  effort?: string;
  permissionMode: string;
  mode: ClaudePresetMode;
}
export interface ClaudeWorkspaceSummary {
  id: string;
  label: string;
}
export interface ClaudeConfigResponse {
  enabled: true;
  configured: boolean;
  cliVersion: string;
  sandbox: "seatbelt" | "test-unsafe";
  presets: ClaudePresetSummary[];
  workspaces: ClaudeWorkspaceSummary[];
}
export interface ClaudeSessionSummary {
  id: string;
  title: string;
  presetId: string;
  workspaceId: string;
  mode: ClaudePresetMode;
  createdAt: string;
  updatedAt: string;
  running: boolean;
}
export type DshTrajectoryCategory = "turn" | "request" | "message" | "tool" | "compaction" | "child" | "status" | "error";
export interface DshTrajectoryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
export interface DshTrajectoryMetadata {
  turn?: number;
  step?: number;
  phase?: "start" | "end" | "chunk" | "committed";
  reason?: string;
  provider?: string;
  model?: string;
  contextWindow?: number;
  callId?: string;
  resultIsError?: boolean;
  compactionId?: string;
  shadowedEventCount?: number;
  shadowedTokenCount?: number;
  childSessionId?: string;
  parentSessionId?: string;
  localChild?: boolean;
  standalone?: boolean;
  usage?: DshTrajectoryUsage;
}
export interface DshTrajectoryEvent {
  id: string;
  observationSeq: number;
  sessionId: string;
  observedAt: string;
  type: string;
  nativeSessionId?: string;
  nativeSeq?: number;
  nativeTime?: string;
  ignorable?: true;
  sourceEventSeqs?: number[];
  sourceEventSeqsTruncated?: true;
  surfaceOp?: "append" | { op: "replace"; start: number; end: number };
  category: DshTrajectoryCategory;
  title: string;
  summary?: string;
  metadata?: DshTrajectoryMetadata;
  source: "dsh-native-notification" | "dca-lifecycle";
  hasDetail: boolean;
  sensitive: boolean;
}
export interface DshTrajectoryPage {
  events: DshTrajectoryEvent[];
  nextBefore: number | null;
  capturePending: boolean;
  coverage: DshTrajectoryCoverage;
}
/**
 * Mirrors the server union. The capture arm keeps literal `false`/`true` so a
 * bounded capture still cannot be typed as complete; the durable arm is the
 * only way to claim completeness, and only the server can produce it.
 */
export type DshTrajectoryCoverage =
  | (DshTrajectoryCoverageBase & { source: "dca-captured-projection"; complete: false; mayContainGaps: true })
  | (DshTrajectoryCoverageBase & { source: "dsh-durable-persistence"; complete: true; mayContainGaps: false });
interface DshTrajectoryCoverageBase {
  capturedFrom: string | null;
  capturedThrough: string | null;
  nativeStreams: Array<{ session: string; first: number; last: number; gaps: number }>;
  note: string;
}
export interface DshTrajectoryDetail {
  eventId: string;
  detail: unknown;
  truncated: boolean;
  warning: string;
}

export interface AppSettings {
  model?: string;
  small_model?: string;
  default_agent?: string;
  subagent_depth?: number;
  compaction?: { auto?: boolean; prune?: boolean; reserved?: number };
}

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

export interface CatalogSkill { name: string; description: string; location?: string }
export interface CatalogCommand {
  name: string;
  description?: string;
  source?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}
/**
 * A single entry dropped from an otherwise-valid catalogue because one of
 * its fields failed validation (issue #297). `name` is present only when it
 * independently validated, so it can never surface an oversized or
 * malformed name just because some other field on that entry was bad.
 */
export interface CatalogOmission { index: number; name?: string; reason: string }
export interface CatalogResponse {
  servers: Record<string, McpStatus>;
  skills: CatalogSkill[];
  commands: CatalogCommand[];
  /**
   * Tool ids the connected process reports as invocable. Built-ins only —
   * a connected MCP server contributes nothing here, so its tools cannot be
   * enumerated. `null` means the registry was unreadable, which is not the
   * same as an empty registry.
   */
  tools: string[] | null;
  /**
   * Entries dropped from `skills`/`commands`/`servers` because a single
   * field on that entry failed validation (issue #297) — the container
   * itself was still valid, only these entries were excluded. An empty
   * list means exactly that: nothing was dropped.
   */
  omitted: { skills: CatalogOmission[]; commands: CatalogOmission[]; servers: CatalogOmission[] };
  refreshedAt: string;
}

export type NotifyEvent = "idle" | "error" | "abort" | "permission" | "question" | "parked";
export interface NotificationPreferences {
  version: 1;
  ntfy: { enabled: boolean; server: string; topic: string; events: Record<NotifyEvent, boolean> };
  webPush: { enabled: boolean; events: Record<NotifyEvent, boolean> };
  browser: { desktop: boolean; sound: boolean; volume: number; events: Record<NotifyEvent, boolean> };
  parkedPermissionSeconds: number;
}

/**
 * Safe projection of a registered PWA push device. Mirrors
 * server/notifications/webpush.ts; it deliberately carries no endpoint or key.
 */
export interface PushSubscriptionSummary {
  id: string;
  addedAt: number;
  label: string;
  platform: string;
  installationId?: string;
}

export type NotificationHistoryState = "all" | "active" | "resolved";

/**
 * Why a record was never delivered, and the axis the noise filters act on.
 * Mirrors server/notifications/history.ts.
 */
export type NotificationSuppression = "auto-permissions" | "subagent" | "preference-off";

/** Unresolved rows each filter is responsible for hiding, filter on or off. */
export type SuppressedActiveCounts = Record<NotificationSuppression, number>;

export interface NotificationRecord {
  id: string;
  kind: NotifyEvent;
  at: number;
  directory?: string;
  sessionID?: string;
  /** Session title as of the moment the notification fired, if it was known. */
  sessionTitle?: string;
  requestID?: string;
  title: string;
  body: string;
  /** Safe event copy for authenticated in-app notification rows. */
  displayBody?: string;
  /** Bounded excerpt of the agent's own output; in-app only, never outbound. */
  detail?: string;
  click?: string;
  resolvedAt?: number;
  resolvedBy?: "checked" | "replied" | "reconciled" | "dismissed" | "suppressed";
  parkedAt?: number;
  delivery: {
    ntfy: "sent" | "pending" | "off" | "failed";
    ntfyError?: string;
    /** Desktop-notification preference; sound and speech are device-local. */
    desktop: "allowed" | "off";
    webPush?: "sent" | "partial" | "pending" | "off" | "failed";
    webPushError?: string;
    suppressed?: NotificationSuppression;
  };
}

export interface WorkspaceNode {
  name: string;
  path: string;
  type: "file" | "directory";
  ignored: boolean;
}

export interface WorkspaceFile {
  path: string;
  type: "text" | "binary";
  content: string;
  encoding?: "base64";
  mimeType?: string;
}

export interface VcsFileDiff {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
}

/** Mirrors `server/opencode/workspace.ts`; only `file` may become interactive. */
export type WorkspaceReferenceStatus = "file" | "directory" | "invalid" | "forbidden" | "missing";

export interface WorkspaceReference {
  path: string;
  status: WorkspaceReferenceStatus;
  /** Canonical target to read. Present only when `status === "file"`. */
  resolvedPath?: string;
}

/** Server-enforced ceiling; callers must chunk rather than be truncated. */
export const WORKSPACE_REFERENCE_BATCH = 64;

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface Worktree { name: string; branch?: string; directory: string }
export interface DiscoveredProject {
  name: string;
  relativePath: string;
  directory: string;
  kind: "repository" | "directory";
}
export interface ReviewStatus {
  url: string;
  forge: "github" | "gitlab";
  title: string;
  state: string;
  author: string;
  pipeline: string | null;
  mergeable: boolean | null;
  headSha: string;
  number: number;
  project: string;
}
export interface ReviewComment { id: string; author: string; body: string; createdAt: string; resolved: boolean | null; discussionId: string | null; bodyTruncated: boolean }
export interface ReviewSummary { id: string; author: string; state: string; body: string; submittedAt: string; bodyTruncated: boolean }
export interface ReviewPipeline { id: string; status: string; webUrl: string; createdAt: string; completedAt: string; duration: number | null }
export interface ReviewCheck { id: string; name: string; stage: string; status: string; webUrl: string; startedAt: string; completedAt: string; duration: number | null; source: "check" | "status" | "job" }
export interface ReviewCommit { sha: string; shortSha: string; subject: string; author: string; authoredAt: string; webUrl: string; subjectTruncated: boolean }
export interface DetailSection<T> { value: T; error: "Authentication unavailable" | "Rate limited" | "Unavailable" | null; truncated: boolean }
export interface ReviewDetails {
  comments: DetailSection<ReviewComment[]>;
  reviews: DetailSection<ReviewSummary[]>;
  pipelines: DetailSection<ReviewPipeline[]>;
  checks: DetailSection<ReviewCheck[]>;
  commits: DetailSection<ReviewCommit[]>;
  partial: boolean;
  auth: "available" | "unavailable" | "rate_limited";
}
export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}
export interface AutoPermissionStatus { enabled: boolean; error: string | null }
export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: unknown;
}
export interface ReminderSummary {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  /** Application-owned tags used to group and filter reminders. */
  tags: string[];
  /**
   * The exact instruction text this reminder appends. Served so it can be read
   * before it is attached; a send still carries the id alone and the server
   * resolves this again at submit time.
   */
  body: string;
  /** Present only for a reminder restricted to one repository (issue #165). */
  scopeRepository?: string;
}

/**
 * The one free-text field a workflow collects. Its typed value becomes the
 * visible prompt, so a workflow can be added server-side without another
 * branch in the dialog. `maxLength` is already bounded by the server.
 */
export interface WorkflowArgumentSpec {
  label: string;
  placeholder?: string;
  hint?: string;
  required: boolean;
  maxLength: number;
}

export interface WorkflowSummary {
  id: string;
  title: string;
  description: string;
  /**
   * The trusted server-resolved injector text, exposed read-only so it can be
   * previewed before submission. Sends only ever name the workflow by id; the
   * server resolves this text again at submit time.
   */
  injector: string;
  /** Present when the workflow collects free text that becomes the prompt. */
  argument?: WorkflowArgumentSpec;
  /** Fixed visible prompt for a workflow that collects nothing. */
  prompt?: string;
}

export interface MessagePage {
  messages: RawMessage[];
  running: boolean;
  nextCursor: string | null;
}

export interface SessionTurnDiff extends VcsFileDiff {
  patch: string;
  status: NonNullable<VcsFileDiff["status"]>;
}

/**
 * Unwrap a response, surfacing the BFF's `{ error }` body when present.
 *
 * The status is attached so callers can distinguish "this session is gone"
 * (404, stop polling) from "the agent server is down" (502, keep retrying).
 */
export type ApiErrorCode =
  | "SESSION_AGENT_UNKNOWN"
  | "SESSION_AGENT_UNSUPPORTED"
  | "SESSION_AGENT_MISMATCH"
  | "SESSION_AGENT_UNAVAILABLE"
  | "TURN_DIFF_TOO_LARGE";

/** Mirrors `server/logs.ts`. */
export type LogSource = "audit" | "stdout" | "stderr";

export interface AuditLogEntry {
  kind: "audit";
  id: string;
  ts: string;
  event: string;
  fields: Array<{ key: string; value: string }>;
}

export interface TextLogEntry {
  kind: "text";
  id: string;
  prefix?: string;
  text: string;
  frames?: string[];
  framesTruncated?: boolean;
  severity: "error" | "warn" | "info";
}

export type LogEntry = AuditLogEntry | TextLogEntry;

export interface LogSnapshot {
  source: LogSource;
  file: string;
  exists: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  entries: LogEntry[];
  truncated: boolean;
  readAt: string;
}

/** Mirrors `server/deployment.ts`. */
export interface ServiceStatus {
  label: string;
  role: "bff" | "opencode";
  loaded: boolean;
  pid: number | null;
  restartCost: "safe" | "destructive";
  restartNote: string;
}

export interface ServedAsset {
  path: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  problem?: string;
}

export type AssetsVerdict = "ok" | "corrupted" | "not-built";

export interface DeploymentSnapshot {
  platform: string;
  servicesAvailable: boolean;
  servicesNote?: string;
  services: ServiceStatus[];
  assets: ServedAsset[];
  assetsVerdict: AssetsVerdict;
  assetsNote: string;
  bundle: { indexHtmlSha1: string | null; hasServiceWorker: boolean; hasManifest: boolean; directory: string };
  busySessions: { count: number | null; directoriesChecked: number; note: string };
  readAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type RootSessionFailureStage = "worktree" | "session" | "prompt";

export class RootSessionLaunchApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly stage: RootSessionFailureStage,
    readonly session?: SessionSummary,
    readonly directory?: string,
  ) {
    super(message);
    this.name = "RootSessionLaunchApiError";
  }
}

export type PlanningItemType = "issue" | "pull_request";
export type PlanningItemState = "open" | "closed";

export interface PlanningItem {
  id: string;
  number: number;
  type: PlanningItemType;
  title: string;
  state: PlanningItemState;
  merged: boolean;
  /**
   * Label names only. The BFF drops GitHub's per-label hex colors on purpose:
   * `client/ds` forbids raw hex, and inventing a token mapping per label would
   * be a guess about meaning the label text already carries.
   */
  labels: string[];
  author: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /** Sub-issue count reported by GitHub; 0 for anything that is not an epic. */
  childCount: number;
  /** Completed sub-issues, never greater than `childCount`. */
  completedChildCount: number;
  /**
   * The epic this item belongs to, resolved by the BFF's bounded fan-out.
   * `null` means top-level *or* an edge nobody spent a request to discover, so
   * it is never evidence that an item has no parent.
   */
  parentNumber: number | null;
}

export interface PlanningSnapshot {
  repository: { owner: string; repo: string; url: string };
  items: PlanningItem[];
  truncated: boolean;
  /** True when more epics existed than the BFF resolved parent links for. */
  epicsTruncated: boolean;
  fetchedAt: string;
}

export interface PlanningLabel { name: string; description: string | null }
export interface CreatePlanningIssueInput { title: string; body: string; labels: string[] }
export interface PlanningComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  bodyTruncated: boolean;
}
export interface PlanningItemDetails {
  item: PlanningItem;
  itemLabelsTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
  comments: PlanningComment[];
  commentsTruncated: boolean;
  commentsError: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code: ApiErrorCode | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      if (
        body.code === "SESSION_AGENT_UNKNOWN" ||
        body.code === "SESSION_AGENT_UNSUPPORTED" ||
        body.code === "SESSION_AGENT_MISMATCH" ||
        body.code === "SESSION_AGENT_UNAVAILABLE" ||
        body.code === "TURN_DIFF_TOO_LARGE"
      ) code = body.code;
    } catch {
      /* keep the status-only message */
    }
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Every project-scoped call threads ?directory=. */
function scoped(path: string, directory: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ directory, ...extra });
  return `/api${path}?${query}`;
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<HealthResponse>(r)),
  appConfig: () => fetch("/api/app-config").then((r) => json<{ publicAppUrl: string | null; dshEnabled: boolean; claudeEnabled: boolean }>(r)),
  projects: () => fetch("/api/projects").then((r) => json<{ root: string; projects: DiscoveredProject[] }>(r)),
  projectPins: () => fetch("/api/project-pins").then((r) => json<{ directories: string[] }>(r)),
  saveProjectPins: (directories: string[]) =>
    fetch("/api/project-pins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directories }),
    }).then((r) => json<{ directories: string[] }>(r)),
  modelPins: () => fetch("/api/model-pins").then((r) => json<{ models: ModelSelection[] }>(r)),
  saveModelPins: (models: ModelSelection[]) =>
    fetch("/api/model-pins", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: models.map(({ providerID, modelID }) => ({ providerID, modelID })) }),
    }).then((r) => json<{ models: ModelSelection[] }>(r)),

  sessions: (directory: string, options: { limit?: number; search?: string } = {}) =>
    fetch(scoped("/sessions", directory, {
      limit: String(options.limit ?? 100),
      ...(options.search ? { search: options.search } : {}),
    })).then((r) =>
      json<{ sessions: SessionSummary[]; truncated: boolean }>(r),
    ),

  /**
   * Recent sessions across projects. Unlike every other session call this one
   * is not scoped to a single directory: the caller passes the projects it
   * knows about and the BFF unions them with the shared pins.
   *
   * `lookupIDs` names sessions the browser opened previously. They are usually
   * not among the most recently active, so they have to be requested by id or
   * the "recently opened" panel would come back empty.
   */
  recentSessions: (directories: string[], lookupIDs: string[] = [], limit = 25) => {
    const query = new URLSearchParams({ limit: String(limit) });
    for (const directory of directories) query.append("directory", directory);
    for (const id of lookupIDs) query.append("session", id);
    return fetch(`/api/recent-sessions?${query}`).then((r) =>
      json<{ sessions: SessionSummary[]; directories: string[] }>(r),
    );
  },

  dshConfig: () => fetch("/api/dsh/config").then((r) => json<DshConfigResponse>(r)),
  dshSessions: () => fetch("/api/dsh/sessions").then((r) => json<{ sessions: DshSessionSummary[] }>(r)),
  createDshSession: (input: { presetId: string; workspaceId: string; title?: string }) =>
    fetch("/api/dsh/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ session: DshSessionSummary }>(r)),
  dshSession: (id: string) => fetch(`/api/dsh/sessions/${encodeURIComponent(id)}`).then((r) =>
    json<{ session: DshSessionSummary; events: import("./transcript.js").TranscriptEvent[] }>(r)),
  promptDsh: (id: string, text: string) => fetch(`/api/dsh/sessions/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((r) => json<{ accepted: boolean }>(r)),
  cancelDsh: (id: string) => fetch(`/api/dsh/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((r) =>
    json<{ cancelled: boolean }>(r)),
  dshEventsUrl: (id: string) => `/api/dsh/events?${new URLSearchParams({ sessionId: id })}`,

  claudeConfig: () => fetch("/api/claude/config").then((r) => json<ClaudeConfigResponse>(r)),
  claudeSessions: () => fetch("/api/claude/sessions").then((r) => json<{ sessions: ClaudeSessionSummary[] }>(r)),
  createClaudeSession: (input: { presetId: string; workspaceId: string; title?: string }) =>
    fetch("/api/claude/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ session: ClaudeSessionSummary }>(r)),
  claudeSession: (id: string) => fetch(`/api/claude/sessions/${encodeURIComponent(id)}`).then((r) =>
    json<{ session: ClaudeSessionSummary; events: import("./transcript.js").TranscriptEvent[] }>(r)),
  promptClaude: (id: string, text: string) => fetch(`/api/claude/sessions/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((r) => json<{ accepted: boolean }>(r)),
  cancelClaude: (id: string) => fetch(`/api/claude/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }).then((r) =>
    json<{ cancelled: boolean }>(r)),
  claudeEventsUrl: (id: string) => `/api/claude/events?${new URLSearchParams({ sessionId: id })}`,
  dshTrajectory: (id: string, options: { limit?: number; before?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 200) });
    if (options.before !== undefined) query.set("before", String(options.before));
    return fetch(`/api/dsh/sessions/${encodeURIComponent(id)}/trajectory?${query}`).then((r) => json<DshTrajectoryPage>(r));
  },
  dshTrajectoryDetail: (id: string, eventId: string, signal?: AbortSignal) =>
    fetch(`/api/dsh/sessions/${encodeURIComponent(id)}/trajectory/${encodeURIComponent(eventId)}/detail`, { method: "POST", signal }).then((r) =>
      json<{ detail: DshTrajectoryDetail }>(r)),
  dshTrajectoryExportUrl: (id: string) => `/api/dsh/sessions/${encodeURIComponent(id)}/trajectory/export`,
  dshTrajectoryFullExport: (id: string, signal?: AbortSignal) =>
    fetch(`/api/dsh/sessions/${encodeURIComponent(id)}/trajectory/export-full`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "export-sensitive-dsh-trajectory" }),
      signal,
    }).then(async (response) => {
      if (!response.ok) await json<never>(response);
      return response.blob();
    }),

  models: (directory: string) =>
    fetch(scoped("/models", directory)).then((r) => json<ModelCatalogue>(r)),

  managedChildAgents: (directory: string) =>
    fetch(scoped("/managed-child-agents", directory)).then((r) =>
      json<{ agents: ManagedChildAgentSummary[] }>(r),
    ),

  session: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}`, directory)).then((r) =>
      json<{ session: SessionSummary }>(r),
    ),

  messages: (directory: string, id: string, options: { limit?: number; before?: string } = {}) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/messages`, directory, {
      limit: String(options.limit ?? 100),
      ...(options.before ? { before: options.before } : {}),
    })).then((r) =>
      json<MessagePage>(r),
    ),

  sessionTurnDiff: (directory: string, id: string, userMessageID: string, signal?: AbortSignal) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/diff`, directory, { userMessageID }), { signal }).then((r) =>
      json<{ changes: SessionTurnDiff[] }>(r),
    ),

  todos: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/todos`, directory)).then((r) =>
      json<{ todos: Todo[] }>(r),
    ),
  modelLimit: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/model-limit`, directory)).then((r) =>
      json<{ context: number | null }>(r),
    ),

  shareSession: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/share`, directory), {
      method: "POST",
    }).then((r) => json<{ session: SessionSummary }>(r)),
  unshareSession: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/share`, directory), {
      method: "DELETE",
    }).then((r) => json<{ session: SessionSummary }>(r)),

  createSession: (input: {
    directory: string;
    title?: string;
    mode?: AgentMode;
    model?: ModelSelection;
    prompt?: string;
    isolated?: boolean;
    worktreeName?: string;
  }) =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ session: SessionSummary }>(r)),

  startDcaSession: async (directory: string, input: {
    sourceSessionID: string;
    prompt: string;
    mode: AgentMode;
    model: ModelSelection;
    authorization?: "modify";
    isolated: boolean;
    idempotencyKey: string;
    workflow: string;
  }) => {
    const response = await fetch(scoped("/session-workflows/start", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        stage?: RootSessionFailureStage;
        session?: SessionSummary;
        directory?: string;
      };
      if (body.stage === "worktree" || body.stage === "session" || body.stage === "prompt") {
        throw new RootSessionLaunchApiError(
          response.status,
          body.error ?? `HTTP ${response.status}`,
          body.stage,
          body.session,
          body.directory,
        );
      }
      throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`);
    }
    return response.json() as Promise<{ session: SessionSummary; isolated: boolean; accepted: true }>;
  },

  prompt: (
    directory: string,
    id: string,
    text: string,
    // Plan/Build activate session policy; a foreign identity rides the
    // exclusive `agent` contract instead (issue #52, narrowed).
    identity: { mode: AgentMode } | { agent: string },
    model?: ModelSelection,
    attachments?: Array<{ filename: string; mime: string; url: string }>,
    reminder?: string,
    workflow?: string,
  ) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/prompt`, directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...identity,
        ...(model ? { model } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(reminder ? { reminder } : {}),
        ...(workflow ? { workflow } : {}),
      }),
    }).then((r) => json<{ accepted: boolean }>(r)),

  sessionAgents: (directory: string) =>
    fetch(scoped("/session-agents", directory)).then(
      (r) => json<{ agents: Array<{ id: string; description?: string }> }>(r),
    ),

  abort: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/abort`, directory), { method: "POST" }).then(
      (r) => json<{ aborted: boolean }>(r),
    ),

  subagents: (directory: string, id: string, signal?: AbortSignal) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/subagents`, directory), { signal }).then((r) =>
      json<SubagentReport>(r),
    ),

  createManagedChild: (directory: string, id: string, input: {
    prompt: string;
    agent: ManagedChildAgent;
    model?: ModelSelection;
    authorization?: "modify";
    idempotencyKey: string;
    workflow?: string;
  }) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/managed-children`, directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ session: SessionSummary }>(r)),

  abortSubagent: (directory: string, id: string, childID: string) =>
    fetch(
      scoped(`/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(childID)}/abort`, directory),
      { method: "POST" },
    ).then((r) => json<{ aborted: boolean }>(r)),

  backgroundSubagents: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}/background`, directory), { method: "POST" }).then(
      (r) => json<{ promoted: boolean }>(r),
    ),

  remove: (directory: string, id: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(id)}`, directory), { method: "DELETE" }).then((r) =>
      json<void>(r),
    ),

  settings: () => fetch("/api/settings").then((r) => json<{ settings: AppSettings }>(r)),
  saveSettings: (settings: AppSettings) =>
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }).then((r) => json<{ settings: AppSettings }>(r)),

  mcp: (directory: string) =>
    fetch(scoped("/mcp", directory)).then((r) => json<{ servers: Record<string, McpStatus> }>(r)),
  catalog: (directory: string, signal?: AbortSignal) =>
    fetch(scoped("/catalog", directory), { signal }).then((r) => json<CatalogResponse>(r)),
  setMcp: (directory: string, name: string, connected: boolean) =>
    fetch(scoped(`/mcp/${encodeURIComponent(name)}/${connected ? "connect" : "disconnect"}`, directory), {
      method: "POST",
    }).then((r) => json<{ servers: Record<string, McpStatus> }>(r)),
  permissions: (directory: string) =>
    fetch(scoped("/permissions", directory)).then((r) => json<{ permissions: unknown }>(r)),
  lsp: (directory: string) =>
    fetch(scoped("/lsp", directory)).then((r) => json<{ servers: unknown }>(r)),

  notifications: () =>
    fetch("/api/notifications").then((r) =>
      json<{ preferences: NotificationPreferences; tokenConfigured: boolean; webPush: { configured: boolean; publicKey: string | null } }>(r),
    ),
  saveNotifications: (preferences: NotificationPreferences) =>
    fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preferences),
    }).then((r) => json<{ preferences: NotificationPreferences; tokenConfigured: boolean; webPush: { configured: boolean; publicKey: string | null } }>(r)),
  testNtfy: () =>
    fetch("/api/notifications/test", { method: "POST" }).then((r) => json<{ sent: boolean }>(r)),
  addPushSubscription: (subscription: PushSubscriptionJSON & { installationId?: string }) =>
    fetch("/api/notifications/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    }).then((r) => r.ok ? undefined : json<never>(r)),
  listPushSubscriptions: () =>
    fetch("/api/notifications/push-subscriptions")
      .then((r) => json<{ subscriptions: PushSubscriptionSummary[] }>(r)),
  removePushSubscriptionById: (id: string) =>
    fetch(`/api/notifications/push-subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((r) => r.ok ? undefined : json<never>(r)),
  removeAllPushSubscriptions: () =>
    fetch("/api/notifications/push-subscriptions/all", {
      method: "DELETE",
    }).then((r) => r.ok ? undefined : json<never>(r)),
  removePushSubscription: (endpoint: string) =>
    fetch("/api/notifications/push-subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).then((r) => r.ok ? undefined : json<never>(r)),
  testWebPush: (endpoint: string) =>
    fetch("/api/notifications/test-web-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).then((r) => json<{ sent: number; failed: number }>(r)),
  notificationHistory: (
    options: {
      limit?: number;
      kind?: NotifyEvent;
      state?: NotificationHistoryState;
      directory?: string;
      hideAutoApproved?: boolean;
      hideSubagent?: boolean;
      hidePreferenceOff?: boolean;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.kind) query.set("kind", options.kind);
    if (options.state && options.state !== "all") query.set("state", options.state);
    if (options.directory) query.set("directory", options.directory);
    if (options.hideAutoApproved) query.set("hideAutoApproved", "1");
    if (options.hideSubagent) query.set("hideSubagent", "1");
    if (options.hidePreferenceOff) query.set("hidePreferenceOff", "1");
    const suffix = query.size ? `?${query}` : "";
    return fetch(`/api/notifications/history${suffix}`).then((r) =>
      json<{
        records: NotificationRecord[];
        activeCount: number;
        appBadgeCount: number;
        appBadgeRevision: number;
        suppressedActive?: SuppressedActiveCounts;
      }>(r),
    );
  },
  dismissNotification: (id: string) =>
    fetch(`/api/notifications/${encodeURIComponent(id)}/dismiss`, { method: "POST" }).then((r) =>
      json<{ dismissed: boolean; activeCount: number; appBadgeCount: number; appBadgeRevision: number }>(r),
    ),
  setNotificationResolved: (id: string, resolved: boolean) =>
    fetch(`/api/notifications/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved }),
    }).then((r) => json<{ record: NotificationRecord; activeCount: number; appBadgeCount: number; appBadgeRevision: number }>(r)),

  resolveNotifications: (ids: string[], directory?: string) =>
    fetch(`/api/notifications/resolve${directory ? `?${new URLSearchParams({ directory })}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => json<{ records: NotificationRecord[]; activeCount: number; appBadgeCount: number; appBadgeRevision: number }>(r)),

  autoPermissions: (directory: string) =>
    fetch(scoped("/auto-approve", directory)).then((r) => json<AutoPermissionStatus>(r)),
  setAutoPermissions: (directory: string, enabled: boolean) =>
    fetch(scoped("/auto-approve", directory), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).then((r) => json<AutoPermissionStatus>(r)),

  workspaceTree: (directory: string, path = "") =>
    fetch(scoped("/workspace/tree", directory, { path })).then((r) =>
      json<{ path: string; dirs: WorkspaceNode[]; files: WorkspaceNode[] }>(r),
    ),
  workspaceFile: (directory: string, path: string, signal?: AbortSignal) =>
    fetch(scoped("/workspace/file", directory, { path }), { signal }).then((r) => json<WorkspaceFile>(r)),
  /** Batched on purpose: one request per rendered code span would spawn a
   * `git check-ignore` process per span. See server/routes/workspace.ts. */
  workspaceReferences: (directory: string, paths: string[], signal?: AbortSignal) =>
    fetch(scoped("/workspace/references", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
      signal,
    }).then((r) => json<{ references: WorkspaceReference[] }>(r)),
  changes: (directory: string, mode: "git" | "branch") =>
    fetch(scoped("/workspace/changes", directory, { mode })).then((r) =>
      json<{ changes: VcsFileDiff[] }>(r),
    ),
  commits: (directory: string) =>
    fetch(scoped("/workspace/commits", directory)).then((r) => json<{ commits: GitCommit[] }>(r)),
  worktrees: (directory: string) =>
    fetch(scoped("/worktrees", directory)).then((r) => json<{ worktrees: Worktree[] }>(r)),
  createWorktree: (directory: string, name?: string) =>
    fetch(scoped("/worktrees", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name ? { name } : {}),
    }).then((r) => json<{ worktree: Worktree }>(r)),
  resetWorktree: (directory: string, worktreeDirectory: string) =>
    fetch(scoped("/worktrees/reset", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeDirectory }),
    }).then((r) => json<{ reset: boolean }>(r)),
  deleteWorktree: (directory: string, worktreeDirectory: string) =>
    fetch(scoped("/worktrees", directory), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeDirectory }),
    }).then((r) => json<void>(r)),
  /** Not project-scoped: the planning feed is one fixed repository (see server/github-planning.ts). */
  planningItems: (refresh = false) => fetch(`/api/planning/items${refresh ? "?refresh=1" : ""}`).then((r) => json<PlanningSnapshot>(r)),
  planningLabels: () => fetch("/api/planning/labels").then((r) => json<{ labels: PlanningLabel[]; truncated: boolean }>(r)),
  planningItemDetails: (number: number) => fetch(`/api/planning/items/${encodeURIComponent(number)}`).then((r) => json<{ details: PlanningItemDetails }>(r)),
  updatePlanningItemLabels: (number: number, labels: string[]) =>
    fetch(`/api/planning/items/${encodeURIComponent(number)}/labels`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    }).then((r) => json<{ item: PlanningItem }>(r)),
  createPlanningIssue: (input: CreatePlanningIssueInput) =>
    fetch("/api/planning/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ issue: PlanningItem }>(r)),
  review: (url: string) =>
    fetch(`/api/forge/review?${new URLSearchParams({ url })}`).then((r) => json<{ review: ReviewStatus }>(r)),
  reviewDetails: (url: string) =>
    fetch(`/api/forge/review/details?${new URLSearchParams({ url })}`).then((r) => json<{ details: ReviewDetails }>(r)),
  mergeReview: (url: string, expectedSha: string) =>
    fetch("/api/forge/review/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, expectedSha }),
    }).then((r) => json<{ merged: boolean }>(r)),
  permissionRequests: (directory: string) =>
    fetch(scoped("/permission-requests", directory)).then((r) =>
      json<{ requests: PermissionRequest[] }>(r),
    ),
  replyPermission: (directory: string, requestId: string, reply: "once" | "always" | "reject") =>
    fetch(scoped(`/permission-requests/${encodeURIComponent(requestId)}/reply`, directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    }).then((r) => json<{ replied: boolean }>(r)),
  questionRequests: (directory: string, sessionId: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(sessionId)}/questions`, directory)).then((r) =>
      json<{ requests: QuestionRequest[] }>(r),
    ),
  replyQuestion: (directory: string, sessionId: string, requestId: string, answers: string[][]) =>
    fetch(scoped(`/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}/reply`, directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    }).then((r) => json<{ replied: boolean }>(r)),
  rejectQuestion: (directory: string, sessionId: string, requestId: string) =>
    fetch(scoped(`/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(requestId)}/reject`, directory), {
      method: "POST",
    }).then((r) => json<{ rejected: boolean }>(r)),
  // Directory-scoped: a reminder may be restricted to one repository, so the
  // server needs to know which project is selected before it will list it.
  reminders: (directory: string) =>
    fetch(`/api/reminders?directory=${encodeURIComponent(directory)}`).then((r) => json<{ reminders: ReminderSummary[] }>(r)),
  workflows: () =>
    fetch("/api/workflows").then((r) => json<{ workflows: WorkflowSummary[] }>(r)),

  /**
   * Not project-scoped: these describe this host, not a project. The log
   * source is an enum the server resolves to a fixed path; the browser never
   * names a file (see `server/logs.ts`).
   */
  observabilityLogs: (source: LogSource, refresh = false) =>
    fetch(`/api/observability/logs?source=${encodeURIComponent(source)}${refresh ? "&refresh=1" : ""}`).then((r) =>
      json<LogSnapshot>(r),
    ),
  observabilityDeployment: (refresh = false) =>
    fetch(`/api/observability/deployment${refresh ? "?refresh=1" : ""}`).then((r) => json<DeploymentSnapshot>(r)),

  /** SSE endpoint URL — consumed by EventSource, not fetch. */
  eventsUrl: (directory?: string) =>
    directory ? `/api/events?directory=${encodeURIComponent(directory)}` : "/api/events",
};

/** Format a dollar amount the way the status bar and list rows expect. */
export function formatCost(cost: number | undefined): string {
  if (!cost) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}
