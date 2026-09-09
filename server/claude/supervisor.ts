import { spawn, type ChildProcessByStdio } from "node:child_process";
import { registerResourceProcess } from "../resource-processes.js";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";

import type { ClaudeConfig, ClaudePreset, ClaudeWorkspace } from "./config.js";

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
 * `temporaryDirectory` overrides the inherited `TMPDIR`. The host value points
 * into `/var/folders/...`, which the Seatbelt profile does not grant, so
 * anything reaching for `os.tmpdir()` (`mkdtemp`, most test harnesses, many
 * build tools) fails with EPERM. Pointing it inside the state root — already
 * writable — makes the ordinary temp-file path work.
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

function seatbeltLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Seatbelt profile for the `claude` binary. Verified empirically on macOS: a
 * deny-default profile that keeps subscription auth working must, unlike the
 * DSH profile, grant read of the login Keychain and the securityd family —
 * `claude` reads its OAuth credential from the Keychain, not a file. HOME is
 * NOT redirected for the same reason.
 *
 * Seatbelt is the write-confinement authority and ONLY that: reads are granted
 * whole-disk (`(allow file-read*)`), so a session can read anything the user
 * can — host tool caches, sibling projects, `~/.codex` transcripts — without a
 * profile edit per path. The workspace is writable only in build mode. This
 * deliberately exposes every home-directory secret the user owns (SSH private
 * keys, `~/.aws`, browser cookie stores) to a session of either mode; the
 * credential boundary the BFF honours is code discipline — it never reads the
 * credential itself — and that discipline is now the only read boundary.
 */
export function claudeSeatbeltProfile(input: {
  workspace: string;
  stateRoot: string;
  mode: ClaudePreset["mode"];
  home?: string;
  /**
   * Worktree isolation: the worktree is `workspace`, but git keeps the shared
   * object store and worktree metadata in the PROJECT's `.git`, so a Build
   * session must write its `.git`. Inherent to git worktrees; it is the one
   * write that reaches outside the session dir. Reads need no counterpart —
   * the profile grants read of the whole disk.
   */
  extraWrites?: string[];
}): string {
  const home = input.home ?? homedir();
  const writes = [
    input.stateRoot, path.join(home, ".claude"), path.join(home, "Library/Keychains"), "/private/tmp", "/tmp",
    ...(input.mode === "build" ? [input.workspace, ...(input.extraWrites ?? [])] : []),
  ].map((item) => `(subpath "${seatbeltLiteral(item)}")`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    // Scoped to descendants: a session must be able to manage its own child
    // processes (a test runner's worker pool terminates workers, and `process*`
    // does not cover `signal`), but must not be able to signal the BFF that
    // supervises it or anything else on the host.
    "(allow signal (target children))",
    "(allow network*)",
    "(allow file-read-metadata)",
    "(allow ipc-posix-shm*)",
    "(allow user-preference-read)",
    '(allow mach-lookup (global-name-regex #"^com\\.apple\\.(SecurityServer|securityd|securityd\\.xpc|trustd|trustd\\.agent|system\\.opendirectoryd\\..*|coreservices\\..*|CoreServices\\..*)"))',
    // Whole-disk read: the allowlist this replaced had to grow a path every time
    // a session needed host state (Homebrew runtimes, Xcode bundles, git config),
    // and read confinement was never what this profile enforced.
    "(allow file-read*)",
    `(allow file-write* ${writes})`,
  ].join("\n");
}

/**
 * The generated Claude settings file. Read-only mode denies the file-mutation
 * tools at the permission layer too (Seatbelt is the hard backstop). `ask` is
 * never emitted — a headless lane has no answerer, so a policy that would ask
 * must deny instead.
 */
export function claudeSettings(preset: ClaudePreset): Record<string, unknown> {
  const mutation = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
  const readOnly = preset.mode === "read-only";
  // Headless `claude` denies a mutation tool that no rule explicitly allows, even
  // under `acceptEdits` — so Build must allow them by name (Seatbelt still confines
  // the writes to the workspace). Read-only denies them at the tool layer too, with
  // Seatbelt as the hard backstop.
  return {
    permissions: {
      defaultMode: preset.permissionMode,
      allow: readOnly ? [] : mutation,
      deny: readOnly ? mutation : [],
      ask: [],
    },
  };
}

interface RunInput {
  session: { id: string; sessionUuid: string; started: boolean };
  preset: ClaudePreset;
  /** The session's working directory: the project, or its isolated worktree. */
  workspace: Pick<ClaudeWorkspace, "directory">;
  /** Worktree isolation grant: the project `.git` write. */
  sandboxExtras?: { writes: string[] };
  /** Per-turn model override (validated against configured presets by the route). */
  model?: string;
  /** Explicit per-turn mode: "plan" for read-only planning, "build" for writing. */
  turnMode: "plan" | "build";
  text: string;
  /** Turn-scoped image directory, removed after the child closes. */
  cleanupDirectory?: string;
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

  private buildArgs(input: RunInput, settingsPath: string): { command: string; args: string[] } {
    const { preset, workspace, session, text } = input;
    const permissionMode = input.turnMode === "plan" ? "plan" : "bypassPermissions";
    const effectiveMode: ClaudePreset["mode"] = input.turnMode === "plan" ? "read-only" : "build";
    const cli = [
      "-p", text,
      "--output-format", "stream-json",
      "--verbose",
      session.started ? "--resume" : "--session-id", session.sessionUuid,
      "--model", input.model ?? preset.model,
      "--add-dir", workspace.directory,
      "--permission-mode", permissionMode,
      "--settings", settingsPath,
      ...(preset.effort ? ["--effort", preset.effort] : []),
      ...(preset.maxBudgetUsd ? ["--max-budget-usd", String(preset.maxBudgetUsd)] : []),
    ];
    if (this.config.sandbox === "seatbelt") {
      const profile = claudeSeatbeltProfile({
        workspace: workspace.directory,
        stateRoot: this.config.sessionRoot,
        mode: effectiveMode,
        extraWrites: input.sandboxExtras?.writes,
      });
      return { command: "/usr/bin/sandbox-exec", args: ["-p", profile, this.config.binaryPath, ...cli] };
    }
    // "host" (terminal parity) and "test-unsafe" run the binary directly: no Seatbelt
    // wrapper, so the turn's authority is the user's own and the permission layer in
    // the generated settings file is the only confinement left.
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
    const effectivePreset = input.turnMode === "plan"
      ? { ...input.preset, mode: "read-only" as const, permissionMode: "plan" }
      : { ...input.preset, mode: "build" as const, permissionMode: "bypassPermissions" };
    writeFileSync(settingsPath, `${JSON.stringify(claudeSettings(effectivePreset), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const { command, args } = this.buildArgs(input, settingsPath);
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
