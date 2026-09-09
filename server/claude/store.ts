import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { ClaudePresetMode } from "./config.js";
import type { ClaudeFrame } from "./supervisor.js";
import type { ClaudeWorktree } from "./worktree.js";
import { ClaudeTranscriptIndex } from "./transcript.js";

/** Placeholder title until the first prompt (or an explicit title) replaces it. */
const DEFAULT_CLAUDE_TITLE = "New Claude conversation";

// Structurally assignable to the client's frozen TranscriptEvent contract.
// Richer than the DSH store: thought, tool (with what it touched), and patch arms.
/** A reminder or workflow block attached to one prompt, shown as a chip on the user row. */
export interface PromptTag { name: string; body: string }

export type ClaudeTranscriptEvent =
  | { id: string; messageId: string; timestamp: string; kind: "user"; text: string; reminders: PromptTag[]; workflows: PromptTag[]; attachments: []; mode?: "plan" | "build" }
  | { id: string; messageId: string; timestamp: string; kind: "agent"; text: string; mode?: "plan" | "build"; /** Model id the CLI reported on the assistant frame that produced this prose, e.g. `claude-opus-4-1-20250805`. */ model?: string; metricsStatus?: "pending" | "final"; costStatus?: "pending" | "final" | "unavailable"; cumulativeCostStatus?: "pending" | "final" | "unavailable"; durationStatus?: "pending" | "final" | "unavailable"; messageCost?: number; cumulativeCost?: number; messageDurationMs?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { id: string; messageId: string; timestamp: string; kind: "thought"; text: string }
  | { id: string; messageId: string; timestamp: string; kind: "tool"; status: "pending" | "running" | "completed" | "error"; name: string; detail?: string; commandText?: string; output?: string; error?: string; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "patch"; files: string[]; fileCount: number; filesTruncated: boolean }
  | { id: string; messageId: string; timestamp: string; kind: "status"; label: string; detail?: string }
  | { id: string; messageId: string; timestamp: string; kind: "error"; message: string };

export type ClaudeIsolation = "direct" | "worktree";

export interface ClaudeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  contextWindow: number;
  costUsd: number;
}

export interface ClaudeSession {
  id: string;
  sessionUuid: string;
  title: string;
  presetId: string;
  workspaceId: string;
  workspaceLabel: string;
  mode: ClaudePresetMode;
  isolation: ClaudeIsolation;
  /** The session's cwd: the project itself, or its isolated worktree. */
  directory: string;
  /** The project the session belongs to (same as `directory` for direct sessions). */
  projectDirectory: string;
  worktree?: ClaudeWorktree;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  started: boolean;
  events: ClaudeTranscriptEvent[];
  runStartedAt?: number;
  activeRunId?: string;
  sawResult?: boolean;
  interrupted?: boolean;
  tokenUsage?: ClaudeTokenUsage;
}

export interface ClaudeRunRecord {
  id: string;
  sessionId: string;
  presetId: string;
  workspaceId: string;
  mode: ClaudePresetMode;
  taskClass: "conversation";
  startedAt: number;
  endedAt?: number;
  outcome: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  costUsd: number;
  interventions: number;
}

interface Ledger { version: 1; records: ClaudeRunRecord[] }
interface SessionIndex { version: 1; sessions: ClaudeSession[] }

const MAX_EVENTS = 1_000;
const MAX_PATCH_FILES = 50;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MUTATION_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Reverse index search (ES2023 `findLastIndex` is unavailable under the server lib target). */
function findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
  for (let i = array.length - 1; i >= 0; i--) if (predicate(array[i])) return i;
  return -1;
}

function blocksOf(frame: ClaudeFrame): Array<Record<string, unknown>> {
  const message = frame.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

export class ClaudeSessionStore extends EventEmitter {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly transcripts = new Map<string, ClaudeTranscriptIndex>();
  private readonly toolIndex = new Map<string, Map<string, string>>();
  private readonly editedFiles = new Map<string, Set<string>>();
  private readonly runModes = new Map<string, "plan" | "build">();
  private ledger: Ledger = { version: 1, records: [] };
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(private readonly ledgerFile: string, private readonly sessionsFile?: string) {
    super();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.ledgerFile, "utf8")) as Partial<Ledger>;
      if (parsed.version === 1 && Array.isArray(parsed.records)) this.ledger = { version: 1, records: parsed.records.slice(-1_000) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.sessionsFile) return;
    try {
      const parsed = JSON.parse(await readFile(this.sessionsFile, "utf8")) as Partial<SessionIndex>;
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
        const interrupted: ClaudeSession[] = [];
        for (const session of parsed.sessions) {
          // A session that was mid-turn when the BFF stopped has no process any
          // more. Say so rather than showing a spinner forever (decision 5's spirit).
          if (session.running) {
            const activeRunId = session.activeRunId;
            session.running = false;
            session.started = true;
            session.activeRunId = undefined;
            session.runStartedAt = undefined;
            session.interrupted = true;
            const id = `status-${randomUUID()}`;
            session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Interrupted by a server restart" });
            const record = [...this.ledger.records].reverse().find((item) => item.id === activeRunId || (item.sessionId === session.id && item.outcome === "running"));
            if (record) {
              record.outcome = "interrupted";
              record.endedAt = Date.now();
            }
            interrupted.push(session);
          }
          this.sessions.set(session.id, session);
        }
        if (interrupted.length) {
          this.persist();
          this.persistSessions();
          for (const session of interrupted) this.emit("finished", { session, outcome: "interrupted", reason: "Claude turn interrupted by a server restart" });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  create(input: {
    presetId: string; workspaceId: string; workspaceLabel: string; mode: ClaudePresetMode;
    isolation: ClaudeIsolation; directory: string; projectDirectory: string; worktree?: ClaudeWorktree; title?: string;
    sessionUuid?: string;
  }): ClaudeSession {
    const now = new Date().toISOString();
    const session: ClaudeSession = {
      id: `claude-${randomUUID()}`,
      sessionUuid: input.sessionUuid ?? randomUUID(),
      title: input.title?.trim().slice(0, 120) || DEFAULT_CLAUDE_TITLE,
      presetId: input.presetId,
      workspaceId: input.workspaceId,
      workspaceLabel: input.workspaceLabel,
      mode: input.mode,
      isolation: input.isolation,
      directory: input.directory,
      projectDirectory: input.projectDirectory,
      ...(input.worktree ? { worktree: input.worktree } : {}),
      createdAt: now,
      updatedAt: now,
      running: false,
      started: false,
      events: [],
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  list(): ClaudeSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  transcript(session: ClaudeSession): ClaudeTranscriptIndex {
    let index = this.transcripts.get(session.id);
    if (!index) {
      index = new ClaudeTranscriptIndex();
      this.transcripts.set(session.id, index);
    }
    index.sync(session.events);
    return index;
  }

  remove(id: string): boolean {
    const removed = this.sessions.delete(id);
    if (removed) {
      this.transcripts.delete(id);
      this.toolIndex.delete(id);
      this.editedFiles.delete(id);
      this.runModes.delete(id);
      this.persistSessions();
      this.emit("update", id);
    }
    return removed;
  }

  /** Test/shutdown seam: wait until the atomic writes have settled. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  startRun(session: ClaudeSession, text: string, tags: { reminders?: PromptTag[]; workflows?: PromptTag[]; plan?: boolean } = {}): ClaudeRunRecord {
    const now = Date.now();
    const messageId = `user-${randomUUID()}`;
    if (session.title === DEFAULT_CLAUDE_TITLE && !session.events.some((event) => event.kind === "user")) {
      const derived = text.split("\n").map((line) => line.trim()).find(Boolean)?.replace(/\s+/g, " ").slice(0, 80);
      if (derived) session.title = derived;
    }
    const turnMode: "plan" | "build" = tags.plan ? "plan" : "build";
    session.running = true;
    session.interrupted = false;
    session.sawResult = false;
    session.runStartedAt = now;
    session.updatedAt = new Date(now).toISOString();
    this.runModes.set(session.id, turnMode);
    session.events.push({
      id: messageId, messageId, timestamp: session.updatedAt, kind: "user", text,
      reminders: tags.reminders ?? [], workflows: tags.workflows ?? [], attachments: [], mode: turnMode,
    });
    this.toolIndex.set(session.id, new Map());
    this.editedFiles.set(session.id, new Set());
    const record: ClaudeRunRecord = {
      id: randomUUID(), sessionId: session.id, presetId: session.presetId, workspaceId: session.workspaceId, mode: session.mode,
      taskClass: "conversation", startedAt: now, outcome: "running", costUsd: 0, interventions: 0,
    };
    session.activeRunId = record.id;
    this.ledger.records.push(record);
    this.ledger.records = this.ledger.records.slice(-1_000);
    this.persist();
    this.persistSessions();
    this.emit("update", session.id);
    return record;
  }

  applyFrame(sessionId: string, frame: ClaudeFrame): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return;
    const now = new Date().toISOString();
    const tools = this.toolIndex.get(sessionId) ?? new Map<string, string>();
    const edited = this.editedFiles.get(sessionId) ?? new Set<string>();

    const turnMode = this.runModes.get(sessionId);

    if (frame.type === "assistant") {
      // The CLI names the model on every assistant frame (`message.model`), so
      // the prose row can say which model produced it — a per-turn override or
      // a preset change would otherwise be invisible next to the cost figures.
      const model = stringField(frame.message, "model")?.slice(0, 80);
      for (const block of blocksOf(frame)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          const id = `agent-${session.activeRunId}`;
          const existingIdx = session.events.findIndex((item) => item.id === id);
          const existing = existingIdx >= 0 ? session.events[existingIdx] : undefined;
          if (existing?.kind === "agent") session.events[existingIdx] = { ...existing, text: existing.text + `\n\n${block.text}`, ...(model && !existing.model ? { model } : {}) };
          else session.events.push({ id, messageId: id, timestamp: now, kind: "agent", text: block.text, metricsStatus: "pending", costStatus: "pending", cumulativeCostStatus: "pending", durationStatus: "pending", ...(turnMode ? { mode: turnMode } : {}), ...(model ? { model } : {}) });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          const id = `thought-${randomUUID()}`;
          session.events.push({ id, messageId: id, timestamp: now, kind: "thought", text: block.thinking });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const id = `tool-${randomUUID()}`;
          tools.set(block.id, id);
          const name = typeof block.name === "string" ? block.name : "tool";
          const filePath = FILE_TOOLS.has(name) ? stringField(block.input, "file_path") ?? stringField(block.input, "notebook_path") : undefined;
          const command = name === "Bash" ? stringField(block.input, "command") : undefined;
          if (filePath && MUTATION_TOOLS.has(name)) edited.add(path.relative(session.directory, filePath) || filePath);
          const bashPreview = command ? command.split("\n")[0].trim().slice(0, 120) : undefined;
          session.events.push({
            id, messageId: id, timestamp: now, kind: "tool", status: "running", name, attachments: [],
            ...(filePath ? { detail: path.relative(session.directory, filePath) || filePath } : {}),
            ...(bashPreview && !filePath ? { detail: bashPreview } : {}),
            ...(command ? { commandText: command } : {}),
          });
        }
      }
    } else if (frame.type === "user") {
      for (const block of blocksOf(frame)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const eventId = tools.get(block.tool_use_id);
        const event = eventId ? session.events.find((item) => item.id === eventId) : undefined;
        if (event?.kind === "tool") {
          const isError = block.is_error === true;
          const text = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map((part) => (part as Record<string, unknown>).text).filter((value) => typeof value === "string").join("") : "";
          session.events[session.events.indexOf(event)] = {
            ...event, status: isError ? "error" : "completed",
            ...(text ? isError ? { error: text } : { output: text } : {}),
          };
        }
      }
    } else if (frame.type === "system" && frame.subtype === "permission_denied") {
      const id = `status-${randomUUID()}`;
      const tool = typeof frame.tool_name === "string" ? frame.tool_name : "tool";
      session.events.push({ id, messageId: id, timestamp: now, kind: "status", label: `Permission denied: ${tool}`, detail: typeof frame.message === "string" ? frame.message : undefined });
    } else if (frame.type === "system" && frame.subtype === "version_drift") {
      const id = `status-${randomUUID()}`;
      session.events.push({
        id, messageId: id, timestamp: now, kind: "status", label: "Claude CLI updated",
        detail: `Configured ${String(frame.expected)}, running ${String(frame.received) || "unknown"}. The turn continued because stream-json remained valid.`,
      });
    } else if (frame.type === "error") {
      const id = `error-${randomUUID()}`;
      const message = frame.subtype === "version_mismatch"
        ? `Claude CLI version mismatch: expected ${String(frame.expected)}, received ${String(frame.received) || "unknown"}. Update CLAUDE_CLI_VERSION in your .env file to ${String(frame.received) || "the installed version"}, then restart the server.`
        : "Claude run failed";
      session.events.push({ id, messageId: id, timestamp: now, kind: "error", message });
      this.finish(session, "failed", { failureReason: message });
    } else if (frame.type === "result") {
      session.sawResult = true;
      if (edited.size) {
        const files = [...edited].sort();
        const id = `patch-${randomUUID()}`;
        session.events.push({ id, messageId: id, timestamp: now, kind: "patch", files: files.slice(0, MAX_PATCH_FILES), fileCount: files.length, filesTruncated: files.length > MAX_PATCH_FILES });
      }
      const cost = typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : 0;
      const usage = frame.usage as Record<string, unknown> | undefined;
      const modelUsage = frame.modelUsage as Record<string, Record<string, unknown>> | undefined;
      const modelEntry = modelUsage ? Object.values(modelUsage)[0] : undefined;
      const prev = session.tokenUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, contextWindow: 0, costUsd: 0 };
      session.tokenUsage = {
        inputTokens: prev.inputTokens + (typeof usage?.input_tokens === "number" ? usage.input_tokens : 0),
        outputTokens: prev.outputTokens + (typeof usage?.output_tokens === "number" ? usage.output_tokens : 0),
        cacheReadTokens: prev.cacheReadTokens + (typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0),
        cacheWriteTokens: prev.cacheWriteTokens + (typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0),
        thinkingTokens: prev.thinkingTokens + (typeof (usage?.output_tokens_details as Record<string, unknown>)?.thinking_tokens === "number" ? (usage!.output_tokens_details as Record<string, unknown>).thinking_tokens as number : 0),
        contextWindow: typeof modelEntry?.contextWindow === "number" ? modelEntry.contextWindow : prev.contextWindow,
        costUsd: prev.costUsd + cost,
      };
      const proseIdx = findLastIndex(session.events, (item) => item.kind === "agent" && item.id === `agent-${session.activeRunId}`);
      const prose = proseIdx >= 0 ? session.events[proseIdx] : undefined;
      if (prose?.kind === "agent") {
        const endedAt = Date.now();
        session.events[proseIdx] = {
          ...prose,
          metricsStatus: "final" as const,
          durationStatus: (session.runStartedAt === undefined ? "unavailable" : "final") as "final" | "unavailable",
          ...(session.runStartedAt !== undefined ? { messageDurationMs: Math.max(0, endedAt - session.runStartedAt) } : {}),
          costStatus: (typeof frame.total_cost_usd === "number" ? "final" : "unavailable") as "final" | "unavailable",
          cumulativeCostStatus: (typeof frame.total_cost_usd === "number" ? "final" : "unavailable") as "final" | "unavailable",
          ...(typeof frame.total_cost_usd === "number" ? { messageCost: frame.total_cost_usd, cumulativeCost: session.tokenUsage.costUsd } : {}),
          ...(usage ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
            cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
            reasoningTokens: (() => { const details = usage.output_tokens_details as Record<string, unknown> | undefined; return typeof details?.thinking_tokens === "number" ? details.thinking_tokens : undefined; })(),
          } : {}),
        };
      }
      this.finish(session, frame.is_error === true ? "failed" : "completed", {
        costUsd: cost,
        ...(frame.is_error === true ? { failureReason: "Claude returned an error result" } : {}),
      });
    }

    session.events = session.events.slice(-MAX_EVENTS);
    session.updatedAt = now;
    this.persistSessions();
    this.emit("update", session.id);
  }

  /** Backstop: the process exited. If no result frame settled the run, it failed. */
  handleExit(sessionId: string, details: { code?: number | null; signal?: NodeJS.Signals | null; stderr?: string } = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return;
    if (session.sawResult) return;
    if (details.signal) {
      const message = `Claude process was interrupted (signal ${details.signal})`;
      const id = `status-${randomUUID()}`;
      session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Claude turn interrupted", detail: message });
      session.interrupted = true;
      this.finish(session, "interrupted", { failureReason: message });
      this.emit("update", session.id);
      return;
    }
    const suffix = details.signal
      ? ` (signal ${details.signal})`
      : details.code !== undefined && details.code !== null ? ` (exit code ${details.code})` : "";
    const diagnostic = details.stderr?.trim().replace(/\s+/g, " ").slice(-500);
    const message = `Claude process exited before completing the turn${suffix}${diagnostic ? `: ${diagnostic}` : ""}`;
    const id = `error-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "error", message });
    this.finish(session, "failed", { failureReason: message });
    this.emit("update", session.id);
  }

  cancel(session: ClaudeSession): boolean {
    if (!session.running) return false;
    this.finish(session, "cancelled", { humanIntervention: true });
    const id = `status-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Cancelled by user" });
    this.persistSessions();
    this.emit("update", session.id);
    return true;
  }

  /** Persist every live turn as interrupted before the BFF terminates its child. */
  interruptRunning(reason = "Claude turn interrupted by a server shutdown"): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.running) continue;
      const id = `status-${randomUUID()}`;
      session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Interrupted by a server shutdown" });
      session.interrupted = true;
      this.finish(session, "interrupted", { failureReason: reason });
      this.emit("update", session.id);
      count += 1;
    }
    return count;
  }

  setPrUrl(session: ClaudeSession, url: string): void {
    session.prUrl = url;
    session.updatedAt = new Date().toISOString();
    this.persistSessions();
    this.emit("update", session.id);
  }

  /**
   * Announce a change that lives beside the session rather than in it — a
   * pending approval was asked or answered — so `/claude/events` subscribers
   * refetch. Nothing is persisted: the approval store owns that state.
   */
  nudge(sessionId: string): void {
    if (this.sessions.has(sessionId)) this.emit("update", sessionId);
  }

  /** Append a status row (e.g. merge/discard outcomes, approval decisions) with or without a running turn. */
  note(session: ClaudeSession, label: string, detail?: string): void {
    const id = `status-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label, ...(detail ? { detail } : {}) });
    session.events = session.events.slice(-MAX_EVENTS);
    session.updatedAt = new Date().toISOString();
    this.persistSessions();
    this.emit("update", session.id);
  }

  private finish(session: ClaudeSession, outcome: ClaudeRunRecord["outcome"], options: { costUsd?: number; humanIntervention?: boolean; failureReason?: string } = {}): void {
    const proseIdx = findLastIndex(session.events, (item) => item.kind === "agent" && item.id === `agent-${session.activeRunId}`);
    const prose = proseIdx >= 0 ? session.events[proseIdx] : undefined;
    if (prose?.kind === "agent" && prose.metricsStatus !== "final") {
      session.events[proseIdx] = {
        ...prose,
        metricsStatus: "final" as const,
        durationStatus: (session.runStartedAt === undefined ? "unavailable" : "final") as "final" | "unavailable",
        ...(session.runStartedAt !== undefined ? { messageDurationMs: Math.max(0, Date.now() - session.runStartedAt) } : {}),
        costStatus: "unavailable" as const,
        cumulativeCostStatus: "unavailable" as const,
      };
    }
    session.running = false;
    session.started = true;
    session.runStartedAt = undefined;
    const activeRunId = session.activeRunId;
    session.activeRunId = undefined;
    this.toolIndex.delete(session.id);
    this.editedFiles.delete(session.id);
    this.runModes.delete(session.id);
    const record = [...this.ledger.records].reverse().find((item) => item.id === activeRunId);
    if (record) {
      record.outcome = outcome;
      record.endedAt = Date.now();
      if (options.costUsd) record.costUsd = options.costUsd;
      if (options.humanIntervention) record.interventions += 1;
    }
    this.persist();
    this.persistSessions();
    // Every way a turn can end (result, error, exit, cancel) passes through
    // here, so this is the single hook the notification lane listens on.
    this.emit("finished", { session, outcome, ...(options.failureReason ? { reason: options.failureReason } : {}) });
  }

  private atomicWrite(target: string, payload: string): void {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    }).catch((error) => {
      this.emit("error", error);
    });
  }

  private persist(): void {
    this.atomicWrite(this.ledgerFile, `${JSON.stringify(this.ledger, null, 2)}\n`);
  }

  private persistSessions(): void {
    if (!this.sessionsFile) return;
    const index: SessionIndex = { version: 1, sessions: this.list() };
    this.atomicWrite(this.sessionsFile, `${JSON.stringify(index)}\n`);
  }
}
