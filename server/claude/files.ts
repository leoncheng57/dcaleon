import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { PathError, isSensitiveWorkspacePath, requireReadableWorkspacePath } from "../paths.js";
import type { WorkspaceFile, WorkspaceNode } from "../opencode/workspace.js";

// A read-only file browser over a Claude session's directory, served from the
// LOCAL filesystem (there is no opencode server behind this lane). Returns the
// exact shapes the opencode workspace client components already consume, so the
// tree renderer and CodeViewer are reused unchanged.

export const CLAUDE_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const CLAUDE_TREE_MAX_ENTRIES = 2_000;

// Never descend into these; they are noise or handled by the sensitive-path guard.
const EXCLUDED_DIRS = new Set([".git", "node_modules", ".venv", "vendor", "dist", "build", "target", "__pycache__", ".next", ".turbo", ".cache"]);

function textExtension(relativePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|txt|css|scss|html|yml|yaml|toml|sh|bash|zsh|py|rb|go|rs|java|kt|c|h|cpp|hpp|sql|xml|svg|env|gitignore|lock|cfg|ini|conf|Dockerfile|makefile)$/i.test(relativePath)
    || /(^|\/)(Dockerfile|Makefile|README|LICENSE|\.gitignore|\.env\.example)$/i.test(relativePath);
}

/** One directory level of the session's tree — identical shape to opencode's `/file`. */
export async function listClaudeTree(directory: string, requestedPath: string): Promise<{ path: string; dirs: WorkspaceNode[]; files: WorkspaceNode[]; nextPageId: null }> {
  // Confinement: an empty path is the root; anything else must resolve inside the dir.
  const relative = requestedPath ? await requireReadableWorkspacePath(directory, requestedPath) : "";
  const absolute = path.join(directory, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    throw new PathError(404, "workspace path not found");
  }
  const dirs: WorkspaceNode[] = [];
  const files: WorkspaceNode[] = [];
  for (const entry of entries) {
    if (dirs.length + files.length >= CLAUDE_TREE_MAX_ENTRIES) break;
    if (entry.isSymbolicLink()) continue; // never follow symlinks out of the tree
    const nodePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (isSensitiveWorkspacePath(nodePath)) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      dirs.push({ name: entry.name, path: nodePath, type: "directory", ignored: false });
    } else if (entry.isFile()) {
      files.push({ name: entry.name, path: nodePath, type: "file", ignored: false });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { path: relative, dirs, files, nextPageId: null };
}

/** One file's content — identical shape to opencode's `/file/content`. */
export async function readClaudeFile(directory: string, requestedPath: string): Promise<WorkspaceFile> {
  const relative = await requireReadableWorkspacePath(directory, requestedPath);
  if (!relative) throw new PathError(400, "'path' is required");
  const absolute = path.join(directory, relative);
  const metadata = await stat(absolute).catch(() => { throw new PathError(404, "workspace path not found"); });
  if (!metadata.isFile()) throw new PathError(400, "path is not a file");
  if (metadata.size > CLAUDE_FILE_MAX_BYTES) {
    return { path: relative, type: "binary", content: "", encoding: "base64", mimeType: "application/octet-stream" };
  }
  const buffer = await readFile(absolute);
  // Binary if it has a NUL byte or fails to round-trip as UTF-8 (and isn't an
  // obviously-text extension).
  const hasNul = buffer.includes(0);
  const asText = buffer.toString("utf8");
  const roundTrips = Buffer.from(asText, "utf8").equals(buffer);
  const isText = !hasNul && (roundTrips || textExtension(relative));
  if (isText) return { path: relative, type: "text", content: asText };
  return { path: relative, type: "binary", content: buffer.toString("base64"), encoding: "base64" };
}
