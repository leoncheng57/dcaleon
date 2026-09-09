// server/opencode/sessions.ts
//
// Session operations against the OpenCode server. Thin, but every function
// here encodes at least one thing that is easy to get wrong:
//
//   - prompt() uses /prompt_async, never /message. The latter holds the HTTP
//     response open for the ENTIRE agent turn, which looks like a hang from a
//     UI and dies the moment a client disconnects.
//   - Every call is directory-scoped. One OpenCode server hosts every project;
//     omitting ?directory= silently targets whichever directory the server was
//     started in.
//   - status() only reports sessions owned by the current server process,
//     which is exactly what makes crash detection possible (detectInterrupted).

import { createHash } from "node:crypto";

import { withReminderTag, type ReminderPreset } from "../reminders/reminders.js";
import { withWorkflowTag, type WorkflowPreset } from "../workflows/workflows.js";
import { isSensitiveWorkspacePath } from "../paths.js";
import { recordInstruction, redactInstructionText } from "./instruction-audit.js";
import { request, requestWithResponse, type OpencodeConfig } from "./client.js";
import type { VcsFileDiff } from "./workspace.js";

export type AgentMode = "plan" | "build";

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

const PLAN_TOOL_ALLOWLIST = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "question",
  "task",
  "todowrite",
  "skill",
]);

type PermissionAction = "allow" | "ask" | "deny";

interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

type PermissionRuleset = PermissionRule[];

export const MANAGED_CHILD_AGENT_IDS = ["plan", "build", "explore", "general"] as const;
export type ManagedChildAgent = typeof MANAGED_CHILD_AGENT_IDS[number];
export type ManagedChildAccess = "read-only" | "can-modify";

export interface ManagedChildAgentSummary {
  id: ManagedChildAgent;
  description?: string;
  access: ManagedChildAccess;
}

export interface ManagedChildMetadata {
  origin: "managed-human";
  requestedAgent: ManagedChildAgent;
  /** Retained while already-persisted v1 metadata ages out. */
  requestedMode?: AgentMode;
  requestedModel?: ModelSelection;
  background: true;
  policySource: "creation-permission";
  effectivePolicyObserved: boolean;
  authorization: "read-only" | "modify";
}

interface RawAgent {
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  permission?: PermissionRuleset;
}

const MANAGED_CHILD_ACCESS: Record<ManagedChildAgent, ManagedChildAccess> = {
  plan: "read-only",
  explore: "read-only",
  build: "can-modify",
  general: "can-modify",
};

export function isManagedChildAgent(value: unknown): value is ManagedChildAgent {
  return typeof value === "string" && (MANAGED_CHILD_AGENT_IDS as readonly string[]).includes(value);
}

export function managedChildAccess(agent: ManagedChildAgent): ManagedChildAccess {
  return MANAGED_CHILD_ACCESS[agent];
}

interface RawMessage {
  info?: { role?: string; agent?: string };
}

const EDIT_TOOL_ALIASES = new Set(["edit", "write", "apply_patch"]);
const sessionPromptTails = new Map<string, Promise<void>>();

export class ModePolicyActivationError extends Error {
  constructor(mode: AgentMode) {
    super(`Could not activate OpenCode ${mode === "plan" ? "Plan" : "Build"} policy; prompt was not sent`);
    this.name = "ModePolicyActivationError";
  }
}

export type SessionAgentIdentityErrorCode =
  | "SESSION_AGENT_UNKNOWN"
  | "SESSION_AGENT_UNSUPPORTED"
  | "SESSION_AGENT_MISMATCH";

export class SessionAgentIdentityError extends Error {
  constructor(
    readonly code: SessionAgentIdentityErrorCode,
    readonly agent?: string,
  ) {
    super(code === "SESSION_AGENT_MISMATCH"
      ? `This session is driven by OpenCode agent "${agent}". Prompt it with that agent; switching a session to a different agent is not supported.`
      : agent
        ? `This session uses OpenCode agent "${agent}". Prompt it with that agent explicitly, or continue it in the TUI.`
        : "This session's OpenCode agent could not be established. Continue it in the TUI or create a web Plan or Build session.");
    this.name = "SessionAgentIdentityError";
  }
}

/** The connected server's live roster no longer offers the requested agent. */
export class SessionAgentUnavailableError extends Error {
  constructor(readonly agent: string) {
    super(`OpenCode agent "${agent}" is not available on the connected server; the prompt was not sent.`);
    this.name = "SessionAgentUnavailableError";
  }
}

function validRuleset(value: unknown): value is PermissionRuleset {
  return Array.isArray(value) && value.every((rule) => {
    if (!rule || typeof rule !== "object") return false;
    const source = rule as Partial<PermissionRule>;
    return typeof source.permission === "string"
      && typeof source.pattern === "string"
      && (source.action === "allow" || source.action === "ask" || source.action === "deny");
  });
}

function rulesEndWith(rules: PermissionRuleset, suffix: PermissionRuleset): boolean {
  if (suffix.length === 0 || suffix.length > rules.length) return false;
  return suffix.every((rule, index) => {
    const existing = rules[rules.length - suffix.length + index];
    return existing.permission === rule.permission
      && existing.pattern === rule.pattern
      && existing.action === rule.action;
  });
}

function rulesEqual(left: PermissionRuleset, right: PermissionRuleset): boolean {
  return left.length === right.length && rulesEndWith(left, right);
}

function permissionNames(tool: string): Set<string> {
  return EDIT_TOOL_ALIASES.has(tool) ? new Set(["*", "edit", tool]) : new Set(["*", tool]);
}

function buildRulesForTools(agentRules: PermissionRuleset, toolIDs: string[]): PermissionRuleset {
  return toolIDs.flatMap((tool) => {
    const names = permissionNames(tool);
    return agentRules
      .filter((rule) => names.has(rule.permission))
      .map((rule) => ({ ...rule, permission: tool }));
  });
}

function hasPlanDenial(rules: PermissionRuleset, toolIDs: string[]): boolean {
  return toolIDs.some((tool) => {
    const names = permissionNames(tool);
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];
      if (rule.pattern === "*" && rule.permission !== "*" && names.has(rule.permission)) {
        return rule.action === "deny";
      }
    }
    return false;
  });
}

/**
 * The agents a session's identity is composed of: the session record's agent
 * plus the latest user message's agent. User messages persist the
 * selected/session-driving agent; assistant agents include internal execution
 * identities such as the automatic compactor and are not identity.
 */
function drivingAgents(session: RawSession, messages: RawMessage[]): string[] {
  let messageAgent: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index].info;
    if (info?.role !== "user" || typeof info.agent !== "string" || !info.agent) continue;
    messageAgent = info.agent;
    break;
  }
  return [session.agent, messageAgent]
    .filter((agent): agent is string => typeof agent === "string" && agent.length > 0);
}

function assertModeAgentIdentity(session: RawSession, messages: RawMessage[]): void {
  const agents = drivingAgents(session, messages);
  const unsupported = agents.find((agent) => agent !== "plan" && agent !== "build");
  if (unsupported) throw new SessionAgentIdentityError("SESSION_AGENT_UNSUPPORTED", unsupported);
  if (agents.length === 0) throw new SessionAgentIdentityError("SESSION_AGENT_UNKNOWN");
}

async function withSessionPromptLock<T>(
  directory: string,
  sessionID: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${directory}\0${sessionID}`;
  const previous = sessionPromptTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  sessionPromptTails.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (sessionPromptTails.get(key) === tail) sessionPromptTails.delete(key);
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  directory: string;
  /** Set when this session was delegated to by another session. */
  parentID?: string;
  /**
   * Non-archived children of this session in the same directory.
   *
   * Derived by grouping the directory listing rather than by asking upstream,
   * because `/session` already returns children — 124 of 149 sessions in one
   * audited directory — so the count is free and a per-row `children` call
   * would not be.
   */
  childCount: number;
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
  /** Present only for children explicitly launched by a human through the BFF. */
  managed?: ManagedChildMetadata;
  /** True even when managed metadata exists but fails validation. */
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
  /** Derived from GET /session/status. False also means "owned by nobody". */
  running: boolean;
}

interface RawSession {
  id?: string;
  title?: string;
  directory?: string;
  parentID?: string;
  agent?: string;
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string };
  metadata?: Record<string, unknown>;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  permission?: PermissionRuleset;
  share?: { url?: unknown };
  time?: { created?: number; updated?: number; archived?: number };
}

const MANAGED_METADATA_KEY = "customDcaManagedChild";

function hasManagedChildMarker(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, MANAGED_METADATA_KEY);
}

function policyFingerprint(permission: PermissionRuleset): string {
  return createHash("sha256").update(JSON.stringify(permission)).digest("hex");
}

function managedChildMetadata(value: unknown, permission?: PermissionRuleset): ManagedChildMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = (value as Record<string, unknown>)[MANAGED_METADATA_KEY];
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  const requestedAgent = isManagedChildAgent(record.requestedAgent)
    ? record.requestedAgent
    : isManagedChildAgent(record.requestedMode)
      ? record.requestedMode
      : undefined;
  if (
    record.origin !== "managed-human" ||
    record.background !== true ||
    !requestedAgent
  ) {
    return undefined;
  }
  const authorization = MANAGED_CHILD_ACCESS[requestedAgent] === "can-modify" ? "modify" : "read-only";
  if (record.version === 2 && record.authorization !== authorization) return undefined;
  const model = record.requestedModel;
  const requestedModel = model && typeof model === "object" && !Array.isArray(model)
    && typeof (model as Record<string, unknown>).providerID === "string"
    && typeof (model as Record<string, unknown>).modelID === "string"
    ? {
        providerID: (model as Record<string, string>).providerID,
        modelID: (model as Record<string, string>).modelID,
        ...(typeof (model as Record<string, unknown>).variant === "string"
          ? { variant: (model as Record<string, string>).variant }
          : {}),
      }
    : undefined;
  return {
    origin: "managed-human",
    requestedAgent,
    ...(record.requestedMode === "plan" || record.requestedMode === "build"
      ? { requestedMode: record.requestedMode }
      : {}),
    ...(requestedModel ? { requestedModel } : {}),
    background: true,
    policySource: "creation-permission",
    effectivePolicyObserved: validRuleset(permission)
      && typeof record.policyFingerprint === "string"
      && record.policyFingerprint === policyFingerprint(permission),
    authorization,
  };
}

export interface SessionMetadata {
  id: string;
  parentID?: string;
  title?: string;
}

/**
 * Titles are user- and model-authored, so they are capped before they reach a
 * cache or a durable notification record. A runaway title must not be able to
 * grow the history file.
 */
export const SESSION_TITLE_LIMIT = 160;

export function truncateSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > SESSION_TITLE_LIMIT ? `${trimmed.slice(0, SESSION_TITLE_LIMIT - 1)}\u2026` : trimmed;
}

export function parseSessionMetadata(value: unknown): SessionMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; parentID?: unknown; title?: unknown };
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (raw.parentID !== undefined && typeof raw.parentID !== "string") return null;
  const title = truncateSessionTitle(raw.title);
  return {
    id: raw.id,
    ...(raw.parentID ? { parentID: raw.parentID } : {}),
    ...(title ? { title } : {}),
  };
}

/** Fetch only the metadata needed to identify a delegated session. */
export async function getSessionMetadata(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SessionMetadata | null> {
  const raw = await request<unknown>(config, `/session/${encodeURIComponent(sessionID)}`, {
    directory,
    signal,
  });
  const metadata = parseSessionMetadata(raw);
  return metadata?.id === sessionID ? metadata : null;
}

function safeShareUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

async function activateModePolicy(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  mode: AgentMode,
): Promise<void> {
  try {
    const [desiredRules, session, messages] = await Promise.all([
      resolveModePolicy(config, directory, mode),
      request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, { directory }),
      request<RawMessage[]>(config, `/session/${encodeURIComponent(sessionID)}/message`, {
        directory,
        query: { limit: 100 },
      }),
    ]);
    if (session.permission !== undefined && !validRuleset(session.permission)) {
      throw new Error("invalid session permission rules");
    }
    if (!Array.isArray(messages)) throw new Error("invalid session message history");
    assertModeAgentIdentity(session, messages);
    const currentRules = session.permission ?? [];
    if (rulesEndWith(currentRules, desiredRules)) return;
    if (mode === "build" && !hasPlanDenial(
      currentRules,
      desiredRules.map((rule) => rule.permission).filter((permission, index, all) =>
        !PLAN_TOOL_ALLOWLIST.has(permission) && all.indexOf(permission) === index),
    )) return;

    await request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, {
      method: "PATCH",
      directory,
      body: { permission: desiredRules },
    });
  } catch (error) {
    if (error instanceof SessionAgentIdentityError) throw error;
    throw new ModePolicyActivationError(mode);
  }
}

async function resolveModePolicy(
  config: OpencodeConfig,
  directory: string,
  mode: AgentMode,
): Promise<PermissionRuleset> {
  return resolveManagedChildPolicy(config, directory, mode, true);
}

async function managedAgentCatalogue(
  config: OpencodeConfig,
  directory: string,
): Promise<RawAgent[]> {
  const agents = await request<unknown>(config, "/agent", { directory });
  if (!Array.isArray(agents)) throw new Error("invalid agent catalogue");
  return agents as RawAgent[];
}

export async function listManagedChildAgents(
  config: OpencodeConfig,
  directory: string,
): Promise<ManagedChildAgentSummary[]> {
  const [agents, rawToolIDs] = await Promise.all([
    managedAgentCatalogue(config, directory),
    request<unknown>(config, "/experimental/tool/ids", { directory }),
  ]);
  if (
    !Array.isArray(rawToolIDs) ||
    rawToolIDs.length === 0 ||
    rawToolIDs.some((id) => typeof id !== "string" || !id) ||
    rawToolIDs.every((id) => typeof id === "string" && PLAN_TOOL_ALLOWLIST.has(id))
  ) {
    throw new Error("invalid tool catalogue");
  }
  const toolIDs = rawToolIDs as string[];
  return MANAGED_CHILD_AGENT_IDS.flatMap((id) => {
    const agent = agents.find((candidate) => candidate?.name === id && candidate.hidden !== true);
    if (!agent || !validRuleset(agent.permission)) return [];
    if (MANAGED_CHILD_ACCESS[id] === "can-modify" && toolIDs.some((tool) => {
      const names = permissionNames(tool);
      return !agent.permission!.some((rule) => names.has(rule.permission));
    })) return [];
    const description = typeof agent.description === "string"
      ? agent.description.replace(/\s+/gu, " ").trim().slice(0, 240)
      : "";
    return [{
      id,
      ...(description ? { description } : {}),
      access: MANAGED_CHILD_ACCESS[id],
    }];
  });
}

async function resolveManagedChildPolicy(
  config: OpencodeConfig,
  directory: string,
  agentID: ManagedChildAgent,
  includeHidden = false,
): Promise<PermissionRuleset> {
  const [toolIDs, agents] = await Promise.all([
    request<unknown>(config, "/experimental/tool/ids", { directory }),
    managedAgentCatalogue(config, directory),
  ]);
  if (!Array.isArray(toolIDs) || toolIDs.length === 0 || toolIDs.some((id) => typeof id !== "string" || !id)) {
    throw new Error("invalid tool catalogue");
  }
  const agent = agents.find((candidate) => candidate?.name === agentID && (includeHidden || candidate.hidden !== true));
  const agentRules = agent?.permission;
  if (!validRuleset(agentRules)) throw new Error(`missing resolved ${agentID} agent policy`);

  const tools = toolIDs as string[];
  const restrictedTools = tools.filter((id) => !PLAN_TOOL_ALLOWLIST.has(id));
  if (restrictedTools.length === 0) throw new Error("tool catalogue has no restricted tools");
  if (agentID === "plan" || agentID === "explore") {
    return restrictedTools.map((permission) => ({ permission, pattern: "*", action: "deny" }));
  }
  if (tools.some((tool) => {
    const names = permissionNames(tool);
    return !agentRules.some((rule) => names.has(rule.permission));
  })) {
    throw new Error(`${agentID} agent policy does not cover every discovered tool`);
  }
  return buildRulesForTools(agentRules, tools);
}

export function toSummary(raw: RawSession, running: boolean): SessionSummary {
  const now = Date.now();
  return {
    id: raw.id ?? "",
    title: raw.title?.trim() || "Untitled session",
    directory: raw.directory ?? "",
    parentID: raw.parentID,
    childCount: 0,
    agent: raw.agent,
    model: raw.model
      ? { providerID: raw.model.providerID, modelID: raw.model.modelID ?? raw.model.id, variant: raw.model.variant }
      : undefined,
    managed: managedChildMetadata(raw.metadata, raw.permission),
    ...(hasManagedChildMarker(raw.metadata) ? { managedConfigurationPresent: true as const } : {}),
    cost: raw.cost ?? 0,
    tokens: {
      input: raw.tokens?.input ?? 0,
      output: raw.tokens?.output ?? 0,
      reasoning: raw.tokens?.reasoning ?? 0,
      cacheRead: raw.tokens?.cache?.read ?? 0,
      cacheWrite: raw.tokens?.cache?.write ?? 0,
    },
    createdAt: new Date(raw.time?.created ?? now).toISOString(),
    updatedAt: new Date(raw.time?.updated ?? raw.time?.created ?? now).toISOString(),
    archived: typeof raw.time?.archived === "number",
    shareUrl: safeShareUrl(raw.share?.url),
    running,
  };
}

type StatusMap = Record<string, { type?: string } | undefined>;

/** IDs the current server process is actively working on. */
export async function runningSessions(
  config: OpencodeConfig,
  directory: string,
): Promise<Set<string>> {
  const data = await request<StatusMap>(config, "/session/status", { directory });
  return new Set(
    Object.entries(data ?? {})
      .filter(([, value]) => value?.type === "busy" || value?.type === "retry")
      .map(([id]) => id),
  );
}

export async function listSessions(
  config: OpencodeConfig,
  directory: string,
  options: { limit?: number; rootsOnly?: boolean; search?: string } = {},
): Promise<SessionSummary[]> {
  const [raw, running] = await Promise.all([
    request<RawSession[]>(config, "/session", {
      directory,
      query: {
        limit: options.limit ?? 100,
        roots: options.rootsOnly ? true : undefined,
        search: options.search,
      },
    }),
    // A status failure must not blank the whole list.
    runningSessions(config, directory).catch(() => new Set<string>()),
  ]);
  const summaries = (raw ?? [])
    .filter((s) => !s.time?.archived)
    .map((s) => toSummary(s, running.has(s.id ?? "")));
  // A roots-only listing has no children to count, and reporting zero would
  // claim every root is a leaf. Leave the field untouched instead.
  return options.rootsOnly ? summaries : withChildCounts(summaries);
}

/**
 * Fill in `childCount` from the sessions we already have.
 *
 * Only meaningful over a full directory listing: with `roots=true` the children
 * are absent, so every count would read zero and the UI would claim leaf
 * sessions that are not leaves. Callers that filter to roots must not use this.
 */
export function withChildCounts(sessions: SessionSummary[]): SessionSummary[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    counts.set(session.parentID, (counts.get(session.parentID) ?? 0) + 1);
  }
  if (counts.size === 0) return sessions;
  return sessions.map((session) => {
    const childCount = counts.get(session.id) ?? 0;
    return childCount === session.childCount ? session : { ...session, childCount };
  });
}

/** Upstream calls in flight during a cross-project fan-out. */
export const RECENT_FANOUT_CONCURRENCY = 6;

/**
 * Sessions from many projects at once, newest first.
 *
 * There is no cross-project session list upstream: `/session` is
 * directory-scoped, so "recent across every project" can only be a fan-out.
 * Two properties matter more than speed here:
 *
 *   - A directory that fails must not blank the list. One unreadable or
 *     renamed project would otherwise take down a panel that is mostly about
 *     other projects, so per-directory failures are swallowed.
 *   - Concurrency is capped. The caller's directory list is user-controlled
 *     (pins plus browser history), and an unbounded Promise.all would let a
 *     large one open hundreds of upstream sockets at once.
 *
 * Each directory still costs two upstream calls (`/session` + `/session/status`)
 * because status is directory-scoped in 1.18.21. If a later server exposes a
 * process-global status map, hoist that single call out of the pool.
 */
export async function listSessionsAcross(
  config: OpencodeConfig,
  directories: string[],
  options: { perDirectoryLimit?: number } = {},
): Promise<SessionSummary[]> {
  const targets = [...new Set(directories.filter((directory) => directory))];
  const collected: SessionSummary[][] = targets.map(() => []);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      collected[index] = await listSessions(config, targets[index], {
        limit: options.perDirectoryLimit ?? 20,
      }).catch(() => []);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(RECENT_FANOUT_CONCURRENCY, targets.length) }, worker),
  );

  // Ties keep fan-out order, which is the caller's directory order, so the
  // result is stable across polls instead of shuffling on every refresh.
  return collected
    .flat()
    .map((session, index) => ({ session, index, updatedAt: Date.parse(session.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
      const rightTime = Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
      return rightTime - leftTime || left.index - right.index;
    })
    .map(({ session }) => session);
}

export async function getSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<SessionSummary> {
  const [raw, running] = await Promise.all([
    request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, { directory }),
    runningSessions(config, directory).catch(() => new Set<string>()),
  ]);
  return toSummary(raw ?? {}, running.has(sessionID));
}

/** Rename a session via upstream PATCH /session/{id}. */
export async function renameSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  title: string,
): Promise<void> {
  await request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, {
    method: "PATCH",
    directory,
    body: { title },
  });
}

export interface SessionTurnDiff extends VcsFileDiff {
  patch: string;
  status: NonNullable<VcsFileDiff["status"]>;
}

export const SESSION_TURN_DIFF_LIMITS = {
  files: 50,
  characters: 120_000,
  lines: 3_000,
} as const;

export type SessionTurnDiffResult =
  | { status: "ok"; changes: SessionTurnDiff[] }
  | { status: "too_large" };

function patchLineCount(patch: string): number {
  let lines = 1;
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export async function getSessionTurnDiff(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  userMessageID: string,
): Promise<SessionTurnDiffResult> {
  const changes = await request<unknown>(
    config,
    `/session/${encodeURIComponent(sessionID)}/diff`,
    { directory, query: { messageID: userMessageID } },
  );
  if (!Array.isArray(changes)) return { status: "ok", changes: [] };
  if (changes.length > SESSION_TURN_DIFF_LIMITS.files) return { status: "too_large" };

  const result: SessionTurnDiff[] = [];
  let characters = 0;
  let lines = 0;
  for (const change of changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) continue;
    const source = change as Record<string, unknown>;
    if (
      typeof source.file !== "string" || !source.file.trim() ||
      typeof source.patch !== "string" ||
      typeof source.additions !== "number" || !Number.isInteger(source.additions) || source.additions < 0 ||
      typeof source.deletions !== "number" || !Number.isInteger(source.deletions) || source.deletions < 0 ||
      (source.status !== "added" && source.status !== "deleted" && source.status !== "modified")
    ) continue;
    if (isSensitiveWorkspacePath(source.file)) continue;

    characters += source.patch.length;
    if (characters > SESSION_TURN_DIFF_LIMITS.characters) return { status: "too_large" };
    lines += patchLineCount(source.patch);
    if (
      result.length >= SESSION_TURN_DIFF_LIMITS.files ||
      lines > SESSION_TURN_DIFF_LIMITS.lines
    ) {
      return { status: "too_large" };
    }
    result.push({
      file: source.file,
      patch: source.patch,
      additions: source.additions,
      deletions: source.deletions,
      status: source.status,
    });
  }
  return { status: "ok", changes: result };
}

export interface CreateSessionInput {
  directory: string;
  title?: string;
  agent?: string;
  model?: ModelSelection;
  parentID?: string;
  metadata?: Record<string, unknown>;
  permission?: PermissionRuleset;
}

export async function createSession(
  config: OpencodeConfig,
  input: CreateSessionInput,
): Promise<SessionSummary> {
  const raw = await request<RawSession>(config, "/session", {
    method: "POST",
    directory: input.directory,
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? {
        model: {
          providerID: input.model.providerID,
          id: input.model.modelID,
          ...(input.model.variant ? { variant: input.model.variant } : {}),
        },
      } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.permission ? { permission: input.permission } : {}),
    },
  });
  return toSummary(raw ?? {}, false);
}

export interface PromptInput {
  text: string;
  mode: AgentMode;
  model?: ModelSelection;
  attachments?: Array<{ filename: string; mime: string; url: string }>;
  reminder?: Pick<ReminderPreset, "id" | "body">;
  workflow?: Pick<WorkflowPreset, "id" | "injector">;
}

/**
 * The persisted message text: the visible prompt plus any trusted sentinel
 * blocks. The workflow injector rides closest to the prompt it belongs to;
 * a reminder (a separate, per-message concept) is appended after it.
 */
function composePromptText(input: PromptInput): string {
  let text = input.text;
  if (input.workflow) text = withWorkflowTag(text, input.workflow);
  if (input.reminder) text = withReminderTag(text, input.reminder);
  return text;
}

async function submitPromptAsync(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  input: PromptInput & { agent?: string },
): Promise<void> {
  await request<void>(config, `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: "POST",
    directory,
    body: {
      agent: input.agent ?? input.mode,
      ...(input.model ? {
        model: { providerID: input.model.providerID, modelID: input.model.modelID },
        ...(input.model.variant ? { variant: input.model.variant } : {}),
      } : {}),
      parts: [
        {
          type: "text",
          text: composePromptText(input),
        },
        ...(input.attachments ?? []).map((attachment) => ({
          type: "file" as const,
          mime: attachment.mime,
          filename: attachment.filename,
          url: attachment.url,
        })),
      ],
    },
  });
}

/**
 * Send a prompt WITHOUT waiting for the turn.
 *
 * `/prompt_async` answers 204 immediately and the agent loop continues
 * server-side — which is what lets the browser close, the laptop sleep, and a
 * notification arrive later. Progress arrives over SSE.
 */
export async function prompt(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  input: PromptInput,
): Promise<void> {
  await withSessionPromptLock(directory, sessionID, async () => {
    await activateModePolicy(config, directory, sessionID, input.mode);
    await submitPromptAsync(config, directory, sessionID, input);
  });
}

export interface SessionAgentSummary {
  id: string;
  description?: string;
}

/**
 * Agents a session prompt may name (issue #52, narrowed): the live roster
 * minus hidden internals and delegation-only subagents. Plan and Build stay in
 * the list — they remain the only agents whose prompts activate session
 * policy — so the catalogue is the single source for the composer's choices.
 */
export async function listSessionAgents(
  config: OpencodeConfig,
  directory: string,
): Promise<SessionAgentSummary[]> {
  const agents = await managedAgentCatalogue(config, directory);
  return agents
    .filter((agent): agent is RawAgent & { name: string } =>
      typeof agent?.name === "string" && agent.name.length > 0 && agent.hidden !== true && agent.mode !== "subagent")
    .map((agent) => ({
      id: agent.name,
      ...(typeof agent.description === "string" && agent.description ? { description: agent.description } : {}),
    }));
}

/**
 * Prompt a session with the arbitrary agent identity it already has.
 *
 * The narrowed #52 contract:
 * - identity is preserved, never remapped — the named agent must equal the
 *   session's own driving agent, so this can never switch a session's agent;
 * - no Plan/Build session permission rules are applied or patched; the
 *   agent's own configured policy (plus any existing session ceiling) governs
 *   the turn;
 * - the agent must still exist, visible and session-capable, on the live
 *   roster — a vanished agent fails loudly before anything is sent.
 * Plan and Build are excluded here because their prompts must keep flowing
 * through the policy-activating path.
 */
export async function promptSessionAgent(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  input: Omit<PromptInput, "mode"> & { agent: string },
): Promise<void> {
  await withSessionPromptLock(directory, sessionID, async () => {
    const [session, messages, roster] = await Promise.all([
      request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, { directory }),
      request<RawMessage[]>(config, `/session/${encodeURIComponent(sessionID)}/message`, {
        directory,
        query: { limit: 100 },
      }),
      listSessionAgents(config, directory),
    ]);
    const identity = drivingAgents(session, messages ?? []);
    if (identity.length === 0) throw new SessionAgentIdentityError("SESSION_AGENT_UNKNOWN");
    const mismatch = identity.find((agent) => agent !== input.agent);
    if (mismatch) throw new SessionAgentIdentityError("SESSION_AGENT_MISMATCH", mismatch);
    if (!roster.some((agent) => agent.id === input.agent)) {
      throw new SessionAgentUnavailableError(input.agent);
    }
    await submitPromptAsync(config, directory, sessionID, {
      ...input,
      // `mode` is unused when `agent` is present; submit sends agent verbatim.
      mode: "build",
      agent: input.agent,
    });
  });
}

export interface ManagedChildInput {
  parentID: string;
  text: string;
  agent: ManagedChildAgent;
  model?: ModelSelection;
  idempotencyKey: string;
  /** Optional composer workflow whose trusted injector rides the first prompt. */
  workflow?: Pick<WorkflowPreset, "id" | "injector">;
}

interface ManagedLaunchEntry {
  fingerprint: string;
  promise: Promise<SessionSummary>;
  settled: boolean;
}

const managedLaunches = new Map<string, ManagedLaunchEntry>();
const MANAGED_LAUNCH_LIMIT = 500;

export class ManagedChildIdempotencyError extends Error {
  constructor() {
    super("idempotency key was already used for a different managed child launch");
    this.name = "ManagedChildIdempotencyError";
  }
}

export class ManagedChildCapacityError extends Error {
  constructor() {
    super("too many managed child launches are still in progress");
    this.name = "ManagedChildCapacityError";
  }
}

export class ManagedChildAgentPolicyError extends Error {
  constructor(readonly agent: ManagedChildAgent) {
    super(`Could not resolve the OpenCode ${agent} policy; Managed Child was not launched`);
    this.name = "ManagedChildAgentPolicyError";
  }
}

export class ManagedChildCleanupError extends Error {
  constructor(readonly childID: string, launchError: unknown, cleanupError: unknown) {
    super(`Managed child launch failed (${launchError instanceof Error ? launchError.message : String(launchError)}), and ${childID} may still exist because cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    this.name = "ManagedChildCleanupError";
  }
}

export class ManagedChildConfigurationError extends Error {
  constructor() {
    super("Managed Child configuration could not be verified; prompt was not sent");
    this.name = "ManagedChildConfigurationError";
  }
}

/**
 * The child's persisted session title, derived from its assignment.
 *
 * Redacts BEFORE the first line is taken and before the 80-character cap:
 * truncating first can cut a token into a shape no pattern still matches, and
 * a title is the single widest leak surface derived from an assignment — it
 * flows into session summaries, sub-agent rows, Hub titles, breadcrumbs and
 * persisted notification history, so filtering at render time would have to be
 * correct in every one of those places. The prompt actually submitted to
 * OpenCode is never redacted: the child must receive the exact text its human
 * wrote. This mitigates credential SHAPES in derived metadata; it is not a
 * licence to carry secrets in an assignment.
 */
export function managedChildTitle(text: string): string {
  const redacted = redactInstructionText(text);
  const firstLine = redacted.split(/\r?\n/u, 1)[0]?.replace(/\s+/gu, " ").trim() || "Managed Child";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function createManagedChild(
  config: OpencodeConfig,
  directory: string,
  input: ManagedChildInput,
): Promise<SessionSummary> {
  const key = `${directory}\0${input.parentID}\0${input.idempotencyKey}`;
  const fingerprint = JSON.stringify({
    parentID: input.parentID,
    text: input.text,
    agent: input.agent,
    model: input.model,
    workflow: input.workflow?.id,
  });
  const existing = managedLaunches.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return Promise.reject(new ManagedChildIdempotencyError());
    return existing.promise;
  }

  if (managedLaunches.size >= MANAGED_LAUNCH_LIMIT) {
    const settled = [...managedLaunches].find(([, entry]) => entry.settled)?.[0];
    if (settled) managedLaunches.delete(settled);
    else return Promise.reject(new ManagedChildCapacityError());
  }

  const launch = (async () => {
    let child: SessionSummary | undefined;
    try {
      let permission: PermissionRuleset;
      try {
        permission = await resolveManagedChildPolicy(config, directory, input.agent);
      } catch {
        throw new ManagedChildAgentPolicyError(input.agent);
      }
      const managed = {
        version: 2,
        origin: "managed-human",
        requestedAgent: input.agent,
        authorization: managedChildAccess(input.agent) === "can-modify" ? "modify" as const : "read-only" as const,
        ...(input.model ? { requestedModel: input.model } : {}),
        background: true as const,
        policyFingerprint: policyFingerprint(permission),
      };
      child = await createSession(config, {
        directory,
        parentID: input.parentID,
        title: managedChildTitle(input.text),
        agent: input.agent,
        model: input.model,
        permission,
        metadata: { [MANAGED_METADATA_KEY]: managed },
      });
      const persisted = await request<RawSession>(config, `/session/${encodeURIComponent(child.id)}`, { directory });
      const persistedModelID = persisted.model?.modelID ?? persisted.model?.id;
      const persistedManaged = managedChildMetadata(persisted.metadata, persisted.permission);
      if (
        !child.id ||
        persisted.id !== child.id ||
        persisted.directory !== directory ||
        persisted.parentID !== input.parentID ||
        persisted.agent !== input.agent ||
        !validRuleset(persisted.permission) ||
        !rulesEqual(persisted.permission, permission) ||
        persistedManaged?.requestedAgent !== input.agent ||
        persistedManaged?.background !== true ||
        persistedManaged?.effectivePolicyObserved !== true ||
        (input.model && (
          persisted.model?.providerID !== input.model.providerID ||
          persistedModelID !== input.model.modelID ||
          persisted.model?.variant !== input.model.variant ||
          persistedManaged?.requestedModel?.providerID !== input.model.providerID ||
          persistedManaged?.requestedModel?.modelID !== input.model.modelID ||
          persistedManaged?.requestedModel?.variant !== input.model.variant
        )) ||
        (!input.model && persistedManaged?.requestedModel !== undefined)
      ) {
        throw new Error("OpenCode did not persist the managed child configuration exactly");
      }
      child = toSummary(persisted, false);
      try {
        await withSessionPromptLock(directory, child.id, () => submitPromptAsync(config, directory, child!.id, {
          text: input.text,
          mode: input.agent === "plan" ? "plan" : "build",
          agent: input.agent,
          model: input.model,
          workflow: input.workflow,
        }));
      } catch (submitError) {
        recordInstruction({
          source: "managed-child-launch",
          directory,
          targetSessionID: child.id,
          parentSessionID: input.parentID,
          targetAgent: input.agent,
          text: input.text,
          delivery: "rejected",
          reason: submitError instanceof Error ? submitError.message : String(submitError),
        });
        throw submitError;
      }
      recordInstruction({
        source: "managed-child-launch",
        directory,
        targetSessionID: child.id,
        parentSessionID: input.parentID,
        targetAgent: input.agent,
        text: input.text,
        delivery: "acknowledged",
      });
      return child;
    } catch (error) {
      if (child?.id) {
        try {
          await deleteSession(config, directory, child.id);
        } catch (cleanupError) {
          throw new ManagedChildCleanupError(child.id, error, cleanupError);
        }
      }
      throw error;
    }
  })();

  const entry: ManagedLaunchEntry = { fingerprint, promise: launch, settled: false };
  managedLaunches.set(key, entry);
  void launch.then(
    () => { entry.settled = true; },
    () => { if (managedLaunches.get(key) === entry) managedLaunches.delete(key); },
  );
  return launch;
}

export async function promptManagedChild(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  input: PromptInput,
): Promise<void> {
  await withSessionPromptLock(directory, sessionID, async () => {
    const session = await request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}`, { directory });
    const managed = managedChildMetadata(session.metadata, session.permission);
    const audit = {
      source: "managed-child-prompt" as const,
      directory,
      targetSessionID: sessionID,
      ...(typeof session.parentID === "string" && session.parentID ? { parentSessionID: session.parentID } : {}),
      ...(managed?.requestedAgent ? { targetAgent: managed.requestedAgent } : {}),
      text: input.text,
    };
    if (
      session.id !== sessionID ||
      session.directory !== directory ||
      session.agent !== managed?.requestedAgent ||
      managed?.effectivePolicyObserved !== true
    ) {
      recordInstruction({
        ...audit,
        delivery: "rejected",
        reason: "Managed Child configuration could not be verified; prompt was not sent",
      });
      throw new ManagedChildConfigurationError();
    }
    try {
      await submitPromptAsync(config, directory, sessionID, {
        ...input,
        agent: managed.requestedAgent,
      });
    } catch (submitError) {
      recordInstruction({
        ...audit,
        delivery: "rejected",
        reason: submitError instanceof Error ? submitError.message : String(submitError),
      });
      throw submitError;
    }
    recordInstruction({ ...audit, delivery: "acknowledged" });
  });
}

export async function abortSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<void> {
  await request<unknown>(config, `/session/${encodeURIComponent(sessionID)}/abort`, {
    method: "POST",
    directory,
  });
}

export async function deleteSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<void> {
  await request<unknown>(config, `/session/${encodeURIComponent(sessionID)}`, {
    method: "DELETE",
    directory,
  });
}

export async function shareSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<SessionSummary> {
  const raw = await request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}/share`, {
    method: "POST",
    directory,
  });
  return toSummary(raw ?? {}, false);
}

export async function unshareSession(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<SessionSummary> {
  const raw = await request<RawSession>(config, `/session/${encodeURIComponent(sessionID)}/share`, {
    method: "DELETE",
    directory,
  });
  return toSummary(raw ?? {}, false);
}

export interface MessagePage {
  messages: unknown[];
  nextCursor: string | null;
}

export function messagePageCursor(headers: Headers): string | null {
  const direct = headers.get("x-next-cursor")?.trim();
  if (direct) return direct;

  const link = headers.get("link");
  if (!link) return null;
  for (const entry of link.split(/,(?=\s*<)/u)) {
    const match = entry.match(/^\s*<([^>]+)>(.*)$/u);
    if (!match || !/;\s*rel\s*=\s*"?next"?(?:\s*;|\s*$)/iu.test(match[2])) continue;
    try {
      const cursor = new URL(match[1], "http://opencode.invalid").searchParams.get("before")?.trim();
      if (cursor) return cursor;
    } catch {
      // Ignore a malformed Link entry and fall back to end-of-history.
    }
  }
  return null;
}

/** Raw `{ info, parts }` messages — the client-side adapter shapes them. */
export async function listMessages(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  options: { limit?: number; before?: string } = {},
): Promise<MessagePage> {
  const response = await requestWithResponse<unknown[]>(
    config,
    `/session/${encodeURIComponent(sessionID)}/message`,
    {
      directory,
      query: {
        limit: options.limit ?? 100,
        before: options.before,
      },
    },
  );
  return {
    messages: response.data ?? [],
    nextCursor: messagePageCursor(response.headers),
  };
}

/**
 * Cap on the agent-output excerpt stored on a notification record.
 *
 * Model-authored text on a durable record, so it is bounded before it is
 * persisted — the same rule as SESSION_TITLE_LIMIT. Longer than a title
 * because this line exists to tell two notifications from the same session
 * apart, and the first few words of an agent's answer are often boilerplate.
 */
export const SESSION_EXCERPT_LIMIT = 240;

/**
 * Below this length, a first sentence reads as a boilerplate opener ("Done."
 * / "Sure,") rather than something that tells two different turns from the
 * same session apart, so it is combined with the second sentence instead.
 */
const SHORT_SENTENCE_THRESHOLD = 40;

/** A sentence-ending punctuation mark followed by whitespace or the end of the string. */
const SENTENCE_END = /[.!?](?:\s|$)/gu;

/**
 * Picks a bounded, literal excerpt of agent output for notification copy.
 *
 * Prefers the first non-empty line — so a bulleted list's first item, not an
 * arbitrary character cutoff spanning several unrelated lines, becomes the
 * excerpt — and, within that line, the first sentence. That sentence is
 * extended to include the second one when the first is short enough to be a
 * boilerplate opener that would otherwise make two different turns from the
 * same session look identical. Every boundary here is optional: whatever is
 * found is still clamped to `limit`, and when no sentence-ending punctuation
 * exists at all, the whole line (or text) is returned bounded exactly as it
 * always was. Nothing is ever reordered or invented — only literal
 * substrings of the input, in their original order, are returned.
 */
export function firstMeaningfulExcerpt(rawText: string, limit: number): string {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const source = lines[0] ?? rawText;
  const flat = source.replace(/\s+/gu, " ").trim();
  if (!flat) return "";

  const matches = [...flat.matchAll(SENTENCE_END)];
  if (matches.length > 0) {
    let end = matches[0].index! + 1;
    if (end < SHORT_SENTENCE_THRESHOLD && matches.length > 1) {
      end = matches[1].index! + 1;
    }
    const sentence = flat.slice(0, end).trim();
    if (sentence.length <= limit) return sentence;
  }

  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}

/**
 * Last thing the agent actually said in a session, for notification copy.
 *
 * Reads only the newest page and scans backwards for the newest assistant
 * turn, joining its text parts. Tool calls, reasoning and user messages are
 * skipped: the excerpt should read like the answer the user is coming back to.
 *
 * Returns undefined rather than a placeholder whenever the transcript does not
 * clearly supply one — a notification that invents a summary is worse than one
 * that stays generic.
 */
export async function latestAssistantExcerpt(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await requestWithResponse<unknown[]>(
    config,
    `/session/${encodeURIComponent(sessionID)}/message`,
    { directory, query: { limit: 1 }, ...(signal ? { signal } : {}) },
  );
  const messages = response.data ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!entry || typeof entry !== "object") continue;
    const { info, parts } = entry as { info?: { role?: unknown }; parts?: unknown };
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") continue;
    const text = (Array.isArray(parts) ? parts : [])
      .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join(" ");
    const excerpt = firstMeaningfulExcerpt(text, SESSION_EXCERPT_LIMIT);
    if (!excerpt) continue;
    return excerpt;
  }
  return undefined;
}

export interface Todo {
  content: string;
  status: string;
  priority: string;
}

/** NB: Todo has no `id` in 1.18.21 — the UI keys on index/content. */
export async function listTodos(
  config: OpencodeConfig,
  directory: string,
  sessionID: string,
): Promise<Todo[]> {
  const data = await request<Todo[]>(
    config,
    `/session/${encodeURIComponent(sessionID)}/todo`,
    { directory },
  );
  return data ?? [];
}
