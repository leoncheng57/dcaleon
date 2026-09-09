import { spawn, type ChildProcessByStdio } from "node:child_process";
import { registerResourceProcess } from "../resource-processes.js";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import type { ClaudeConfig, ClaudePreset, ClaudeWorkspace } from "./config.js";
import { APPROVER_PROMPT_TOOL, APPROVER_SOURCE, claudeApproverConfig } from "./approver.js";

export const CLAUDE_MAX_LINE_BYTES = 4 * 1024 * 1024;

/** A parsed stream-json record. `type` (and sometimes `subtype`) discriminate it. */
export interface ClaudeFrame {
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

// Only these cross into the child. No credential var is forwarded: `claude`
// authenticates from its own Keychain item, and the BFF never brokers auth.
// HOME stays the real HOME so the binary can find that Keychain and its config.
// USER/LOGNAME/__CF_USER_TEXT_ENCODING are the user IDENTITY (not a credential):
// macOS resolves the login Keychain by user, and without USER even an
// un-sandboxed `claude` reports "Not logged in". A launchd-supervised BFF has a
// minimal env that lacks these, so they are synthesized from the process user
// when absent. SSH_AUTH_SOCK grants the same host Git authority documented for
// this app without exposing a private-key file. This is an allowlist by design
// — a credential var in `source` (ANTHROPIC_API_KEY,
// CLAUDE_CODE_OAUTH_TOKEN, ...) is never copied through.
const SAFE_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "__CF_USER_TEXT_ENCODING", "SSH_AUTH_SOCK"] as const;

/**
 * `temporaryDirectory` overrides the inherited `TMPDIR`, keeping a turn's temp
 * files inside the state root so they are removed with the session rather than
 * accumulating in the host's `/var/folders/...`.
 */
export function claudeSupervisorEnvironment(source: NodeJS.ProcessEnv = process.env, temporaryDirectory?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV) if (source[key]) environment[key] = source[key];
  if (temporaryDirectory) environment.TMPDIR = temporaryDirectory;
  if (!environment.USER || !environment.LOGNAME || !environment.__CF_USER_TEXT_ENCODING) {
    try {
      const info = userInfo();
      environment.USER ??= info.username;
      environment.LOGNAME ??= info.username;
      environment.__CF_USER_TEXT_ENCODING ??= `0x${info.uid.toString(16).toUpperCase()}:0x0:0x0`;
    } catch {
      // userInfo() can throw in exotic setups (no passwd entry); a USER already
      // in `source` still covers the common case, so fail soft.
    }
  }
  return environment;
}

/**
 * The generated Claude settings file. This is now the ONLY confinement a turn
 * has: with no Seatbelt wrapper, a session holds the authority `claude` holds in
 * a terminal, so read-only mode's tool-layer denies have no OS-level backstop
 * behind them. `ask` is never emitted: a rule that would ask is answered by the
 * permission prompt tool when `approvals` is set, and denied outright when it is
 * not, because a lane with no answerer must not fall back to allowing.
 */
export function claudeSettings(preset: ClaudePreset, approvals = false): Record<string, unknown> {
  const mutation = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
  const readOnly = preset.mode === "read-only";
  // Headless `claude` denies a mutation tool that no rule explicitly allows, even
  // under `acceptEdits` — so an ungated Build must allow them by name. A gated Build
  // must NOT: naming them here pre-approves them, and the prompt tool would never be
  // consulted. Read-only denies them at the tool layer either way — and that deny is
  // the whole boundary now, so it must not be relaxed.
  return {
    permissions: {
      defaultMode: preset.permissionMode,
      allow: readOnly || approvals ? [] : mutation,
      deny: readOnly ? mutation : [],
      ask: [],
    },
  };
}

/** A Build turn with a gate configured; a plan turn is already read-only. */
function isGated(input: Pick<RunInput, "turnMode" | "approvals">): boolean {
  return input.turnMode !== "plan" && input.approvals !== undefined;
}

interface RunInput {
  session: { id: string; sessionUuid: string; started: boolean };
  preset: ClaudePreset;
  /** The session's working directory: the project, or its isolated worktree. */
  workspace: Pick<ClaudeWorkspace, "directory">;
  /** Per-turn model override (validated against configured presets by the route). */
  model?: string;
  /** Explicit per-turn mode: "plan" for read-only planning, "build" for writing. */
  turnMode: "plan" | "build";
  text: string;
  /** Turn-scoped image directory, removed after the child closes. */
  cleanupDirectory?: string;
  /**
   * Loopback approval gate. When set, a Build turn runs under `default` and
   * routes every permission check to the in-session approver; when absent the
   * turn runs pre-approved with no confinement at all.
   */
  approvals?: { url: string; token: string };
}

export class ClaudeSupervisor extends EventEmitter {
  private readonly children = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();
  private readonly buffers = new Map<string, Buffer>();
  private readonly stderr = new Map<string, string>();
  private observedCliVersion: string | undefined;

  constructor(private config: ClaudeConfig) {
    super();
  }

  private cleanup(directory: string | undefined): void {
    if (!directory) return;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cause) {
      this.emit("diagnostic", `could not remove Claude image attachments: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private settingsPath(sessionUuid: string): string {
    return path.join(this.config.sessionRoot, `${sessionUuid}.settings.json`);
  }

  private mcpConfigPath(sessionUuid: string): string {
    return path.join(this.config.sessionRoot, `${sessionUuid}.mcp.json`);
  }

  private buildArgs(input: RunInput, settingsPath: string, mcpConfigPath: string): { command: string; args: string[] } {
    const { preset, workspace, session, text } = input;
    const gated = isGated(input);
    const permissionMode = input.turnMode === "plan" ? "plan" : gated ? "default" : "bypassPermissions";
    const cli = [
      "-p", text,
      "--output-format", "stream-json",
      "--verbose",
      session.started ? "--resume" : "--session-id", session.sessionUuid,
      "--model", input.model ?? preset.model,
      "--add-dir", workspace.directory,
      "--permission-mode", permissionMode,
      "--settings", settingsPath,
      ...(gated ? ["--mcp-config", mcpConfigPath, "--permission-prompt-tool", APPROVER_PROMPT_TOOL] : []),
      ...(preset.effort ? ["--effort", preset.effort] : []),
      ...(preset.maxBudgetUsd ? ["--max-budget-usd", String(preset.maxBudgetUsd)] : []),
    ];
    // The binary runs directly, at terminal parity: a turn's authority is the
    // user's own and the permission layer in the generated settings file is the
    // only confinement. Nothing stops a Bash call from writing outside the
    // workspace, so an ungated Build turn is as privileged as the operator.
    return { command: this.config.binaryPath, args: cli };
  }

  /**
   * Spawn one `claude -p` for this prompt. Resolves once the process has
   * started (the turn is accepted); frames arrive on the "frame" event and the
   * turn ends on "exit". Rejects only if the process fails to spawn.
   */
  run(input: RunInput): Promise<void> {
    const settingsPath = this.settingsPath(input.session.sessionUuid);
    mkdirSync(this.config.sessionRoot, { recursive: true, mode: 0o700 });
    const temporaryDirectory = path.join(this.config.sessionRoot, "tmp");
    mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
    const gated = isGated(input);
    const effectivePreset = input.turnMode === "plan"
      ? { ...input.preset, mode: "read-only" as const, permissionMode: "plan" }
      : { ...input.preset, mode: "build" as const, permissionMode: gated ? "default" : "bypassPermissions" };
    writeFileSync(settingsPath, `${JSON.stringify(claudeSettings(effectivePreset, gated), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const mcpConfigPath = this.mcpConfigPath(input.session.sessionUuid);
    if (gated && input.approvals) {
      const scriptPath = path.join(this.config.sessionRoot, `${input.session.sessionUuid}.approver.mjs`);
      writeFileSync(scriptPath, APPROVER_SOURCE, { encoding: "utf8", mode: 0o600 });
      const document = claudeApproverConfig({
        nodePath: process.execPath,
        scriptPath,
        url: input.approvals.url,
        token: input.approvals.token,
        sessionId: input.session.id,
      });
      writeFileSync(mcpConfigPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const { command, args } = this.buildArgs(input, settingsPath, mcpConfigPath);
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(command, args, {
          cwd: input.workspace.directory,
          env: claudeSupervisorEnvironment(process.env, temporaryDirectory),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
      const sessionId = input.session.id;
      this.children.set(sessionId, child);
      registerResourceProcess(child, "Claude");
      this.buffers.set(sessionId, Buffer.alloc(0));
      this.stderr.set(sessionId, "");
      child.once("spawn", () => resolve());
      child.once("error", (cause) => {
        this.children.delete(sessionId);
        this.buffers.delete(sessionId);
        this.stderr.delete(sessionId);
        this.cleanup(input.cleanupDirectory);
        reject(cause);
      });
      child.stdout.on("data", (chunk: Buffer) => this.receiveChunk(sessionId, chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const detail = chunk.toString("utf8");
        this.stderr.set(sessionId, `${this.stderr.get(sessionId) ?? ""}${detail}`.slice(-4_000));
        this.emit("diagnostic", detail.slice(0, 2_000));
      });
      // `close`, not `exit`: `exit` can fire before the last stdout chunk is
      // delivered, which would let the turn be marked finished (and its final
      // `result` frame dropped) while frames are still in flight. `close` fires
      // only after every stdio stream has drained. Any partial trailing line is
      // flushed first so a frame without a final newline is not lost either.
      child.once("close", (code, signal) => {
        const remainder = this.buffers.get(sessionId);
        if (remainder && remainder.length) this.receiveLine(sessionId, remainder.toString("utf8"));
        const stderr = this.stderr.get(sessionId)?.trim();
        this.children.delete(sessionId);
        this.buffers.delete(sessionId);
        this.stderr.delete(sessionId);
        this.cleanup(input.cleanupDirectory);
        this.emit("exit", { sessionId, code, signal, ...(stderr ? { stderr } : {}) });
      });
    });
  }

  private receiveChunk(sessionId: string, chunk: Buffer): void {
    let frame = this.buffers.get(sessionId) ?? Buffer.alloc(0);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (frame.length + segment.length > CLAUDE_MAX_LINE_BYTES) {
        this.emit("diagnostic", "claude frame exceeded the size limit");
        this.children.get(sessionId)?.kill("SIGTERM");
        frame = Buffer.alloc(0);
        this.buffers.set(sessionId, frame);
        return;
      }
      if (segment.length) frame = Buffer.concat([frame, segment]);
      if (newline === -1) break;
      const line = (frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame).toString("utf8");
      frame = Buffer.alloc(0);
      this.receiveLine(sessionId, line);
      offset = newline + 1;
    }
    this.buffers.set(sessionId, frame);
  }

  private reloadCliVersion(): string {
    try {
      const raw = readFileSync(path.resolve(".env"), "utf8");
      const match = raw.match(/^CLAUDE_CLI_VERSION\s*=\s*['"]?([^'"\s#]+)/m);
      return match?.[1] ?? this.config.cliVersion;
    } catch {
      return this.config.cliVersion;
    }
  }

  private receiveLine(sessionId: string, line: string): void {
    if (!line.trim()) return;
    let parsed: ClaudeFrame;
    try {
      parsed = JSON.parse(line) as ClaudeFrame;
    } catch {
      this.emit("diagnostic", "claude emitted malformed JSON");
      return;
    }
    // Report binary drift, but do not kill a healthy stream solely because the
    // CLI auto-updated. Parsing remains fail-closed at each malformed frame.
    if (parsed.type === "system" && parsed.subtype === "init") {
      const version = typeof parsed.claude_code_version === "string" ? parsed.claude_code_version : "";
      this.observedCliVersion = version || undefined;
      if (version !== this.config.cliVersion) {
        const refreshed = this.reloadCliVersion();
        if (version === refreshed) {
          this.config = { ...this.config, cliVersion: refreshed };
        } else {
          this.emit("diagnostic", `Claude CLI version drift: configured ${this.config.cliVersion}, observed ${version || "unknown"}; continuing while stream-json remains valid`);
          this.emit("frame", { sessionId, frame: { type: "system", subtype: "version_drift", expected: this.config.cliVersion, received: version } });
        }
      }
    }
    this.emit("frame", { sessionId, frame: parsed });
  }

  cancel(sessionId: string): boolean {
    const child = this.children.get(sessionId);
    if (!child) return false;
    child.kill("SIGTERM");
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.children.has(sessionId);
  }

  cliVersions(): { configured: string; observed?: string; matches?: boolean } {
    return {
      configured: this.config.cliVersion,
      ...(this.observedCliVersion ? { observed: this.observedCliVersion, matches: this.observedCliVersion === this.config.cliVersion } : {}),
    };
  }

  close(): void {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
    this.buffers.clear();
    this.stderr.clear();
  }
}
