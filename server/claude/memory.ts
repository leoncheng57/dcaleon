import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAX_ENTRIES = 100;
const MAX_ENTRY_CHARACTERS = 100_000;
const MAX_INDEX_CHARACTERS = 100_000;

export interface ClaudeMemoryEntry {
  filename: string;
  type: string;
  description?: string;
  body: string;
  truncated?: true;
}

export interface ClaudeMemorySnapshot {
  index: string;
  indexTruncated?: true;
  entries: ClaudeMemoryEntry[];
  truncated: boolean;
}

/** Claude Code uses a filesystem-safe spelling of the absolute project path. */
export function claudeProjectKey(directory: string): string {
  return directory.replaceAll(path.sep, "-");
}

function memoryRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

function memoryDirectory(directory: string): string {
  return path.join(memoryRoot(), claudeProjectKey(directory), "memory");
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { data: {}, body: normalized };
  const data: Record<string, string> = {};
  let metadata = false;
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    const nested = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (match) {
      metadata = match[1].toLowerCase() === "metadata" && !match[2];
      data[match[1].toLowerCase()] = match[2].replace(/^['\"]|['\"]$/g, "").trim();
    } else if (metadata && nested) {
      data[`metadata.${nested[1].toLowerCase()}`] = nested[2].replace(/^['\"]|['\"]$/g, "").trim();
    }
  }
  return { data, body: normalized.slice(end + 5) };
}

function bounded(raw: string, maximum: number): { value: string; truncated?: true } {
  return raw.length > maximum ? { value: raw.slice(0, maximum), truncated: true } : { value: raw };
}

async function readableFile(file: string): Promise<boolean> {
  const stats = await lstat(file).catch(() => null);
  return !!stats?.isFile() && !stats.isSymbolicLink();
}

export async function listClaudeMemory(directory: string): Promise<ClaudeMemorySnapshot> {
  const root = memoryDirectory(directory);
  const files = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const names = files
    .filter((file) => file.isFile() && !file.isSymbolicLink() && file.name !== "MEMORY.md" && file.name.endsWith(".md"))
    .map((file) => file.name)
    .sort((a, b) => a.localeCompare(b));
  const indexPath = path.join(root, "MEMORY.md");
  const indexRaw = await (await readableFile(indexPath) ? readFile(indexPath, "utf8") : Promise.resolve(""));
  const index = bounded(indexRaw, MAX_INDEX_CHARACTERS);
  const entries = await Promise.all(names.slice(0, MAX_ENTRIES).map(async (filename) => {
    const raw = await readFile(path.join(root, filename), "utf8");
    const parsed = parseFrontmatter(raw);
    const body = bounded(parsed.body, MAX_ENTRY_CHARACTERS);
    return {
      filename,
      type: parsed.data.type || parsed.data["metadata.type"] || "other",
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      body: body.value,
      ...(body.truncated ? { truncated: true as const } : {}),
    };
  }));
  return { index: index.value, ...(index.truncated ? { indexTruncated: true as const } : {}), entries, truncated: names.length > MAX_ENTRIES };
}

/** Deletes exactly one direct, regular Markdown entry; never the MEMORY.md index. */
export async function deleteClaudeMemory(directory: string, filename: unknown): Promise<void> {
  if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(filename) || filename === "MEMORY.md") {
    throw new Error("a memory filename must name one Markdown entry");
  }
  // Canonicalise the parent before unlinking so a replaced memory directory
  // cannot redirect this project-scoped action elsewhere on the host.
  const parent = await realpath(memoryDirectory(directory));
  const target = path.join(parent, filename);
  if (!await readableFile(target)) throw new Error("memory entry not found");
  await unlink(target);
}
