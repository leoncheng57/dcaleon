import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Bounded so a huge diff cannot flood the BFF or the browser.
export const CHANGES_MAX_DIFF_BYTES = 512 * 1024;
export const CHANGES_MAX_FILES = 500;

export interface ClaudeWorktree {
  /** The worktree's working directory (the session's cwd). */
  directory: string;
  /** Branch the worktree checked out: `claude/<session-uuid>`. */
  branch: string;
  /** Commit the branch started from; diffs are taken against it. */
  baseCommit: string;
  /** The project the worktree belongs to (owns the shared `.git`). */
  project: string;
}

export interface ChangedFile {
  path: string;
  status: string;
}

export interface WorkspaceChanges {
  files: ChangedFile[];
  diff: string;
  truncated: boolean;
}

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer });
  return stdout;
}

export async function isGitRepository(directory: string): Promise<boolean> {
  try {
    const out = await git(directory, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** True when the project has uncommitted changes (staged, unstaged, or untracked). */
export async function isDirty(directory: string): Promise<boolean> {
  const status = await git(directory, ["status", "--porcelain"]);
  return status.trim().length > 0;
}

/**
 * Create an isolated worktree for one session, on its own branch off the
 * project's HEAD. The worktree lives under `root` (inside Claude state), never
 * inside the project, so Seatbelt can grant it as a distinct write path.
 */
export async function createWorktree(project: string, root: string, sessionUuid: string): Promise<ClaudeWorktree> {
  if (!await isGitRepository(project)) throw new Error("workspace is not a git repository; worktree isolation needs one");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(await realpath(root), sessionUuid);
  const branch = `claude/${sessionUuid}`;
  const baseCommit = (await git(project, ["rev-parse", "HEAD"])).trim();
  await git(project, ["worktree", "add", "-b", branch, directory, "HEAD"]);
  return { directory: await realpath(directory), branch, baseCommit, project };
}

/**
 * Changes made in a directory. For a worktree, diff against its base commit so
 * commits the agent made inside the worktree are included; for a direct
 * session, diff the working tree against HEAD.
 */
export async function workspaceChanges(directory: string, baseCommit?: string): Promise<WorkspaceChanges> {
  const status = await git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files: ChangedFile[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    if (files.length >= CHANGES_MAX_FILES) break;
    files.push({ status: line.slice(0, 2).trim() || "??", path: line.slice(3).trim() });
  }
  // Committed-but-uncommitted-to-base changes only exist in worktree mode.
  if (baseCommit) {
    const committed = await git(directory, ["diff", "--name-status", `${baseCommit}..HEAD`]);
    for (const line of committed.split("\n")) {
      if (!line.trim() || files.length >= CHANGES_MAX_FILES) continue;
      const [statusCode, ...rest] = line.split("\t");
      const filePath = rest.at(-1) ?? "";
      if (filePath && !files.some((item) => item.path === filePath)) files.push({ status: statusCode.trim(), path: filePath });
    }
  }
  // Untracked files never appear in `git diff`; stage them into the index view
  // read-only via --no-index is noisy, so include them through `git add -N`-free
  // means: diff tracked changes, then append untracked file contents as new-file diffs.
  let diff = baseCommit
    ? await git(directory, ["diff", baseCommit], CHANGES_MAX_DIFF_BYTES * 2)
    : await git(directory, ["diff", "HEAD"], CHANGES_MAX_DIFF_BYTES * 2);
  for (const file of files) {
    if (file.status !== "??") continue;
    try {
      const untracked = await git(directory, ["diff", "--no-index", "--", "/dev/null", file.path], CHANGES_MAX_DIFF_BYTES * 2).catch((error: { stdout?: string }) => error.stdout ?? "");
      diff += untracked;
    } catch {
      // unreadable untracked file; the file list still names it
    }
    if (diff.length > CHANGES_MAX_DIFF_BYTES) break;
  }
  const truncated = diff.length > CHANGES_MAX_DIFF_BYTES;
  return { files, diff: truncated ? diff.slice(0, CHANGES_MAX_DIFF_BYTES) : diff, truncated };
}

/**
 * Merge a session's branch into the project. Refuses when the project's own
 * working tree is dirty — a merge must never be confused with a human's
 * in-progress edits. Uncommitted worktree changes are committed first so nothing
 * the agent wrote is lost.
 */
export async function mergeWorktree(worktree: ClaudeWorktree, message: string): Promise<{ mergeCommit: string }> {
  if (await isDirty(worktree.project)) throw new Error("project working tree has uncommitted changes; commit or stash them before merging");
  if (await isDirty(worktree.directory)) {
    await git(worktree.directory, ["add", "-A"]);
    await git(worktree.directory, ["-c", "user.name=custom-dca", "-c", "user.email=custom-dca@localhost", "commit", "-q", "-m", message]);
  }
  const ahead = (await git(worktree.project, ["rev-list", "--count", `HEAD..${worktree.branch}`])).trim();
  if (ahead === "0") throw new Error("session branch has no changes to merge");
  await git(worktree.project, ["-c", "user.name=custom-dca", "-c", "user.email=custom-dca@localhost", "merge", "--no-ff", "-q", "-m", message, worktree.branch]);
  return { mergeCommit: (await git(worktree.project, ["rev-parse", "HEAD"])).trim() };
}

/** Remove the worktree and its branch. Safe to call after a merge or to discard. */
export async function removeWorktree(worktree: ClaudeWorktree): Promise<void> {
  await git(worktree.project, ["worktree", "remove", "--force", worktree.directory]).catch(async () => {
    // If git lost track of it, remove the directory and prune.
    await rm(worktree.directory, { recursive: true, force: true });
    await git(worktree.project, ["worktree", "prune"]).catch(() => undefined);
  });
  await git(worktree.project, ["branch", "-D", worktree.branch]).catch(() => undefined);
}

export async function worktreeExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
