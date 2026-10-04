import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { auditHmacKeyPath, resolveAuditHmacKey } from "../server/notifications/audit.js";

const tempDirs: string[] = [];
// Every key hex minted by a test, collected so the last assertion can prove
// none of them ever reached a warning or console channel.
const mintedHex: string[] = [];
const warnings: string[] = [];
const consoleWarn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
});
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "audit-key-"));
  tempDirs.push(dir);
  return dir;
}

async function keyFileHex(file: string): Promise<string> {
  const hex = (await readFile(file, "utf8")).trim();
  mintedHex.push(hex);
  return hex;
}

describe("resolveAuditHmacKey", () => {
  it("creates the key file atomically in a missing directory and returns its bytes", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "state", "key");

    const key = resolveAuditHmacKey({ NOTIFICATION_AUDIT_HMAC_KEY_FILE: file });

    const hex = await keyFileHex(file);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(hex, "hex"))).toBe(true);
  });

  it("reuses the persisted key on a second call without rewriting the file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "key");

    const first = resolveAuditHmacKey({ NOTIFICATION_AUDIT_HMAC_KEY_FILE: file });
    const before = await keyFileHex(file);
    const second = resolveAuditHmacKey({ NOTIFICATION_AUDIT_HMAC_KEY_FILE: file });

    expect(second.equals(first)).toBe(true);
    expect((await readFile(file, "utf8")).trim()).toBe(before);
  });

  it("produces identical correlation IDs for processes sharing a key file", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "shared.key");
    const otherFile = path.join(dir, "other.key");
    const savedKeyFile = process.env.NOTIFICATION_AUDIT_HMAC_KEY_FILE;
    const savedKey = process.env.NOTIFICATION_AUDIT_HMAC_KEY;
    try {
      // vitest.config.ts pins NOTIFICATION_AUDIT_HMAC_KEY, which would take
      // precedence over the file; remove it so the file is the source.
      delete process.env.NOTIFICATION_AUDIT_HMAC_KEY;
      process.env.NOTIFICATION_AUDIT_HMAC_KEY_FILE = file;

      vi.resetModules();
      const first = await import("../server/notifications/audit.js");
      vi.resetModules();
      const second = await import("../server/notifications/audit.js");

      const firstId = first.correlationId("ses_abc");
      const secondId = second.correlationId("ses_abc");
      mintedHex.push((await readFile(file, "utf8")).trim());
      expect(firstId).toBe(secondId);

      process.env.NOTIFICATION_AUDIT_HMAC_KEY_FILE = otherFile;
      vi.resetModules();
      const third = await import("../server/notifications/audit.js");
      const thirdId = third.correlationId("ses_abc");
      mintedHex.push((await readFile(otherFile, "utf8")).trim());
      expect(thirdId).not.toBe(secondId);
    } finally {
      if (savedKeyFile === undefined) delete process.env.NOTIFICATION_AUDIT_HMAC_KEY_FILE;
      else process.env.NOTIFICATION_AUDIT_HMAC_KEY_FILE = savedKeyFile;
      if (savedKey === undefined) delete process.env.NOTIFICATION_AUDIT_HMAC_KEY;
      else process.env.NOTIFICATION_AUDIT_HMAC_KEY = savedKey;
      vi.resetModules();
    }
  });

  it("prefers NOTIFICATION_AUDIT_HMAC_KEY and never touches disk", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "never-created");

    const key = resolveAuditHmacKey({
      NOTIFICATION_AUDIT_HMAC_KEY: "explicit-key-material",
      NOTIFICATION_AUDIT_HMAC_KEY_FILE: file,
    });

    expect(key.equals(Buffer.from("explicit-key-material", "utf8"))).toBe(true);
    await expect(stat(file)).rejects.toThrow();
  });

  it("warns and falls back on an invalid existing file, leaving it untouched", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "key");
    await writeFile(file, "not-a-key");
    const warn = vi.fn();

    const key = resolveAuditHmacKey({ NOTIFICATION_AUDIT_HMAC_KEY_FILE: file }, warn);

    expect(key).toHaveLength(32);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(file);
    expect(await readFile(file, "utf8")).toBe("not-a-key");
  });

  it("resolves the default path under .state/", () => {
    const env = { NOTIFICATION_AUDIT_HMAC_KEY_FILE: "/tmp/custom/key" };
    expect(auditHmacKeyPath(env)).toBe("/tmp/custom/key");
    expect(auditHmacKeyPath({})).toBe(path.resolve(process.cwd(), ".state/notification-audit-hmac.key"));
  });

  it("never leaks a generated key into warnings or console output", () => {
    const output = [...warnings, ...vi.mocked(consoleWarn).mock.calls.map((c) => c.map(String).join(" "))];
    expect(mintedHex.length).toBeGreaterThan(0);
    for (const line of output) {
      for (const hex of mintedHex) expect(line).not.toContain(hex);
    }
    consoleLog.mockClear();
  });
});
