import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { correlationId, logAuditEvent } from "../notifications/audit.js";
import { OpencodeError, type OpencodeConfig } from "./client.js";
import type { EventBus, OpencodeEvent } from "./events.js";
import { listPermissions, parsePermissionRequest, replyPermission, type PermissionRequest } from "./permissions.js";
import { requireWorkspaceDirectory } from "../paths.js";

export interface AutoPermissionStatus {
  enabled: boolean;
  error: string | null;
}

export interface AutoPermissionSnapshot {
  enabled: string[];
  source: Record<string, "explicit" | "loaded">;
  lastReloadAt: number;
  stateFileMtimeMs: number | null;
}

/**
 * "explicit" means a request through the authenticated UI (`setEnabled`) set
 * this directory's flag in this process; that instruction always wins over
 * whatever the shared state file says. "loaded" means the flag came from
 * reconciling the file itself and is kept in sync with it — including being
 * turned back off if a later reconcile no longer finds the directory listed.
 */
interface DirectoryState {
  enabled: boolean;
  source: "explicit" | "loaded";
  generation: number;
  queue: Promise<void>;
  failures: Map<string, string>;
  completed: Set<string>;
}

/** How often the background timer re-checks the shared state file. */
const RELOAD_INTERVAL_MS = 5_000;
/** Minimum spacing between on-demand reconciles triggered by live traffic. */
const MIN_RELOAD_INTERVAL_MS = 1_000;

export class AutoPermissionService {
  private readonly states = new Map<string, DirectoryState>();
  /** Serializes state-file writes so a rapid toggle cannot interleave rewrites. */
  private persistQueue = Promise.resolve();
  private loaded: Promise<void> = Promise.resolve();
  /** Serializes reconcile passes so a burst of events triggers one file read, not many. */
  private reloadInFlight: Promise<void> | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastReloadAt = 0;
  /** The state-file mtime this process last observed, whoever wrote it. */
  private lastFileMtimeMs: number | null = null;
  /** The mtime produced by this process's own most recent successful write, so
   * a reconcile pass right after `persist()` doesn't mistake its own write for
   * an external change. */
  private lastWrittenMtimeMs: number | null = null;
  /** Tracks the previous restore outcome so we only log transitions, not
   * steady-state no-ops that flood the audit log (see #470). */
  private lastRestoreOutcome: string | null = null;
  private readonly onEvent = (event: OpencodeEvent) => {
    if (event.type === "permission.asked") void this.handleAsked(event);
    if (event.type === "permission.replied") void this.handleReplied(event);
  };
  private readonly onConnected = () => {
    for (const [directory, state] of this.states) {
      if (state.enabled) void this.reconcile(directory, state.generation);
    }
  };

  /**
   * `stateFile` makes the per-directory enabled flags survive a restart. The
   * flag used to be memory-only, which read as a safety default but had the
   * opposite effect in practice: every deploy silently flipped a directory the
   * user had explicitly set to auto-approve back into ask mode, so the next
   * agent turn fired a permission push per tool call at their phone until they
   * noticed and re-toggled. Persisting an instruction the user already gave
   * through the authenticated UI is not an escalation; forgetting it was noise.
   * Pass no file to stay volatile (unit tests, and any caller that wants the
   * old behaviour).
   */
  constructor(
    private readonly config: OpencodeConfig,
    private readonly bus: EventBus,
    private readonly stateFile: string | null = null,
    // Overridable so tests can reconcile in milliseconds instead of seconds;
    // production wiring always uses the module defaults above.
    private readonly reloadIntervalMs: number = RELOAD_INTERVAL_MS,
    private readonly minReloadIntervalMs: number = MIN_RELOAD_INTERVAL_MS,
  ) {}

  start(): void {
    this.bus.on("event", this.onEvent);
    this.bus.on("connected", this.onConnected);
    if (this.stateFile) {
      this.loaded = this.reconcileFromFile(true);
      // A directory enabled after this process started — by a manual edit, a
      // second process sharing the default state-file path, or any other
      // writer — must not stay silently stale. This is what closed the
      // production bug where one auto-approved directory kept suppressing
      // correctly while a sibling directory, enabled in the same file after
      // boot, kept sending ordinary Web Push permission alerts.
      this.reloadTimer = setInterval(() => void this.reconcileFromFile(true), this.reloadIntervalMs);
      this.reloadTimer.unref();
    }
  }

  stop(): void {
    this.bus.off("event", this.onEvent);
    this.bus.off("connected", this.onConnected);
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  isEnabled(directory: string | undefined): boolean {
    return Boolean(directory && this.states.get(directory)?.enabled);
  }

  async isEnabledCanonical(directory: string | undefined): Promise<boolean> {
    if (!directory) return false;
    // An event can arrive while persisted auto-approval state is restoring,
    // or after the shared state file changed since this process last read
    // it. Reconcile before answering so notification suppression reflects
    // current on-disk truth, not just this process's last snapshot.
    await this.loaded.catch(() => undefined);
    await this.reconcileFromFile().catch(() => undefined);
    try {
      return this.isEnabled(await requireWorkspaceDirectory(directory));
    } catch {
      return false;
    }
  }

  status(directory: string): AutoPermissionStatus {
    const state = this.states.get(directory);
    return {
      enabled: state?.enabled ?? false,
      error: state?.failures.values().next().value ?? null,
    };
  }

  /**
   * A snapshot for diagnosis: which directories are enabled, whether each
   * came from an explicit toggle or from reconciling the file, and when the
   * file was last read. Not wired to an HTTP route yet — intended for direct
   * use (tests, future debug tooling) so a staleness report doesn't require
   * cross-referencing multiple JSON files by hand again.
   */
  snapshot(): AutoPermissionSnapshot {
    const enabled: string[] = [];
    const source: Record<string, "explicit" | "loaded"> = {};
    for (const [directory, state] of this.states) {
      source[directory] = state.source;
      if (state.enabled) enabled.push(directory);
    }
    return {
      enabled: enabled.sort(),
      source,
      lastReloadAt: this.lastReloadAt,
      stateFileMtimeMs: this.lastFileMtimeMs,
    };
  }

  /**
   * Force an immediate, awaitable reconcile pass against the shared state
   * file, bypassing the on-demand throttle. The running server relies on the
   * background interval and the on-demand triggers in `isEnabledCanonical`/
   * `handleAsked` instead; this exists so a test (or a future debug action)
   * can make timer-driven reconciliation deterministic rather than racing a
   * wall-clock interval.
   */
  async reload(): Promise<void> {
    await this.reconcileFromFile(true);
  }

  async setEnabled(directory: string, enabled: boolean): Promise<AutoPermissionStatus> {
    // An explicit toggle must never lose to a concurrent startup load or a
    // concurrent background reconcile of the shared file.
    await this.loaded.catch(() => undefined);
    const state = this.state(directory);
    state.enabled = enabled;
    state.source = "explicit";
    state.generation += 1;
    state.failures.clear();
    await this.persist();
    if (enabled) {
      await this.reconcile(directory, state.generation);
    } else {
      // State flips before queued work drains, so pending event handlers observe
      // the disable and cannot approve after this call resolves.
      await state.queue;
    }
    return this.status(directory);
  }

  /**
   * Reconcile in-memory state against the shared state file, and keep doing
   * so for the life of the process instead of only once at boot.
   *
   * A directory the file lists is promoted (or re-affirmed) as `"loaded"`,
   * unless this process already has it `"explicit"` — an authenticated
   * toggle always wins over the file, including a file the same toggle just
   * rewrote. A directory this process previously loaded as enabled, but that
   * the file no longer lists, is demoted back off. Directories this process
   * itself set `"explicit"` are never touched by either direction: this is
   * what makes it safe for a second process (or a manual edit) to share the
   * same file without one process's toggle being clobbered by the other's
   * boot-time load.
   *
   * `force` bypasses the on-demand throttle (used by the background timer
   * and the initial boot call); the file's mtime is always checked first, so
   * an unforced call still costs only a `stat` when nothing changed.
   */
  private async reconcileFromFile(force = false): Promise<void> {
    if (!this.stateFile) return;
    const now = Date.now();
    if (!force && now - this.lastReloadAt < this.minReloadIntervalMs) return;
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = this.doReconcileFromFile(now).finally(() => {
      this.reloadInFlight = null;
    });
    return this.reloadInFlight;
  }

  private async doReconcileFromFile(now: number): Promise<void> {
    this.lastReloadAt = now;
    const file = this.stateFile;
    if (!file) return;

    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      // A missing file is the first run (or the file was removed); leave any
      // already-loaded state alone rather than guessing at intent.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastFileMtimeMs = null;
        // Only log the transition to file_not_found, not every 5s poll that
        // finds the same steady state (#470).
        if (this.lastRestoreOutcome !== "file_not_found") {
          logAuditEvent("auto_approval_restore_completed", {
            restoredCount: 0,
            outcome: "file_not_found",
          });
        }
        this.lastRestoreOutcome = "file_not_found";
        return;
      }
      console.warn("[auto-permission]", `Could not stat state file: ${this.message(error)}`);
      // Errors are always noteworthy — log unconditionally.
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: 0,
        outcome: "stat_error",
      });
      this.lastRestoreOutcome = "stat_error";
      return;
    }
    if (this.lastFileMtimeMs !== null && fileStat.mtimeMs === this.lastFileMtimeMs) return;
    const previousMtime = this.lastFileMtimeMs;
    this.lastFileMtimeMs = fileStat.mtimeMs;

    let enabled: string[];
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      const candidate = (parsed as { enabled?: unknown })?.enabled;
      enabled = Array.isArray(candidate)
        ? candidate.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
    } catch (error) {
      // Fails closed to whatever was already loaded rather than guessing at a
      // corrupt instruction list; the next content change is still picked up
      // once the mtime moves again.
      console.warn("[auto-permission]", `Could not restore state: ${this.message(error)}`);
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: 0,
        outcome: "parse_error",
      });
      this.lastRestoreOutcome = "parse_error";
      return;
    }

    if (previousMtime !== null && fileStat.mtimeMs !== this.lastWrittenMtimeMs) {
      console.warn("[auto-permission]", "state file changed outside this process; reconciling");
    }

    const enabledSet = new Set(enabled);

    for (const directory of enabled) {
      const existing = this.states.get(directory);
      if (existing?.source === "explicit") continue;
      if (existing?.enabled) continue;
      const state = this.state(directory);
      state.enabled = true;
      state.source = "loaded";
      state.generation += 1;
      void this.reconcile(directory, state.generation);
    }

    for (const [directory, state] of this.states) {
      if (state.source === "explicit") continue;
      if (state.enabled && !enabledSet.has(directory)) {
        state.enabled = false;
        state.generation += 1;
      }
    }

    // Only log when directories were actually restored, or when transitioning
    // from an error state. A success with restoredCount 0 and no state change
    // is the steady-state no-op that flooded the log (#470).
    if (enabled.length > 0 || this.lastRestoreOutcome !== "success") {
      logAuditEvent("auto_approval_restore_completed", {
        restoredCount: enabled.length,
        outcome: "success",
      });
    }
    this.lastRestoreOutcome = "success";
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const file = this.stateFile;
    const enabled = [...this.states.entries()]
      .filter(([, state]) => state.enabled)
      .map(([directory]) => directory)
      .sort();
    this.persistQueue = this.persistQueue
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp-${process.pid}`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, file);
        try {
          // Recording our own write's mtime lets the next reconcile pass tell
          // "I just wrote this" apart from "someone else changed this since",
          // so the external-writer warning only fires for an actual other
          // writer, not this process's own persisted toggle.
          const written = await stat(file);
          this.lastWrittenMtimeMs = written.mtimeMs;
          this.lastFileMtimeMs = written.mtimeMs;
        } catch {
          // If the immediate re-stat fails, the next reconcile pass simply
          // re-reads the file; the write itself already succeeded above.
        }
      })
      .catch((error: unknown) => {
        console.warn("[auto-permission]", `Could not persist state: ${this.message(error)}`);
      });
    return this.persistQueue;
  }

  private state(directory: string): DirectoryState {
    let state = this.states.get(directory);
    if (!state) {
      state = {
        enabled: false,
        source: "loaded",
        generation: 0,
        queue: Promise.resolve(),
        failures: new Map(),
        completed: new Set(),
      };
      this.states.set(directory, state);
    }
    return state;
  }

  private enqueue(directory: string, task: (state: DirectoryState) => Promise<void>): Promise<void> {
    const state = this.state(directory);
    const run = state.queue.then(() => task(state));
    state.queue = run.catch((error: unknown) => {
      console.warn("[auto-permission]", error instanceof Error ? error.message : String(error));
    });
    return state.queue;
  }

  private async handleAsked(event: OpencodeEvent): Promise<void> {
    if (!event.directory) return;
    let directory: string;
    try {
      directory = await requireWorkspaceDirectory(event.directory);
    } catch {
      return;
    }
    // Same staleness concern as `isEnabledCanonical`: the directory may have
    // been enabled in the shared file after this process last reconciled it.
    await this.reconcileFromFile().catch(() => undefined);
    const pending = parsePermissionRequest(event.properties);
    const state = this.states.get(directory);
    const sessionID = typeof event.properties.sessionID === "string" ? event.properties.sessionID : undefined;

    logAuditEvent("permission_asked_observed", {
      directoryCorrelation: correlationId(directory),
      sessionCorrelation: correlationId(sessionID),
      requestCorrelation: correlationId(pending?.id),
      autoApprovalEnabled: state?.enabled ?? false,
    });

    if (!pending || !state?.enabled) return;
    const generation = state.generation;
    await this.enqueue(directory, async (current) => {
      if (!current.enabled || current.generation !== generation) return;
      if (current.completed.has(pending.id)) {
        logAuditEvent("auto_approval_reply", {
          directoryCorrelation: correlationId(directory),
          requestCorrelation: correlationId(pending.id),
          outcome: "already_handled",
        });
        return;
      }
      await this.approve(directory, current, pending);
    });
  }

  private async handleReplied(event: OpencodeEvent): Promise<void> {
    const requestID = event.properties.requestID;
    if (!event.directory || typeof requestID !== "string") return;
    let directory: string;
    try {
      directory = await requireWorkspaceDirectory(event.directory);
    } catch {
      return;
    }
    const state = this.states.get(directory);
    if (!state) return;
    await this.enqueue(directory, async (current) => {
      current.failures.delete(requestID);
      current.completed.delete(requestID);
    });
  }

  private reconcile(directory: string, generation: number): Promise<void> {
    return this.enqueue(directory, async (state) => {
      if (!state.enabled || state.generation !== generation) return;
      let pending: PermissionRequest[];
      try {
        pending = await listPermissions(this.config, directory);
        state.failures.delete("reconcile");
      } catch (error) {
        state.failures.set("reconcile", `Could not list pending permissions: ${this.message(error)}`);
        return;
      }
      const pendingIDs = new Set(pending.map((permission) => permission.id));
      for (const requestID of state.failures.keys()) {
        if (requestID !== "reconcile" && !pendingIDs.has(requestID)) state.failures.delete(requestID);
      }
      for (const requestID of state.completed) {
        if (!pendingIDs.has(requestID)) state.completed.delete(requestID);
      }
      for (const permission of pending) {
        if (!state.enabled || state.generation !== generation) return;
        if (!state.completed.has(permission.id)) await this.approve(directory, state, permission);
      }
    });
  }

  private async approve(directory: string, state: DirectoryState, pending: PermissionRequest): Promise<void> {
    try {
      await replyPermission(this.config, directory, pending.id, "once");
      state.failures.delete(pending.id);
      this.complete(state, pending.id);
      logAuditEvent("auto_approval_reply", {
        directoryCorrelation: correlationId(directory),
        requestCorrelation: correlationId(pending.id),
        outcome: "approved",
      });
    } catch (error) {
      if (error instanceof OpencodeError && error.status === 404) {
        state.failures.delete(pending.id);
        this.complete(state, pending.id);
        logAuditEvent("auto_approval_reply", {
          directoryCorrelation: correlationId(directory),
          requestCorrelation: correlationId(pending.id),
          outcome: "not_found",
        });
        return;
      }
      state.failures.set(pending.id, `Could not auto-approve ${pending.permission}: ${this.message(error)}`);
      logAuditEvent("auto_approval_reply", {
        directoryCorrelation: correlationId(directory),
        requestCorrelation: correlationId(pending.id),
        outcome: "error",
      });
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private complete(state: DirectoryState, requestID: string): void {
    state.completed.add(requestID);
    if (state.completed.size > 500) {
      const oldest = state.completed.values().next().value;
      if (oldest) state.completed.delete(oldest);
    }
  }
}
