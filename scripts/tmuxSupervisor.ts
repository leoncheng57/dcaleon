// Linux supervision backend: a detached tmux session around a restart loop.
//
// Why tmux and not systemd. The handoff assumed systemd would be the Linux
// counterpart to launchd, and on an ordinary VM it would be. The host this was
// actually built for is a hosted workspace container — no init system reachable
// by the workspace user, and a restart policy that does not bring the workload
// back. systemd --user is not available to bootstrap into. tmux is, it is
// already how that image supervises its own agent session, and a detached
// session survives the SSH connection that started it.
//
// What this does NOT give you, and launchd does: restart across a host reboot.
// A stopped pod comes back with no sessions, so `install` has to run again.
// Recording that plainly is better than implying parity.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { BFF_LABEL, assertSupportedNodeVersion } from "./launchd.js";

/** tmux rejects `.` and `:` in a session name; the label is the same service. */
export const TMUX_SESSION = BFF_LABEL.replaceAll(".", "-");

/** Seconds between a supervised process exiting and the loop restarting it. */
export const RESTART_DELAY_SECONDS = 5;

/** One-second polls waiting for a killed session to release its port. */
export const PORT_RELEASE_ATTEMPTS = 10;

/**
 * Rotate the log past this size, keeping one previous generation.
 *
 * Rotation happens between runs, not on a timer, and that is forced rather than
 * lazy: `tee -a` holds an open descriptor, so renaming the file underneath it
 * leaves tee writing to the moved inode, and truncating it in place leaves tee
 * appending at its old offset — producing a sparse file that still reports the
 * old size. The only safe moment to move the file is when no tee owns it.
 *
 * Which covers the case that actually runs away: a crash loop, restarting every
 * five seconds and writing a stack trace each time. A healthy process that
 * never exits also never rotates — `service:install` rotates on the way in, so
 * the bound is "one deploy's worth of logs", and on a 98 GB home volume that is
 * the right trade for not corrupting the live log.
 */
export const LOG_ROTATE_BYTES = 32 * 1024 * 1024;

export interface SupervisedLoopOptions {
  nodePath: string;
  serverPath: string;
  port: number;
  logPath: string;
  rotateBytes?: number;
}

/**
 * The shell the tmux session runs. Pure so a test can assert the shape without
 * a tmux binary: the restart loop, the port, and the tee into the log file are
 * the parts that go wrong silently when they are wrong.
 */
export function renderSupervisedLoop(options: SupervisedLoopOptions): string {
  const quote = (value: string | number) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const log = quote(options.logPath);
  const rotateBytes = options.rotateBytes ?? LOG_ROTATE_BYTES;
  return [
    "while true; do",
    // Between runs, when no tee holds the descriptor: see LOG_ROTATE_BYTES.
    `if [ -f ${log} ] && [ "$(wc -c < ${log})" -gt ${rotateBytes} ]; then mv -f ${log} ${quote(`${options.logPath}.1`)}; fi;`,
    `PORT=${quote(options.port)} NODE_ENV=production`,
    `${quote(options.nodePath)} ${quote(options.serverPath)}`,
    `2>&1 | tee -a ${log};`,
    `sleep ${RESTART_DELAY_SECONDS};`,
    "done",
  ].join(" ");
}

function tmux(args: string[], allowFailure = false): boolean {
  const result = spawnSync("tmux", args, { stdio: allowFailure ? "ignore" : "inherit" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("tmux is not installed; the Linux supervisor requires it");
  }
  if (!allowFailure && result.status !== 0) throw new Error(`tmux ${args[0]} failed`);
  return result.status === 0;
}

export function sessionExists(): boolean {
  return tmux(["has-session", "-t", TMUX_SESSION], true);
}

function build(root: string): void {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "run", "build"], { cwd: root, stdio: "inherit" })
    : spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("production build failed");
}

/**
 * Undefined when `ss` is missing: absent evidence is not evidence the port is
 * free, and the caller has to tell "no listener" apart from "cannot tell".
 */
export function portInUse(port: number): boolean | undefined {
  const result = spawnSync("ss", ["-tlnH", `sport = :${port}`], { encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  if (result.status !== 0) return undefined;
  return result.stdout.trim() !== "";
}

/**
 * `tmux kill-session` returns as soon as the session is gone, but the Node
 * process it held takes a moment longer to close its listening socket. Without
 * this wait, install kills its own previous session and then refuses to start
 * because "the port is in use" — by the corpse it just created. launchd's
 * bootout is synchronous enough that the launchd backend never sees this.
 */
export function waitForPortRelease(port: number, attempts = PORT_RELEASE_ATTEMPTS): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (portInUse(port) !== true) return;
    spawnSync("sleep", ["1"]);
  }
}

function assertPortAvailable(port: number): void {
  const inUse = portInUse(port);
  if (inUse === undefined) {
    console.warn(`Warning: ss is unavailable; cannot confirm :${port} is free.`);
    return;
  }
  if (inUse) throw new Error(`port ${port} already has a listener; choose another supervised port`);
}

/**
 * The deploy-time half of rotation. Safe here because install has already
 * killed the session, so nothing holds the file open.
 */
export function rotateIfLarge(logPath: string, limit = LOG_ROTATE_BYTES): boolean {
  try {
    if (statSync(logPath).size <= limit) return false;
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    // No log yet, or an unreadable one: nothing to rotate, and never a reason
    // to fail a deploy.
    return false;
  }
}

export function supervisorPaths(root: string) {
  const logDir = path.join(root, ".state", "logs");
  return { logDir, log: path.join(logDir, "bff.tmux.log") };
}

function pollHealth(port: number, attempts = 20): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawnSync("curl", ["-fsS", "--max-time", "3", `http://127.0.0.1:${port}/api/health`], { stdio: "ignore" });
    if (result.status === 0) return true;
    spawnSync("sleep", ["1"]);
  }
  return false;
}

export function install(root: string, port: number): void {
  assertSupportedNodeVersion();
  build(root);
  const envPath = path.join(root, ".env");
  const serverPath = path.join(root, "dist", "server", "index.js");
  if (!existsSync(envPath)) throw new Error(`missing ${envPath}; copy .env.example and configure it first`);
  if (!existsSync(serverPath)) throw new Error("missing production build; run npm run build first");

  const mode = statSync(envPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(`Warning: ${envPath} is mode ${mode.toString(8)}; run chmod 600 .env.`);
  }

  const paths = supervisorPaths(root);
  mkdirSync(paths.logDir, { recursive: true });

  // Stop before the port check: the listener we are about to object to is
  // usually our own previous session — then wait for it to actually let go.
  if (sessionExists()) {
    tmux(["kill-session", "-t", TMUX_SESSION]);
    waitForPortRelease(port);
  }
  assertPortAvailable(port);

  // Only now: until the session is gone, a tee still holds the log open and
  // renaming it would leave that tee writing to the moved inode.
  rotateIfLarge(paths.log);

  const loop = renderSupervisedLoop({ nodePath: process.execPath, serverPath, port, logPath: paths.log });
  tmux(["new-session", "-d", "-s", TMUX_SESSION, "-c", root, loop]);

  if (!pollHealth(port)) {
    throw new Error(`tmux session ${TMUX_SESSION} started but :${port} never answered /api/health; see ${paths.log}`);
  }
  console.log(`Installed ${BFF_LABEL} on http://127.0.0.1:${port} (tmux session ${TMUX_SESSION})`);
  console.log(`Log: ${paths.log}`);
  console.log("Note: a pod restart clears tmux sessions — rerun this to bring it back.");
}

export function status(root: string): void {
  if (!sessionExists()) {
    console.log(`${BFF_LABEL} is not running (no tmux session ${TMUX_SESSION}).`);
    process.exitCode = 1;
    return;
  }
  tmux(["list-sessions", "-f", `#{==:#{session_name},${TMUX_SESSION}}`]);
  console.log(`log: ${supervisorPaths(root).log}`);
}

export function logs(root: string): void {
  const paths = supervisorPaths(root);
  if (!existsSync(paths.log)) throw new Error(`no log found at ${paths.log}`);
  const result = spawnSync("tail", ["-n", "100", "-F", paths.log], { stdio: "inherit" });
  if (result.signal !== "SIGINT" && result.status !== 0) throw new Error("tail failed");
}

export function uninstall(root: string): void {
  if (sessionExists()) tmux(["kill-session", "-t", TMUX_SESSION]);
  console.log(`Uninstalled ${BFF_LABEL}; logs were preserved in ${supervisorPaths(root).logDir}.`);
}
