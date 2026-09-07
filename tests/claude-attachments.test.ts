import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeAttachmentError, MAX_CLAUDE_IMAGE_BYTES, stageClaudeImages } from "../server/claude/attachments.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Claude image staging", () => {
  it("writes decoded images under the private session root with generated names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-images-"));
    temporary.push(root);
    const staged = await stageClaudeImages(root, "session-id", [{ mime: "image/png", data: "data:image/png;base64,aGVsbG8=" }]);
    expect(staged.directory).toContain(path.join(root, "attachments", "session-id"));
    expect(staged.paths[0]).toMatch(/image-1\.png$/u);
    await expect(readFile(staged.paths[0]!)).resolves.toEqual(Buffer.from("hello"));
  });

  it("rejects unsupported, malformed, oversized, and excess images", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-images-"));
    temporary.push(root);
    await expect(stageClaudeImages(root, "s", [{ mime: "text/plain", data: "data:text/plain;base64,aGk=" }])).rejects.toBeInstanceOf(ClaudeAttachmentError);
    await expect(stageClaudeImages(root, "s", [{ mime: "image/png", data: "data:image/png;base64,***" }])).rejects.toThrow("valid base64");
    const oversized = Buffer.alloc(MAX_CLAUDE_IMAGE_BYTES + 1).toString("base64");
    await expect(stageClaudeImages(root, "s", [{ mime: "image/png", data: `data:image/png;base64,${oversized}` }])).rejects.toThrow("under 3 MiB");
    const image = { mime: "image/png", data: "data:image/png;base64,aGk=" };
    await expect(stageClaudeImages(root, "s", [image, image, image, image, image])).rejects.toThrow("at most 4");
  });
});
