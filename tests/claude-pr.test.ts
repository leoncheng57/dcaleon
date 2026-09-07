import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktree, currentBranch, originRemote, pushWorktreeBranch } from "../server/claude/worktree.js";
import { writeFileSync } from "node:fs";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { encoding: "utf8" }).trim();
}

/** A project with a real bare `origin`, so a push is exercised end to end offline. */
function projectWithOrigin(): { project: string; root: string; origin: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-pr-")));
  temporary.push(base);
  const origin = path.join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const project = path.join(base, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  writeFileSync(path.join(project, "README.md"), "hi\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "init"]);
  git(project, ["remote", "add", "origin", origin]);
  git(project, ["push", "-q", "origin", "main"]);
  return { project, root: path.join(base, "state", "worktrees"), origin };
}

describe("Claude PR plumbing", () => {
  it("parses common origin remote URL shapes into host/owner/repo", async () => {
    const { project } = projectWithOrigin();
    // A local bare path is not github; parse should still return host/owner/repo or null gracefully.
    git(project, ["remote", "set-url", "origin", "git@github.com:acme/widgets.git"]);
    expect(await originRemote(project)).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
    git(project, ["remote", "set-url", "origin", "https://github.com/acme/widgets"]);
    expect(await originRemote(project)).toEqual({ host: "github.com", owner: "acme", repo: "widgets" });
    git(project, ["remote", "set-url", "origin", "https://gitlab.com/group/sub/proj.git"]);
    expect(await originRemote(project)).toEqual({ host: "gitlab.com", owner: "group", repo: "sub/proj" });
  });

  it("reports the project's current branch as the PR base", async () => {
    const { project } = projectWithOrigin();
    expect(await currentBranch(project)).toBe("main");
  });

  it("commits pending worktree work and pushes the branch to origin", async () => {
    const { project, root, origin } = projectWithOrigin();
    const wt = await createWorktree(project, root, "pr-1");
    writeFileSync(path.join(wt.directory, "feature.txt"), "new feature\n");
    await pushWorktreeBranch(wt, "session work");
    // The branch now exists on origin with the commit.
    const remoteBranches = execFileSync("git", ["-C", origin, "branch", "--format=%(refname:short)"], { encoding: "utf8" });
    expect(remoteBranches).toContain("claude/pr-1");
    const log = execFileSync("git", ["-C", origin, "log", "--oneline", "claude/pr-1"], { encoding: "utf8" });
    expect(log).toContain("session work");
  });

  it("refuses to push a branch with no commits", async () => {
    const { project, root } = projectWithOrigin();
    const wt = await createWorktree(project, root, "empty");
    await expect(pushWorktreeBranch(wt, "nothing")).rejects.toThrow(/no commits to push/u);
  });

  it("returns null for a project without an origin remote", async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-noremote-")));
    temporary.push(base);
    execFileSync("git", ["init", "-q", base]);
    expect(await originRemote(base)).toBeNull();
    expect(existsSync(base)).toBe(true);
  });
});
