import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chooseBackend, requireBackend } from "../scripts/supervisor.js";
import { LOG_ROTATE_BYTES, PORT_RELEASE_ATTEMPTS, RESTART_DELAY_SECONDS, TMUX_SESSION, renderSupervisedLoop, rotateIfLarge, supervisorPaths } from "../scripts/tmuxSupervisor.js";
import { BFF_LABEL } from "../scripts/launchd.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = path.join(repoRoot, "scripts", "deploy.sh");

describe("supervisor backend selection", () => {
  it("supervises with launchd on macOS and tmux on Linux", () => {
    expect(chooseBackend("darwin").backend).toBe("launchd");
    expect(chooseBackend("linux").backend).toBe("tmux");
  });

  // Guessing a backend would fail later and further from the cause, so an
  // unknown platform is refused with the reason named.
  it("refuses an unsupported platform instead of guessing", () => {
    const choice = chooseBackend("win32");
    expect(choice.backend).toBeNull();
    expect(choice.reason).toContain("win32");
    expect(() => requireBackend("win32")).toThrow(/no supervisor for platform 'win32'/);
  });

  // The islands rule: what a host can do is a property of the host, never an
  // operator toggle. No env var may redirect the backend.
  it("reads the platform only, never the environment", () => {
    const source = execFileSync("cat", [path.join(repoRoot, "scripts", "supervisor.ts")], { encoding: "utf8" });
    const chooseBody = source.slice(source.indexOf("export function chooseBackend"), source.indexOf("export function requireBackend"));
    expect(chooseBody).not.toMatch(/process\.env/);
  });
});

describe("tmux supervised loop", () => {
  const options = {
    nodePath: "/usr/bin/node",
    serverPath: "/home/dcaleon/dcaleon/dist/server/index.js",
    port: 3210,
    logPath: "/home/dcaleon/dcaleon/.state/logs/bff.tmux.log",
  };

  it("restarts the server rather than exiting with it", () => {
    const loop = renderSupervisedLoop(options);
    expect(loop).toMatch(/^while true; do /);
    expect(loop).toContain(`sleep ${RESTART_DELAY_SECONDS};`);
    expect(loop.trimEnd().endsWith("done")).toBe(true);
  });

  it("carries the port and appends to the log", () => {
    const loop = renderSupervisedLoop(options);
    expect(loop).toContain("PORT='3210'");
    expect(loop).toContain("NODE_ENV=production");
    expect(loop).toContain(`tee -a '${options.logPath}'`);
  });

  // The loop is handed to `tmux new-session` as one shell word; an unquoted
  // path with a space would silently run the wrong thing.
  it("quotes paths so a space cannot split the command", () => {
    const loop = renderSupervisedLoop({ ...options, serverPath: "/home/dcaleon/my dir/index.js" });
    expect(loop).toContain("'/home/dcaleon/my dir/index.js'");
  });

  it("names the session after the service, without tmux-hostile characters", () => {
    expect(TMUX_SESSION).toBe("ai-dcaleon-bff");
    expect(BFF_LABEL).toBe("ai.dcaleon.bff");
    expect(TMUX_SESSION).not.toMatch(/[.:]/);
  });

  it("keeps its log beside the launchd logs", () => {
    expect(supervisorPaths("/srv/dcaleon").log).toBe("/srv/dcaleon/.state/logs/bff.tmux.log");
  });
});

// Regression: the first real Linux deploy failed here. install() killed its own
// previous session and then refused to start, because `tmux kill-session`
// returns before the Node process it held closes its listening socket — so the
// port check found the corpse it had just made. launchd's bootout is
// synchronous enough that the launchd backend never sees this.
describe("tmux port release after kill-session", () => {
  const source = execFileSync("cat", [path.join(repoRoot, "scripts", "tmuxSupervisor.ts")], { encoding: "utf8" });

  it("waits for the port between killing the old session and checking it", () => {
    const install = source.slice(source.indexOf("export function install"), source.indexOf("export function status"));
    const killAt = install.indexOf("kill-session");
    const waitAt = install.indexOf("waitForPortRelease");
    const checkAt = install.indexOf("assertPortAvailable");
    expect(killAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(killAt);
    expect(checkAt).toBeGreaterThan(waitAt);
  });

  it("gives up waiting rather than blocking forever", () => {
    expect(PORT_RELEASE_ATTEMPTS).toBeGreaterThan(0);
    expect(PORT_RELEASE_ATTEMPTS).toBeLessThanOrEqual(30);
  });

  // A missing `ss` must read as "cannot tell", never as "the port is free":
  // the caller warns instead of silently starting a second listener.
  it("reports an unknown port state distinctly from an idle one", () => {
    const body = source.slice(source.indexOf("export function portInUse"), source.indexOf("export function waitForPortRelease"));
    expect(body).toContain("return undefined");
    expect(source).toContain("cannot confirm");
  });
});

describe("tmux log rotation", () => {
  const options = {
    nodePath: "/usr/bin/node",
    serverPath: "/home/dcaleon/dcaleon/dist/server/index.js",
    port: 3210,
    logPath: "/home/dcaleon/dcaleon/.state/logs/bff.tmux.log",
  };

  it("rotates between runs, keeping one previous generation", () => {
    const loop = renderSupervisedLoop(options);
    expect(loop).toContain("wc -c <");
    expect(loop).toContain(`mv -f '${options.logPath}' '${options.logPath}.1'`);
  });

  // `tee -a` holds the descriptor open, so the rename has to sit before the
  // run that creates the next tee — never beside a live one.
  it("rotates before starting the server, not during", () => {
    const loop = renderSupervisedLoop(options);
    expect(loop.indexOf("mv -f")).toBeLessThan(loop.indexOf("tee -a"));
  });

  it("rotates at a bound a crash loop can reach but a deploy will not", () => {
    expect(LOG_ROTATE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(LOG_ROTATE_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it("does not rotate a file that is absent or small, and never throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dca-rotate-"));
    const log = path.join(dir, "bff.tmux.log");
    expect(rotateIfLarge(log)).toBe(false);
    writeFileSync(log, "x".repeat(64));
    expect(rotateIfLarge(log)).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it("rotates a file past the limit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dca-rotate-"));
    const log = path.join(dir, "bff.tmux.log");
    writeFileSync(log, "x".repeat(2048));
    expect(rotateIfLarge(log, 1024)).toBe(true);
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(existsSync(log)).toBe(false);
  });

  // install() must not rename a log a live tee still owns.
  it("rotates only after the old session is gone", () => {
    const source = execFileSync("cat", [path.join(repoRoot, "scripts", "tmuxSupervisor.ts")], { encoding: "utf8" });
    const install = source.slice(source.indexOf("export function install"), source.indexOf("export function status"));
    expect(install.indexOf("kill-session")).toBeLessThan(install.indexOf("rotateIfLarge"));
  });
});

describe("deploy.sh platform dispatch", () => {
  const source = execFileSync("cat", [deployScript], { encoding: "utf8" });

  it("chooses the same two backends the supervisor module does", () => {
    expect(source).toContain("Darwin) supervisor=\"launchd\" ;;");
    expect(source).toContain("Linux) supervisor=\"tmux\" ;;");
  });

  // The regression this whole phase exists to prevent: a launchctl call that
  // runs unconditionally would abort the deploy on Linux.
  it("guards every launchctl call behind the launchd backend", () => {
    const lines = source.split("\n");
    const offenders: string[] = [];
    let guardDepth = 0;
    let depth = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#/.test(trimmed)) continue;
      if (/^if \[ "\$supervisor" = "launchd" \]/.test(trimmed) || /&& \[ "\$supervisor" = "launchd" \]/.test(trimmed)) {
        guardDepth = depth + 1;
      }
      if (/^if /.test(trimmed)) depth += 1;
      if (/^fi\b/.test(trimmed)) {
        depth -= 1;
        if (depth < guardDepth) guardDepth = 0;
      }
      if (trimmed.includes("launchctl") && guardDepth === 0 && !trimmed.includes('"$supervisor"')) {
        offenders.push(trimmed);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no longer hardcodes the macOS curl path", () => {
    expect(source).not.toContain("/usr/bin/curl");
  });

  it("waits on the port with a tool that exists on each platform", () => {
    expect(source).toContain("/usr/sbin/lsof");
    expect(source).toContain("ss -tlnH");
  });
});
