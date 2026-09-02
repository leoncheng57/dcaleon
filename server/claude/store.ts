import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { ClaudePresetMode } from "./config.js";
import type { ClaudeFrame } from "./supervisor.js";
import type { ClaudeWorktree } from "./worktree.js";

// Structurally assignable to the client's frozen TranscriptEvent contract.
// Richer than the DSH store: thought, tool (with what it touched), and patch arms.
export type ClaudeTranscriptEvent =
  | { id: string; messageId: string; timestamp: string; kind: "user"; text: string; reminders: []; workflows: []; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "agent"; text: string }
  | { id: string; messageId: string; timestamp: string; kind: "thought"; text: string }
  | { id: string; messageId: string; timestamp: string; kind: "tool"; status: "pending" | "running" | "completed" | "error"; name: string; detail?: string; commandText?: string; output?: string; error?: string; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "patch"; files: string[]; fileCount: number; filesTruncated: boolean }
  | { id: string; messageId: string; timestamp: string; kind: "status"; label: string; detail?: string }
  | { id: string; messageId: string; timestamp: string; kind: "error"; message: string };

export type ClaudeIsolation = "direct" | "worktree";

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
  outcome: "running" | "completed" | "cancelled" | "failed";
  costUsd: number;
  interventions: number;
}

interface Ledger { version: 1; records: ClaudeRunRecord[] }
interface SessionIndex { version: 1; sessions: ClaudeSession[] }

const MAX_EVENTS = 1_000;
const MAX_PATCH_FILES = 50;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MUTATION_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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
  private readonly toolIndex = new Map<string, Map<string, string>>();
  private readonly editedFiles = new Map<string, Set<string>>();
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
        for (const session of parsed.sessions) {
          // A session that was mid-turn when the BFF stopped has no process any
          // more. Say so rather than showing a spinner forever (decision 5's spirit).
          if (session.running) {
            session.running = false;
            session.started = true;
            session.activeRunId = undefined;
            session.runStartedAt = undefined;
            const id = `status-${randomUUID()}`;
            session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Interrupted by a server restart" });
          }
          this.sessions.set(session.id, session);
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
      title: input.title?.trim().slice(0, 120) || "New Claude conversation",
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

  remove(id: string): boolean {
    const removed = this.sessions.delete(id);
    if (removed) {
      this.toolIndex.delete(id);
      this.editedFiles.delete(id);
      this.persistSessions();
      this.emit("update", id);
    }
    return removed;
  }

  /** Test/shutdown seam: wait until the atomic writes have settled. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  startRun(session: ClaudeSession, text: string): ClaudeRunRecord {
    const now = Date.now();
    const messageId = `user-${randomUUID()}`;
    session.running = true;
    session.sawResult = false;
    session.runStartedAt = now;
    session.updatedAt = new Date(now).toISOString();
    session.events.push({
      id: messageId, messageId, timestamp: session.updatedAt, kind: "user", text,
      reminders: [], workflows: [], attachments: [],
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

    if (frame.type === "assistant") {
      for (const block of blocksOf(frame)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          const id = `agent-${randomUUID()}`;
          session.events.push({ id, messageId: id, timestamp: now, kind: "agent", text: block.text });
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
          session.events.push({
            id, messageId: id, timestamp: now, kind: "tool", status: "running", name, attachments: [],
            ...(filePath ? { detail: path.relative(session.directory, filePath) || filePath } : {}),
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
          event.status = isError ? "error" : "completed";
          const text = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map((part) => (part as Record<string, unknown>).text).filter((value) => typeof value === "string").join("") : "";
          if (text) { if (isError) event.error = text; else event.output = text; }
        }
      }
    } else if (frame.type === "system" && frame.subtype === "permission_denied") {
      const id = `status-${randomUUID()}`;
      const tool = typeof frame.tool_name === "string" ? frame.tool_name : "tool";
      session.events.push({ id, messageId: id, timestamp: now, kind: "status", label: `Permission denied: ${tool}`, detail: typeof frame.message === "string" ? frame.message : undefined });
    } else if (frame.type === "error") {
      const id = `error-${randomUUID()}`;
      const message = frame.subtype === "version_mismatch"
        ? `Claude CLI version mismatch: expected ${String(frame.expected)}, received ${String(frame.received) || "unknown"}`
        : "Claude run failed";
      session.events.push({ id, messageId: id, timestamp: now, kind: "error", message });
      this.finish(session, "failed");
    } else if (frame.type === "result") {
      session.sawResult = true;
      // One patch row per turn naming what the agent edited, so the transcript
      // shows the footprint without opening the Changes drawer.
      if (edited.size) {
        const files = [...edited].sort();
        const id = `patch-${randomUUID()}`;
        session.events.push({ id, messageId: id, timestamp: now, kind: "patch", files: files.slice(0, MAX_PATCH_FILES), fileCount: files.length, filesTruncated: files.length > MAX_PATCH_FILES });
      }
      const cost = typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : 0;
      this.finish(session, frame.is_error === true ? "failed" : "completed", { costUsd: cost });
    }

    session.events = session.events.slice(-MAX_EVENTS);
    session.updatedAt = now;
    this.persistSessions();
    this.emit("update", session.id);
  }

  /** Backstop: the process exited. If no result frame settled the run, it failed. */
  handleExit(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return;
    if (session.sawResult) return;
    const id = `error-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "error", message: "Claude process exited before completing the turn" });
    this.finish(session, "failed");
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

  setPrUrl(session: ClaudeSession, url: string): void {
    session.prUrl = url;
    session.updatedAt = new Date().toISOString();
    this.persistSessions();
    this.emit("update", session.id);
  }

  /** Append a status row (e.g. merge/discard outcomes) outside a running turn. */
  note(session: ClaudeSession, label: string, detail?: string): void {
    const id = `status-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label, ...(detail ? { detail } : {}) });
    session.events = session.events.slice(-MAX_EVENTS);
    session.updatedAt = new Date().toISOString();
    this.persistSessions();
    this.emit("update", session.id);
  }

  private finish(session: ClaudeSession, outcome: ClaudeRunRecord["outcome"], options: { costUsd?: number; humanIntervention?: boolean } = {}): void {
    session.running = false;
    session.started = true;
    session.runStartedAt = undefined;
    const activeRunId = session.activeRunId;
    session.activeRunId = undefined;
    this.toolIndex.delete(session.id);
    this.editedFiles.delete(session.id);
    const record = [...this.ledger.records].reverse().find((item) => item.id === activeRunId);
    if (record) {
      record.outcome = outcome;
      record.endedAt = Date.now();
      if (options.costUsd) record.costUsd = options.costUsd;
      if (options.humanIntervention) record.interventions += 1;
    }
    this.persist();
    this.persistSessions();
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
