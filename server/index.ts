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
import { parsePublicAppUrl } from "./publicAppUrl.js";
import { readDshConfig } from "./dsh/config.js";
import { dshRoutes } from "./routes/dsh.js";
import { readClaudeConfig } from "./claude/config.js";
import { claudeRoutes } from "./routes/claude.js";
import { parseLiveBrowserConfig } from "./browser/policy.js";
import { liveBrowserRoutes } from "./browser/routes.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const opencode = readOpencodeConfig();
const publicAppUrl = parsePublicAppUrl(process.env.PUBLIC_APP_URL);
const dsh = readDshConfig();
const claude = readClaudeConfig();

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
const notificationService = new NotificationService(
  opencode,
  bus,
  notificationStore,
  notificationHistory,
  publicAppUrl,
  (directory) => autoPermissions.isEnabledCanonical(directory),
  undefined,
  pushSubscriptions,
);
notificationService.start();
bus.start();

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
app.use("/api", appConfigRoutes(publicAppUrl, dsh.enabled, claude.enabled));
app.use("/api", projectRoutes());
app.use("/api", observabilityRoutes(opencode, PORT));
app.use("/api", modelPinRoutes());
app.use("/api", recentRoutes(opencode));
app.use("/api", dshRoutes(dsh));
app.use("/api", claudeRoutes(claude));
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

/**
 * Liveness for this BFF plus reachability of the OpenCode server behind it.
 * Deliberately reports upstream version skew instead of hiding it — a
 * mismatch is the first thing to suspect when a response shape looks wrong.
 */
app.get("/api/health", async (_req, res) => {
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
      dsh: { enabled: dsh.enabled, configured: dsh.configured, sdkVersion: dsh.sdkVersion, sandbox: dsh.sandbox },
      claude: { enabled: claude.enabled, configured: claude.configured, cliVersion: claude.cliVersion, sandbox: claude.sandbox },
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

app.listen(PORT, "0.0.0.0", () => {
  // 0.0.0.0 so the app is reachable over the tailnet from a phone.
  console.log(`[bff] listening on :${PORT} -> opencode ${opencode.baseUrl}`);
});
