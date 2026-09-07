import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_CLAUDE_IMAGE_ATTACHMENTS = 4;
export const MAX_CLAUDE_IMAGE_BYTES = 3 * 1024 * 1024;

const EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

export class ClaudeAttachmentError extends Error {}

export interface StagedClaudeImages {
  paths: string[];
  directory?: string;
}

/** Decode browser data URLs into a private, turn-scoped directory for Claude. */
export async function stageClaudeImages(sessionRoot: string, sessionUuid: string, input: unknown): Promise<StagedClaudeImages> {
  if (input === undefined) return { paths: [] };
  if (!Array.isArray(input) || input.length > MAX_CLAUDE_IMAGE_ATTACHMENTS) {
    throw new ClaudeAttachmentError(`images must contain at most ${MAX_CLAUDE_IMAGE_ATTACHMENTS} attachments`);
  }
  if (input.length === 0) return { paths: [] };

  const decoded = input.map((item, index) => {
    if (!item || typeof item !== "object") throw new ClaudeAttachmentError(`image ${index + 1} is invalid`);
    const mime = "mime" in item && typeof item.mime === "string" ? item.mime : "";
    const data = "data" in item && typeof item.data === "string" ? item.data : "";
    const extension = EXTENSIONS.get(mime);
    const prefix = `data:${mime};base64,`;
    if (!extension || !data.startsWith(prefix)) throw new ClaudeAttachmentError(`image ${index + 1} must be PNG, JPEG, GIF, or WebP`);
    const encoded = data.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
      throw new ClaudeAttachmentError(`image ${index + 1} is not valid base64`);
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_CLAUDE_IMAGE_BYTES) throw new ClaudeAttachmentError(`image ${index + 1} must be under 3 MiB`);
    return { bytes, extension };
  });

  const directory = path.join(sessionRoot, "attachments", sessionUuid, crypto.randomUUID());
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths = await Promise.all(decoded.map(async ({ bytes, extension }, index) => {
      const target = path.join(directory, `image-${index + 1}${extension}`);
      await writeFile(target, bytes, { mode: 0o600 });
      return target;
    }));
    return { paths, directory };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
