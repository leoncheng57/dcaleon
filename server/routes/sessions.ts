// server/routes/sessions.ts — the session API the SPA talks to.
//
// Every route is project-scoped. `directory` is required rather than defaulted
// because a silent default would target whichever directory the OpenCode
// server happened to start in, which is a confusing class of bug: the UI shows
// an empty list and nothing appears wrong.

import { Router, type Request, type Response } from "express";

import { OpencodeError, request, type OpencodeConfig } from "../opencode/client.js";
import type { EventBus } from "../opencode/events.js";
import type { AutoPermissionService } from "../opencode/autoPermissions.js";
import { listPermissions, replyPermission } from "../opencode/permissions.js";
import { PathError, requireWorkspaceDirectory } from "../paths.js";
import {
  abortSession,
  createSession,
  createManagedChild,
  deleteSession,
  getSession,
  renameSession,
  SESSION_TITLE_LIMIT,
  getSessionTurnDiff,
  SESSION_TURN_DIFF_LIMITS,
  listMessages,
  listSessions,
  listTodos,
  prompt,
  promptManagedChild,
  shareSession,
  unshareSession,
  ModePolicyActivationError,
  ManagedChildIdempotencyError,
  ManagedChildCapacityError,
  ManagedChildCleanupError,
  ManagedChildAgentPolicyError,
  ManagedChildConfigurationError,
  isManagedChildAgent,
  managedChildAccess,
  listManagedChildAgents,
  listSessionAgents,
  promptSessionAgent,
  SessionAgentIdentityError,
  SessionAgentUnavailableError,
  type AgentMode,
} from "../opencode/sessions.js";
import { listSubagents, promoteSubagentToBackground } from "../opencode/subagents.js";
import { recordInstruction } from "../opencode/instruction-audit.js";
import { createWorktree } from "../opencode/worktrees.js";
import {
  getModelCatalogue,
  getModelContextLimit,
  isSelectableModel,
  ModelCatalogueError,
  type ModelSelection,
} from "../opencode/config.js";
import { visibleReminder } from "../reminders/loader.js";
import { isValidReminderId, type ReminderPreset } from "../reminders/reminders.js";
import { isValidWorkflowId, workflowCatalogue, type WorkflowPreset } from "../workflows/workflows.js";
import { eventClickUrl } from "../publicAppUrl.js";
import { parseQuestionRequests, validateQuestionAnswers, type QuestionRequest } from "../opencode/questions.js";
import { getCapabilities } from "../opencode/capabilities.js";

/** Resolve and validate the project scope for a request. */
async function directoryOf(req: Request): Promise<string> {
  const value = req.query.directory ?? req.body?.directory;
  return requireWorkspaceDirectory(value);
}

/**
 * Express 5 types route params as `string | string[]` (a repeated `:id` in the
 * path would produce an array). Ours never repeat, so reject the array form
 * rather than silently taking the first element.
 */
function paramOf(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value) {
    throw new HttpError(400, `invalid '${name}' path parameter`);
  }
  return value;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type RootSessionFailureStage = "worktree" | "session" | "prompt";

class RootSessionLaunchError extends Error {
  constructor(
    readonly stage: RootSessionFailureStage,
    message: string,
    readonly directory?: string,
    readonly session?: Awaited<ReturnType<typeof createSession>>,
  ) {
    super(message);
  }
}

class RootSessionIdempotencyError extends Error {
  constructor() {
    super("idempotency key was already used for a different root session launch");
  }
}

interface RootLaunchEntry {
  fingerprint: string;
  promise: Promise<{ session: Awaited<ReturnType<typeof createSession>>; isolated: boolean; accepted: true }>;
  settled: boolean;
}

const rootLaunches = new Map<string, RootLaunchEntry>();
const ROOT_LAUNCH_LIMIT = 500;

function promptAttachments(value: unknown): Array<{ filename: string; mime: string; url: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new HttpError(400, "at most four image attachments are allowed");
  return value.map((item) => {
    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const filename = typeof source.filename === "string" ? source.filename.slice(0, 200) : "image";
    const mime = typeof source.mime === "string" ? source.mime : "";
    const url = typeof source.url === "string" ? source.url : "";
    const prefix = `data:${mime};base64,`;
    const encoded = url.startsWith(prefix) ? url.slice(prefix.length) : "";
    const validBase64 = encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
    const decodedBytes = validBase64 ? Buffer.byteLength(encoded, "base64") : Number.POSITIVE_INFINITY;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || !validBase64 || decodedBytes > 3 * 1024 * 1024) {
      throw new HttpError(400, "attachments must be PNG, JPEG, GIF or WebP data URLs under 3 MiB");
    }
    return { filename, mime, url };
  });
}

/**
 * Resolve a reminder by id for injection, honouring repository scope.
 *
 * This is the path that returns the actual trusted body, so it must apply the
 * same scope predicate as the listing route. Filtering only `GET /api/reminders`
 * would hide a scoped reminder from the picker while leaving it fully
 * injectable by id from any other project (issue #165).
 *
 * A scoped reminder in a non-matching directory is reported as unknown rather
 * than forbidden: confirming existence would leak the very thing scope hides.
 */
async function promptReminder(directory: string, value: unknown): Promise<ReminderPreset | undefined> {
  if (value === undefined) return undefined;
  if (!isValidReminderId(value)) throw new HttpError(400, "reminder must be a valid preset id");
  const preset = await visibleReminder(directory, value);
  if (!preset) throw new HttpError(400, `unknown reminder "${value}"`);
  return preset;
}

/**
 * Resolve a workflow injector by id. The browser only ever names the workflow;
 * the trusted injector text is resolved here so a tampered client cannot
 * author hidden prompt content.
 */
function promptWorkflow(value: unknown): WorkflowPreset | undefined {
  if (value === undefined) return undefined;
  if (!isValidWorkflowId(value)) throw new HttpError(400, "workflow must be a valid workflow id");
  const preset = workflowCatalogue().find((item) => item.id === value);
  if (!preset) throw new HttpError(400, `unknown workflow "${value}"`);
  return preset;
}

function promptMode(value: unknown): AgentMode {
  if (value === undefined) return "build";
  if (value !== "plan" && value !== "build") throw new HttpError(400, "mode must be 'plan' or 'build'");
  return value;
}

/**
 * Optional explicit agent identity for a prompt (issue #52, narrowed).
 * Exclusive with `mode`: Plan/Build keep the policy-activating path, so a
 * request must pick one contract or the other rather than blending them.
 */
function promptAgent(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(value)) {
    throw new HttpError(400, "agent must be a short agent identifier");
  }
  if (value === "plan" || value === "build") {
    throw new HttpError(400, "prompt Plan or Build through 'mode', which activates session policy");
  }
  return value;
}

async function selectedModel(
  config: OpencodeConfig,
  directory: string,
  value: unknown,
): Promise<ModelSelection | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "model must contain providerID and modelID");
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set(["providerID", "modelID", "variant"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new HttpError(400, `unsupported model field '${key}'`);
  }
  if (typeof source.providerID !== "string" || !source.providerID.trim() ||
      typeof source.modelID !== "string" || !source.modelID.trim()) {
    throw new HttpError(400, "model must contain providerID and modelID");
  }
  if (source.variant !== undefined && (typeof source.variant !== "string" || !source.variant.trim())) {
    throw new HttpError(400, "model variant must be a non-empty string");
  }
  const model: ModelSelection = {
    providerID: source.providerID.trim(),
    modelID: source.modelID.trim(),
    ...(typeof source.variant === "string" ? { variant: source.variant.trim() } : {}),
  };
  if (!isSelectableModel(await getModelCatalogue(config, directory), model)) {
    throw new HttpError(400, `unknown or disabled model or variant "${model.providerID}/${model.modelID}${model.variant ? `/${model.variant}` : ""}"`);
  }
  return model;
}

/**
 * Map thrown errors onto responses without leaking stack traces.
 *
 * OpenCode answers 500 (`UnknownError`) for an unknown session id rather than
 * 404, so a stale bookmark would otherwise surface as "bad gateway". Callers
 * that know they were addressing a specific session pass `notFoundOn5xx` to
 * get the honest status instead.
 */
function fail(res: Response, error: unknown, options: { notFoundOn5xx?: boolean } = {}): void {
  if (error instanceof HttpError || error instanceof PathError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof RootSessionIdempotencyError) {
    res.status(409).json({ error: error.message, code: "ROOT_SESSION_IDEMPOTENCY_CONFLICT" });
    return;
  }
  if (error instanceof RootSessionLaunchError) {
    res.status(502).json({
      error: error.message,
      code: error.stage === "worktree"
        ? "ROOT_SESSION_WORKTREE_FAILED"
        : error.stage === "session"
          ? "ROOT_SESSION_CREATION_FAILED"
          : "ROOT_SESSION_PROMPT_REJECTED",
      stage: error.stage,
      ...(error.directory ? { directory: error.directory } : {}),
      ...(error.session ? { session: error.session } : {}),
    });
    return;
  }
  if (error instanceof ModePolicyActivationError) {
    res.status(502).json({ error: error.message });
    return;
  }
  if (error instanceof ManagedChildIdempotencyError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof ManagedChildCapacityError) {
    res.status(503).json({ error: error.message });
    return;
  }
  if (error instanceof ManagedChildCleanupError) {
    res.status(502).json({ error: error.message, childID: error.childID, cleanupFailed: true });
    return;
  }
  if (error instanceof ManagedChildAgentPolicyError) {
    res.status(502).json({ error: error.message, agent: error.agent });
    return;
  }
  if (error instanceof ManagedChildConfigurationError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof SessionAgentIdentityError) {
    res.status(409).json({ error: error.message, code: error.code, agent: error.agent });
    return;
  }
  if (error instanceof SessionAgentUnavailableError) {
    res.status(409).json({ error: error.message, code: "SESSION_AGENT_UNAVAILABLE", agent: error.agent });
    return;
  }
  if (error instanceof ModelCatalogueError) {
    res.status(502).json({ error: error.message });
    return;
  }
  if (error instanceof OpencodeError) {
    if (error.status >= 400 && error.status < 500) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (options.notFoundOn5xx) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    // Otherwise the agent server itself is unhealthy.
    res.status(502).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

const asyncRoute =
  (
    handler: (req: Request, res: Response) => Promise<void>,
    options: { notFoundOn5xx?: boolean } = {},
  ) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => fail(res, error, options));
  };

/** Routes addressing one session by id: upstream 5xx most likely means gone. */
const sessionRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  asyncRoute(handler, { notFoundOn5xx: true });

export function sessionRoutes(
  config: OpencodeConfig,
  bus: EventBus,
  publicAppUrl: string | null = null,
  autoPermissions?: AutoPermissionService,
): Router {
  const router = Router();
  const pendingQuestions = async (directory: string): Promise<QuestionRequest[]> => {
    try {
      return parseQuestionRequests(await request<unknown>(config, "/question", { directory }));
    } catch (error) {
      throw new HttpError(502, error instanceof Error ? error.message : String(error));
    }
  };

  router.get(
    "/models",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json(await getModelCatalogue(config, directory));
    }),
  );

  router.get(
    "/session-agents",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json({ agents: await listSessionAgents(config, directory) });
    }),
  );

  router.get(
    "/managed-child-agents",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json({ agents: await listManagedChildAgents(config, directory) });
    }),
  );

  router.get(
    "/sessions",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const limit = Number(req.query.limit ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, "limit must be an integer between 1 and 100");
      }
      const sessions = await listSessions(config, directory, {
        limit: limit + 1,
        rootsOnly: req.query.roots === "true",
        search: typeof req.query.search === "string" ? req.query.search : undefined,
      });
      res.json({ sessions: sessions.slice(0, limit), truncated: sessions.length > limit });
    }),
  );

  router.post(
    "/sessions",
    asyncRoute(async (req, res) => {
      const projectDirectory = await directoryOf(req);
      const { title, model, prompt: initialPrompt, isolated, worktreeName } = req.body ?? {};
      const mode = promptMode(req.body?.mode);
      // Validate before creating an isolated worktree so rejected input has no side effects.
      const validatedModel = await selectedModel(config, projectDirectory, model);
      const directory = isolated === true
        ? (await createWorktree(
            config,
            bus,
            projectDirectory,
            typeof worktreeName === "string" ? worktreeName : undefined,
          )).directory
        : projectDirectory;
      const session = await createSession(config, { directory, title, agent: mode, model: validatedModel });
      // Fire-and-forget the opening turn so the response is not held for it.
      if (typeof initialPrompt === "string" && initialPrompt.trim()) {
        await prompt(config, directory, session.id, { text: initialPrompt, mode, model: validatedModel });
      }
      res.status(201).json({ session });
    }),
  );

  router.post(
    "/session-workflows/start",
    asyncRoute(async (req, res) => {
      const projectDirectory = await directoryOf(req);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "body must describe a root session launch");
      }
      const allowed = new Set(["sourceSessionID", "prompt", "mode", "model", "authorization", "isolated", "idempotencyKey", "workflow"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new HttpError(400, `unsupported root session field '${key}'`);
      }
      if (typeof body.sourceSessionID !== "string" || !body.sourceSessionID) {
        throw new HttpError(400, "sourceSessionID is required");
      }
      await ownedSession(projectDirectory, body.sourceSessionID);
      if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 100_000) {
        throw new HttpError(400, "prompt must be a non-empty string of at most 100000 characters");
      }
      if (body.mode !== "plan" && body.mode !== "build") {
        throw new HttpError(400, "mode must be 'plan' or 'build'");
      }
      if (body.mode === "build" && body.authorization !== "modify") {
        throw new HttpError(400, "Build requires explicit modify authorization");
      }
      if (body.mode === "plan" && body.authorization !== undefined) {
        throw new HttpError(400, "Plan does not accept modify authorization");
      }
      if (typeof body.isolated !== "boolean") throw new HttpError(400, "isolated must be a boolean");
      if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(body.idempotencyKey)) {
        throw new HttpError(400, "idempotencyKey must contain 1-128 safe characters");
      }
      const workflow = promptWorkflow(body.workflow);
      if (workflow?.id !== "start-dca-session") {
        throw new HttpError(400, "workflow must be 'start-dca-session'");
      }
      const model = await selectedModel(config, projectDirectory, body.model);
      if (!model) throw new HttpError(400, "model is required");

      const key = `${projectDirectory}\0${body.sourceSessionID}\0${body.idempotencyKey}`;
      const fingerprint = JSON.stringify({
        sourceSessionID: body.sourceSessionID,
        prompt: body.prompt.trim(),
        mode: body.mode,
        model,
        isolated: body.isolated,
        workflow: workflow.id,
      });
      const existing = rootLaunches.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new RootSessionIdempotencyError();
        res.status(201).json(await existing.promise);
        return;
      }
      if (rootLaunches.size >= ROOT_LAUNCH_LIMIT) {
        const settled = [...rootLaunches].find(([, entry]) => entry.settled)?.[0];
        if (settled) rootLaunches.delete(settled);
        else throw new HttpError(503, "too many root session launches are still in progress");
      }

      const entry: RootLaunchEntry = {
        fingerprint,
        settled: false,
        promise: Promise.resolve(undefined as never),
      };
      entry.promise = (async () => {
        let targetDirectory = projectDirectory;
        if (body.isolated) {
          try {
            targetDirectory = (await createWorktree(config, bus, projectDirectory)).directory;
          } catch (error) {
            throw new RootSessionLaunchError("worktree", `Isolated worktree creation failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        let session: Awaited<ReturnType<typeof createSession>>;
        try {
          session = await createSession(config, { directory: targetDirectory, agent: body.mode, model });
        } catch (error) {
          throw new RootSessionLaunchError("session", `Session creation failed: ${error instanceof Error ? error.message : String(error)}`, targetDirectory);
        }
        try {
          await prompt(config, targetDirectory, session.id, { text: body.prompt.trim(), mode: body.mode, model, workflow });
        } catch (error) {
          throw new RootSessionLaunchError("prompt", `Opening prompt was rejected: ${error instanceof Error ? error.message : String(error)}`, targetDirectory, session);
        }
        return { session, isolated: body.isolated, accepted: true as const };
      })();
      rootLaunches.set(key, entry);
      void entry.promise.finally(() => { entry.settled = true; }).catch(() => undefined);
      res.status(201).json(await entry.promise);
    }),
  );

  router.get(
    "/sessions/:id",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json({ session: await getSession(config, directory, paramOf(req, "id")) });
    }),
  );

  router.delete(
    "/sessions/:id",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      await deleteSession(config, directory, paramOf(req, "id"));
      res.status(204).end();
    }),
  );

  const ownedSession = async (directory: string, sessionID: string) => {
    let session;
    try {
      session = await getSession(config, directory, sessionID);
    } catch (error) {
      if (error instanceof OpencodeError && error.status >= 500) throw new HttpError(404, "session not found");
      throw error;
    }
    if (session.directory !== directory) throw new HttpError(404, "session not found");
    return session;
  };

  router.patch(
    "/sessions/:id",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          typeof body.title !== "string") {
        throw new HttpError(400, "body must contain { title: string }");
      }
      const title = body.title.trim();
      if (!title || title.length > SESSION_TITLE_LIMIT) {
        throw new HttpError(400, `title must be a non-empty string of at most ${SESSION_TITLE_LIMIT} characters`);
      }
      // Same cross-directory guard share/unshare use: `?directory=` selects
      // the project, so without it a caller could retitle another project's
      // session by id.
      await ownedSession(directory, sessionID);
      await renameSession(config, directory, sessionID, title);
      const session = await getSession(config, directory, sessionID);
      res.json({ session });
    }),
  );

  router.post(
    "/sessions/:id/share",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      await ownedSession(directory, sessionID);
      const session = await shareSession(config, directory, sessionID);
      if (!session.shareUrl) throw new HttpError(502, "OpenCode did not return a valid public share URL");
      res.json({ session });
    }),
  );

  router.delete(
    "/sessions/:id/share",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      await ownedSession(directory, sessionID);
      res.json({ session: await unshareSession(config, directory, sessionID) });
    }),
  );

  router.get(
    "/sessions/:id/messages",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const requestedLimit = Number(req.query.limit ?? 100);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        throw new HttpError(400, "limit must be an integer between 1 and 100");
      }
      const before = req.query.before;
      if (before !== undefined && (typeof before !== "string" || !before.trim())) {
        throw new HttpError(400, "before must be a non-empty cursor");
      }
      // Raw {info, parts} — the client adapter owns the shaping so there is
      // exactly one place that understands OpenCode's wire format.
      const [page, session] = await Promise.all([
        listMessages(config, directory, paramOf(req, "id"), {
          limit: requestedLimit,
          before: typeof before === "string" ? before : undefined,
        }),
        getSession(config, directory, paramOf(req, "id")).catch(() => null),
      ]);
      res.json({ ...page, running: session?.running ?? false });
    }),
  );

  router.get(
    "/sessions/:id/diff",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      const userMessageID = req.query.userMessageID;
      if (typeof userMessageID !== "string" || !userMessageID.trim() || userMessageID.length > 512) {
        throw new HttpError(400, "userMessageID must be a non-empty string of at most 512 characters");
      }
      await ownedSession(directory, sessionID);
      const result = await getSessionTurnDiff(config, directory, sessionID, userMessageID);
      if (result.status === "too_large") {
        res.status(413).json({
          error: "Turn diff exceeds safe response limits",
          code: "TURN_DIFF_TOO_LARGE",
          limits: SESSION_TURN_DIFF_LIMITS,
        });
        return;
      }
      res.json({ changes: result.changes });
    }),
  );

  router.get(
    "/sessions/:id/todos",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json({ todos: await listTodos(config, directory, paramOf(req, "id")) });
    }),
  );

  router.get(
    "/sessions/:id/model-limit",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const session = await getSession(config, directory, paramOf(req, "id"));
      const providerID = session.model?.providerID;
      const modelID = session.model?.modelID;
      const context = providerID && modelID
        ? await getModelContextLimit(config, directory, providerID, modelID)
        : null;
      res.json({ context });
    }),
  );

  router.post(
    "/sessions/:id/prompt",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const { text, model, attachments, reminder, workflow } = req.body ?? {};
      if (typeof text !== "string" || !text.trim()) {
        throw new HttpError(400, "'text' is required");
      }
      const sessionID = paramOf(req, "id");
      const agent = promptAgent(req.body?.agent);
      if (agent !== undefined && req.body?.mode !== undefined) {
        throw new HttpError(400, "'agent' and 'mode' are exclusive");
      }
      const input = {
        text,
        mode: promptMode(req.body?.mode),
        model: await selectedModel(config, directory, model),
        attachments: promptAttachments(attachments),
        reminder: await promptReminder(directory, reminder),
        workflow: promptWorkflow(workflow),
      };
      const session = await getSession(config, directory, sessionID);
      if (session.managedConfigurationPresent) {
        if (!session.managed) {
          // Audit the refusal (issue #91): the human tried to instruct a
          // Managed Child whose configuration no longer verifies, and that
          // attempt should outlive this 409.
          recordInstruction({
            source: "managed-child-prompt",
            directory,
            targetSessionID: sessionID,
            ...(session.parentID ? { parentSessionID: session.parentID } : {}),
            text,
            delivery: "rejected",
            reason: "Managed Child configuration could not be verified; prompt was not sent",
          });
          throw new ManagedChildConfigurationError();
        }
        await promptManagedChild(config, directory, sessionID, input);
      }
      else if (agent !== undefined) await promptSessionAgent(config, directory, sessionID, { ...input, agent });
      else await prompt(config, directory, sessionID, input);
      // 202: accepted, running server-side. Progress arrives over SSE.
      res.status(202).json({ accepted: true });
    }),
  );

  router.post(
    "/sessions/:id/abort",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      await abortSession(config, directory, paramOf(req, "id"));
      res.json({ aborted: true });
    }),
  );

  /**
   * Confirm a child really belongs to the parent named in the path.
   *
   * Upstream will abort any session id handed to it, so without this check
   * `/sessions/{anything}/subagents/{victim}/abort` would be a general-purpose
   * abort endpoint wearing a sub-agent costume. The parent link is the
   * authorization, and the directory check keeps it inside the project scope
   * the caller already proved.
   */
  const ownedChild = async (directory: string, parentID: string, childID: string) => {
    const child = await getSession(config, directory, childID).catch(() => null);
    if (!child || child.directory !== directory || child.parentID !== parentID) {
      throw new HttpError(404, "child session not found for this parent");
    }
    return child;
  };

  router.get(
    "/sessions/:id/subagents",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json(await listSubagents(config, directory, paramOf(req, "id")));
    }),
  );

  router.post(
    "/sessions/:id/managed-children",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const parentID = paramOf(req, "id");
      await ownedSession(directory, parentID);
      if (!(await getCapabilities(config, directory)).managedChildren) {
        throw new HttpError(409, "managed children require OpenCode 1.18.22 or newer");
      }
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "body must contain prompt, agent and idempotencyKey");
      }
      const allowed = new Set(["prompt", "agent", "mode", "model", "authorization", "idempotencyKey", "workflow"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new HttpError(400, `unsupported managed child field '${key}'`);
      }
      const text = body.prompt;
      if (typeof text !== "string" || !text.trim() || text.length > 100_000) {
        throw new HttpError(400, "prompt must be a non-empty string of at most 100000 characters");
      }
      if (body.agent !== undefined && body.mode !== undefined && body.agent !== body.mode) {
        throw new HttpError(400, "agent and legacy mode must not disagree");
      }
      const agent = body.agent ?? body.mode;
      if (!isManagedChildAgent(agent)) {
        throw new HttpError(400, "agent must be 'plan', 'build', 'explore' or 'general'");
      }
      if (managedChildAccess(agent) === "can-modify" && body.authorization !== "modify") {
        throw new HttpError(400, `agent '${agent}' requires explicit modify authorization`);
      }
      if (managedChildAccess(agent) === "read-only" && body.authorization !== undefined) {
        throw new HttpError(400, `read-only agent '${agent}' does not accept modify authorization`);
      }
      const idempotencyKey = body.idempotencyKey;
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey)) {
        throw new HttpError(400, "idempotencyKey must contain 1-128 safe characters");
      }
      const session = await createManagedChild(config, directory, {
        parentID,
        text: text.trim(),
        agent,
        model: await selectedModel(config, directory, body.model),
        idempotencyKey,
        workflow: promptWorkflow(body.workflow),
      });
      res.status(201).json({ session });
    }),
  );

  router.post(
    "/sessions/:id/subagents/:childId/abort",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const childID = paramOf(req, "childId");
      await ownedChild(directory, paramOf(req, "id"), childID);
      await abortSession(config, directory, childID);
      res.json({ aborted: true });
    }),
  );

  /**
   * Promote this session's currently running synchronous children to
   * background execution. Upstream is parent-scoped and answers a bare
   * boolean; `false` means nothing was eligible, which is a conflict rather
   * than a server fault.
   */
  router.post(
    "/sessions/:id/background",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      await ownedSession(directory, sessionID);
      const promoted = await promoteSubagentToBackground(config, directory, sessionID);
      if (!promoted) {
        throw new HttpError(409, "No running sub-agent could be moved to the background.");
      }
      res.json({ promoted: true });
    }),
  );

  router.get(
    "/auto-approve",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json(autoPermissions?.status(directory) ?? { enabled: false, error: null });
    }),
  );

  router.patch(
    "/auto-approve",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
        throw new HttpError(400, "body must be exactly { enabled: boolean }");
      }
      if (!autoPermissions) throw new HttpError(503, "auto permissions are unavailable");
      res.json(await autoPermissions.setEnabled(directory, body.enabled));
    }),
  );

  router.get(
    "/permission-requests",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      res.json({ requests: await listPermissions(config, directory) });
    }),
  );

  router.post(
    "/permission-requests/:requestId/reply",
    asyncRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const reply = req.body?.reply;
      if (reply !== "once" && reply !== "always" && reply !== "reject") {
        throw new HttpError(400, "reply must be 'once', 'always' or 'reject'");
      }
      await replyPermission(
        config,
        directory,
        paramOf(req, "requestId"),
        reply,
        typeof req.body?.message === "string" ? req.body.message : undefined,
      );
      res.json({ replied: true });
    }),
  );

  const ownedQuestion = async (directory: string, sessionID: string, requestID: string): Promise<QuestionRequest> => {
    const pending = await pendingQuestions(directory);
    const found = pending.find((item) => item.id === requestID && item.sessionID === sessionID);
    if (!found) throw new HttpError(404, "question request not found for this session");
    return found;
  };

  router.get(
    "/sessions/:id/questions",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const sessionID = paramOf(req, "id");
      const pending = await pendingQuestions(directory);
      res.json({ requests: pending.filter((item) => item.sessionID === sessionID) });
    }),
  );

  router.post(
    "/sessions/:id/questions/:requestId/reply",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const pending = await ownedQuestion(directory, paramOf(req, "id"), paramOf(req, "requestId"));
      const replied = await request<boolean>(config, `/question/${encodeURIComponent(pending.id)}/reply`, {
        method: "POST",
        directory,
        body: { answers: (() => {
          try {
            return validateQuestionAnswers(pending.questions, req.body?.answers);
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
          }
        })() },
      });
      if (!replied) throw new HttpError(409, "OpenCode did not accept the question reply");
      res.json({ replied: true });
    }),
  );

  router.post(
    "/sessions/:id/questions/:requestId/reject",
    sessionRoute(async (req, res) => {
      const directory = await directoryOf(req);
      const pending = await ownedQuestion(directory, paramOf(req, "id"), paramOf(req, "requestId"));
      const rejected = await request<boolean>(config, `/question/${encodeURIComponent(pending.id)}/reject`, {
        method: "POST",
        directory,
      });
      if (!rejected) throw new HttpError(409, "OpenCode did not accept the question rejection");
      res.json({ rejected: true });
    }),
  );

  /**
   * SSE fan-out. One upstream subscription serves every connected tab.
   *
   * Optionally filtered by ?directory= so a project view is not woken by
   * activity in an unrelated repo.
   */
  router.get("/events", (req: Request, res: Response) => {
    const scope = typeof req.query.directory === "string" ? req.query.directory : undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer SSE into uselessness without this.
      "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", properties: {} })}\n\n`);

    const onEvent = (event: { type: string; properties: unknown; directory?: string }) => {
      if (scope && event.directory && event.directory !== scope) return;
      if (autoPermissions?.isEnabled(event.directory) &&
          (event.type === "permission.asked" || event.type === "notification.parked")) return;
      const properties = event.properties && typeof event.properties === "object"
        ? event.properties as Record<string, unknown>
        : {};
      res.write(`data: ${JSON.stringify({ ...event, click: eventClickUrl(publicAppUrl, { ...event, properties }) })}\n\n`);
    };
    bus.on("event", onEvent);

    // Keep intermediaries from closing an idle connection. Upstream sends its
    // own heartbeat but we may be filtering all of it out.
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      bus.off("event", onEvent);
    });
  });

  return router;
}
