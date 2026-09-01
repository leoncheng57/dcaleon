import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { ClaudePresetMode } from "./config.js";
import type { ClaudeFrame } from "./supervisor.js";

// Structurally assignable to the client's frozen TranscriptEvent contract.
// Richer than the DSH store: it emits thought and tool arms, not just user/agent.
export type ClaudeTranscriptEvent =
  | { id: string; messageId: string; timestamp: string; kind: "user"; text: string; reminders: []; workflows: []; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "agent"; text: string }
  | { id: string; messageId: string; timestamp: string; kind: "thought"; text: string }
  | { id: string; messageId: string; timestamp: string; kind: "tool"; status: "pending" | "running" | "completed" | "error"; name: string; detail?: string; output?: string; error?: string; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "status"; label: string; detail?: string }
  | { id: string; messageId: string; timestamp: string; kind: "error"; message: string };

export interface ClaudeSession {
  id: string;
  sessionUuid: string;
  title: string;
  presetId: string;
  workspaceId: string;
  mode: ClaudePresetMode;
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

function blocksOf(frame: ClaudeFrame): Array<Record<string, unknown>> {
  const message = frame.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

export class ClaudeSessionStore extends EventEmitter {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly toolIndex = new Map<string, Map<string, string>>();
  private ledger: Ledger = { version: 1, records: [] };
  private loaded = false;
  private writeChain = Promise.resolve();

  constructor(private readonly ledgerFile: string) {
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
  }

  create(input: { presetId: string; workspaceId: string; mode: ClaudePresetMode; title?: string }): ClaudeSession {
    const now = new Date().toISOString();
    const session: ClaudeSession = {
      id: `claude-${randomUUID()}`,
      sessionUuid: randomUUID(),
      title: input.title?.trim().slice(0, 120) || "New Claude conversation",
      presetId: input.presetId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      createdAt: now,
      updatedAt: now,
      running: false,
      started: false,
      events: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  list(): ClaudeSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  /** Test/shutdown seam: wait until the atomic metrics write has settled. */
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
    const record: ClaudeRunRecord = {
      id: randomUUID(), sessionId: session.id, presetId: session.presetId, workspaceId: session.workspaceId, mode: session.mode,
      taskClass: "conversation", startedAt: now, outcome: "running", costUsd: 0, interventions: 0,
    };
    session.activeRunId = record.id;
    this.ledger.records.push(record);
    this.ledger.records = this.ledger.records.slice(-1_000);
    this.persist();
    this.emit("update", session.id);
    return record;
  }

  applyFrame(sessionId: string, frame: ClaudeFrame): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.running) return;
    const now = new Date().toISOString();
    const tools = this.toolIndex.get(sessionId) ?? new Map<string, string>();

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
          session.events.push({ id, messageId: id, timestamp: now, kind: "tool", status: "running", name, attachments: [] });
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
      const cost = typeof frame.total_cost_usd === "number" ? frame.total_cost_usd : 0;
      this.finish(session, frame.is_error === true ? "failed" : "completed", { costUsd: cost });
    }

    session.events = session.events.slice(-1_000);
    session.updatedAt = now;
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
    this.emit("update", session.id);
    return true;
  }

  private finish(session: ClaudeSession, outcome: ClaudeRunRecord["outcome"], options: { costUsd?: number; humanIntervention?: boolean } = {}): void {
    session.running = false;
    session.started = true;
    session.runStartedAt = undefined;
    const activeRunId = session.activeRunId;
    session.activeRunId = undefined;
    this.toolIndex.delete(session.id);
    const record = [...this.ledger.records].reverse().find((item) => item.id === activeRunId);
    if (record) {
      record.outcome = outcome;
      record.endedAt = Date.now();
      if (options.costUsd) record.costUsd = options.costUsd;
      if (options.humanIntervention) record.interventions += 1;
    }
    this.persist();
  }

  private persist(): void {
    const payload = `${JSON.stringify(this.ledger, null, 2)}\n`;
    const target = this.ledgerFile;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    }).catch((error) => {
      this.emit("error", error);
    });
  }
}
