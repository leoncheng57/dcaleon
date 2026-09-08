import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BFF_LABEL = "ai.dcaleon.bff";
export const DEFAULT_SUPERVISED_PORT = 3210;

export interface BffPlistOptions {
  repoRoot: string;
  nodePath: string;
  home: string;
  pathValue: string;
  port: number;
  stdoutPath: string;
  stderrPath: string;
}

export function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderBffPlist(options: BffPlistOptions): string {
  const value = (input: string | number) => escapePlistString(String(input));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BFF_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${value(options.nodePath)}</string>
    <string>${value(path.join(options.repoRoot, "dist/server/index.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${value(options.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${value(options.home)}</string>
    <key>PATH</key>
    <string>${value(options.pathValue)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>${value(options.port)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${value(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${value(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export function parseSupervisedPort(value: string | undefined): number {
  const port = Number(value ?? DEFAULT_SUPERVISED_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid supervised port: ${value}`);
  }
  if (port === 3000) {
    throw new Error("supervised port 3000 conflicts with the development default");
  }
  return port;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node 22 or newer is required; found ${version}`);
  }
}

export function assertInstallablePlist(plist: string): void {
  const unresolved = plist.match(/REPLACE_WITH_[A-Z_]+/g);
  if (unresolved) throw new Error(`unresolved plist placeholder: ${unresolved[0]}`);

  const executable = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("LaunchAgent executable must be an absolute path");
  }
}

export function activeClaudeSessions(payload: unknown): Array<{ id: string; title: string }> {
  if (!payload || typeof payload !== "object") return [];
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((session) => {
    if (!session || typeof session !== "object") return [];
    const item = session as { id?: unknown; title?: unknown; running?: unknown };
    if (item.running !== true || typeof item.id !== "string") return [];
    return [{ id: item.id, title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.id }];
  });
}

export function parseBffPlistPort(plist: string): number | undefined {
  const value = plist.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/u)?.[1];
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function runLaunchctl(args: string[], allowFailure = false): boolean {
  const result = spawnSync("launchctl", args, { stdio: allowFailure ? "ignore" : "inherit" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed`);
  }
  return result.status === 0;
}

function build(root: string): void {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "run", "build"], { cwd: root, stdio: "inherit" })
    : spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("production build failed");
}

function assertPortAvailable(port: number): void {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
  if (result.status === 0) {
    throw new Error(`port ${port} already has a listener; choose another supervised port`);
  }
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") throw result.error;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function paths(root: string) {
  const logDir = path.join(root, ".state", "logs");
  return {
    plist: path.join(os.homedir(), "Library", "LaunchAgents", `${BFF_LABEL}.plist`),
    logDir,
    stdout: path.join(logDir, "bff.launchd.out.log"),
    stderr: path.join(logDir, "bff.launchd.err.log"),
  };
}

function userDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd supervision requires a POSIX user id");
  return `gui/${uid}`;
}

function serviceTarget(): string {
  return `${userDomain()}/${BFF_LABEL}`;
}

function assertNoActiveClaudeSessions(port: number, force: boolean): void {
  if (force) return;
  const response = spawnSync("/usr/bin/curl", ["-fsS", "--max-time", "3", `http://127.0.0.1:${port}/api/claude/sessions`], { encoding: "utf8" });
  // launchd says the service is loaded, so an unreadable status is unknown—not
  // proof of zero active turns. The explicit force flag remains the recovery
  // path for a wedged or pre-Claude deployment.
  if (response.status !== 0) {
    throw new Error(`refusing to replace the BFF because Claude session status on port ${port} is unavailable; retry when it is healthy or use --force-active-claude to interrupt any unknown work explicitly`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.stdout);
  } catch {
    throw new Error("refusing to replace the BFF because its Claude session response was not valid JSON");
  }
  const active = activeClaudeSessions(payload);
  if (active.length === 0) return;
  const names = active.slice(0, 5).map((session) => `- ${session.title} (${session.id})`).join("\n");
  const remainder = active.length > 5 ? `\n- and ${active.length - 5} more` : "";
  throw new Error(`refusing to replace the BFF while ${active.length} Claude session${active.length === 1 ? " is" : "s are"} running:\n${names}${remainder}\nWait for them to finish or rerun with --force-active-claude to interrupt them explicitly.`);
}

function install(port: number, forceActiveClaude: boolean): void {
  assertSupportedNodeVersion();
  const root = repoRoot();
  build(root);
  const servicePaths = paths(root);
  const envPath = path.join(root, ".env");
  const serverPath = path.join(root, "dist", "server", "index.js");
  if (!existsSync(envPath)) throw new Error(`missing ${envPath}; copy .env.example and configure it first`);
  if (!existsSync(serverPath)) throw new Error("missing production build; run npm run build first");

  const mode = statSync(envPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.warn(`Warning: ${envPath} is mode ${mode.toString(8)}; run chmod 600 .env.`);
  }

  mkdirSync(path.dirname(servicePaths.plist), { recursive: true });
  mkdirSync(servicePaths.logDir, { recursive: true });
  const plist = renderBffPlist({
    repoRoot: root,
    nodePath: process.execPath,
    home: os.homedir(),
    pathValue: [
      path.dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    port,
    stdoutPath: servicePaths.stdout,
    stderrPath: servicePaths.stderr,
  });
  assertInstallablePlist(plist);

  if (runLaunchctl(["print", serviceTarget()], true)) {
    // Check after the build, immediately before bootout, so a routine deploy
    // cannot silently kill a Claude turn that started while assets compiled.
    const currentPort = existsSync(servicePaths.plist)
      ? parseBffPlistPort(readFileSync(servicePaths.plist, "utf8")) ?? port
      : port;
    assertNoActiveClaudeSessions(currentPort, forceActiveClaude);
    runLaunchctl(["bootout", serviceTarget()]);
  }
  assertPortAvailable(port);
  writeFileSync(servicePaths.plist, plist, { mode: 0o644 });
  chmodSync(servicePaths.plist, 0o644);
  runLaunchctl(["bootstrap", userDomain(), servicePaths.plist]);
  runLaunchctl(["print", serviceTarget()]);
  console.log(`Installed ${BFF_LABEL} on http://127.0.0.1:${port}`);
  console.log(`Plist: ${servicePaths.plist}`);
}

function status(): void {
  const root = repoRoot();
  const servicePaths = paths(root);
  if (!runLaunchctl(["print", serviceTarget()], true)) {
    console.log(`${BFF_LABEL} is not loaded.`);
    process.exitCode = 1;
    return;
  }
  runLaunchctl(["print", serviceTarget()]);
  console.log(`stdout: ${servicePaths.stdout}`);
  console.log(`stderr: ${servicePaths.stderr}`);
}

function logs(): void {
  const servicePaths = paths(repoRoot());
  const files = [servicePaths.stdout, servicePaths.stderr].filter(existsSync);
  if (files.length === 0) throw new Error(`no logs found under ${servicePaths.logDir}`);
  const result = spawnSync("tail", ["-n", "100", "-F", ...files], { stdio: "inherit" });
  if (result.signal !== "SIGINT" && result.status !== 0) throw new Error("tail failed");
}

function uninstall(): void {
  const servicePaths = paths(repoRoot());
  if (runLaunchctl(["print", serviceTarget()], true)) {
    runLaunchctl(["bootout", serviceTarget()]);
  }
  rmSync(servicePaths.plist, { force: true });
  console.log(`Uninstalled ${BFF_LABEL}; logs were preserved in ${servicePaths.logDir}.`);
}

function main(): void {
  const action = process.argv[2];
  const portArg = process.argv.find((value) => value.startsWith("--port="))?.slice("--port=".length);
  const forceActiveClaude = process.argv.includes("--force-active-claude");
  if (action === "install") install(parseSupervisedPort(portArg), forceActiveClaude);
  else if (action === "status") status();
  else if (action === "logs") logs();
  else if (action === "uninstall") uninstall();
  else throw new Error("usage: launchd.ts <install|status|logs|uninstall> [--port=3210] [--force-active-claude]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
