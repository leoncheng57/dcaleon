import { Router, type Response } from "express";
import { realpath, stat } from "node:fs/promises";

import type { ClaudeConfig, ClaudePreset, ClaudeWorkspace } from "../claude/config.js";
import { ClaudeSupervisor } from "../claude/supervisor.js";
import { ClaudeSessionStore } from "../claude/store.js";

const MAX_PROMPT = 40_000;

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function publicSession(session: ReturnType<ClaudeSessionStore["create"]>) {
  return {
    id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId,
    mode: session.mode, createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running,
  };
}

export function claudeRoutes(
  config: ClaudeConfig,
  supervisor = new ClaudeSupervisor(config),
  store = new ClaudeSessionStore(config.ledgerFile),
): Router {
  const router = Router();
  let loadError: Error | null = null;
  const ready = store.load().catch((cause) => {
    loadError = cause instanceof Error ? cause : new Error(String(cause));
  });

  // One child per session, so a frame is trusted to belong to its session; the
  // route still guards that the session is known and running before applying.
  supervisor.on("frame", ({ sessionId, frame }) => store.applyFrame(sessionId, frame));
  supervisor.on("exit", ({ sessionId }) => store.handleExit(sessionId));
  supervisor.on("diagnostic", (detail) => console.warn("[claude]", detail));
  store.on("error", (detail) => console.warn("[claude-ledger]", detail));

  router.use(async (_req, res, next) => {
    await ready;
    if (loadError) return error(res, 503, "Claude runtime ledger is unavailable");
    next();
  });

  function requireEnabled(res: Response): boolean {
    if (!config.enabled) {
      error(res, 404, "Claude runtime is disabled");
      return false;
    }
    if (!config.configured) {
      error(res, 503, `Claude runtime is not configured: ${config.errors.join("; ")}`);
      return false;
    }
    return true;
  }
  function preset(id: unknown): ClaudePreset | undefined { return config.presets.find((item) => item.id === id); }
  function workspace(id: unknown): ClaudeWorkspace | undefined { return config.workspaces.find((item) => item.id === id); }
  async function verifyWorkspaceIdentity(selectedWorkspace: ClaudeWorkspace): Promise<boolean> {
    const canonical = await realpath(selectedWorkspace.directory);
    const metadata = await stat(canonical);
    return canonical === selectedWorkspace.directory &&
      metadata.dev === selectedWorkspace.device && metadata.ino === selectedWorkspace.inode;
  }

  router.get("/claude/config", (_req, res) => {
    if (!requireEnabled(res)) return;
    res.json({
      enabled: true,
      configured: config.configured,
      cliVersion: config.cliVersion,
      sandbox: config.sandbox,
      presets: config.presets.map(({ id, label, model, effort, permissionMode, mode }) => ({ id, label, model, effort, permissionMode, mode })),
      workspaces: config.workspaces.map(({ id, label }) => ({ id, label })),
    });
  });

  router.get("/claude/sessions", (_req, res) => {
    if (!requireEnabled(res)) return;
    res.json({ sessions: store.list().map(publicSession) });
  });

  router.post("/claude/sessions", async (req, res) => {
    if (!requireEnabled(res)) return;
    const selectedPreset = preset(req.body?.presetId);
    const selectedWorkspace = workspace(req.body?.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 400, "presetId and workspaceId must be allowlisted");
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) {
        return error(res, 409, "allowlisted Claude workspace identity changed");
      }
      const session = store.create({
        presetId: selectedPreset.id,
        workspaceId: selectedWorkspace.id,
        mode: selectedPreset.mode,
        title: req.body?.title,
      });
      res.status(201).json({ session: publicSession(session) });
    } catch {
      error(res, 400, "allowlisted Claude workspace is unavailable");
    }
  });

  router.get("/claude/sessions/:id", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    res.json({ session: publicSession(session), events: session.events });
  });

  router.post("/claude/sessions/:id/prompt", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (session.running) return error(res, 409, "Claude session is already running");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > MAX_PROMPT) return error(res, 400, `text must contain 1-${MAX_PROMPT} characters`);
    const selectedPreset = preset(session.presetId);
    const selectedWorkspace = workspace(session.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 409, "Claude session configuration is no longer allowlisted");
    if (selectedPreset.mode !== session.mode) {
      return error(res, 409, "Claude session preset policy changed after creation");
    }
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) {
        return error(res, 409, "allowlisted Claude workspace identity changed");
      }
    } catch {
      return error(res, 409, "allowlisted Claude workspace is unavailable");
    }
    store.startRun(session, text);
    try {
      await supervisor.run({
        session: { id: session.id, sessionUuid: session.sessionUuid, started: session.started },
        preset: selectedPreset,
        workspace: selectedWorkspace,
        text,
      });
      res.status(202).json({ accepted: true });
    } catch (cause) {
      store.applyFrame(session.id, { type: "error", subtype: "spawn_failed" });
      console.warn("[claude]", cause instanceof Error ? cause.message : String(cause));
      error(res, 502, "Claude process failed to start");
    }
  });

  router.post("/claude/sessions/:id/cancel", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    supervisor.cancel(session.id);
    const cancelled = store.cancel(session);
    res.json({ cancelled });
  });

  router.get("/claude/events", (req, res) => {
    if (!requireEnabled(res)) return;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!store.get(sessionId)) return error(res, 404, "Claude session not found");
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

  return router;
}
