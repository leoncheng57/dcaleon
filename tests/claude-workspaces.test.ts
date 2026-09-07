import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listClaudeWorkspaces, resolveClaudeWorkspace } from "../server/claude/workspaces.js";
import type { ClaudeConfig } from "../server/claude/config.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function repo(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(path.join(directory, "README.md"), "x\n");
}

function config(root: string, projectsRoot: string | null, workspaces: ClaudeConfig["workspaces"] = []): ClaudeConfig {
  return {
    enabled: true, configured: true, binaryPath: "/bin/claude", cliVersion: "1.0.0",
    sessionRoot: path.join(root, "state", "sessions"), ledgerFile: path.join(root, "state", "ledger.json"),
    sessionsFile: path.join(root, "state", "sessions.json"), worktreeRoot: path.join(root, "state", "worktrees"),
    projectsRoot, sandbox: "test-unsafe", presets: [], workspaces, errors: [],
  };
}

describe("Claude workspace resolution", () => {
  it("offers discovered git repositories under the projects root, never the runtime's own state", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-ws-")));
    temporary.push(root);
    repo(path.join(root, "alpha"));
    repo(path.join(root, "beta"));
    mkdirSync(path.join(root, "plain-dir")); // not a repository
    // The state dir lives INSIDE the projects root and even contains a repo — it must never be offered.
    repo(path.join(root, "state", "worktrees", "some-session"));
    const found = await listClaudeWorkspaces(config(root, root));
    expect(found.map((item) => item.label).sort()).toEqual(["alpha", "beta"]);
    expect(found.every((item) => item.source === "discovered" && item.device > 0)).toBe(true);
    expect(found.some((item) => item.directory.includes("/state/"))).toBe(false);
  });

  it("lists the static allowlist first and resolves by id with an identity", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-ws-")));
    temporary.push(root);
    repo(path.join(root, "alpha"));
    const allow = { id: "pinned", label: "Pinned", directory: path.join(root, "alpha"), device: 1, inode: 2 };
    const found = await listClaudeWorkspaces(config(root, root, [allow]));
    expect(found[0]).toMatchObject({ id: "pinned", source: "allowlist" });
    // The same directory is not offered twice under a discovered id.
    expect(found.filter((item) => item.directory === allow.directory)).toHaveLength(1);
    expect(await resolveClaudeWorkspace(config(root, root, [allow]), "pinned")).toMatchObject({ id: "pinned" });
    expect(await resolveClaudeWorkspace(config(root, root, [allow]), "nope")).toBeUndefined();
    expect(await resolveClaudeWorkspace(config(root, root, [allow]), 42)).toBeUndefined();
  });

  it("is allowlist-only when discovery is disabled", async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-ws-")));
    temporary.push(root);
    repo(path.join(root, "alpha"));
    expect(await listClaudeWorkspaces(config(root, null))).toEqual([]);
  });
});
