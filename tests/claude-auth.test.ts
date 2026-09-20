import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

describe("Claude auth — Keychain token reader (macOS)", () => {
  // Unit tests run on ubuntu in CI, so the platform is pinned rather than inherited.
  const macos = { platform: "darwin" as NodeJS.Platform };
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function load() {
    return import("../server/claude/auth.js");
  }

  it("parses a valid Keychain entry and returns the access token", async () => {
    const keychainPayload = JSON.stringify({
      claudeAiOauth: { accessToken: "test-token-abc", expiresAt: Date.now() + 3_600_000 },
    });
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, keychainPayload, "");
      return undefined as any;
    });

    const { getClaudeOAuthToken, clearCachedToken } = await load();
    const token = await getClaudeOAuthToken(macos);
    expect(token).toBe("test-token-abc");
    clearCachedToken();
  });

  it("caches the token and does not re-read Keychain on subsequent calls", async () => {
    const keychainPayload = JSON.stringify({
      claudeAiOauth: { accessToken: "cached-token", expiresAt: Date.now() + 3_600_000 },
    });
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, keychainPayload, "");
      return undefined as any;
    });

    const { getClaudeOAuthToken, clearCachedToken } = await load();
    await getClaudeOAuthToken(macos);
    await getClaudeOAuthToken(macos);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    clearCachedToken();
  });

  it("re-reads Keychain after clearCachedToken", async () => {
    const keychainPayload = JSON.stringify({
      claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 3_600_000 },
    });
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, keychainPayload, "");
      return undefined as any;
    });

    const { getClaudeOAuthToken, clearCachedToken } = await load();
    await getClaudeOAuthToken(macos);
    clearCachedToken();
    await getClaudeOAuthToken(macos);
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
    clearCachedToken();
  });

  it("throws when the Keychain entry has no accessToken", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, JSON.stringify({ claudeAiOauth: {} }), "");
      return undefined as any;
    });

    const { getClaudeOAuthToken } = await load();
    await expect(getClaudeOAuthToken(macos)).rejects.toThrow("No claudeAiOauth.accessToken");
  });

  it("throws when the security command fails", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(new Error("The specified item could not be found"), "", "");
      return undefined as any;
    });

    const { getClaudeOAuthToken } = await load();
    await expect(getClaudeOAuthToken(macos)).rejects.toThrow("Keychain read failed");
  });
});

describe("Claude auth — credentials file reader (Linux)", () => {
  const linux = { platform: "linux" as NodeJS.Platform };

  afterEach(async () => {
    const { clearCachedToken } = await import("../server/claude/auth.js");
    clearCachedToken();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function withCredentials(payload: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "dcaleon-creds-"));
    await writeFile(path.join(dir, ".credentials.json"), payload, { mode: 0o600 });
    return dir;
  }

  it("resolves the credentials path under CLAUDE_CONFIG_DIR when set", async () => {
    const { credentialsFilePath } = await import("../server/claude/auth.js");
    expect(credentialsFilePath({ CLAUDE_CONFIG_DIR: "/srv/dcaleon/.claude" })).toBe("/srv/dcaleon/.claude/.credentials.json");
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset", async () => {
    const { credentialsFilePath } = await import("../server/claude/auth.js");
    expect(credentialsFilePath({})).toBe(path.join(homedir(), ".claude", ".credentials.json"));
  });

  it("picks the file reader off macOS and the Keychain on it", async () => {
    const { credentialSource } = await import("../server/claude/auth.js");
    expect(credentialSource("darwin")).toBe("keychain");
    expect(credentialSource("linux")).toBe("file");
  });

  it("reads the access token out of ~/.claude/.credentials.json", async () => {
    const dir = await withCredentials(JSON.stringify({
      claudeAiOauth: { accessToken: "linux-token", expiresAt: Date.now() + 3_600_000 },
    }));
    const { getClaudeOAuthToken } = await import("../server/claude/auth.js");
    await expect(getClaudeOAuthToken({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } })).resolves.toBe("linux-token");
  });

  it("never shells out to the Keychain on Linux", async () => {
    const dir = await withCredentials(JSON.stringify({
      claudeAiOauth: { accessToken: "linux-token", expiresAt: Date.now() + 3_600_000 },
    }));
    const { getClaudeOAuthToken } = await import("../server/claude/auth.js");
    await getClaudeOAuthToken({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  // The headless case the cloud deployment actually hits: nobody has run
  // `/login` on the box yet, so the diagnosis has to name the missing path.
  it("names the missing file when the host has never logged in", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcaleon-creds-"));
    const { getClaudeOAuthToken } = await import("../server/claude/auth.js");
    await expect(getClaudeOAuthToken({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } }))
      .rejects.toThrow(`Credentials file read failed (${path.join(dir, ".credentials.json")})`);
  });

  it("names the credentials file when the JSON has no accessToken", async () => {
    const dir = await withCredentials(JSON.stringify({ claudeAiOauth: {} }));
    const { getClaudeOAuthToken } = await import("../server/claude/auth.js");
    await expect(getClaudeOAuthToken({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } }))
      .rejects.toThrow("No claudeAiOauth.accessToken in credentials file");
  });
});
