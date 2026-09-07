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
    writeFileSync(path.join(root, "binary"), "");
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, binaryPath: path.join(root, "binary"), mode: "read-only" });
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
    writeFileSync(path.join(root, "binary"), "");
    const profile = claudeSeatbeltProfile({ workspace, stateRoot, binaryPath: path.join(root, "binary"), mode: "build" });
    await run("/bin/mkdir", ["-p", workspace, stateRoot]);

    const allowed = await underProfile(profile, `echo ok > '${path.join(workspace, "built.txt")}'`);
    expect(allowed.ok).toBe(true);
    expect(existsSync(path.join(workspace, "built.txt"))).toBe(true);
  });
});
