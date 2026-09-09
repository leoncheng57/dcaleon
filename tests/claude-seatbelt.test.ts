import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { claudeSeatbeltProfile } from "../server/claude/supervisor.js";

const run = promisify(execFile);
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

async function underProfile(profile: string, command: string): Promise<{ ok: boolean; stderr: string }> {
  try {
    await run("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", command]);
    return { ok: true, stderr: "" };
  } catch (error) {
    return { ok: false, stderr: (error as { stderr?: string }).stderr ?? String(error) };
  }
}

describe("Claude Seatbelt profile", () => {
  it.runIf(onMac)("denies a workspace write in read-only mode but allows the state root", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-")));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, mode: "read-only" });
    // The workspace and state dirs must exist for the write attempt to reach the sandbox check.
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);

    const denied = await underProfile(profile, `echo x > '${path.join(workspace, "escape.txt")}'`);
    expect(denied.ok).toBe(false);
    expect(existsSync(path.join(workspace, "escape.txt"))).toBe(false);

    const allowed = await underProfile(profile, `echo ok > '${path.join(stateRoot, "probe.txt")}'`);
    expect(allowed.ok).toBe(true);
    expect(existsSync(path.join(stateRoot, "probe.txt"))).toBe(true);
  });

  it.runIf(onMac)("grants the workspace write in build mode", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-build-")));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, mode: "build" });
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);

    const allowed = await underProfile(profile, `echo ok > '${path.join(workspace, "built.txt")}'`);
    expect(allowed.ok).toBe(true);
    expect(existsSync(path.join(workspace, "built.txt"))).toBe(true);
  });

  it.runIf(onMac)("lets Homebrew runtimes load their shared libraries and Git read host configuration", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-runtime-")));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, mode: "read-only" });
    expect(profile).toContain("(allow file-read*)");

    const node = await underProfile(profile, `'${process.execPath}' --version >/dev/null`);
    expect(node).toEqual({ ok: true, stderr: "" });
    const git = await underProfile(profile, `cd '${workspace}' && /usr/bin/git config --global --list >/dev/null`);
    expect(git).toEqual({ ok: true, stderr: "" });
  });

  it.runIf(onMac)("reads a home-directory path the old allowlist never named, and still cannot write it", async () => {
    // The read grant is whole-disk, so host state outside the session (a sibling
    // project, `~/.codex` transcripts) is readable without a profile edit. Probing
    // under HOME is the point: no `$HOME/<dir>` beyond `~/.claude` was ever granted.
    const outside = realpathSync(mkdtempSync(path.join(os.homedir(), ".claude-sb-read-")));
    temporary.push(outside);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-outside-")));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);
    writeFileSync(path.join(outside, "transcript.jsonl"), "secret\n");
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, mode: "build" });

    const read = await underProfile(profile, `/bin/cat '${path.join(outside, "transcript.jsonl")}' >/dev/null`);
    expect(read).toEqual({ ok: true, stderr: "" });

    // Whole-disk READ only: Build still writes nowhere but its own workspace.
    const write = await underProfile(profile, `echo x > '${path.join(outside, "escape.txt")}'`);
    expect(write.ok).toBe(false);
    expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
  });

  it.runIf(onMac)("allows pgrep to enumerate processes via sysmond", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-pgrep-")));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, mode: "read-only" });

    // pgrep links libsysmon → com.apple.sysmond.  Before the sysmond mach-lookup
    // grant this failed with "sysmond service not found".
    const pgrep = await underProfile(profile, "/usr/bin/pgrep -l launchd");
    expect(pgrep.ok).toBe(true);
  });

  it("lets a session signal its own children but nothing else", () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-sb-")));
    temporary.push(root);
    const profile = claudeSeatbeltProfile({
      workspace: path.join(root, "ws"),
      stateRoot: path.join(root, "state"),
      mode: "build",
    });
    // A test runner's worker pool terminates workers, and `process*` does not
    // cover `signal`; the BFF that supervises the session must stay untouchable.
    expect(profile).toContain("(allow signal (target children))");
    expect(profile).not.toContain("(allow signal)");
  });
});
