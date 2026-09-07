import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeProjectKey, deleteClaudeMemory, listClaudeMemory } from "../server/claude/memory.js";

const temporary: string[] = [];
const previousRoot = process.env.CLAUDE_PROJECTS_DIR;
afterEach(async () => {
  process.env.CLAUDE_PROJECTS_DIR = previousRoot;
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-memory-"));
  temporary.push(root);
  process.env.CLAUDE_PROJECTS_DIR = root;
  const directory = "/Users/ada/Projects/example";
  const memory = path.join(root, claudeProjectKey(directory), "memory");
  await mkdir(memory, { recursive: true });
  await writeFile(path.join(memory, "MEMORY.md"), "- [A](user-role.md)\n");
  await writeFile(path.join(memory, "user-role.md"), "---\ndescription: Senior engineer\nmetadata:\n  type: user\n---\nUse concise explanations.\n");
  await writeFile(path.join(memory, "project.md"), "---\ntype: project\n---\nShip Friday.\n");
  return { directory, memory };
}

describe("Claude project memory", () => {
  it("derives Claude's filesystem project key", () => {
    expect(claudeProjectKey("/Users/ada/Projects/example")).toBe("-Users-ada-Projects-example");
  });

  it("lists the index and frontmatter-backed entries without following symlinks", async () => {
    const { directory, memory } = await fixture();
    await symlink("/etc/passwd", path.join(memory, "escape.md"));
    await expect(listClaudeMemory(directory)).resolves.toMatchObject({
      index: "- [A](user-role.md)\n",
      truncated: false,
      entries: [
        { filename: "project.md", type: "project", body: "Ship Friday.\n" },
        { filename: "user-role.md", type: "user", description: "Senior engineer", body: "Use concise explanations.\n" },
      ],
    });
  });

  it("deletes only a direct memory entry and never the index", async () => {
    const { directory, memory } = await fixture();
    await deleteClaudeMemory(directory, "project.md");
    await expect(listClaudeMemory(directory)).resolves.toMatchObject({ entries: [expect.objectContaining({ filename: "user-role.md" })] });
    await expect(deleteClaudeMemory(directory, "MEMORY.md")).rejects.toThrow(/filename/u);
    await expect(deleteClaudeMemory(directory, "../user-role.md")).rejects.toThrow(/filename/u);
    await expect(deleteClaudeMemory(directory, "missing.md")).rejects.toThrow(/not found/u);
    await expect(writeFile(path.join(memory, "MEMORY.md"), "still here\n")).resolves.toBeUndefined();
  });
});
