import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { BridgeNotification } from "./bridge.js";
import type { DshPresetMode } from "./config.js";

export type DshTranscriptEvent =
  | { id: string; messageId: string; timestamp: string; kind: "user"; text: string; reminders: []; workflows: []; attachments: [] }
  | { id: string; messageId: string; timestamp: string; kind: "agent"; text: string; /** The preset's model at the time the turn was sent; DSH frames do not name it themselves. */ model?: string; metricsStatus: "pending" | "final"; costStatus: "pending" | "unavailable"; cumulativeCostStatus: "pending" | "unavailable"; durationStatus: "pending" | "final" | "unavailable"; messageDurationMs?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { id: string; messageId: string; timestamp: string; kind: "status"; label: string; detail?: string }
  | { id: string; messageId: string; timestamp: string; kind: "error"; message: string };

export interface DshSession {
  id: string;
  title: string;
  presetId: string;
  presetFingerprint: string;
  workspaceId: string;
  mode: DshPresetMode;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  events: DshTranscriptEvent[];
  runStartedAt?: number;
  /** Model the active turn was sent on (from the preset); stamped onto its agent rows. */
  runModel?: string;
  activeRunId?: string;
  lastAssistantRunId?: string;
}

export interface ExperimentRecord {
  id: string;
  sessionId: string;
  presetId: string;
  presetFingerprint: string;
  workspaceId: string;
  mode: DshPresetMode;
  taskClass: "conversation";
  startedAt: number;
  endedAt?: number;
  outcome: "running" | "completed" | "cancelled" | "failed";
  interventions: number;
  testResult: "not-recorded";
}

interface Ledger { version: 1; records: ExperimentRecord[] }
interface SessionIndex { version: 1; sessions: DshSession[] }

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).join("");
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  for (const key of ["text", "delta", "chunk", "content", "message"]) {
    const text = textFrom(item[key]);
    if (text) return text;
  }
  return "";
}

function usageFrom(value: unknown): Pick<Extract<DshTranscriptEvent, { kind: "agent" }>, "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens"> {
  const usage = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const number = (key: string) => typeof usage[key] === "number" ? usage[key] as number : undefined;
  return {
    inputTokens: number("inputTokens"), outputTokens: number("outputTokens"), reasoningTokens: number("reasoningTokens"),
    cacheReadTokens: number("cacheReadTokens"), cacheWriteTokens: number("cacheWriteTokens"),
  };
}

function currentTurnAgent(session: DshSession): Extract<DshTranscriptEvent, { kind: "agent" }> | undefined {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]!;
    if (event.kind === "user") return undefined;
    if (event.kind === "agent") return event;
  }
  return undefined;
}

export class DshSessionStore extends EventEmitter {
  private readonly sessions = new Map<string, DshSession>();
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
          if (session.running) {
            const prose = [...session.events].reverse().find((item) => item.kind === "agent" && item.metricsStatus === "pending");
            if (prose?.kind === "agent") {
              prose.metricsStatus = "final";
              prose.costStatus = "unavailable";
              prose.cumulativeCostStatus = "unavailable";
              prose.durationStatus = "unavailable";
            }
            session.running = false;
            session.runStartedAt = undefined;
            session.activeRunId = undefined;
            session.lastAssistantRunId = undefined;
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

  create(input: { presetId: string; presetFingerprint: string; workspaceId: string; mode: DshPresetMode; title?: string }): DshSession {
    const now = new Date().toISOString();
    const session: DshSession = {
      id: `dsh-${randomUUID()}`,
      title: input.title?.trim().slice(0, 120) || "New DSH conversation",
      presetId: input.presetId,
      presetFingerprint: input.presetFingerprint,
      workspaceId: input.workspaceId,
      mode: input.mode,
      createdAt: now,
      updatedAt: now,
      running: false,
      events: [],
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  list(): DshSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): DshSession | undefined {
    return this.sessions.get(id);
  }

  /** Test/shutdown seam: wait until the atomic metrics write has settled. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  startRun(session: DshSession, text: string, options: { model?: string } = {}): ExperimentRecord {
    const now = Date.now();
    const messageId = `user-${randomUUID()}`;
    session.running = true;
    session.runStartedAt = now;
    session.runModel = options.model;
    session.updatedAt = new Date(now).toISOString();
    session.events.push({
      id: messageId, messageId, timestamp: session.updatedAt, kind: "user", text,
      reminders: [], workflows: [], attachments: [],
    });
    const record: ExperimentRecord = {
      id: randomUUID(), sessionId: session.id, presetId: session.presetId, presetFingerprint: session.presetFingerprint, workspaceId: session.workspaceId, mode: session.mode,
      taskClass: "conversation", startedAt: now, outcome: "running", interventions: 0, testResult: "not-recorded",
    };
    session.activeRunId = record.id;
    this.ledger.records.push(record);
    this.ledger.records = this.ledger.records.slice(-1_000);
    this.persist();
    this.persistSessions();
    this.emit("update", session.id);
    return record;
  }

  applyBridge(event: BridgeNotification): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    if (!session.running) return;
    const now = new Date().toISOString();
    const raw = event.notification?.payload as Record<string, unknown> | undefined;
    const rawEvent = raw?.event as Record<string, unknown> | undefined;
    const rawType = typeof rawEvent?.type === "string" ? rawEvent.type : String(event.notification?.method || "event");
    if (event.type === "notification") {
      if (rawType === "assistant/chunk") {
        const text = textFrom(rawEvent?.data);
        if (text) {
          const id = `agent-live-${session.activeRunId}`;
          const existing = session.events.find((item) => item.id === id && item.kind === "agent");
          if (existing?.kind === "agent") existing.text += text;
          else session.events.push({ id, messageId: id, timestamp: now, kind: "agent", text, ...(session.runModel ? { model: session.runModel } : {}), metricsStatus: "pending", costStatus: "pending", cumulativeCostStatus: "pending", durationStatus: "pending" });
        }
      } else if (rawType === "assistant/message") {
        const text = textFrom(rawEvent?.data);
        if (text) {
          session.events = session.events.filter((item) => item.id !== `agent-live-${session.activeRunId}`);
          const id = `agent-${randomUUID()}`;
          session.events.push({ id, messageId: id, timestamp: now, kind: "agent", text, ...(session.runModel ? { model: session.runModel } : {}), metricsStatus: "pending", costStatus: "pending", cumulativeCostStatus: "pending", durationStatus: "pending", ...usageFrom(rawEvent?.data && typeof rawEvent.data === "object" ? (rawEvent.data as Record<string, unknown>).usage : undefined) });
          session.lastAssistantRunId = session.activeRunId;
        }
      } else if (/tool|compaction|subagent/i.test(rawType)) {
        const id = `status-${randomUUID()}`;
        session.events.push({ id, messageId: id, timestamp: now, kind: "status", label: rawType });
      }
    } else if (event.type === "finished") {
      const hasAssistant = session.lastAssistantRunId === session.activeRunId ||
        session.events.some((item) => item.id === `agent-live-${session.activeRunId}`);
      if (!hasAssistant && event.finalResponse) {
        const id = `agent-${randomUUID()}`;
        session.events.push({ id, messageId: id, timestamp: now, kind: "agent", text: event.finalResponse, ...(session.runModel ? { model: session.runModel } : {}), metricsStatus: "pending", costStatus: "pending", cumulativeCostStatus: "pending", durationStatus: "pending" });
      }
      const outcome = event.finishReason === "completed" ? "completed" : event.finishReason === "aborted" ? "cancelled" : "failed";
      this.finish(session, outcome);
    } else {
      const id = `error-${randomUUID()}`;
      session.events.push({ id, messageId: id, timestamp: now, kind: "error", message: event.error || "DSH run failed" });
      this.finish(session, "failed");
    }
    session.events = session.events.slice(-1_000);
    session.updatedAt = now;
    this.persistSessions();
    this.emit("update", session.id);
  }

  cancel(session: DshSession): boolean {
    if (!session.running) return false;
    this.finish(session, "cancelled", true);
    const id = `status-${randomUUID()}`;
    session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "status", label: "Cancelled by user" });
    this.persistSessions();
    this.emit("update", session.id);
    return true;
  }

  failRunning(presetId: string, workspaceId: string): void {
    for (const session of this.sessions.values()) {
      if (!session.running || session.presetId !== presetId || session.workspaceId !== workspaceId) continue;
      const id = `error-${randomUUID()}`;
      session.events.push({ id, messageId: id, timestamp: new Date().toISOString(), kind: "error", message: "DSH bridge stopped during the run" });
      this.finish(session, "failed");
      this.persistSessions();
      this.emit("update", session.id);
    }
  }

  private finish(session: DshSession, outcome: ExperimentRecord["outcome"], humanIntervention = false): void {
    const prose = currentTurnAgent(session);
    if (prose) {
      prose.metricsStatus = "final";
      prose.costStatus = "unavailable";
      prose.cumulativeCostStatus = "unavailable";
      prose.durationStatus = session.runStartedAt === undefined ? "unavailable" : "final";
      if (session.runStartedAt !== undefined) prose.messageDurationMs = Math.max(0, Date.now() - session.runStartedAt);
    }
    session.running = false;
    session.runStartedAt = undefined;
    session.activeRunId = undefined;
    session.lastAssistantRunId = undefined;
    const record = [...this.ledger.records].reverse().find((item) => item.sessionId === session.id && item.outcome === "running");
    if (record) {
      record.outcome = outcome;
      record.endedAt = Date.now();
      if (humanIntervention) record.interventions += 1;
    }
    this.persist();
    this.persistSessions();
    // `update` is also emitted for streamed output, so consumers outside the
    // experiment UI need a separate terminal signal.
    this.emit("finished", { session, outcome });
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

  private persistSessions(): void {
    if (!this.sessionsFile) return;
    const payload = `${JSON.stringify({ version: 1, sessions: [...this.sessions.values()] } satisfies SessionIndex, null, 2)}\n`;
    const target = this.sessionsFile;
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
