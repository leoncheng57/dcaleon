import { Router, type Response } from "express";
import type { EventEmitter } from "node:events";
import { realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ClaudeConfig, ClaudePreset } from "../claude/config.js";
import type { ClaudeApprovalStore } from "../claude/approvals.js";
import { ClaudeSupervisor } from "../claude/supervisor.js";
import { ClaudeSessionStore, type ClaudeIsolation } from "../claude/store.js";
import { listClaudeWorkspaces, resolveClaudeWorkspace, type ResolvedWorkspace } from "../claude/workspaces.js";
import { createWorktree, currentBranch, isDirty, mergeWorktree, originRemote, pushWorktreeBranch, removeWorktree, workspaceChanges, worktreeExists } from "../claude/worktree.js";
import { createPullRequest, getReviewStatus, parseReviewUrl } from "../forge.js";
import { getReviewDetails } from "../forge-details.js";
import { listClaudeTree, readClaudeFile, resolveClaudeReferences } from "../claude/files.js";
import { composeClaudePrompt } from "../claude/prompt.js";
import { ClaudeAttachmentError, stageClaudeImages } from "../claude/attachments.js";
import { publishClaudeRunEvents } from "../claude/notifications.js";
import { PathError } from "../paths.js";
import { visibleReminder, visibleReminders } from "../reminders/loader.js";
import { isValidReminderId } from "../reminders/reminders.js";
import { isValidWorkflowId, workflowCatalogue } from "../workflows/workflows.js";
import { fetchClaudeUsage } from "../claude/usage.js";
import { TranscriptCursorError, type ClaudeActionCategory } from "../claude/transcript.js";

const MAX_PROMPT = 40_000;

function error(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function publicSession(session: ReturnType<ClaudeSessionStore["create"]>) {
  return {
    id: session.id, title: session.title, presetId: session.presetId, workspaceId: session.workspaceId, workspaceLabel: session.workspaceLabel,
    mode: session.mode, isolation: session.isolation, createdAt: session.createdAt, updatedAt: session.updatedAt, running: session.running,
    interrupted: session.interrupted === true,
    ...(session.worktree ? { branch: session.worktree.branch } : {}),
    ...(session.prUrl ? { prUrl: session.prUrl } : {}),
    ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
    worktreeClosed: session.isolation === "worktree" && session.events.some((event) => event.kind === "status" && ["Merged into project", "Worktree discarded"].includes(event.label)),
  };
}

/** Worktree sessions need to write the project's shared `.git`; reads are whole-disk. */
function sandboxExtras(session: ReturnType<ClaudeSessionStore["create"]>): { writes: string[] } | undefined {
  if (!session.worktree) return undefined;
  return { writes: [path.join(session.projectDirectory, ".git")] };
}

export function claudeRoutes(
  config: ClaudeConfig,
  supervisor = new ClaudeSupervisor(config),
  store = new ClaudeSessionStore(config.ledgerFile, config.sessionsFile),
  /** The app's OpenCode event bus; a finished turn is announced on it so the notification lane hears Claude too. */
  bus?: Pick<EventEmitter, "emit">,
  /** Present only when the operator enabled approvals; `port` addresses this BFF over loopback. */
  approvals?: { store: ClaudeApprovalStore; port: number },
): Router {
  const router = Router();
  let loadError: Error | null = null;
  const ready = store.load().catch((cause) => {
    loadError = cause instanceof Error ? cause : new Error(String(cause));
  });

  // One child per session, so a frame is trusted to belong to its session; the
  // route still guards that the session is known and running before applying.
  supervisor.on("frame", ({ sessionId, frame }) => store.applyFrame(sessionId, frame));
  supervisor.on("exit", ({ sessionId, code, signal, stderr }) => {
    // Nothing can answer a check whose turn is over, so refuse what is left
    // rather than leaving a row in the UI that can never be actioned.
    approvals?.store.cancelSession(sessionId);
    store.handleExit(sessionId, { code, signal, stderr });
  });
  supervisor.on("diagnostic", (detail) => console.warn("[claude]", detail));
  store.on("error", (detail) => console.warn("[claude-ledger]", detail));
  if (bus) store.on("finished", ({ session, outcome, reason }) => publishClaudeRunEvents(bus, session, outcome, reason));

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
      approvals: config.approvals,
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
    const query: { before?: string; after?: string; since?: string; q?: string; actions?: boolean; category?: ClaudeActionCategory } = {};
    for (const key of ["before", "after", "since", "q"] as const) {
      const value = req.query[key];
      if (value !== undefined && (typeof value !== "string" || !value || value.length > (key === "q" ? 200 : 512))) return error(res, 400, "Invalid transcript query");
      if (typeof value === "string") query[key] = value;
    }
    if ([query.before, query.after, query.since].filter(Boolean).length > 1) return error(res, 400, "Use one transcript cursor");
    if (req.query.actions !== undefined && req.query.actions !== "true") return error(res, 400, "Invalid actions filter");
    query.actions = req.query.actions === "true";
    if (req.query.category !== undefined) {
      if (!query.actions || typeof req.query.category !== "string" || !["edit", "command", "read", "failure", "other"].includes(req.query.category)) return error(res, 400, "Invalid action category");
      query.category = req.query.category as ClaudeActionCategory;
    }
    try {
      res.set("Cache-Control", "private, no-store");
      res.json({ session: publicSession(session), ...store.transcript(session).read(query) });
    } catch (cause) {
      if (cause instanceof TranscriptCursorError) return error(res, 400, cause.message);
      throw cause;
    }
  });

  // Explicit full-history workflow only. Never used by polling or the main view.
  router.get("/claude/sessions/:id/export", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.json({ events: session.events });
  });

  // The reminders this session may attach, scoped by the session's own cwd.
  // A dedicated route rather than /api/reminders?directory= because a worktree
  // session's cwd lives under the state dir, which the workspace-directory
  // guard rightly rejects — and because the browser must never name a path.
  router.get("/claude/sessions/:id/reminders", async (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    const reminders = await visibleReminders(session.directory);
    res.json({
      reminders: reminders.map(({ id, title, description, triggers, tags, body, scopeRepository }) => ({
        id, title, description, triggers, tags, body, ...(scopeRepository ? { scopeRepository } : {}),
      })),
    });
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
    const plan = req.body?.plan === true;
    // Per-message playbooks, named by id only. The trusted bodies are resolved
    // here (reminder scope honoured against the session's cwd), exactly as the
    // OpenCode prompt route does, so a tampered client cannot author them.
    const reminderId = req.body?.reminder;
    const workflowId = req.body?.workflow;
    if (reminderId !== undefined && !isValidReminderId(reminderId)) return error(res, 400, "reminder must be a valid preset id");
    if (workflowId !== undefined && !isValidWorkflowId(workflowId)) return error(res, 400, "workflow must be a valid workflow id");
    const reminder = reminderId === undefined ? undefined : await visibleReminder(session.directory, reminderId);
    if (reminderId !== undefined && !reminder) return error(res, 400, `unknown reminder "${reminderId}"`);
    const workflow = workflowId === undefined ? undefined : workflowCatalogue().find((item) => item.id === workflowId);
    if (workflowId !== undefined && !workflow) return error(res, 400, `unknown workflow "${workflowId}"`);
    let staged;
    try {
      staged = await stageClaudeImages(config.sessionRoot, session.sessionUuid, req.body?.images);
    } catch (cause) {
      if (cause instanceof ClaudeAttachmentError) return error(res, 400, cause.message);
      console.warn("[claude]", cause instanceof Error ? cause.message : String(cause));
      return error(res, 500, "Claude image attachments could not be staged");
    }
    const composed = composeClaudePrompt({ text, imagePaths: staged.paths, reminder, workflow });
    // The transcript keeps the human's own words plus chips; only the binary
    // sees the sentinel blocks.
    store.startRun(session, text, { reminders: composed.reminders, workflows: composed.workflows, plan });
    try {
      await supervisor.run({
        session: { id: session.id, sessionUuid: session.sessionUuid, started: session.started },
        preset: selectedPreset,
        workspace: { directory: session.directory },
        sandboxExtras: sandboxExtras(session),
        ...(requestedModel ? { model: requestedModel } : {}),
        turnMode: plan ? "plan" : "build",
        ...(approvals ? { approvals: { url: `http://127.0.0.1:${approvals.port}/api/claude/internal/approvals`, token: approvals.store.token } } : {}),
        text: composed.text,
        ...(staged.directory ? { cleanupDirectory: staged.directory } : {}),
      });
      res.status(202).json({ accepted: true });
    } catch (cause) {
      if (staged.directory) await rm(staged.directory, { recursive: true, force: true });
      store.applyFrame(session.id, { type: "error", subtype: "spawn_failed" });
      console.warn("[claude]", cause instanceof Error ? cause.message : String(cause));
      error(res, 502, "Claude process failed to start");
    }
  });

  // The in-session approver's own endpoint. It may only ASK: there is no way to
  // supply a decision through it, so the token the sandbox necessarily holds
  // cannot be turned into a self-approval. Held open until someone answers.
  router.post("/claude/internal/approvals", async (req, res) => {
    if (!requireEnabled(res)) return;
    if (!approvals) return error(res, 404, "Claude approvals are disabled");
    if (req.get("X-Dcaleon-Approval-Token") !== approvals.store.token) return error(res, 403, "invalid approval token");
    const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : "";
    const toolName = typeof req.body?.toolName === "string" ? req.body.toolName : "";
    const toolUseId = typeof req.body?.toolUseId === "string" ? req.body.toolUseId : "";
    if (!store.get(sessionId)) return error(res, 404, "Claude session not found");
    if (!toolName || !toolUseId) return error(res, 400, "toolName and toolUseId are required");
    const raw = req.body?.input;
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    res.json(await approvals.store.ask({ sessionId, toolName, toolUseId, input }));
  });

  router.get("/claude/sessions/:id/approvals", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    res.set("Cache-Control", "private, no-store");
    res.json({ approvals: approvals?.store.list(session.id) ?? [] });
  });

  router.post("/claude/sessions/:id/approvals/:approvalId/reply", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    if (!approvals) return error(res, 404, "Claude approvals are disabled");
    const reply = req.body?.reply;
    if (reply !== "once" && reply !== "always" && reply !== "reject") {
      return error(res, 400, "reply must be 'once', 'always' or 'reject'");
    }
    const pending = approvals.store.list(session.id).some((item) => item.id === req.params.approvalId);
    if (!pending) return error(res, 404, "approval request not found for this session");
    const message = typeof req.body?.message === "string" ? req.body.message : undefined;
    res.json({ replied: approvals.store.reply(req.params.approvalId, reply, message) });
  });

  router.post("/claude/sessions/:id/cancel", (req, res) => {
    if (!requireEnabled(res)) return;
    const session = store.get(req.params.id);
    if (!session) return error(res, 404, "Claude session not found");
    approvals?.store.cancelSession(session.id);
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

  router.get("/claude/usage", async (_req, res) => {
    if (!requireEnabled(res)) return;
    try {
      const data = await fetchClaudeUsage(config.cliVersion);
      res.json(data);
    } catch (cause) {
      res.json({ available: false, reason: cause instanceof Error ? cause.message : "Unknown error" });
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
