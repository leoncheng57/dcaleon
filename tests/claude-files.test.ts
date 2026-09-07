import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listClaudeTree, readClaudeFile, resolveClaudeReferences } from "../server/claude/files.js";
import { PathError } from "../server/paths.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-files-"));
  temporary.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "# Title\nhello\n");
  await writeFile(path.join(root, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  await writeFile(path.join(root, ".env"), "SECRET=shh\n");
  await writeFile(path.join(root, "node_modules", "dep.js"), "noise\n");
  return root;
}

describe("Claude files browser", () => {
  it("lists a directory level, hiding .git, node_modules and sensitive files", async () => {
    const root = await workspace();
    const top = await listClaudeTree(root, "");
    expect(top.dirs.map((d) => d.name)).toEqual(["src"]); // .git and node_modules excluded
    expect(top.files.map((f) => f.name)).toEqual(["README.md"]); // .env excluded
    expect(top.dirs[0]).toMatchObject({ path: "src", type: "directory", ignored: false });
    const src = await listClaudeTree(root, "src");
    expect(src.files.map((f) => f.name).sort()).toEqual(["index.ts", "logo.png"]);
  });

  it("reads a text file and base64-encodes a binary one", async () => {
    const root = await workspace();
    const text = await readClaudeFile(root, "src/index.ts");
    expect(text).toMatchObject({ path: "src/index.ts", type: "text" });
    expect(text.content).toContain("export const x");
    const binary = await readClaudeFile(root, "src/logo.png");
    expect(binary.type).toBe("binary");
    expect(binary.encoding).toBe("base64");
  });

  it("refuses path traversal, absolute paths, and symlink escapes", async () => {
    const root = await workspace();
    const secret = await mkdtemp(path.join(os.tmpdir(), "claude-outside-"));
    temporary.push(secret);
    await writeFile(path.join(secret, "loot.txt"), "loot\n");
    await symlink(path.join(secret, "loot.txt"), path.join(root, "escape.txt"));

    await expect(readClaudeFile(root, "../../etc/passwd")).rejects.toBeInstanceOf(PathError);
    await expect(readClaudeFile(root, "/etc/passwd")).rejects.toBeInstanceOf(PathError);
    await expect(readClaudeFile(root, "escape.txt")).rejects.toThrow(/outside the project/u);
    // Sensitive files are refused even by exact name.
    await expect(readClaudeFile(root, ".env")).rejects.toThrow(/sensitive/u);
    // A traversing tree request is refused too.
    await expect(listClaudeTree(root, "../..")).rejects.toBeInstanceOf(PathError);
  });

  it("caps a very large file rather than streaming it whole", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 0x20));
    const big = await readClaudeFile(root, "big.bin");
    expect(big.type).toBe("binary");
    expect(big.content).toBe(""); // over the cap: named, not delivered
  });
});

describe("Claude reference resolution", () => {
  it("marks readable files openable and everything else inert", async () => {
    const root = await workspace();
    const references = await resolveClaudeReferences(root, [
      "src/index.ts", // a real file → openable
      "README.md", // a real file → openable
      "src", // a directory, not a file → missing
      "does/not/exist.ts", // absent → missing
      ".env", // sensitive → forbidden
    ]);
    const byPath = Object.fromEntries(references.map((r) => [r.path, r]));
    expect(byPath["src/index.ts"]).toEqual({ path: "src/index.ts", status: "file", resolvedPath: "src/index.ts" });
    expect(byPath["README.md"].status).toBe("file");
    expect(byPath["src"].status).toBe("missing");
    expect(byPath["does/not/exist.ts"].status).toBe("missing");
    expect(byPath[".env"].status).toBe("forbidden");
  });

  it("returns the canonical relative path through a symlinked directory alias", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "note.txt"), "hi\n");
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    const [reference] = await resolveClaudeReferences(root, ["alias/note.txt"]);
    // Resolves inside the project; the canonical target replaces the alias.
    expect(reference.status).toBe("file");
    expect(reference.resolvedPath).toBe("real/note.txt");
  });

  it("bounds the number of candidates it will validate", async () => {
    const root = await workspace();
    const many = Array.from({ length: 300 }, (_, index) => `missing-${index}.ts`);
    const references = await resolveClaudeReferences(root, many);
    expect(references.length).toBe(200); // CLAUDE_REFERENCE_MAX
  });
});
