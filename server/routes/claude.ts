import { Router, type Response } from "express";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ClaudeConfig, ClaudePreset } from "../claude/config.js";
import { ClaudeSupervisor } from "../claude/supervisor.js";
import { ClaudeSessionStore, type ClaudeIsolation } from "../claude/store.js";
import { listClaudeWorkspaces, resolveClaudeWorkspace, type ResolvedWorkspace } from "../claude/workspaces.js";
import { createWorktree, currentBranch, isDirty, mergeWorktree, originRemote, pushWorktreeBranch, removeWorktree, workspaceChanges, worktreeExists } from "../claude/worktree.js";
import { createPullRequest, getReviewStatus, parseReviewUrl } from "../forge.js";
import { getReviewDetails } from "../forge-details.js";
import { listClaudeTree, readClaudeFile, resolveClaudeReferences } from "../claude/files.js";
import { PathError } from "../paths.js";

const MAX_PROMPT = 40_000;

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function publicSession(session: ReturnType<ClaudeSessionStore["create"]>) {
  return {
    id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId, workspaceLabel: session.workspaceLabel,
    mode: session.mode, isolation: session.isolation, createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running,
    // Branch is safe to show; the worktree PATH is a host path and stays server-side.
    ...(session.worktree ? { branch: session.worktree.branch } : {}),
    ...(session.prUrl ? { prUrl: session.prUrl } : {}),
  };
}

/** Worktree sessions need to read the project and write its shared `.git`. */
function sandboxExtras(session: ReturnType<ClaudeSessionStore["create"]>): { reads: string[]; writes: string[] } | undefined {
  if (!session.worktree) return undefined;
  return { reads: [session.projectDirectory], writes: [path.join(session.projectDirectory, ".git")] };
}

export function claudeRoutes(
  config: ClaudeConfig,
  supervisor = new ClaudeSupervisor(config),
  store = new ClaudeSessionStore(config.ledgerFile, config.sessionsFile),
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
    if (loadError) return error(res, 503, "Claude runtime state is unavailable");
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
  async function verifyWorkspaceIdentity(selected: ResolvedWorkspace): Promise<boolean> {
    const canonical = await realpath(selected.directory);
    const metadata = await stat(canonical);
    return canonical === selected.directory && metadata.dev === selected.device && metadata.ino === selected.inode;
  }

  router.get("/claude/config", async (_req, res) => {
    if (!requireEnabled(res)) return;
    const workspaces = await listClaudeWorkspaces(config);
    res.json({
      enabled: true,
      configured: config.configured,
      cliVersion: config.cliVersion,
      sandbox: config.sandbox,
      presets: config.presets.map(({ id, label, model, effort, permissionMode, mode }) => ({ id, label, model, effort, permissionMode, mode })),
      workspaces: workspaces.map(({ id, label, source }) => ({ id, label, source })),
      models: config.models,
    });
  });

  router.get("/claude/sessions", (_req, res) => {
    if (!requireEnabled(res)) return;
    res.json({ sessions: store.list().map(publicSession) });
  });

  router.post("/claude/sessions", async (req, res) => {
    if (!requireEnabled(res)) return;
    const selectedPreset = preset(req.body?.presetId);
    const selectedWorkspace = await resolveClaudeWorkspace(config, req.body?.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 400, "presetId and workspaceId must be allowlisted");
    const isolation: ClaudeIsolation = req.body?.isolation === "worktree" ? "worktree" : "direct";
    if (isolation === "worktree" && selectedPreset.mode !== "build") return error(res, 400, "worktree isolation requires a Build preset");
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) return error(res, 409, "allowlisted Claude workspace identity changed");
    } catch {
      return error(res, 400, "allowlisted Claude workspace is unavailable");
    }
    let worktree;
    const sessionUuid = crypto.randomUUID();
    if (isolation === "worktree") {
      try {
        worktree = await createWorktree(selectedWorkspace.directory, config.worktreeRoot, sessionUuid);
      } catch (cause) {
        return error(res, 409, cause instanceof Error ? cause.message : "could not create a worktree for this session");
      }
    }
    const session = store.create({
      presetId: selectedPreset.id,
      workspaceId: selectedWorkspace.id,
      workspaceLabel: selectedWorkspace.label,
      mode: selectedPreset.mode,
      isolation,
      directory: worktree?.directory ?? selectedWorkspace.directory,
      projectDirectory: selectedWorkspace.directory,
      ...(worktree ? { worktree } : {}),
      title: req.body?.title,
      sessionUuid,
    });
    res.status(201).json({ session: publicSession(session) });
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
    const selectedWorkspace = await resolveClaudeWorkspace(config, session.workspaceId);
    if (!selectedPreset || !selectedWorkspace) return error(res, 409, "Claude session configuration is no longer allowlisted");
    if (selectedPreset.mode !== session.mode) return error(res, 409, "Claude session preset policy changed after creation");
    try {
      if (!await verifyWorkspaceIdentity(selectedWorkspace)) return error(res, 409, "allowlisted Claude workspace identity changed");
    } catch {
      return error(res, 409, "allowlisted Claude workspace is unavailable");
    }
    if (session.worktree && !await worktreeExists(session.worktree.directory)) {
      return error(res, 409, "this session's worktree no longer exists");
    }
    // A per-turn model override, restricted to models the operator configured
    // (never an arbitrary browser-supplied model). Mode/permission stay fixed.
    const allowedModels = new Set(config.models);
    const requestedModel = typeof req.body?.modelOverride === "string" ? req.body.modelOverride : undefined;
    if (requestedModel && !allowedModels.has(requestedModel)) return error(res, 400, "model is not one of the configured presets");
    // A plan turn is read-only planning; only meaningful for a Build session
    // (a read-only session is already non-writing).
    const plan = req.body?.plan === true && session.mode === "build";
    store.startRun(session, text);
    try {
      await supervisor.run({
        session: { id: session.id, sessionUuid: session.sessionUuid, started: session.started },
        preset: selectedPreset,
        workspace: { directory: session.directory },
        sandboxExtras: sandboxExtras(session),
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(plan ? { plan: true } : {}),
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

  // What the session changed: working-tree diff for direct sessions, diff against
  // the base commit (so the agent's own commits count) for worktree sessions.
  router.get("/claude/sessions/:id/changes", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (session.worktree && !await worktreeExists(session.worktree.directory)) return res.json({ files: [], diff: "", truncated: false, gone: true });
    try {
      const changes = await workspaceChanges(session.directory, session.worktree?.baseCommit);
      res.set("Cache-Control", "private, no-store");
      res.json(changes);
    } catch (cause) {
      error(res, 409, cause instanceof Error ? `changes unavailable: ${cause.message}` : "changes unavailable");
    }
  });

  // Read-only file browser over the session's directory (worktree or project),
  // served from the local filesystem in the shapes the workspace UI expects.
  router.get("/claude/sessions/:id/tree", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (session.worktree && !await worktreeExists(session.worktree.directory)) return res.json({ path: "", dirs: [], files: [], nextPageId: null });
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await listClaudeTree(session.directory, typeof req.query.path === "string" ? req.query.path : ""));
    } catch (cause) {
      if (cause instanceof PathError) return error(res, cause.status, cause.message);
      error(res, 409, "workspace tree unavailable");
    }
  });

  router.get("/claude/sessions/:id/file", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    try {
      res.set("Cache-Control", "private, no-store");
      res.json(await readClaudeFile(session.directory, typeof req.query.path === "string" ? req.query.path : ""));
    } catch (cause) {
      if (cause instanceof PathError) return error(res, cause.status, cause.message);
      error(res, 409, "workspace file unavailable");
    }
  });

  // Validate transcript-mentioned paths so inline `path:line` spans become
  // openable in the Files drawer. Bounded, path-confined, content never read.
  router.post("/claude/sessions/:id/references", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((item: unknown): item is string => typeof item === "string") : [];
    if (session.worktree && !await worktreeExists(session.worktree.directory)) return res.json({ references: [] });
    try {
      res.set("Cache-Control", "private, no-store");
      res.json({ references: await resolveClaudeReferences(session.directory, paths) });
    } catch {
      error(res, 409, "workspace references unavailable");
    }
  });

  router.post("/claude/sessions/:id/merge", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (!session.worktree) return error(res, 400, "only worktree sessions can be merged");
    if (session.running) return error(res, 409, "wait for the running turn to finish before merging");
    if (!await worktreeExists(session.worktree.directory)) return error(res, 409, "this session's worktree no longer exists");
    try {
      if (await isDirty(session.projectDirectory)) return error(res, 409, "project working tree has uncommitted changes; commit or stash them before merging");
      const { mergeCommit } = await mergeWorktree(session.worktree, `Merge Claude session ${session.title} (${session.worktree.branch})`);
      await removeWorktree(session.worktree);
      store.note(session, "Merged into project", `${session.worktree.branch} → ${mergeCommit.slice(0, 7)}`);
      res.json({ merged: true, mergeCommit });
    } catch (cause) {
      error(res, 409, cause instanceof Error ? cause.message : "merge failed");
    }
  });

  router.post("/claude/sessions/:id/discard", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (!session.worktree) return error(res, 400, "only worktree sessions can be discarded");
    if (session.running) supervisor.cancel(session.id), store.cancel(session);
    try {
      await removeWorktree(session.worktree);
      store.note(session, "Worktree discarded", session.worktree.branch);
      res.json({ discarded: true });
    } catch (cause) {
      error(res, 409, cause instanceof Error ? cause.message : "discard failed");
    }
  });

  // Push the worktree branch to origin and open a PR. Runs in the BFF on host
  // git credentials (never in the sandbox). GitHub origin + GITHUB_TOKEN only;
  // degrades with a clear message otherwise.
  router.post("/claude/sessions/:id/pr", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (!session.worktree) return error(res, 400, "only worktree sessions can open a PR");
    if (session.running) return error(res, 409, "wait for the running turn to finish before opening a PR");
    if (!await worktreeExists(session.worktree.directory)) return error(res, 409, "this session's worktree no longer exists");
    if (!process.env.GITHUB_TOKEN) return error(res, 400, "GITHUB_TOKEN is not configured; cannot open a PR");
    const remote = await originRemote(session.projectDirectory);
    if (!remote || remote.host !== "github.com") return error(res, 400, "opening a PR needs a github.com origin remote");
    try {
      const base = await currentBranch(session.projectDirectory);
      await pushWorktreeBranch(session.worktree, `Claude session ${session.title}`);
      const pr = await createPullRequest({
        owner: remote.owner, repo: remote.repo, head: session.worktree.branch, base,
        title: session.title || `Claude session ${session.worktree.branch}`,
        body: `Opened from a Claude Code runtime session.\n\nBranch: \`${session.worktree.branch}\``,
      });
      store.setPrUrl(session, pr.url);
      store.note(session, "Pull request opened", pr.url);
      res.status(201).json({ url: pr.url, number: pr.number });
    } catch (cause) {
      error(res, 502, cause instanceof Error ? cause.message : "could not open a pull request");
    }
  });

  router.get("/claude/sessions/:id/pr", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (!session.prUrl) return res.json({ pr: null });
    try {
      const ref = parseReviewUrl(session.prUrl);
      const [status, details] = await Promise.all([
        getReviewStatus(ref),
        getReviewDetails(ref).catch(() => null),
      ]);
      res.set("Cache-Control", "private, no-store");
      res.json({ pr: { ...status, checks: details?.checks?.value ?? [] } });
    } catch (cause) {
      error(res, 502, cause instanceof Error ? cause.message : "could not read PR status");
    }
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
