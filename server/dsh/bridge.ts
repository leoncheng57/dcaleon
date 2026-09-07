import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { registerResourceProcess } from "../resource-processes.js";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { DshConfig, DshPreset, DshWorkspace } from "./config.js";

export interface BridgeNotification {
  type: "notification" | "finished" | "failed";
  sessionId: string;
  notification?: { method?: unknown; payload?: unknown };
  finalResponse?: string;
  finishReason?: string | null;
  error?: string;
  bridgePresetId?: string;
  bridgeWorkspaceId?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SAFE_ENV = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL",
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
] as const;
export const DSH_BRIDGE_MAX_LINE_BYTES = 1024 * 1024;

export function dshBridgeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV) if (source[key]) environment[key] = source[key];
  return environment;
}

function seatbeltLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function dshSeatbeltProfile(input: {
  workspace: string;
  stateRoot: string;
  python: string;
  bridgeScript: string;
  cordis: string;
  mode: DshPreset["mode"];
}): string {
  const pythonRoot = path.dirname(path.dirname(input.python));
  // A virtualenv's bin/python is normally a symlink to the system/Homebrew
  // interpreter. Reading only the venv lets imports resolve but macOS dyld
  // cannot open the real Python framework, so the bridge exits before startup.
  // The canonical runtime is read-only; it is never added to `writes` below.
  const pythonRuntimeRoot = path.dirname(path.dirname(realpathSync(input.python)));
  const reads = [
    input.workspace, input.stateRoot, pythonRoot, pythonRuntimeRoot, input.bridgeScript, input.cordis,
    "/System", "/usr", "/bin", "/sbin", "/Library", "/private/etc", "/dev",
  ].map((item) => `(subpath "${seatbeltLiteral(item)}")`).join(" ");
  const writes = [
    input.stateRoot,
    ...(input.mode === "build" ? [input.workspace] : []),
  ].map((item) => `(subpath "${seatbeltLiteral(item)}")`).join(" ");
  return `(version 1)\n(deny default)\n(import "system.sb")\n(allow process*)\n(allow network*)\n(allow file-read-metadata)\n(allow file-read* ${reads})\n(allow file-write* ${writes})`;
}

export class DshBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private ready: Promise<void> | null = null;
  private stdoutFrame = Buffer.alloc(0);

  constructor(
    private readonly config: DshConfig,
    readonly preset: DshPreset,
    readonly workspace: DshWorkspace,
  ) {
    super();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let ready = false;
      const env = dshBridgeEnvironment();
      const stateHome = path.join(this.config.sessionRoot, "home");
      const stateTmp = path.join(this.config.sessionRoot, "tmp");
      mkdirSync(stateHome, { recursive: true, mode: 0o700 });
      mkdirSync(stateTmp, { recursive: true, mode: 0o700 });
      const fingerprint = createHash("sha256").update(readFileSync(this.preset.cordis)).digest("hex");
      if (fingerprint !== this.preset.fingerprint) {
        reject(new Error("DSH composition changed after startup"));
        return;
      }
      const workspaceMetadata = statSync(this.workspace.directory);
      if (workspaceMetadata.dev !== this.workspace.device || workspaceMetadata.ino !== this.workspace.inode) {
        reject(new Error("DSH workspace identity changed after startup"));
        return;
      }
      Object.assign(env, {
        HOME: stateHome,
        TMPDIR: stateTmp,
        PYTHONDONTWRITEBYTECODE: "1",
        DSH_BRIDGE_PROVIDER: this.preset.provider,
        DSH_BRIDGE_MODEL: this.preset.model,
        DSH_BRIDGE_CORDIS: this.preset.cordis,
        DSH_BRIDGE_WORKSPACE: this.workspace.directory,
        DSH_BRIDGE_SESSION_ROOT: this.config.sessionRoot,
        DSH_BRIDGE_SDK_VERSION: this.config.sdkVersion,
        ...(this.preset.maxTokens ? { DSH_BRIDGE_MAX_TOKENS: String(this.preset.maxTokens) } : {}),
      });
      let command = this.config.python;
      let args = [this.config.bridgeScript];
      if (this.config.sandbox === "seatbelt") {
        const profile = dshSeatbeltProfile({
          workspace: this.workspace.directory,
          stateRoot: path.dirname(this.config.sessionRoot),
          python: this.config.python,
          bridgeScript: this.config.bridgeScript,
          cordis: this.preset.cordis,
          mode: this.preset.mode,
        });
        command = "/usr/bin/sandbox-exec";
        args = ["-p", profile, this.config.python, this.config.bridgeScript];
      }
      const child = spawn(command, args, {
        cwd: this.workspace.directory,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      registerResourceProcess(child, "DSH");
      const readyTimer = setTimeout(() => {
        if (ready) return;
        reject(new Error("DSH bridge did not become ready within 10 seconds"));
        child.kill("SIGTERM");
      }, 10_000);
      const resolveReady = () => {
        if (ready) return;
        ready = true;
        clearTimeout(readyTimer);
        resolve();
      };
      child.stdout.on("data", (chunk: Buffer) => this.receiveChunk(chunk, resolveReady));
      child.stderr.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString("utf8").slice(0, 2_000)));
      child.once("error", (error) => {
        clearTimeout(readyTimer);
        reject(error);
        this.failAll(error);
      });
      child.once("exit", (code) => {
        const error = new Error(`DSH bridge exited${code === null ? "" : ` with code ${code}`}`);
        clearTimeout(readyTimer);
        if (!ready) reject(error);
        this.failAll(error);
        this.child = null;
        this.ready = null;
        this.emit("exit", error);
      });
    });
    return this.ready;
  }

  private receiveChunk(chunk: Buffer, ready: () => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.stdoutFrame.length + segment.length > DSH_BRIDGE_MAX_LINE_BYTES) {
        this.stdoutFrame = Buffer.alloc(0);
        this.emit("diagnostic", "DSH bridge frame exceeded the 1 MiB limit");
        this.child?.kill("SIGTERM");
        return;
      }
      if (segment.length) this.stdoutFrame = Buffer.concat([this.stdoutFrame, segment]);
      if (newline === -1) return;
      const frame = this.stdoutFrame.at(-1) === 0x0d ? this.stdoutFrame.subarray(0, -1) : this.stdoutFrame;
      this.stdoutFrame = Buffer.alloc(0);
      this.receive(frame.toString("utf8"), ready);
      offset = newline + 1;
    }
  }

  private receive(line: string, ready: () => void): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("diagnostic", "DSH bridge emitted malformed JSON");
      return;
    }
    if (message.type === "ready") {
      if (message.protocol !== 1 || message.sdkVersion !== this.config.sdkVersion) {
        this.emit("diagnostic", "DSH bridge protocol or SDK version mismatch");
        return;
      }
      ready();
      return;
    }
    if (message.type === "notification" || message.type === "finished" || message.type === "failed") {
      this.emit("notification", message as unknown as BridgeNotification);
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.ok === false) pending.reject(new Error(String(message.error || "DSH bridge request failed")));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method: "ping" | "prompt" | "cancel", params: Record<string, unknown> = {}): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error("DSH bridge is unavailable");
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH bridge ${method} timed out`));
        this.child?.kill("SIGTERM");
      }, method === "prompt" ? 60_000 : 10_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  close(): void {
    this.child?.kill("SIGTERM");
  }
}

export class DshBridgePool extends EventEmitter {
  private readonly bridges = new Map<string, DshBridge>();

  constructor(private readonly config: DshConfig) {
    super();
  }

  get(preset: DshPreset, workspace: DshWorkspace): DshBridge {
    const key = `${preset.id}\0${workspace.id}`;
    let bridge = this.bridges.get(key);
    if (!bridge) {
      bridge = new DshBridge(this.config, preset, workspace);
      bridge.on("notification", (event: BridgeNotification) => this.emit("notification", { ...event, bridgePresetId: preset.id, bridgeWorkspaceId: workspace.id }));
      bridge.on("diagnostic", () => this.emit("diagnostic", { preset: preset.id, workspace: workspace.id, message: "bridge diagnostic available locally" }));
      bridge.on("exit", (error: Error) => {
        this.emit("bridgeExit", { presetId: preset.id, workspaceId: workspace.id });
        this.emit("diagnostic", { preset: preset.id, workspace: workspace.id, message: error.message });
      });
      this.bridges.set(key, bridge);
    }
    return bridge;
  }

  close(): void {
    for (const bridge of this.bridges.values()) bridge.close();
    this.bridges.clear();
  }

  closeWorkspace(presetId: string, workspaceId: string): void {
    const key = `${presetId}\0${workspaceId}`;
    this.bridges.get(key)?.close();
    this.bridges.delete(key);
  }
}
