import { Router, type Response } from "express";
import type { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";

import type { DshConfig, DshPreset, DshWorkspace } from "../dsh/config.js";
import { DshBridgePool } from "../dsh/bridge.js";
import { DshSessionStore } from "../dsh/store.js";
import { DshTrajectoryStore } from "../dsh/trajectory.js";
import { DshDurableReader } from "../dsh/durable.js";
import { publishDshRunEvents } from "../dsh/notifications.js";

const MAX_PROMPT = 40_000;

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function privateTrajectory(res: Response): void {
  res.set({
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
}

function publicSession(session: ReturnType<DshSessionStore["create"]>) {
  return {
    id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId,
    mode: session.mode, createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running,
  };
}

export function dshRoutes(
  config: DshConfig,
  pool = new DshBridgePool(config),
  store = new DshSessionStore(config.ledgerFile, config.sessionsFile),
  trajectory = new DshTrajectoryStore(config.trajectoryRoot, {
    sensitiveEnabled: config.trajectorySensitiveEnabled,
    maintenanceEnabled: config.enabled,
    allowedProviders: config.presets.map((item) => item.provider),
    allowedModels: config.presets.map((item) => item.model),
    // The bridge exports this root as DSH_SESSION_ROOT, which the stock
    // composition uses for the JSONL backend, so a persisting deployment
    // persists here. It stays optional: nothing requires the operator's
    // sha256-pinned cordis file to compose persistence at all.
    durable: new DshDurableReader(config.sessionRoot),
  }),
  bus?: Pick<EventEmitter, "emit">,
): Router {
  const router = Router();
  let loadError: Error | null = null;
  const ready = store.load().catch((cause) => {
    loadError = cause instanceof Error ? cause : new Error(String(cause));
  });
  const MAX_CAPTURE_QUEUE = 32;
  let queuedCaptures = 0;
  let captureWrites = Promise.resolve();
  const overflowSessions = new Set<string>();
  const enqueueWrite = (write: () => Promise<void>): boolean => {
    if (queuedCaptures >= MAX_CAPTURE_QUEUE) return false;
    queuedCaptures++;
    captureWrites = captureWrites.then(write)
      .catch((cause) => console.warn("[dsh-trajectory]", cause))
      .finally(() => {
        queuedCaptures--;
        const sessionId = overflowSessions.values().next().value as string | undefined;
        if (sessionId && queuedCaptures < MAX_CAPTURE_QUEUE) {
          overflowSessions.delete(sessionId);
          enqueueWrite(() => trajectory.appendLifecycle(sessionId, "dca/capture-gap"));
        }
      });
    return true;
  };
  const enqueueCapture = (event: Parameters<DshSessionStore["applyBridge"]>[0]) => {
    const session = store.get(event.sessionId);
    if (!session?.running) return;
    if (event.bridgePresetId !== session.presetId || event.bridgeWorkspaceId !== session.workspaceId) return;
    if (!enqueueWrite(() => trajectory.appendBridge(event)) && overflowSessions.size < MAX_CAPTURE_QUEUE) overflowSessions.add(event.sessionId);
  };
  const captureLifecycle = (sessionId: string, type: string, detail?: unknown): void => {
    if (!enqueueWrite(() => trajectory.appendLifecycle(sessionId, type, detail)) && overflowSessions.size < MAX_CAPTURE_QUEUE) overflowSessions.add(sessionId);
  };
  pool.on("notification", (event) => {
    const session = store.get(event.sessionId);
    if (!session || event.bridgePresetId !== session.presetId || event.bridgeWorkspaceId !== session.workspaceId) return;
    enqueueCapture(event);
    store.applyBridge(event);
  });
  pool.on("bridgeExit", ({ presetId, workspaceId }) => {
    for (const session of store.list()) {
      if (session.running && session.presetId === presetId && session.workspaceId === workspaceId) {
        captureLifecycle(session.id, "dca/bridge-exit", { presetId, workspaceId });
      }
    }
    store.failRunning(presetId, workspaceId);
  });
  pool.on("diagnostic", (detail) => console.warn("[dsh]", detail));
  store.on("error", (detail) => console.warn("[dsh-ledger]", detail));
  if (bus) store.on("finished", ({ session, outcome }) => {
    const selectedWorkspace = workspace(session.workspaceId);
    // Never guess a project identity after an operator removes a workspace.
    if (selectedWorkspace) publishDshRunEvents(bus, session, selectedWorkspace.directory, outcome);
  });

  router.use(async (_req, res, next) => {
    await ready;
    if (loadError) return error(res, 503, "DSH experiment ledger is unavailable");
    next();
  });

  function requireEnabled(res: Response): boolean {
    if (!config.enabled) {
      error(res, 404, "DSH experiment is disabled");
      return false;
    }
    if (!config.configured) {
      error(res, 503, `DSH experiment is not configured: ${config.errors.join("; ")}`);
      return false;
    }
    return true;
  }
  function preset(id: unknown): DshPreset | undefined { return config.presets.find((item) => item.id === id); }
  function workspace(id: unknown): DshWorkspace | undefined { return config.workspaces.find((item) => item.id === id); }
  async function verifyWorkspaceIdentity(selectedWorkspace: DshWorkspace): Promise<boolean> {
    const canonical = await realpath(selectedWorkspace.directory);
    const metadata = await stat(canonical);
    return canonical === selectedWorkspace.directory &&
      metadata.dev === selectedWorkspace.device && metadata.ino === selectedWorkspace.inode;
  }

  router.get("/dsh/config", (_req, res) => {
    if (!requireEnabled(res)) return;
    res.json({
      enabled: true,
      configured: config.configured,
      protocol: 1,
      sdkVersion: config.sdkVersion,
      sandbox: config.sandbox,
      trajectory: {
        sensitiveDetailEnabled: config.trajectorySensitiveEnabled,
        fullExportEnabled: config.trajectoryFullExportEnabled,
      },
      presets: config.presets.map(({ id, label, provider, model, fingerprint, mode }) => ({ id, label, provider, model, fingerprint, mode })),
      workspaces: config.workspaces.map(({ id, label }) => ({ id, label })),
    });
  });

  router.get("/dsh/sessions", (_req, res) => {
    if (!requireEnabled(res)) return;
    res.json({ sessions: store.list().map(publicSession) });
  });

  router.post("/dsh/sessions", async (req, res) => {
    if (!requireEnabled(res)) return;
    const selectedPreset = preset(req.body?.presetId);
    const selectedWorkspace = workspace(req.body?.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 400, "presetId and workspaceId must be allowlisted");
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) {
        return error(res, 409, "allowlisted DSH workspace identity changed");
      }
      const session = store.create({
        presetId: selectedPreset.id,
        presetFingerprint: selectedPreset.fingerprint,
        workspaceId: selectedWorkspace.id,
        mode: selectedPreset.mode,
        title: req.body?.title,
      });
      captureLifecycle(session.id, "dca/session-created", {
        presetId: selectedPreset.id,
        presetFingerprint: selectedPreset.fingerprint,
        workspaceId: selectedWorkspace.id,
        mode: selectedPreset.mode,
      });
      res.status(201).json({ session: publicSession(session) });
    } catch {
      error(res, 400, "allowlisted DSH workspace is unavailable");
    }
  });

  router.get("/dsh/sessions/:id", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "DSH session not found");
    res.json({ session: publicSession(session), events: session.events });
  });

  router.post("/dsh/sessions/:id/prompt", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "DSH session not found");
    if (session.running) return error(res, 409, "DSH session is already running");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > MAX_PROMPT) return error(res, 400, `text must contain 1-${MAX_PROMPT} characters`);
    const selectedPreset = preset(session.presetId);
    const selectedWorkspace = workspace(session.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 409, "DSH session configuration is no longer allowlisted");
    if (selectedPreset.fingerprint !== session.presetFingerprint || selectedPreset.mode !== session.mode) {
      return error(res, 409, "DSH session preset policy changed after creation");
    }
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) {
        pool.closeWorkspace(selectedPreset.id, selectedWorkspace.id);
        captureLifecycle(session.id, "dca/workspace-identity-changed", { presetId: session.presetId, workspaceId: session.workspaceId });
        store.applyBridge({ type: "failed", sessionId: session.id, error: "allowlisted DSH workspace identity changed" });
        return error(res, 409, "allowlisted DSH workspace identity changed");
      }
    } catch (cause) {
      pool.closeWorkspace(selectedPreset.id, selectedWorkspace.id);
      captureLifecycle(session.id, "dca/workspace-unavailable", { presetId: session.presetId, workspaceId: session.workspaceId, cause: cause instanceof Error ? cause.message : String(cause) });
      store.applyBridge({ type: "failed", sessionId: session.id, error: "allowlisted DSH workspace is unavailable" });
      return error(res, 409, "allowlisted DSH workspace is unavailable");
    }
    store.startRun(session, text, { model: `${selectedPreset.provider}/${selectedPreset.model}` });
    captureLifecycle(session.id, "dca/prompt-accepted", {
      presetId: session.presetId,
      workspaceId: session.workspaceId,
      promptCharacters: text.length,
    });
    try {
      await pool.get(selectedPreset, selectedWorkspace).request("prompt", { sessionId: session.id, text });
      res.status(202).json({ accepted: true });
    } catch (cause) {
      // The bridge may reject the RPC without ever emitting a `failed`
      // notification or exiting, so nothing else would reach the trajectory.
      // Without this the capture shows an accepted prompt and no outcome,
      // which is the one direction a projection must never be wrong in.
      captureLifecycle(session.id, "dca/prompt-rejected", { presetId: session.presetId, workspaceId: session.workspaceId, cause: cause instanceof Error ? cause.message : String(cause) });
      store.applyBridge({ type: "failed", sessionId: session.id, error: cause instanceof Error ? cause.message : String(cause) });
      error(res, 502, "DSH bridge rejected the prompt");
    }
  });

  router.post("/dsh/sessions/:id/cancel", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "DSH session not found");
    const selectedPreset = preset(session.presetId);
    const selectedWorkspace = workspace(session.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 409, "DSH session configuration is no longer allowlisted");
    try {
      const result = await pool.get(selectedPreset, selectedWorkspace).request("cancel", { sessionId: session.id }) as { cancelled?: boolean };
      const cancelled = result.cancelled === true && store.cancel(session);
      if (cancelled) captureLifecycle(session.id, "dca/cancelled-by-user");
      res.json({ cancelled });
    } catch (cause) {
      captureLifecycle(session.id, "dca/cancel-failed", { presetId: session.presetId, workspaceId: session.workspaceId, cause: cause instanceof Error ? cause.message : String(cause) });
      store.applyBridge({ type: "failed", sessionId: session.id, error: "DSH bridge cancellation failed" });
      error(res, 502, "DSH bridge cancellation failed");
    }
  });

  router.get("/dsh/events", (req, res) => {
    if (!requireEnabled(res)) return;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!store.get(sessionId)) return error(res, 404, "DSH session not found");
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    const update = (changed: string) => {
      if (changed === sessionId) res.write(`event: update\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    };
    store.on("update", update);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      store.off("update", update);
    });
  });

  router.get("/dsh/sessions/:id/trajectory", async (req, res) => {
    if (!requireEnabled(res)) return;
    privateTrajectory(res);
    if (!store.get(req.params.id)) return error(res, 404, "DSH session not found");
    const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
    const before = req.query.before === undefined ? undefined : Number(req.query.before);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return error(res, 400, "limit must be an integer from 1 to 500");
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) return error(res, 400, "before must be a positive integer");
    try {
      const page = await trajectory.page(req.params.id, {
        limit,
        ...(before === undefined ? {} : { before }),
      });
      res.json({ ...page, capturePending: queuedCaptures > 0 || overflowSessions.size > 0 });
    } catch (cause) {
      console.warn("[dsh-trajectory] list failed", cause);
      error(res, 500, "DSH trajectory is unavailable");
    }
  });

  router.get("/dsh/sessions/:id/trajectory/export", async (req, res) => {
    if (!requireEnabled(res)) return;
    privateTrajectory(res);
    if (!store.get(req.params.id)) return error(res, 404, "DSH session not found");
    try {
      const exported = await trajectory.export(req.params.id);
      res.set({
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="dsh-trajectory-${req.params.id}.json"`,
      });
      res.json(exported);
    } catch (cause) {
      console.warn("[dsh-trajectory] safe export failed", cause);
      error(res, 500, "DSH trajectory export is unavailable");
    }
  });

  router.post("/dsh/sessions/:id/trajectory/export-full", async (req, res) => {
    if (!requireEnabled(res)) return;
    privateTrajectory(res);
    if (!store.get(req.params.id)) return error(res, 404, "DSH session not found");
    if (!config.trajectoryFullExportEnabled) return error(res, 403, "Full trajectory export is disabled");
    if (req.body?.confirmation !== "export-sensitive-dsh-trajectory") return error(res, 400, "Explicit sensitive export confirmation is required");
    try {
      const exported = await trajectory.exportFull(req.params.id);
      res.set({
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="dsh-trajectory-${req.params.id}-sensitive.json"`,
      });
      res.json(exported);
    } catch (cause) {
      console.warn("[dsh-trajectory] sensitive export failed", cause);
      error(res, 500, "Sensitive DSH trajectory export is unavailable");
    }
  });

  router.post("/dsh/sessions/:id/trajectory/:eventId/detail", async (req, res) => {
    if (!requireEnabled(res)) return;
    privateTrajectory(res);
    if (!store.get(req.params.id)) return error(res, 404, "DSH session not found");
    if (!config.trajectorySensitiveEnabled) return error(res, 403, "Sensitive trajectory detail is disabled");
    try {
      const detail = await trajectory.detail(req.params.id, req.params.eventId);
      if (!detail) return error(res, 404, "DSH trajectory detail not found");
      res.json({ detail });
    } catch (cause) {
      console.warn("[dsh-trajectory] detail failed", cause);
      error(res, 500, "DSH trajectory detail is unavailable");
    }
  });
  return router;
}
