import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chooseBackend, requireBackend } from "../scripts/supervisor.js";
import { RESTART_DELAY_SECONDS, TMUX_SESSION, renderSupervisedLoop, supervisorPaths } from "../scripts/tmuxSupervisor.js";
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
    serverPath: "/home/coder/dcaleon/dist/server/index.js",
    port: 3210,
    logPath: "/home/coder/dcaleon/.state/logs/bff.tmux.log",
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
    const loop = renderSupervisedLoop({ ...options, serverPath: "/home/coder/my dir/index.js" });
    expect(loop).toContain("'/home/coder/my dir/index.js'");
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
