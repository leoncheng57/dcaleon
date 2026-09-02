import { stat } from "node:fs/promises";
import path from "node:path";

import { discoverProjects } from "../projects.js";
import type { ClaudeConfig, ClaudeWorkspace } from "./config.js";

export interface ResolvedWorkspace extends ClaudeWorkspace {
  source: "allowlist" | "discovered";
  repository: boolean;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
}

/**
 * The workspaces a Claude session may run in: the static allowlist plus, when a
 * projects root is configured, every git repository discovered under it. Every
 * entry carries a dev/inode identity so a later swap of the path is detected.
 */
export async function listClaudeWorkspaces(config: ClaudeConfig): Promise<ResolvedWorkspace[]> {
  const result: ResolvedWorkspace[] = config.workspaces.map((item) => ({ ...item, source: "allowlist", repository: true }));
  if (!config.projectsRoot) return result;
  let discovery;
  try {
    discovery = await discoverProjects({ root: config.projectsRoot, excludedWorktreesRoot: config.worktreeRoot });
  } catch {
    return result;
  }
  const seen = new Set(result.map((item) => item.id));
  const stateRoot = path.dirname(config.sessionRoot);
  for (const project of discovery.projects) {
    if (project.kind !== "repository") continue;
    const relative = path.relative(stateRoot, project.directory);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) continue;
    if (result.some((item) => item.directory === project.directory)) continue;
    let id = `proj-${safeId(project.relativePath)}`;
    let suffix = 2;
    while (seen.has(id)) id = `proj-${safeId(project.relativePath)}-${suffix++}`;
    seen.add(id);
    try {
      const metadata = await stat(project.directory);
      result.push({ id, label: project.name, directory: project.directory, device: metadata.dev, inode: metadata.ino, source: "discovered", repository: true });
    } catch {
      // vanished mid-scan
    }
  }
  return result;
}

export async function resolveClaudeWorkspace(config: ClaudeConfig, id: unknown): Promise<ResolvedWorkspace | undefined> {
  if (typeof id !== "string") return undefined;
  return (await listClaudeWorkspaces(config)).find((item) => item.id === id);
}
