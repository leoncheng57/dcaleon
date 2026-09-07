import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function install(port: number): void {
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
  if (action === "install") install(parseSupervisedPort(portArg));
  else if (action === "status") status();
  else if (action === "logs") logs();
  else if (action === "uninstall") uninstall();
  else throw new Error("usage: launchd.ts <install|status|logs|uninstall> [--port=3210]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
