import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
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
  const resolved = await realpath(directory);
  await linkDependencies(project, resolved);
  await copyLocalEnvironment(project, resolved);
  return { directory: resolved, branch, baseCommit, project };
}

/**
 * Copy the project's root `.env*` files into the worktree.
 *
 * Local environment files are gitignored by convention, and `git worktree add`
 * materialises tracked files only — so a fresh worktree of a repo that needs
 * credentials starts without them, and the first command an agent runs fails on
 * missing configuration before it can do any work. That is the same gap
 * `linkDependencies` closes for `node_modules`.
 *
 * `COPYFILE_EXCL` makes "already there" a skip rather than an overwrite, which
 * leaves anything tracked (`.env.example`) exactly as git checked it out.
 *
 * Best-effort for the same reason as `linkDependencies`: a session without
 * local env is still a usable session, so failure must not fail creation.
 */
async function copyLocalEnvironment(project: string, worktree: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(project);
  } catch {
    return; // unreadable project root; the worktree is still usable
  }
  for (const entry of entries) {
    if (!entry.startsWith(".env")) continue;
    const source = path.join(project, entry);
    try {
      if (!(await stat(source)).isFile()) continue;
      await copyFile(source, path.join(worktree, entry), fsConstants.COPYFILE_EXCL);
    } catch {
      // already present, or unreadable; each entry is independent
    }
  }
}

/**
 * Make the project's installed dependencies resolvable from the worktree.
 *
 * `git worktree add` copies tracked files only, so a fresh worktree has no
 * `node_modules` and nothing in it can run — an agent cannot typecheck or test
 * the change it just made, which is how an unverified change reaches CI.
 * Seatbelt grants read of the whole disk, so the packages are readable; only
 * the entry point was missing.
 *
 * `node_modules` is a real directory of per-entry symlinks rather than one
 * symlink to the project's: tools write scratch state *inside* `node_modules`
 * (vite's `.vite-temp`, for one), and a single symlink would aim those writes
 * at the project, which is read-only to a session. Linking per entry keeps the
 * writes in the worktree.
 *
 * Best-effort: a session that cannot link dependencies is still a usable
 * session, so failure here must not fail worktree creation.
 */
async function linkDependencies(project: string, worktree: string): Promise<void> {
  const source = path.join(project, "node_modules");
  try {
    if (!(await stat(source)).isDirectory()) return;
  } catch {
    return; // project has no installed dependencies; nothing to link
  }
  const target = path.join(worktree, "node_modules");
  try {
    await mkdir(target, { recursive: true });
    // Includes dotted entries (`.bin`) and scope directories (`@scope`), each of
    // which is linked whole.
    for (const entry of await readdir(source)) {
      await symlink(path.join(source, entry), path.join(target, entry)).catch(() => {});
    }
  } catch {
    // Leave the worktree as-is; callers treat dependencies as a convenience.
  }
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

export interface GitRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Parse `origin` into host/owner/repo; null when there is no usable remote. */
export async function originRemote(project: string): Promise<GitRemote | null> {
  let url: string;
  try {
    url = (await git(project, ["remote", "get-url", "origin"])).trim();
  } catch {
    return null;
  }
  // git@host:owner/repo(.git)  or  https://host/owner/repo(.git)
  const ssh = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  const match = ssh ?? https;
  if (!match) return null;
  const [owner, ...rest] = match[2].split("/");
  const repo = rest.join("/");
  if (!owner || !repo) return null;
  return { host: match[1], owner, repo };
}

/** The branch the project's HEAD is on — the natural PR base. */
export async function currentBranch(project: string): Promise<string> {
  return (await git(project, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/**
 * Push a session's worktree branch to `origin`, committing any pending worktree
 * changes first (so nothing the agent wrote is left behind). Runs in the BFF on
 * host git credentials — never inside the Seatbelt sandbox.
 */
export async function pushWorktreeBranch(worktree: ClaudeWorktree, message: string): Promise<void> {
  if (await isDirty(worktree.directory)) {
    await git(worktree.directory, ["add", "-A"]);
    await git(worktree.directory, ["-c", "user.name=custom-dca", "-c", "user.email=custom-dca@localhost", "commit", "-q", "-m", message]);
  }
  const ahead = (await git(worktree.project, ["rev-list", "--count", `HEAD..${worktree.branch}`])).trim();
  if (ahead === "0") throw new Error("session branch has no commits to push");
  await git(worktree.directory, ["push", "-u", "origin", worktree.branch]);
}
