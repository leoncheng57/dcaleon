import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class PathError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PathError";
  }
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(expandHome(env.PROJECTS_DIR || "~/Documents/Projects"));
}

export function worktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    expandHome(env.OPENCODE_WORKTREE_ROOT || "~/.local/share/opencode/worktree"),
  );
}

/**
 * Canonicalise a project before forwarding it to OpenCode.
 *
 * OpenCode's file routes do not apply agent permission rules. Checking only
 * for an absolute path would expose every readable host file to a browser on
 * the tailnet. realpath also closes symlink escapes from PROJECTS_DIR.
 */
export async function requireProjectDirectory(
  value: unknown,
  root = projectsRoot(),
): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new PathError(400, "a 'directory' query parameter is required");
  }
  if (!path.isAbsolute(value)) {
    throw new PathError(400, "'directory' must be an absolute path");
  }

  let canonicalRoot: string;
  let canonicalDirectory: string;
  try {
    [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(value)]);
  } catch {
    throw new PathError(400, "'directory' must identify an existing project");
  }
  const directoryStat = await stat(canonicalDirectory).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    throw new PathError(400, "'directory' must identify an existing project directory");
  }
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  if (!relative) {
    throw new PathError(403, "'directory' must identify a project below the configured root");
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathError(403, `'directory' is outside PROJECTS_DIR (${canonicalRoot})`);
  }
  return canonicalDirectory;
}

export async function requireWorkspaceDirectory(value: unknown): Promise<string> {
  try {
    return await requireProjectDirectory(value);
  } catch (error) {
    if (!(error instanceof PathError) || error.status !== 403) throw error;
  }
  return requireProjectDirectory(value, worktreesRoot()).catch(() => {
    throw new PathError(403, `'directory' is outside PROJECTS_DIR (${projectsRoot()}) and the OpenCode worktree root — update PROJECTS_DIR in .env to a parent that contains this path`);
  });
}

/** Normalise a workspace-relative path and reject traversal/absolute paths. */
export function requireRelativePath(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || path.isAbsolute(value)) {
    throw new PathError(400, "'path' must be workspace-relative");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new PathError(400, "'path' must not traverse outside the workspace");
  }
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

const SENSITIVE_SEGMENT = /^(\.git|\.env(?:\..*)?|\.ssh|\.aws|credentials?|id_rsa|id_ed25519)$/i;

export function isSensitiveWorkspacePath(relativePath: string): boolean {
  return relativePath.split("/").filter(Boolean).some((segment) => SENSITIVE_SEGMENT.test(segment));
}

/** Resolve a child path, reject symlink escapes, ignored files and common secrets. */
export async function requireReadableWorkspacePath(
  directory: string,
  relativePath: string,
): Promise<string> {
  if (isSensitiveWorkspacePath(relativePath)) {
    throw new PathError(403, "sensitive workspace paths are not readable through the API");
  }
  if (!relativePath) return relativePath;

  let workspace: string;
  let target: string;
  try {
    [workspace, target] = await Promise.all([
      realpath(directory),
      realpath(path.join(directory, relativePath)),
    ]);
  } catch {
    throw new PathError(404, "workspace path not found");
  }
  const containment = path.relative(workspace, target);
  if (containment.startsWith("..") || path.isAbsolute(containment)) {
    throw new PathError(403, "workspace path resolves outside the project");
  }
  const canonicalRelative = containment.replaceAll(path.sep, "/");
  if (isSensitiveWorkspacePath(canonicalRelative)) {
    throw new PathError(403, "sensitive workspace paths are not readable through the API");
  }

  try {
    await execFileAsync("git", ["-C", workspace, "check-ignore", "-q", "--", canonicalRelative], {
      timeout: 5_000,
    });
    throw new PathError(403, "ignored workspace paths are not readable through the API");
  } catch (error) {
    if (error instanceof PathError) throw error;
    // git check-ignore exits 1 for a visible file and 128 outside a git repo.
    const code = (error as { code?: unknown }).code;
    if (code !== 1 && code !== 128) throw error;
  }
  // Callers must forward this canonical relative target, never the original
  // symlink alias; otherwise the link could be swapped after validation.
  return canonicalRelative;
}
