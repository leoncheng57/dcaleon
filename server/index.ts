// server/index.ts — BFF entrypoint.
//
// Responsibilities that justify a backend at all (the OpenCode server could
// otherwise be called straight from the browser):
//   - holds the OpenCode basic-auth credential
//   - fans one upstream SSE stream out to many browser clients
//   - threads ?directory= per project
//   - runs what the OpenCode API does not expose: git history, forge APIs,
//     notification transport
//
// All browser-facing API routes are registered here; feature modules own the
// upstream and filesystem details so this entrypoint remains auditable.

import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import dotenv from "dotenv";

import { readOpencodeConfig, checkHealth, EXPECTED_SERVER_VERSION } from "./opencode/client.js";
import { EventBus } from "./opencode/events.js";
import { bindBrowserSessionLifecycle } from "./browser/lifecycle.js";
import { AutoPermissionService } from "./opencode/autoPermissions.js";
import { sessionRoutes } from "./routes/sessions.js";
import { settingsRoutes } from "./routes/settings.js";
import { mcpRoutes } from "./routes/mcp.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { parseAllowedPorts, previewRoutes } from "./routes/preview.js";
import { worktreeRoutes } from "./routes/worktrees.js";
import { notificationRoutes } from "./routes/notifications.js";
import { PreferenceStore } from "./notifications/preferences.js";
import { HistoryStore } from "./notifications/history.js";
import { NotificationService } from "./notifications/service.js";
import { PushSubscriptionStore, webPushConfig } from "./notifications/webpush.js";
import { forgeRoutes } from "./routes/forge.js";
import { planningRoutes } from "./routes/planning.js";
import { reminderRoutes } from "./routes/reminders.js";
import { workflowRoutes } from "./routes/workflows.js";
import { appConfigRoutes } from "./routes/appConfig.js";
import { observabilityRoutes } from "./routes/observability.js";
import { projectRoutes } from "./routes/projects.js";
import { modelPinRoutes } from "./routes/modelPins.js";
import { recentRoutes } from "./routes/recents.js";
import { memoryRoutes } from "./routes/memory.js";
import { parsePublicAppUrl } from "./publicAppUrl.js";
import { chooseBindHost, describeBindHost } from "./bindHost.js";
import { readDshConfig } from "./dsh/config.js";
import { dshRoutes } from "./routes/dsh.js";
import { readClaudeConfig } from "./claude/config.js";
import { ClaudeSessionStore } from "./claude/store.js";
import { ClaudeSupervisor } from "./claude/supervisor.js";
import { CredentialWatch } from "./claude/credentialWatch.js";
import { claudeRoutes } from "./routes/claude.js";
import { ClaudeApprovalStore } from "./claude/approvals.js";
import { bindClaudeApprovalEvents } from "./claude/approvalBridge.js";
import { listPermissions } from "./opencode/permissions.js";
import { getSessionMetadata, latestAssistantExcerpt } from "./opencode/sessions.js";
import { isClaudeSessionId } from "./publicAppUrl.js";
import { parseLiveBrowserConfig } from "./browser/policy.js";
import { publicIslands, readIslandConfig } from "./islands.js";
import { islandGuardRoutes } from "./routes/islandGuard.js";
import { liveBrowserRoutes } from "./browser/routes.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const opencode = readOpencodeConfig();
const publicAppUrl = parsePublicAppUrl(process.env.PUBLIC_APP_URL);
const dsh = readDshConfig();
const claude = readClaudeConfig();
// Which runtime islands this host runs at all. Separate from each island's own
// env configuration above: DCALEON_ISLANDS is the operator's preference, and
// the platform independently vetoes what it cannot host (see server/islands.ts).
const islands = readIslandConfig();
for (const problem of islands.errors) console.warn("[islands]", problem);
for (const island of [islands.opencode, islands.dsh, islands.claude]) {
  if (!island.available) console.warn(`[islands] ${island.id} unavailable: ${island.reason}`);
}

app.use(express.json({ limit: "20mb" }));

// One upstream SSE subscription, fanned out to every browser client.
const bus = new EventBus(opencode);
bus.on("error", (error: unknown) => {
  console.warn("[bus]", error instanceof Error ? error.message : error);
});
const autoPermissions = new AutoPermissionService(
  opencode,
  bus,
  // Persisted so a BFF restart does not silently flip an auto-approved
  // directory back to ask mode — which pushed one permission ask per tool
  // call at every configured phone until the user noticed and re-toggled.
  process.env.AUTO_APPROVE_STATE_FILE || path.resolve(process.cwd(), ".state/auto-approve.json"),
);
autoPermissions.start();
const notificationStore = new PreferenceStore();
const notificationHistory = new HistoryStore();
const pushSubscriptions = new PushSubscriptionStore();
webPushConfig(); // Fail at startup rather than exposing a half-configured channel.
// Created here rather than inside claudeRoutes so the notification service can
// answer questions about a Claude session from this store instead of asking the
// OpenCode server about an id it has never issued.
const claudeStore = new ClaudeSessionStore(claude.ledgerFile, claude.sessionsFile);
const claudeSupervisor = new ClaudeSupervisor(claude);
const claudeApprovals = claude.approvals ? new ClaudeApprovalStore() : undefined;
// Wire auto-permissions into the Claude approval store: when the toggle is ON
// for a session's project directory, tool calls are approved without waiting.
if (claudeApprovals) {
  claudeApprovals.autoApprove = (sessionId) => {
    const session = claudeStore.get(sessionId);
    return Boolean(session && autoPermissions.isEnabled(session.projectDirectory));
  };
  // Asks and answers become the bus events the notification lane and the
  // session SSE already react to. Without this the gate was silent: a gated
  // call sat for the full timeout with no ping and no row (decision 34c).
  bindClaudeApprovalEvents(bus, claudeApprovals, claudeStore);
}
const notificationService = new NotificationService(
  opencode,
  bus,
  notificationStore,
  notificationHistory,
  publicAppUrl,
  (directory) => autoPermissions.isEnabledCanonical(directory),
  async (directory, sessionID, signal) => {
    if (!isClaudeSessionId(sessionID)) return getSessionMetadata(opencode, directory, sessionID, signal);
    const session = claudeStore.get(sessionID);
    return session ? { id: session.id, title: session.title } : null;
  },
  pushSubscriptions,
  async (directory, sessionID, signal) => {
    if (!isClaudeSessionId(sessionID)) return latestAssistantExcerpt(opencode, directory, sessionID, signal);
    const session = claudeStore.get(sessionID);
    const last = session?.events.filter((event) => event.kind === "agent").at(-1);
    return last && last.kind === "agent" ? last.text : undefined;
  },
  // The parked escalation asks "is it still waiting?" against the store that
  // actually holds the ask: OpenCode's `/permission` for its sessions, the
  // BFF's approval store for Claude's.
  async (directory, pending) => {
    if (isClaudeSessionId(pending.sessionID)) return claudeApprovals?.list(pending.sessionID).some((item) => item.id === pending.id) ?? false;
    return (await listPermissions(opencode, directory)).some((item) => item.id === pending.id);
  },
);
notificationService.start();

// An unreadable Claude credential store stops every turn and, on a headless
// host, tells nobody. The watch pushes once on the transition into that state
// and once on recovery; see credentialHealth.ts for why expiry itself is
// reported but never alerted on.
const credentialWatch = new CredentialWatch({
  subscriptions: pushSubscriptions,
  available: islands.claude.available && claude.enabled,
});
credentialWatch.start();
// Without the OpenCode island there is no upstream to subscribe to, and
// starting anyway is exactly the failure this phase removes: endless SSE
// reconnects against a server that is not running. The bus stays constructed
// so Claude turns can still emit onto it.
if (islands.opencode.available) bus.start();
else console.warn("[bus] not started — the OpenCode island is unavailable on this host");

// Mounted before every route below so an OpenCode request on a host without
// that island gets one honest 503 instead of an upstream connection error.
app.use("/api", islandGuardRoutes(islands.opencode));

app.use("/api", sessionRoutes(opencode, bus, publicAppUrl, autoPermissions));
app.use("/api", settingsRoutes(opencode));
app.use("/api", mcpRoutes(opencode));
app.use("/api", workspaceRoutes(opencode));
app.use("/api", worktreeRoutes(opencode, bus));
app.use("/api", notificationRoutes(notificationStore, notificationHistory, pushSubscriptions));
app.use("/api", forgeRoutes());
app.use("/api", planningRoutes());
app.use("/api", reminderRoutes());
app.use("/api", workflowRoutes());
app.use("/api", appConfigRoutes(publicAppUrl, dsh.enabled, dsh.configured, claude.enabled, claude.configured, islands));
app.use("/api", projectRoutes());
app.use("/api", observabilityRoutes(opencode, PORT));
app.use("/api", modelPinRoutes());
app.use("/api", recentRoutes(opencode, claudeStore));
app.use("/api", memoryRoutes());
app.use("/api", dshRoutes(dsh, undefined, undefined, undefined, bus));
app.use("/api", claudeRoutes(claude, claudeSupervisor, claudeStore, bus, claudeApprovals ? { store: claudeApprovals, port: PORT } : undefined, autoPermissions));
const opencodePort = Number(new URL(opencode.baseUrl).port || 80);
app.use("/api", previewRoutes(parseAllowedPorts(process.env.PREVIEW_ALLOWED_PORTS, [PORT, opencodePort])));

// Live session browser (issue #229). Off by default; the manager — and with
// it playwright-core — is only loaded when the flag is set, so a disabled
// deployment pays nothing at boot. Chromium itself launches lazily on first
// open, never here.
const liveBrowser = parseLiveBrowserConfig(process.env);
const liveBrowserManager = liveBrowser.enabled
  ? new (await import("./browser/manager.js")).BrowserManager(
      liveBrowser,
      process.env.BROWSER_PROFILE_DIR || path.resolve(process.cwd(), ".state/live-browser-profile"),
    )
  : null;
app.use("/api", liveBrowserRoutes(liveBrowser, liveBrowserManager));
if (liveBrowserManager) {
  bindBrowserSessionLifecycle(bus, liveBrowserManager);
}

/**
 * Liveness for this BFF plus reachability of the OpenCode server behind it.
 * Deliberately reports upstream version skew instead of hiding it — a
 * mismatch is the first thing to suspect when a response shape looks wrong.
 */
app.get("/api/health", async (_req, res) => {
  // A host that does not run the OpenCode island has no upstream to be
  // unreachable, so probing one would report this BFF as unhealthy forever —
  // and the deploy path gates on this endpoint. Report the island instead.
  if (!islands.opencode.available) {
    res.json({
      healthy: true,
      upstream: { url: null, reachable: false, islandAvailable: false, reason: islands.opencode.reason },
      events: { connected: false },
      islands: publicIslands(islands),
      dsh: { enabled: dsh.enabled, configured: dsh.configured, sdkVersion: dsh.sdkVersion, sandbox: dsh.sandbox },
      claude: { enabled: claude.enabled, configured: claude.configured, cliVersion: claude.cliVersion, versions: claudeSupervisor.cliVersions(), credentials: credentialWatch.state() },
    });
    return;
  }
  try {
    const upstream = await checkHealth(opencode);
    res.json({
      healthy: true,
      upstream: {
        url: opencode.baseUrl,
        reachable: upstream.healthy,
        version: upstream.version,
        expected: EXPECTED_SERVER_VERSION,
        versionMatches: upstream.versionMatches,
      },
      events: { connected: bus.isConnected() },
      islands: publicIslands(islands),
      dsh: { enabled: dsh.enabled, configured: dsh.configured, sdkVersion: dsh.sdkVersion, sandbox: dsh.sandbox },
      claude: { enabled: claude.enabled, configured: claude.configured, cliVersion: claude.cliVersion, versions: claudeSupervisor.cliVersions(), credentials: credentialWatch.state() },
    });
  } catch (error) {
    res.status(503).json({
      healthy: false,
      upstream: {
        url: opencode.baseUrl,
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

// Static SPA (built UI). dist/server/index.js -> ../client
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../client");
app.use(express.static(clientDir));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  // Express/send in the current dependency set returns ENOENT for an
  // absolute sendFile path even when the file exists; the rooted form is the
  // documented equivalent and keeps client-side routes working.
  res.sendFile("index.html", { root: clientDir });
});

const bindHost = chooseBindHost();
const server = app.listen(PORT, bindHost, () => {
  // The bind address is this app's access-control boundary; see server/bindHost.ts.
  console.log(`[bff] listening on ${describeBindHost(bindHost)}:${PORT} -> opencode ${opencode.baseUrl}`);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(); // stop accepting prompts before changing run state
  const interrupted = claudeStore.interruptRunning(`Claude turn interrupted because the BFF received ${signal}`);
  if (interrupted) console.warn(`[bff] ${interrupted} Claude turn(s) interrupted by ${signal}`);
  await claudeStore.flush();
  claudeSupervisor.close();
  notificationService.stop();
  credentialWatch.stop();
  autoPermissions.stop();
  bus.stop();
  process.exitCode = 0;
}
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
