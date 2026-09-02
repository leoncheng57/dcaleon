import type {
  AppSettings,
  ClaudeConfigResponse,
  ClaudeSessionSummary,
  DshConfigResponse,
  DshSessionSummary,
  DshTrajectoryEvent,
  DshTrajectoryPage,
  NotificationPreferences,
  NotificationRecord,
  PlanningItem,
  SessionSummary,
} from "../lib/api.js";
import type { RawMessage } from "../lib/events.js";
import type { TranscriptEvent } from "../lib/transcript.js";

export const SIMULATOR_DIRECTORY = "/tmp/mock-project";
const SECOND_DIRECTORY = "/tmp/mock-second-project";

const modelCatalogue = {
  defaultModel: { providerID: "anthropic", modelID: "claude-opus-5" },
  models: [
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-opus-5", name: "Claude Opus 5", status: "active", limits: { context: 200_000, output: 32_000 }, capabilities: { image: true, reasoning: true }, variants: ["high"] },
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-text", name: "Claude Text", status: "active", limits: { context: 100_000, output: 16_000 }, capabilities: { image: false, reasoning: true }, variants: [] },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-5.6-sol", name: "GPT-5.6 Sol", status: "active", limits: { context: 200_000, output: 32_000 }, capabilities: { image: true, reasoning: true }, variants: [] },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-5", name: "GPT-5", status: "active", limits: { context: 128_000, output: 16_000 }, capabilities: { image: true, reasoning: true }, variants: [] },
  ],
};

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "title">): SessionSummary {
  return {
    directory: SIMULATOR_DIRECTORY,
    childCount: 0,
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    cost: 0.0431,
    tokens: { input: 110, output: 940, reasoning: 250, cacheRead: 10_400, cacheWrite: 800 },
    createdAt: "2026-08-24T15:00:00.000Z",
    updatedAt: "2026-08-25T18:30:00.000Z",
    archived: false,
    running: false,
    ...overrides,
  };
}

const baseMessages: RawMessage[] = [
  {
    info: { id: "msg_preview_user", role: "user", agent: "build", time: { created: 1_787_000_000_000 }, model: { providerID: "anthropic", modelID: "claude-opus-5" } },
    parts: [{ id: "prt_preview_user", messageID: "msg_preview_user", type: "text", text: "Add a health endpoint and verify the deployment pipeline." }],
  },
  {
    info: { id: "msg_preview_agent", role: "assistant", agent: "build", mode: "build", parentID: "msg_preview_user", time: { created: 1_787_000_001_000, completed: 1_787_000_009_000 }, providerID: "anthropic", modelID: "claude-opus-5" },
    parts: [
      { id: "prt_preview_reason", messageID: "msg_preview_agent", type: "reasoning", text: "The server needs a bounded liveness route and a focused regression test.", time: { start: 1_787_000_001_500, end: 1_787_000_003_500 } },
      { id: "prt_preview_read", messageID: "msg_preview_agent", type: "tool", tool: "read", callID: "call_preview_read", state: { status: "completed", input: { filePath: "server/index.ts" }, output: "export const app = express();", title: "server/index.ts", time: { start: 1_787_000_004_000, end: 1_787_000_004_250 } } },
      { id: "prt_preview_text", messageID: "msg_preview_agent", type: "text", text: "Implemented the route and tests. Review `server/index.ts:98` and the [example pull request](https://github.com/acme/demo/pull/7)." },
      { id: "prt_preview_patch", messageID: "msg_preview_agent", type: "patch", hash: "def456", files: ["server/index.ts", "tests/health.test.ts"] },
      { id: "prt_preview_finish", messageID: "msg_preview_agent", type: "step-finish", reason: "stop", cost: 0.0421, tokens: { input: 100, output: 900, reasoning: 250, cache: { read: 10_000, write: 750 } } },
    ],
  },
  {
    info: { id: "msg_preview_verify", role: "assistant", agent: "build", mode: "build", time: { created: 1_787_000_010_000, completed: 1_787_000_012_000 } },
    parts: [
      { id: "prt_preview_bash", messageID: "msg_preview_verify", type: "tool", tool: "bash", callID: "call_preview_bash", state: { status: "completed", input: { command: "npm test" }, output: "Tests: 428 passed", title: "npm test", time: { start: 1_787_000_010_500, end: 1_787_000_011_500 } } },
      { id: "prt_preview_done", messageID: "msg_preview_verify", type: "text", text: "All verification passed. The public PR simulator uses fixture data and never receives repository secrets." },
    ],
  },
];

const planningItems: PlanningItem[] = [
  { id: "112", number: 112, type: "issue", title: "CICD. add a preview deployed pr step", state: "open", merged: false, labels: ["priority:medium", "deployment"], author: "leoncheng57", url: "https://github.com/leoncheng57/custom-dca-opencode/issues/112", createdAt: "2026-08-23T10:00:00Z", updatedAt: "2026-08-25T18:00:00Z", commentCount: 1, childCount: 0, completedChildCount: 0, parentNumber: 153 },
  { id: "153", number: 153, type: "issue", title: "Use GitHub's deployment infra to build a public simulator", state: "open", merged: false, labels: ["priority:high", "deployment"], author: "leoncheng57", url: "https://github.com/leoncheng57/custom-dca-opencode/issues/153", createdAt: "2026-08-24T09:00:00Z", updatedAt: "2026-08-25T19:00:00Z", commentCount: 2, childCount: 2, completedChildCount: 1, parentNumber: null },
  { id: "178", number: 178, type: "pull_request", title: "Show native task child model provenance", state: "open", merged: false, labels: ["priority:medium", "frontend"], author: "contributor", url: "https://github.com/leoncheng57/custom-dca-opencode/pull/178", createdAt: "2026-08-25T13:00:00Z", updatedAt: "2026-08-25T20:00:00Z", commentCount: 3, childCount: 0, completedChildCount: 0, parentNumber: null },
  { id: "109", number: 109, type: "issue", title: "Publish the migrated agent-skills catalog", state: "closed", merged: false, labels: ["priority:low", "documentation"], author: "leoncheng57", url: "https://github.com/leoncheng57/custom-dca-opencode/issues/109", createdAt: "2026-08-20T09:00:00Z", updatedAt: "2026-08-23T19:00:00Z", commentCount: 4, childCount: 0, completedChildCount: 0, parentNumber: 153 },
];

const defaultPreferences: NotificationPreferences = {
  version: 1,
  ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", events: { idle: true, error: true, abort: true, permission: true, question: true, parked: true } },
  webPush: { enabled: false, events: { idle: true, error: true, abort: true, permission: true, question: true, parked: true } },
  browser: { desktop: true, sound: false, volume: 0.6, events: { idle: true, error: true, abort: true, permission: true, question: true, parked: true } },
  parkedPermissionSeconds: 120,
};

const notificationRecords: NotificationRecord[] = [
  { id: "note-preview-permission", kind: "permission", at: 1_787_000_020_000, directory: SIMULATOR_DIRECTORY, sessionID: "ses_preview_done", sessionTitle: "Build the PR preview pipeline", requestID: "perm_preview", title: "Permission requested", body: "Open the IDE to review the session.", displayBody: "Run npm test", detail: "Ready to run the preview build once you approve the command.", delivery: { ntfy: "off", desktop: "allowed", webPush: "off" } },
  { id: "note-preview-idle", kind: "idle", at: 1_787_000_010_000, directory: SIMULATOR_DIRECTORY, sessionID: "ses_preview_done", sessionTitle: "Build the PR preview pipeline", title: "Session finished", body: "Open the IDE to review the session.", detail: "Published the preview bundle to gh-pages and updated the sticky PR comment.", resolvedAt: 1_787_000_015_000, resolvedBy: "checked", delivery: { ntfy: "off", desktop: "allowed", webPush: "off" } },
];

// ---------------------------------------------------------------------------
// DSH V1 fixture data — tab-local, reset on reload.
// ---------------------------------------------------------------------------

const DSH_PRESET_ID = "dsh-preview-preset";
const DSH_WORKSPACE_ID = "dsh-preview-workspace";

const dshConfig: DshConfigResponse = {
  enabled: true,
  configured: true,
  protocol: 1,
  sdkVersion: "0.1.1rc2",
  sandbox: "seatbelt",
  trajectory: { sensitiveDetailEnabled: false, fullExportEnabled: false },
  presets: [{ id: DSH_PRESET_ID, label: "Preview preset", provider: "simulator", model: "sim-preview-v1", fingerprint: "0".repeat(64), mode: "read-only" }],
  workspaces: [{ id: DSH_WORKSPACE_ID, label: "Preview workspace" }],
};

const CLAUDE_PRESET_ID = "claude-preview-preset";
const CLAUDE_WORKSPACE_ID = "claude-preview-workspace";

const claudeConfig: ClaudeConfigResponse = {
  enabled: true,
  configured: true,
  cliVersion: "2.1.257",
  sandbox: "seatbelt",
  presets: [{ id: CLAUDE_PRESET_ID, label: "Preview preset", model: "sim-preview-v1", effort: "high", permissionMode: "default", mode: "read-only" }],
  workspaces: [{ id: CLAUDE_WORKSPACE_ID, label: "Preview workspace" }],
};

interface ClaudeFixtureSession extends ClaudeSessionSummary {
  events: TranscriptEvent[];
}

function claudeSummary(session: ClaudeFixtureSession): ClaudeSessionSummary {
  return { id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId, workspaceLabel: "Preview workspace", mode: session.mode, isolation: session.isolation, ...(session.branch ? { branch: session.branch } : {}), createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running };
}

interface DshFixtureSession extends DshSessionSummary {
  events: TranscriptEvent[];
}

function dshSummary(session: DshFixtureSession): DshSessionSummary {
  return { id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId, mode: session.mode, createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running };
}

function dshTrajectory(sessionId: string): DshTrajectoryPage {
  const time = "2026-08-25T18:00:00.000Z";
  const nativeSessionId = "id:simulatorroot";
  const at = (milliseconds: number) => new Date(Date.parse(time) + milliseconds).toISOString();
  const native = (nativeSeq: number, type: string, category: DshTrajectoryEvent["category"], title: string, metadata?: DshTrajectoryEvent["metadata"], extra: Partial<DshTrajectoryEvent> = {}): DshTrajectoryEvent => ({
    id: `${sessionId}:${nativeSeq}`,
    observationSeq: nativeSeq + 2,
    sessionId,
    observedAt: at(nativeSeq * 1_250),
    type,
    nativeSessionId,
    nativeSeq,
    nativeTime: at(nativeSeq * 1_250),
    category,
    title,
    source: "dsh-native-notification",
    hasDetail: false,
    sensitive: category === "request" || category === "message" || category === "tool" || category === "compaction",
    ...(metadata ? { metadata } : {}),
    ...extra,
  });
  const events: DshTrajectoryEvent[] = [
    { id: `${sessionId}-capture`, observationSeq: 1, sessionId, observedAt: time, type: "dca/session-created", category: "status", title: "DCA capture started", source: "dca-lifecycle", hasDetail: false, sensitive: false },
    native(0, "turn/start", "turn", "Turn 1 started", { turn: 1, phase: "start" }),
    native(1, "step/start", "turn", "Step 1 started", { turn: 1, step: 1, phase: "start" }),
    native(2, "request/header", "request", "Request header captured", { provider: "simulator", model: "sim-preview-v1" }),
    native(3, "tool/call", "tool", "Tool called", { turn: 1, step: 1, phase: "start", callId: "id:callpreview" }),
    native(4, "tool/result", "tool", "Tool result committed", { turn: 1, step: 1, phase: "end", callId: "id:callpreview", resultIsError: false }, { sourceEventSeqs: [3], surfaceOp: "append" }),
    native(5, "assistant/message", "message", "Assistant message committed", { turn: 1, step: 1, phase: "committed", usage: { inputTokens: 120, outputTokens: 24 } }, { sourceEventSeqs: [2], surfaceOp: "append" }),
    native(6, "step/end", "turn", "Step 1 ended", { turn: 1, step: 1, phase: "end" }),
    native(7, "turn/end", "turn", "Turn 1 completed", { turn: 1, phase: "end", reason: "completed" }),
    native(8, "compaction/start", "compaction", "Standalone compaction started", { phase: "start", compactionId: "id:compactpreview", standalone: true }),
    native(9, "compaction/summary", "compaction", "Compaction summary committed", { compactionId: "id:compactpreview", shadowedEventCount: 3, shadowedTokenCount: 90, usage: { inputTokens: 40, outputTokens: 8 } }),
    native(10, "user/message", "compaction", "Compaction surface replacement", { phase: "committed", compactionId: "id:compactpreview" }, { sourceEventSeqs: [8, 9, 3, 4, 5], surfaceOp: { op: "replace", start: 3, end: 5 } }),
    native(11, "compaction/end", "compaction", "Standalone compaction ended", { phase: "end", compactionId: "id:compactpreview", standalone: true }),
    { id: `${sessionId}-child-start`, observationSeq: 14, sessionId, observedAt: at(15_000), type: "subagent.started", category: "child", title: "Child agent started", metadata: { parentSessionId: nativeSessionId, childSessionId: "id:simulatorchild" }, source: "dsh-native-notification", hasDetail: false, sensitive: true },
    { id: `${sessionId}-child-finish`, observationSeq: 15, sessionId, observedAt: at(20_000), type: "subagent.finished", category: "child", title: "Child agent finished", metadata: { parentSessionId: nativeSessionId, childSessionId: "id:simulatorchild", reason: "completed" }, source: "dsh-native-notification", hasDetail: false, sensitive: true },
  ];
  return {
    events,
    nextBefore: null,
    capturePending: false,
    coverage: {
      source: "dca-captured-projection",
      complete: false,
      mayContainGaps: true,
      capturedFrom: time,
      capturedThrough: time,
      nativeStreams: [{ session: nativeSessionId, first: 0, last: 11, gaps: 0 }],
      note: "DCA-captured projection only. It is not canonical DSH persistence, starts when the bridge observes events, and may contain gaps.",
    },
  };
}

function makeDshSeedSession(): DshFixtureSession {
  const now = "2026-08-25T18:00:00.000Z";
  return {
    id: "dsh-preview-done",
    title: "DSH experiment conversation",
    presetId: DSH_PRESET_ID,
    workspaceId: DSH_WORKSPACE_ID,
    mode: "read-only",
    createdAt: now,
    updatedAt: now,
    running: false,
    events: [
      { id: "dsh-evt-1", messageId: "dsh-msg-1", timestamp: now, kind: "user", text: "Explain the seatbelt sandbox.", reminders: [], workflows: [], attachments: [] },
      { id: "dsh-evt-2", messageId: "dsh-msg-2", timestamp: now, kind: "agent", text: "The DSH preview is simulated. No DSH runtime, model provider, or filesystem was contacted." },
      { id: "dsh-evt-3", messageId: "dsh-msg-3", timestamp: now, kind: "status", label: "Run completed" },
    ],
  };
}

function response(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bodyOf(init?: RequestInit): Record<string, any> {
  if (typeof init?.body !== "string") return {};
  try { return JSON.parse(init.body) as Record<string, any>; } catch { return {}; }
}

function routeMatch(pathname: string, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(pathname);
}

export function createPublicSimulator(): typeof fetch {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  let sessions: SessionSummary[] = [
    summary({ id: "ses_preview_done", title: "Build the PR preview pipeline", childCount: 3 }),
    summary({ id: "ses_preview_running", title: "Review mobile navigation", running: true, cost: 0.12, updatedAt: "2026-08-25T19:15:00.000Z" }),
    summary({ id: "ses_preview_child", title: "Audit deployment safety", parentID: "ses_preview_done", cost: 0.006, updatedAt: "2026-08-25T18:15:00.000Z" }),
    summary({ id: "ses_preview_child_done", title: "Verify Pages routing", parentID: "ses_preview_done", cost: 0.004, updatedAt: "2026-08-25T18:10:00.000Z" }),
    // A human-authorized Managed Child (decision #19) beside the two native
    // task children, so a preview actually shows the managed/native
    // distinction rather than a wall of identical `sub` rows.
    summary({
      id: "ses_preview_managed",
      title: "Draft the release notes",
      parentID: "ses_preview_done",
      agent: "plan",
      cost: 0.002,
      updatedAt: "2026-08-25T18:05:00.000Z",
      managed: {
        origin: "managed-human",
        requestedAgent: "plan",
        requestedMode: "plan",
        requestedModel: { providerID: "anthropic", modelID: "claude-opus-5" },
        background: true,
        policySource: "creation-permission",
        effectivePolicyObserved: true,
        authorization: "read-only",
      },
    }),
    summary({ id: "ses_preview_second", title: "Document release operations", directory: SECOND_DIRECTORY, cost: 0.01, updatedAt: "2026-08-25T17:30:00.000Z" }),
  ];
  const messages = new Map<string, RawMessage[]>([
    ["ses_preview_done", structuredClone(baseMessages)],
    ["ses_preview_running", [{ info: { id: "msg_running", role: "assistant", agent: "build", time: { created: 1_787_000_020_000 } }, parts: [{ id: "prt_running", messageID: "msg_running", type: "text", text: "Checking the compact navigation at phone width." }] }]],
    ["ses_preview_child", [{ info: { id: "msg_child", role: "assistant", agent: "explore", mode: "build", time: { created: 1_787_000_015_000, completed: 1_787_000_016_000 } }, parts: [{ id: "prt_child", messageID: "msg_child", type: "text", text: "The publisher validates every file hash and writes only the PR-owned directory." }] }]],
    ["ses_preview_child_done", [{ info: { id: "msg_child_done", role: "assistant", agent: "explore", mode: "build", time: { created: 1_787_000_014_000, completed: 1_787_000_014_500 } }, parts: [{ id: "prt_child_done", messageID: "msg_child_done", type: "text", text: "Hash routing keeps every simulator page reload-safe on GitHub Pages." }] }]],
    ["ses_preview_managed", [{ info: { id: "msg_managed", role: "assistant", agent: "plan", mode: "plan", time: { created: 1_787_000_013_000, completed: 1_787_000_013_500 } }, parts: [{ id: "prt_managed", messageID: "msg_managed", type: "text", text: "Drafted the release notes without touching any file: this child was launched read-only." }] }]],
  ]);
  let settings: AppSettings = { model: "anthropic/claude-opus-5", subagent_depth: 3, compaction: { auto: true, prune: true, reserved: 8_192 } };
  let preferences = structuredClone(defaultPreferences);
  let modelPins = [{ providerID: "openai", modelID: "gpt-5.6-sol" }, { providerID: "anthropic", modelID: "claude-opus-5" }];
  let projectPins = [SIMULATOR_DIRECTORY];
  let autoPermissions = false;
  let mcpServers: Record<string, any> = { github: { status: "connected" }, docs: { status: "failed", error: "fixture connection refused" }, local: { status: "disabled" }, auth: { status: "needs_auth" } };
  let permissions = [{ id: "perm_preview", sessionID: "ses_preview_done", permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" }, always: ["npm *"] }];
  let questions = [{ id: "que_preview", sessionID: "ses_preview_done", questions: [{ header: "Deployment", question: "Which preview surface should be verified?", options: [{ label: "Desktop", description: "Review the wide layout" }, { label: "Mobile", description: "Review the phone layout" }], multiple: true, custom: true }] }];

  // DSH fixture state — mutable per tab, reset on page reload.
  const dshSessions: DshFixtureSession[] = [makeDshSeedSession()];
  let dshCounter = 0;
  const claudeSessions: ClaudeFixtureSession[] = [];
  let claudeCounter = 0;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "https://preview.invalid");
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = bodyOf(init);
    const path = url.pathname;

    if (path === "/api/health") return response({ healthy: true, upstream: { url: "simulator://opencode", reachable: true, version: "1.18.23+dca.2", expected: "1.18.23+dca.2", versionMatches: true }, events: { connected: true } });
    if (path === "/api/app-config") return response({ publicAppUrl: null, dshEnabled: true, claudeEnabled: true });
    if (path === "/api/projects") return response({ root: "/tmp", projects: [{ name: "mock-project", relativePath: "mock-project", directory: SIMULATOR_DIRECTORY, kind: "repository" }, { name: "mock-second-project", relativePath: "mock-second-project", directory: SECOND_DIRECTORY, kind: "repository" }] });
    if (path === "/api/project-pins") {
      if (method === "PATCH") projectPins = Array.isArray(body.directories) ? body.directories : projectPins;
      return response({ directories: projectPins });
    }
    if (path === "/api/model-pins") {
      if (method === "PATCH") modelPins = Array.isArray(body.models) ? body.models : modelPins;
      return response({ models: modelPins });
    }
    if (path === "/api/recent-sessions") {
      // Honours `session=` lookups the way the real route does. The
      // notification popover's running/idle join asks by id with `limit=0`
      // (client/lib/sessionRunState.ts), so a fixture that only ever returned
      // "the newest few" would answer `unknown` for every notification and the
      // preview would show a feature that looks broken rather than one that
      // works.
      const lookups = new Set(url.searchParams.getAll("session"));
      const rawLimit = Number(url.searchParams.get("limit") ?? 5);
      const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 5;
      const ordered = sessions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const selected = new Map(ordered.slice(0, limit).map((session) => [session.id, session]));
      for (const session of ordered) if (lookups.has(session.id)) selected.set(session.id, session);
      return response({ sessions: [...selected.values()], directories: [SIMULATOR_DIRECTORY, SECOND_DIRECTORY] });
    }
    if (path === "/api/session-agents") return response({ agents: [
      { id: "plan", description: "Plan work without changing files." },
      { id: "build", description: "Implement and verify changes." },
      { id: "explore", description: "Inspect the codebase and report findings." },
      { id: "general", description: "Handle multi-step delegated work." },
    ] });
    // The Managed Child launcher and the composer workflow both read this
    // catalogue to decide which agents exist and which of them can modify
    // files, so a preview without it would offer no agent at all.
    if (path === "/api/managed-child-agents") return response({ agents: [
      { id: "plan", description: "Plan work without changing files.", access: "read-only" },
      { id: "build", description: "Implement and verify changes.", access: "can-modify" },
      { id: "explore", description: "Inspect the codebase and report findings.", access: "read-only" },
      { id: "general", description: "Handle multi-step delegated work.", access: "can-modify" },
    ] });
    if (path === "/api/sessions" && method === "POST") {
      const id = `ses_preview_created_${sessions.length}`;
      const session = summary({ id, title: body.title || String(body.prompt || "New simulated task").slice(0, 64), directory: body.directory || SIMULATOR_DIRECTORY, model: body.model || modelCatalogue.defaultModel });
      sessions = [session, ...sessions];
      messages.set(id, body.prompt ? [{ info: { id: `${id}_user`, role: "user", agent: body.mode || "build", time: { created: Date.now() } }, parts: [{ id: `${id}_part`, messageID: `${id}_user`, type: "text", text: String(body.prompt) }] }] : []);
      return response({ session }, 201);
    }
    if (path === "/api/sessions") {
      const directory = url.searchParams.get("directory");
      return response({ sessions: sessions.filter((item) => item.directory === directory && !item.archived) });
    }
    if (path === "/api/models") return response(modelCatalogue);

    const sessionRoute = routeMatch(path, /^\/api\/sessions\/([^/]+)(.*)$/u);
    if (sessionRoute) {
      const id = decodeURIComponent(sessionRoute[1]);
      const rest = sessionRoute[2];
      const session = sessions.find((item) => item.id === id);
      if (!session) return response({ error: "Simulated session not found" }, 404);
      if (rest === "/messages") return response({ messages: messages.get(id) ?? [], running: session.running, nextCursor: null });
      if (rest === "/todos") return response({ todos: id === "ses_preview_done" ? [{ content: "Research existing preview workflows", status: "completed", priority: "high" }, { content: "Deploy the in-browser simulator", status: "completed", priority: "high" }, { content: "Review the PR deployment", status: "in_progress", priority: "medium" }] : [] });
      if (rest === "/model-limit") return response({ context: 200_000 });
      if (rest === "/diff") return response({ changes: [{ file: "server/index.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }] });
      if (rest === "/prompt" && method === "POST") {
        const now = Date.now();
        const current = messages.get(id) ?? [];
        current.push(
          { info: { id: `msg_sim_user_${now}`, role: "user", agent: body.mode || "build", time: { created: now }, ...(body.model ? { model: body.model } : {}) }, parts: [{ id: `prt_sim_user_${now}`, messageID: `msg_sim_user_${now}`, type: "text", text: String(body.text || "") }] },
          { info: { id: `msg_sim_agent_${now}`, role: "assistant", agent: body.mode || "build", mode: body.mode || "build", time: { created: now + 1, completed: now + 2 } }, parts: [{ id: `prt_sim_agent_${now}`, messageID: `msg_sim_agent_${now}`, type: "text", text: "Simulated response accepted. No model or external service was called." }] },
        );
        messages.set(id, current);
        return response({ accepted: true }, 202);
      }
      if (rest === "/abort" && method === "POST") { session.running = false; return response({ aborted: true }); }
      if (rest === "/share" && method === "POST") { session.shareUrl = "https://example.test/simulated-share"; return response({ session }); }
      if (rest === "/share" && method === "DELETE") { delete session.shareUrl; return response({ session }); }
      if (rest === "/subagents") return response({ parentID: id, capabilities: { backgroundSubagents: true, managedChildren: true }, truncated: false, tasks: id === "ses_preview_done" ? [{ sessionID: "ses_preview_child", parentID: id, title: "Audit deployment safety", agent: "explore", origin: "native-task", description: "Check artifact and publication boundaries", state: "completed", evidence: "child-transcript", background: true, present: true, createdAt: "2026-08-25T18:00:00Z", updatedAt: "2026-08-25T18:15:00Z", cost: 0.006 }, { sessionID: "ses_preview_child_done", parentID: id, title: "Verify Pages routing", agent: "explore", origin: "native-task", description: "Exercise nested simulator routes", state: "completed", evidence: "child-transcript", background: false, present: true, createdAt: "2026-08-25T18:00:00Z", updatedAt: "2026-08-25T18:10:00Z", cost: 0.004 }, { sessionID: "ses_preview_managed", parentID: id, title: "Draft the release notes", origin: "managed-human", requestedAgent: "plan", requestedMode: "plan", requestedModel: { providerID: "anthropic", modelID: "claude-opus-5" }, policySource: "creation-permission", effectivePolicyObserved: true, state: "completed", evidence: "child-transcript", background: true, present: true, createdAt: "2026-08-25T18:00:00Z", updatedAt: "2026-08-25T18:05:00Z", cost: 0.002 }] : [] });
      if (rest === "/managed-children" && method === "POST") {
        const requestedAgent = body.agent || "plan";
        const authorization = body.authorization === "modify" ? "modify" : "read-only";
        const child = summary({
          id: `ses_preview_managed_${sessions.length}`,
          title: "Managed simulated child",
          parentID: id,
          agent: requestedAgent,
          managed: {
            origin: "managed-human",
            requestedAgent,
            ...(requestedAgent === "plan" || requestedAgent === "build" ? { requestedMode: requestedAgent } : {}),
            requestedModel: body.model,
            background: true,
            policySource: "creation-permission",
            effectivePolicyObserved: true,
            authorization,
          },
        });
        sessions.push(child); messages.set(child.id, []); return response({ session: child }, 201);
      }
      if (rest.startsWith("/subagents/") && rest.endsWith("/abort")) return response({ aborted: true });
      if (rest === "/background") return response({ promoted: true });
      if (rest === "/questions") return response({ requests: questions.filter((item) => item.sessionID === id) });
      if (/^\/questions\/[^/]+\/(?:reply|reject)$/u.test(rest) && method === "POST") { questions = questions.filter((item) => !rest.includes(item.id)); return response(rest.endsWith("reply") ? { replied: true } : { rejected: true }); }
      if (!rest && method === "DELETE") { sessions = sessions.filter((item) => item.id !== id); return response(undefined, 204); }
      if (!rest) return response({ session });
    }

    if (path === "/api/settings") {
      if (method === "PATCH") settings = { ...settings, ...body, subagent_depth: settings.subagent_depth };
      return response({ settings });
    }
    if (path === "/api/mcp") return response({ servers: mcpServers });
    const mcpRoute = routeMatch(path, /^\/api\/mcp\/([^/]+)\/(connect|disconnect)$/u);
    if (mcpRoute) { mcpServers = { ...mcpServers, [decodeURIComponent(mcpRoute[1])]: { status: mcpRoute[2] === "connect" ? "connected" : "disabled" } }; return response({ servers: mcpServers }); }
    if (path === "/api/catalog") return response({ servers: mcpServers, skills: [{ name: "browser-check", description: "Check a page in the browser.", location: "browser-check/SKILL.md" }], commands: [{ name: "verify", description: "Run project verification.", source: "command", agent: "build", model: "mock/model", subtask: false }], refreshedAt: new Date().toISOString() });
    if (path === "/api/permissions") return response({ permissions: { "*": "ask", read: "allow", edit: { "*": "allow", "**/.env": "deny" }, bash: { "git *": "allow", "rm -rf *": "deny" } } });
    if (path === "/api/lsp") return response({ servers: { typescript: { status: "connected", root: SIMULATOR_DIRECTORY }, eslint: { status: "disabled" } } });
    if (path === "/api/notifications/history") return response({ records: notificationRecords, activeCount: notificationRecords.filter((item) => !item.resolvedAt).length, appBadgeCount: 1, appBadgeRevision: 1, suppressedActive: { "auto-permissions": 0, subagent: 0, "preference-off": 0 } });
    if (path === "/api/notifications/resolve" && method === "POST") {
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const records = notificationRecords.filter((item) => ids.has(item.id) && !item.resolvedAt);
      for (const record of records) { record.resolvedAt = Date.now(); record.resolvedBy = "checked"; }
      return response({ records, activeCount: notificationRecords.filter((item) => !item.resolvedAt).length, appBadgeCount: 0, appBadgeRevision: 2 });
    }
    const notificationRoute = routeMatch(path, /^\/api\/notifications\/([^/]+)$/u);
    if (notificationRoute && method === "PATCH") {
      const record = notificationRecords.find((item) => item.id === decodeURIComponent(notificationRoute[1]));
      if (!record) return response({ error: "Notification not found" }, 404);
      if (body.resolved) { record.resolvedAt = Date.now(); record.resolvedBy = "checked"; } else { delete record.resolvedAt; delete record.resolvedBy; }
      return response({ record, activeCount: notificationRecords.filter((item) => !item.resolvedAt).length, appBadgeCount: 0, appBadgeRevision: 2 });
    }
    if (path === "/api/notifications") {
      if (method === "PATCH") preferences = body as NotificationPreferences;
      return response({ preferences, tokenConfigured: false, webPush: { configured: false, publicKey: null } });
    }
    if (path.startsWith("/api/notifications/test")) return response({ sent: true, failed: 0 });
    if (path === "/api/auto-approve") { if (method === "PATCH") autoPermissions = Boolean(body.enabled); return response({ enabled: autoPermissions, error: null }); }

    if (path === "/api/workspace/tree") {
      const nested = url.searchParams.get("path") === "src";
      return response(nested ? { path: "src", dirs: [], files: [{ name: "index.ts", path: "src/index.ts", type: "file", ignored: false }] } : { path: "", dirs: [{ name: "src", path: "src", type: "directory", ignored: false }, { name: "tests", path: "tests", type: "directory", ignored: false }], files: [{ name: "README.md", path: "README.md", type: "file", ignored: false }, { name: "package.json", path: "package.json", type: "file", ignored: false }] });
    }
    if (path === "/api/workspace/file") {
      const file = url.searchParams.get("path") || "README.md";
      const content = file === "src/index.ts" ? "import express from \"express\";\n\nexport const app = express();\n\napp.get(\"/health\", (_req, res) => res.json({ healthy: true }));\n" : "# Mock project\n\nA deterministic workspace for public PR previews.\n";
      return response({ path: file, type: "text", content });
    }
    if (path === "/api/workspace/references" && method === "POST") return response({ references: (body.paths || []).map((candidate: string) => ({ path: candidate, status: candidate.startsWith("server/") || candidate.startsWith("src/") ? "file" : "missing", ...(candidate.startsWith("server/") || candidate.startsWith("src/") ? { resolvedPath: candidate.replace(/^server\//u, "src/") } : {}) })) });
    if (path === "/api/workspace/changes") return response({ changes: [{ file: "server/index.ts", patch: "@@ -12,0 +13,4 @@\n+app.get('/health', handler);", additions: 4, deletions: 0, status: "modified" }, { file: ".github/workflows/pr-preview.yml", patch: "@@ -0,0 +1,42 @@\n+name: PR preview", additions: 42, deletions: 0, status: "added" }] });
    if (path === "/api/workspace/commits") return response({ commits: [{ sha: "abc123456789", shortSha: "abc1234", subject: "Add PR preview deployment", author: "Preview Contributor", authoredAt: "2026-08-25T18:30:00Z" }, { sha: "def456789012", shortSha: "def4567", subject: "Add deterministic simulator fixtures", author: "Preview Contributor", authoredAt: "2026-08-25T18:00:00Z" }] });
    if (path === "/api/worktrees") return response({ worktrees: [{ name: "preview-pipeline", branch: "feat/pr-preview-pipeline", directory: `${SIMULATOR_DIRECTORY}.worktrees/preview-pipeline` }] });

    if (path === "/api/planning/items") return response({ repository: { owner: "leoncheng57", repo: "custom-dca-opencode", url: "https://github.com/leoncheng57/custom-dca-opencode" }, items: planningItems, truncated: false, epicsTruncated: false, fetchedAt: new Date().toISOString() });
    if (path.startsWith("/api/observability/logs")) {
      const source = new URLSearchParams(path.split("?")[1] ?? "").get("source") ?? "audit";
      const now = new Date();
      const at = (offset: number) => new Date(now.getTime() - offset).toISOString();
      const audit = [
        { kind: "audit", id: "audit-0", ts: at(90_000), event: "auto_approval_restore_completed", fields: [{ key: "restoredCount", value: "12" }, { key: "outcome", value: "success" }] },
        { kind: "audit", id: "audit-1", ts: at(60_000), event: "permission_asked_observed", fields: [{ key: "directoryCorrelation", value: "dcd9225d2c65dad8" }, { key: "autoApprovalEnabled", value: "true" }] },
        { kind: "audit", id: "audit-2", ts: at(30_000), event: "notification_decided", fields: [{ key: "kind", value: "permission" }, { key: "outcome", value: "suppressed" }, { key: "suppressionReason", value: "auto-permissions" }] },
        { kind: "audit", id: "audit-3", ts: at(5_000), event: "webpush_delivery_finished", fields: [{ key: "sent", value: "4" }, { key: "failed", value: "0" }, { key: "expired", value: "0" }] },
      ];
      const stdout = [
        { kind: "text", id: "stdout-0", prefix: "bff", text: "listening on :3210 -> opencode http://127.0.0.1:4097", severity: "info" },
      ];
      const stderr = [
        { kind: "text", id: "stderr-0", prefix: "bus", text: "fetch failed", severity: "warn" },
        { kind: "text", id: "stderr-1", text: "BadRequestError: request aborted", severity: "error", frames: ["at IncomingMessage.onAborted (raw-body/index.js:245:10)", "at IncomingMessage.emit (node:events:509:20)"] },
      ];
      const entries = source === "stdout" ? stdout : source === "stderr" ? stderr : audit;
      return response({
        source,
        file: `/simulated/.state/logs/${source === "audit" ? "audit.jsonl" : `bff.launchd.${source === "stdout" ? "out" : "err"}.log`}`,
        exists: true,
        sizeBytes: source === "audit" ? 8762 : 158_000,
        modifiedAt: now.toISOString(),
        entries,
        truncated: source !== "audit",
        readAt: now.toISOString(),
      });
    }
    if (path.startsWith("/api/observability/deployment")) {
      return response({
        platform: "darwin",
        servicesAvailable: true,
        services: [
          { label: "ai.custom-dca-opencode.bff", role: "bff", loaded: true, pid: 47322, restartCost: "safe", restartNote: "Rebuilds before swapping; browsers reconnect briefly. Active agent turns are unaffected." },
          { label: "ai.opencode.serve", role: "opencode", loaded: true, pid: 83146, restartCost: "destructive", restartNote: "Interrupts the running turn. Session history survives but nothing resumes automatically." },
        ],
        assets: [
          { path: "/sw.js", ok: true, status: 200, contentType: "text/javascript; charset=utf-8", bytes: 11944 },
          { path: "/manifest.webmanifest", ok: true, status: 200, contentType: "application/manifest+json; charset=utf-8", bytes: 378 },
        ],
        assetsVerdict: "ok",
        assetsNote: "Service worker and manifest are being served with the correct content types.",
        bundle: { indexHtmlSha1: "ed4f47c26eacfdc55d5cf062f154cf72e222a376", hasServiceWorker: true, hasManifest: true, directory: "/simulated/dist/client" },
        busySessions: { count: 1, directoriesChecked: 2, note: "Across 2 pinned projects. Session status is process-local, so zero is not proof of idle." },
        readAt: new Date().toISOString(),
      });
    }
    if (path === "/api/planning/labels") return response({ labels: ["deployment", "documentation", "frontend", "priority:high", "priority:medium", "priority:low"].map((name) => ({ name, description: `${name} work` })), truncated: false });
    if (path === "/api/planning/issues" && method === "POST") {
      const issue: PlanningItem = { id: `sim-${planningItems.length}`, number: 900 + planningItems.length, type: "issue", title: String(body.title), state: "open", merged: false, labels: body.labels || [], author: "preview-user", url: "https://github.com/leoncheng57/custom-dca-opencode/issues", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), commentCount: 0, childCount: 0, completedChildCount: 0, parentNumber: null };
      planningItems.push(issue); return response({ issue }, 201);
    }
    const planningRoute = routeMatch(path, /^\/api\/planning\/items\/(\d+)(\/labels)?$/u);
    if (planningRoute) {
      const item = planningItems.find((candidate) => candidate.number === Number(planningRoute[1]));
      if (!item) return response({ error: "Planning item not found" }, 404);
      if (planningRoute[2] && method === "PATCH") { item.labels = body.labels || item.labels; return response({ item }); }
      return response({ details: { item, itemLabelsTruncated: false, body: "## Preview context\n\nThis content is served from deterministic fixture data.", bodyTruncated: false, comments: [{ id: "comment-1", author: "reviewer", body: "The deployment should refresh on every commit.", createdAt: "2026-08-25T18:00:00Z", bodyTruncated: false }], commentsTruncated: false, commentsError: null } });
    }

    if (path === "/api/forge/review") return response({ review: { url: url.searchParams.get("url"), forge: "github", title: "Mock pull request", state: "open", author: "octocat", pipeline: "success", mergeable: true, headSha: "abc123", number: 7, project: "acme/demo" } });
    if (path === "/api/forge/review/details") return response({ details: { comments: { value: [{ id: "1", author: "reviewer", body: "Looks good.", createdAt: "2026-08-25T18:00:00Z", resolved: null, discussionId: null, bodyTruncated: false }], error: null, truncated: false }, reviews: { value: [{ id: "2", author: "maintainer", state: "APPROVED", body: "Approved.", submittedAt: "2026-08-25T18:05:00Z", bodyTruncated: false }], error: null, truncated: false }, pipelines: { value: [], error: null, truncated: false }, checks: { value: [{ id: "3", name: "test", stage: "checks", status: "success", webUrl: "https://github.com/acme/demo/actions", startedAt: "2026-08-25T18:00:00Z", completedAt: "2026-08-25T18:02:00Z", duration: 120, source: "check" }], error: null, truncated: false }, commits: { value: [{ sha: "abc1230000000000000000000000000000000000", shortSha: "abc1230", subject: "Add the preview route", author: "octocat", authoredAt: "2026-08-25T17:50:00Z", webUrl: "https://github.com/acme/demo/commit/abc1230000000000000000000000000000000000", subjectTruncated: false }, { sha: "def4560000000000000000000000000000000000", shortSha: "def4560", subject: "Cover the route with a test", author: "octocat", authoredAt: "2026-08-25T17:58:00Z", webUrl: "https://github.com/acme/demo/commit/def4560000000000000000000000000000000000", subjectTruncated: false }], error: null, truncated: false }, partial: false, auth: "available" } });
    if (path === "/api/forge/review/merge") return response({ merged: true });
    if (path === "/api/permission-requests") return response({ requests: permissions });
    const permissionRoute = routeMatch(path, /^\/api\/permission-requests\/([^/]+)\/reply$/u);
    if (permissionRoute && method === "POST") { permissions = permissions.filter((item) => item.id !== decodeURIComponent(permissionRoute[1])); return response({ replied: true }); }
    if (path === "/api/workflows") return response({ workflows: [
      { id: "playwright-ui-review", title: "Review a UI change with Playwright", description: "Drive a focused Playwright pass over one route or component and bring back targeted evidence, without a full deployment or a complete screenshot regeneration.", injector: "Drive the named route with Playwright and exercise exactly the requested state or interaction. Report what was verified, what failed, and where any evidence was written." },
      { id: "pr-snippet-review", title: "Post a snippet-by-snippet PR review", description: "Walk one pull request as an ordered sequence of explained snippets and post it as a single GitHub comment. Takes only the pull request number; the repository comes from this project directory.", injector: "Produce one ordered snippet-by-snippet GitHub review comment. Resolve the repository from this session's project directory and pin every link to the pull request head SHA." },
      { id: "goal", title: "Complete an objective autonomously", description: "Work an objective through research, implementation, fixes, and final verification as one sustained run with durable checkpoints.", injector: "Work the objective through to completion as one sustained run, with a durable checkpoint updated at every boundary.", argument: { label: "Objective", placeholder: "make the notification badge match the server's global unresolved count", hint: "The run continues without asking whether to proceed, so state the acceptance criteria you actually want.", required: true, maxLength: 100_000 } },
      { id: "dca", title: "Operate DCA sessions over the BFF API", description: "Create, prompt, and observe DCA sessions through the agent-facing BFF HTTP API, distinct from the human-only composer workflows.", injector: "Use the BFF HTTP API to create, prompt, and observe sessions. Accepted is not completed; poll for the finished turn.", argument: { label: "Session work", placeholder: "launch a read-only child that audits export error handling and report its findings", hint: "Describe the session lifecycle work. The procedure below calls already-authorized BFF endpoints directly.", required: true, maxLength: 20_000 } },
      { id: "leaving-now-wrap-up", title: "Wrap up and leave an accurate status", description: "Stop this run safely, push authorized progress, refresh every status artifact, and end with one accurate merge verdict.", injector: "Stop this run's work, preserve authorized progress, refresh every status artifact, and end with one accurate merge verdict.", argument: { label: "Wrap-up note", placeholder: "branch feat/planning-epic-hierarchy, PR #312 — post the update there", hint: "May name the branch, pull request, issue, or human update destination. No destination is invented for you.", required: true, maxLength: 4_000 } },
      { id: "managed-child", title: "Launch a Managed Child", description: "Start an independent child session with its own transcript and a Plan or Build policy fixed at creation time. No native task card is created and no automatic hand-back occurs.", injector: "Complete the objective in this independent managed-child transcript and report outcomes, risks, and next steps." },
      { id: "start-dca-session", title: "Start a DCA session", description: "Start an independent root session in this project or an isolated worktree, after reviewing its Plan/Build mode, model, assignment, and trusted instructions.", injector: "Work only on the assignment under the selected mode. This is an independent root session with no parent or automatic hand-back." },
      { id: "session-handoff", title: "Hand off to another session", description: "Carry the current task into one explicitly configured standalone OpenCode session, with a self-contained packet and explicit CLI flags.", injector: "Nothing is inherited automatically. Carry settings through explicit CLI flags and a self-contained handoff packet.", argument: { label: "Task to hand off", placeholder: "finish the epic hierarchy work on feat/planning-epic-hierarchy", hint: "Nothing is inherited automatically, so describe the task the way the receiving session will need to read it.", required: true, maxLength: 20_000 } },
      { id: "session-update", title: "Send an update to another session", description: "Deliver a hand-off message to another session in this project after an explicit preview of the target and the exact prompt.", injector: "Treat this as new input from the user's other workstream. Delivery is asynchronous: accepted does not mean completed." },
      { id: "standup", title: "Write today's standup", description: "Gather the last day's commits and pull requests, then turn them into a three-section standup update written to be read aloud.", injector: "Gather the commit and pull request data yourself, then write a three-section standup update from what the commands actually returned.", argument: { label: "Scope", placeholder: "everything, or just the notification work", hint: "Narrows the update to one project or topic. The commit and pull request data is gathered by the agent, not pre-fetched.", required: true, maxLength: 2_000 } },
      { id: "design-doc-prototype", title: "Capture a Durable Design Prototype", description: "Mock up an unbuilt UI change as fast static HTML, screenshot it, and publish it into a dated engineering-design document — no fields to fill in, just confirm and send.", injector: "Build a self-contained static HTML mockup, capture desktop and mobile screenshots, and publish the durable design writeup for review.", prompt: "Capture a durable design prototype for this proposal and publish it for review." },
      { id: "docs-preview", title: "Choose, render, and preview documentation", description: "Pick the documentation medium from where the reader opens it, render it with a real renderer, and preview the result before claiming completion.", injector: "Choose the medium from where the reader opens it, render it with a real renderer, and preview the result before claiming completion.", argument: { label: "What to document", placeholder: "the notification suppression pipeline, as a diagram for the README", hint: "Name the subject and, if you already know it, where the reader will open it.", required: true, maxLength: 20_000 } },
      { id: "mini-design-doc", title: "Write a mini design doc", description: "Produce a transcript-first technical design narrative that takes under five minutes to read and ends with one clear recommendation.", injector: "Write a transcript-first design narrative under five minutes long, ending with one clear recommendation.", argument: { label: "Subject", placeholder: "whether session status should be joined into the notification centre", hint: "One medium-sized decision. The result stays in this transcript and creates no files.", required: true, maxLength: 20_000 } },
      { id: "system-design-artifacts", title: "Build a system-design review package", description: "Assemble an evidence-led senior system-design review package, with every load-bearing claim tagged by its evidence class.", injector: "Audit evidence first, tag every load-bearing claim with an evidence class, and select artifacts that each answer a distinct review question.", argument: { label: "Subject", placeholder: "the notification delivery and suppression system, current-state", hint: "Name the system or proposal, and say current-state, target-state, or mixed if you already know which you want.", required: true, maxLength: 20_000 } },
    ] });

    // -----------------------------------------------------------------------
    // DSH V1 fixture routes
    // -----------------------------------------------------------------------

    if (path === "/api/dsh/config") return response(dshConfig);

    if (path === "/api/dsh/sessions" && method === "POST") {
      const selectedPreset = dshConfig.presets.find((item) => item.id === body.presetId);
      const selectedWorkspace = dshConfig.workspaces.find((item) => item.id === body.workspaceId);
      if (!selectedPreset || !selectedWorkspace) return response({ error: "presetId and workspaceId must be allowlisted" }, 400);
      const now = new Date().toISOString();
      const session: DshFixtureSession = {
        id: `dsh-sim-${++dshCounter}`,
        title: typeof body.title === "string" ? body.title.trim().slice(0, 120) || "New DSH conversation" : "New DSH conversation",
        presetId: selectedPreset.id,
        workspaceId: selectedWorkspace.id,
        mode: selectedPreset.mode,
        createdAt: now,
        updatedAt: now,
        running: false,
        events: [],
      };
      dshSessions.unshift(session);
      return response({ session: dshSummary(session) }, 201);
    }
    if (path === "/api/dsh/sessions") {
      return response({ sessions: dshSessions.map(dshSummary) });
    }

    const dshSessionRoute = routeMatch(path, /^\/api\/dsh\/sessions\/([^/]+)(.*)$/u);
    if (dshSessionRoute) {
      const dshId = decodeURIComponent(dshSessionRoute[1]);
      const dshRest = dshSessionRoute[2];
      const dshSession = dshSessions.find((item) => item.id === dshId);
      if (!dshSession) return response({ error: "DSH session not found" }, 404);

      if (dshRest === "/prompt" && method === "POST") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 40_000) return response({ error: "text must contain 1-40000 characters" }, 400);
        if (dshSession.running) return response({ error: "DSH session is already running" }, 409);
        const now = new Date().toISOString();
        const userMsgId = `dsh-user-${++dshCounter}`;
        const agentMsgId = `dsh-agent-${++dshCounter}`;
        dshSession.events.push(
          { id: `dsh-evt-u-${dshCounter}`, messageId: userMsgId, timestamp: now, kind: "user", text, reminders: [], workflows: [], attachments: [] },
          { id: `dsh-evt-a-${dshCounter}`, messageId: agentMsgId, timestamp: now, kind: "agent", text: "Simulated DSH fixture response. No DSH runtime or model provider was called." },
        );
        dshSession.updatedAt = now;
        return response({ accepted: true }, 202);
      }

      if (dshRest === "/cancel" && method === "POST") {
        const wasCancelled = dshSession.running;
        dshSession.running = false;
        if (wasCancelled) {
          const now = new Date().toISOString();
          dshSession.events.push({ id: `dsh-evt-cancel-${++dshCounter}`, messageId: `dsh-cancel-${dshCounter}`, timestamp: now, kind: "status", label: "Cancelled by user" });
          dshSession.updatedAt = now;
        }
        return response({ cancelled: wasCancelled });
      }

      if (dshRest === "/trajectory" && method === "GET") return response(dshTrajectory(dshId));
      if (dshRest === "/trajectory/export" && method === "GET") {
        const trajectory = dshTrajectory(dshId);
        return response({ version: 1, coverage: trajectory.coverage, events: trajectory.events });
      }
      if (dshRest.startsWith("/trajectory/") && dshRest.endsWith("/detail") && method === "POST") {
        return response({ error: "Sensitive trajectory detail is disabled" }, 403);
      }
      if (dshRest === "/trajectory/export-full" && method === "POST") {
        return response({ error: "Full trajectory export is disabled" }, 403);
      }

      // GET /api/dsh/sessions/:id — session + normalized events
      if (!dshRest) return response({ session: dshSummary(dshSession), events: dshSession.events });
    }

    if (path === "/api/claude/config") return response(claudeConfig);

    if (path === "/api/claude/sessions" && method === "POST") {
      const selectedPreset = claudeConfig.presets.find((item) => item.id === body.presetId);
      const selectedWorkspace = claudeConfig.workspaces.find((item) => item.id === body.workspaceId);
      if (!selectedPreset || !selectedWorkspace) return response({ error: "presetId and workspaceId must be allowlisted" }, 400);
      const now = new Date().toISOString();
      const isolation = body.isolation === "worktree" && selectedPreset.mode === "build" ? "worktree" : "direct";
      const session: ClaudeFixtureSession = {
        id: `claude-sim-${++claudeCounter}`,
        title: typeof body.title === "string" ? body.title.trim().slice(0, 120) || "New Claude conversation" : "New Claude conversation",
        presetId: selectedPreset.id,
        workspaceId: selectedWorkspace.id,
        mode: selectedPreset.mode,
        isolation,
        ...(isolation === "worktree" ? { branch: `claude/sim-${claudeCounter}` } : {}),
        createdAt: now,
        updatedAt: now,
        running: false,
        events: [],
      };
      claudeSessions.unshift(session);
      return response({ session: claudeSummary(session) }, 201);
    }
    if (path === "/api/claude/sessions") {
      return response({ sessions: claudeSessions.map(claudeSummary) });
    }

    const claudeSessionRoute = routeMatch(path, /^\/api\/claude\/sessions\/([^/]+)(.*)$/u);
    if (claudeSessionRoute) {
      const claudeId = decodeURIComponent(claudeSessionRoute[1]);
      const claudeRest = claudeSessionRoute[2];
      const claudeSession = claudeSessions.find((item) => item.id === claudeId);
      if (!claudeSession) return response({ error: "Claude session not found" }, 404);

      if (claudeRest === "/prompt" && method === "POST") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 40_000) return response({ error: "text must contain 1-40000 characters" }, 400);
        if (claudeSession.running) return response({ error: "Claude session is already running" }, 409);
        const now = new Date().toISOString();
        const userMsgId = `claude-user-${++claudeCounter}`;
        const agentMsgId = `claude-agent-${++claudeCounter}`;
        claudeSession.events.push(
          { id: `claude-evt-u-${claudeCounter}`, messageId: userMsgId, timestamp: now, kind: "user", text, reminders: [], workflows: [], attachments: [] },
          { id: `claude-evt-a-${claudeCounter}`, messageId: agentMsgId, timestamp: now, kind: "agent", text: "Simulated Claude fixture response. No claude binary or model provider was called." },
        );
        claudeSession.updatedAt = now;
        return response({ accepted: true }, 202);
      }

      if (claudeRest === "/cancel" && method === "POST") {
        const wasCancelled = claudeSession.running;
        claudeSession.running = false;
        if (wasCancelled) {
          const now = new Date().toISOString();
          claudeSession.events.push({ id: `claude-evt-cancel-${++claudeCounter}`, messageId: `claude-cancel-${claudeCounter}`, timestamp: now, kind: "status", label: "Cancelled by user" });
          claudeSession.updatedAt = now;
        }
        return response({ cancelled: wasCancelled });
      }

      if (claudeRest === "/changes" && method === "GET") {
        return response({ files: [{ path: "src/example.ts", status: "M" }], diff: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,2 @@\n line\n+// simulated change\n", truncated: false });
      }
      if (claudeRest === "/merge" && method === "POST") {
        if (claudeSession.isolation !== "worktree") return response({ error: "only worktree sessions can be merged" }, 400);
        const now = new Date().toISOString();
        claudeSession.events.push({ id: `claude-evt-merge-${++claudeCounter}`, messageId: `claude-merge-${claudeCounter}`, timestamp: now, kind: "status", label: "Merged into project", detail: `${claudeSession.branch} → 0000000` });
        claudeSession.updatedAt = now;
        return response({ merged: true, mergeCommit: "0000000000000000000000000000000000000000" });
      }
      if (claudeRest === "/discard" && method === "POST") {
        if (claudeSession.isolation !== "worktree") return response({ error: "only worktree sessions can be discarded" }, 400);
        const now = new Date().toISOString();
        claudeSession.events.push({ id: `claude-evt-discard-${++claudeCounter}`, messageId: `claude-discard-${claudeCounter}`, timestamp: now, kind: "status", label: "Worktree discarded", detail: claudeSession.branch });
        claudeSession.updatedAt = now;
        return response({ discarded: true });
      }

      if (!claudeRest) return response({ session: claudeSummary(claudeSession), events: claudeSession.events });
    }

    if (path === "/api/claude/events") return response({ error: "Claude events SSE is not available in the public simulator. Poll GET /api/claude/sessions/:id instead." }, 501);

    // /api/dsh/events is SSE (EventSource). The fixture adapter intercepts
    // fetch() but not new EventSource(). The client's `dshEventsUrl` helper
    // builds a URL and hands it to EventSource directly, so this route
    // cannot be served from a fetch shim. UI-side the EventSource would
    // need to be wrapped or the DSH page would need to skip SSE when
    // VITE_PUBLIC_SIMULATOR is true and poll GET /api/dsh/sessions/:id
    // instead. No network request is made here.
    if (path === "/api/dsh/events") return response({ error: "DSH events SSE is not available in the public simulator. Poll GET /api/dsh/sessions/:id instead." }, 501);

    return response({ error: `The public simulator has no fixture for ${method} ${path}` }, 404);
  }) as typeof fetch;
}

export function installPublicSimulator(): void {
  localStorage.setItem("opencode.directory.v1", localStorage.getItem("opencode.directory.v1") || SIMULATOR_DIRECTORY);
  globalThis.fetch = createPublicSimulator();
}
