import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorktree, isDirty, mergeWorktree, removeWorktree, workspaceChanges } from "../server/claude/worktree.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { encoding: "utf8" }).trim();
}

/** A real repository with one commit, the way a project looks before a session. */
function project(): { project: string; root: string } {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-wt-")));
  temporary.push(base);
  const projectDir = path.join(base, "project");
  const root = path.join(base, "state", "worktrees");
  execFileSync("git", ["init", "-q", "-b", "main", projectDir]);
  writeFileSync(path.join(projectDir, "README.md"), "hello\n");
  git(projectDir, ["add", "-A"]);
  git(projectDir, ["commit", "-q", "-m", "init"]);
  return { project: projectDir, root };
}

describe("Claude worktree isolation", () => {
  it("creates an isolated worktree on its own branch off HEAD, outside the project", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "abc-123");
    expect(wt.branch).toBe("claude/abc-123");
    expect(wt.baseCommit).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(wt.directory.startsWith(realpathSync(root))).toBe(true);
    expect(path.relative(dir, wt.directory).startsWith("..")).toBe(true);
    expect(existsSync(path.join(wt.directory, "README.md"))).toBe(true);
    expect(git(dir, ["branch", "--list", "claude/abc-123"])).toContain("claude/abc-123");
  });

  it("reports the worktree's changes against the base commit, including untracked files", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "chg");
    writeFileSync(path.join(wt.directory, "README.md"), "hello\nmore\n");
    writeFileSync(path.join(wt.directory, "new.txt"), "brand new\n");
    const changes = await workspaceChanges(wt.directory, wt.baseCommit);
    expect(changes.files.map((f) => f.path).sort()).toEqual(["README.md", "new.txt"]);
    expect(changes.diff).toContain("+more");
    expect(changes.diff).toContain("brand new");
    expect(changes.truncated).toBe(false);
    // The project itself is untouched by work in the worktree.
    expect(await isDirty(dir)).toBe(false);
  });

  it("merges the session branch into a clean project and can then remove the worktree", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "mrg");
    writeFileSync(path.join(wt.directory, "feature.txt"), "done\n");
    const { mergeCommit } = await mergeWorktree(wt, "merge session");
    expect(mergeCommit).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(existsSync(path.join(dir, "feature.txt"))).toBe(true);
    await removeWorktree(wt);
    expect(existsSync(wt.directory)).toBe(false);
    expect(git(dir, ["branch", "--list", "claude/mrg"])).toBe("");
  });

  it("refuses to merge into a project with uncommitted changes", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "dirty");
    writeFileSync(path.join(wt.directory, "x.txt"), "x\n");
    writeFileSync(path.join(dir, "README.md"), "human is mid-edit\n"); // dirty project
    await expect(mergeWorktree(wt, "m")).rejects.toThrow(/uncommitted changes/u);
    // Nothing merged, the human's edit is intact.
    expect(git(dir, ["status", "--porcelain"])).toContain("README.md");
  });

  it("refuses to merge a branch with nothing to merge", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "empty");
    await expect(mergeWorktree(wt, "m")).rejects.toThrow(/no changes to merge/u);
  });

  it("discards a worktree without touching the project", async () => {
    const { project: dir, root } = project();
    const wt = await createWorktree(dir, root, "disc");
    writeFileSync(path.join(wt.directory, "scratch.txt"), "throwaway\n");
    await removeWorktree(wt);
    expect(existsSync(wt.directory)).toBe(false);
    expect(existsSync(path.join(dir, "scratch.txt"))).toBe(false);
    expect(await isDirty(dir)).toBe(false);
  });

  it("refuses worktree isolation for a directory that is not a git repository", async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-nogit-")));
    temporary.push(base);
    await expect(createWorktree(base, path.join(base, "wt"), "x")).rejects.toThrow(/not a git repository/u);
  });
});
