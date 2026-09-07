import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockedExecFile = vi.mocked(execFile);

describe("Claude auth — Keychain token reader", () => {
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
    const token = await getClaudeOAuthToken();
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
    await getClaudeOAuthToken();
    await getClaudeOAuthToken();
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
    await getClaudeOAuthToken();
    clearCachedToken();
    await getClaudeOAuthToken();
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
    clearCachedToken();
  });

  it("throws when the Keychain entry has no accessToken", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, JSON.stringify({ claudeAiOauth: {} }), "");
      return undefined as any;
    });

    const { getClaudeOAuthToken } = await load();
    await expect(getClaudeOAuthToken()).rejects.toThrow("No claudeAiOauth.accessToken");
  });

  it("throws when the security command fails", async () => {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(new Error("The specified item could not be found"), "", "");
      return undefined as any;
    });

    const { getClaudeOAuthToken } = await load();
    await expect(getClaudeOAuthToken()).rejects.toThrow("Keychain read failed");
  });
});
