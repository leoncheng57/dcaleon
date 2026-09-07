import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBucket, parseResponse, clearCachedUsage, fetchClaudeUsage, CACHE_TTL_MS } from "../server/claude/usage.js";

vi.mock("../server/claude/auth.js", () => ({
  getClaudeOAuthToken: vi.fn(async () => "mock-token"),
  clearCachedToken: vi.fn(),
}));

afterEach(() => {
  clearCachedUsage();
  vi.restoreAllMocks();
});

describe("parseBucket", () => {
  it("extracts utilization and resets_at from a valid object", () => {
    expect(parseBucket({ utilization: 42.5, resets_at: "2026-09-07T00:00:00Z" })).toEqual({
      utilization: 42.5,
      resetsAt: "2026-09-07T00:00:00Z",
    });
  });

  it("defaults to 0 and null for missing or invalid fields", () => {
    expect(parseBucket(undefined)).toEqual({ utilization: 0, resetsAt: null });
    expect(parseBucket({})).toEqual({ utilization: 0, resetsAt: null });
    expect(parseBucket({ utilization: "not a number" })).toEqual({ utilization: 0, resetsAt: null });
  });
});

describe("parseResponse", () => {
  it("parses a full usage response with session, weekly, and per-model buckets", () => {
    const body = {
      session: { utilization: 15, resets_at: "2026-09-06T23:00:00Z" },
      weekly: { utilization: 30, resets_at: "2026-09-10T00:00:00Z" },
      models: {
        "claude-opus-5": { utilization: 25, resets_at: "2026-09-10T00:00:00Z" },
        "claude-sonnet-5": { utilization: 10, resets_at: null },
      },
      subscription_type: "team",
      rate_limit_tier: "tier_3",
    };
    const result = parseResponse(body);
    expect(result.available).toBe(true);
    expect(result.session.utilization).toBe(15);
    expect(result.weekly.utilization).toBe(30);
    expect(result.weeklyByModel["claude-opus-5"].utilization).toBe(25);
    expect(result.weeklyByModel["claude-sonnet-5"].utilization).toBe(10);
    expect(result.subscriptionType).toBe("team");
    expect(result.rateLimitTier).toBe("tier_3");
  });

  it("handles the alternate field names (current_session, all_models, weekly_by_model)", () => {
    const body = {
      current_session: { utilization: 5 },
      all_models: { utilization: 20 },
      weekly_by_model: { "claude-opus-5": { utilization: 18 } },
    };
    const result = parseResponse(body);
    expect(result.session.utilization).toBe(5);
    expect(result.weekly.utilization).toBe(20);
    expect(result.weeklyByModel["claude-opus-5"].utilization).toBe(18);
  });

  it("returns safe defaults for an empty body", () => {
    const result = parseResponse({});
    expect(result.session.utilization).toBe(0);
    expect(result.weekly.utilization).toBe(0);
    expect(Object.keys(result.weeklyByModel)).toHaveLength(0);
    expect(result.subscriptionType).toBeNull();
    expect(result.rateLimitTier).toBeNull();
  });
});

describe("fetchClaudeUsage", () => {
  it("fetches usage and caches the result", async () => {
    const body = { session: { utilization: 10 }, weekly: { utilization: 20 } };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await fetchClaudeUsage("2.1.259");
    expect(first.available).toBe(true);
    if (first.available) expect(first.session.utilization).toBe(10);

    const second = await fetchClaudeUsage("2.1.259");
    expect(second.available).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache is cleared", async () => {
    const body = { session: { utilization: 10 }, weekly: { utilization: 20 } };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchClaudeUsage("2.1.259");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    clearCachedUsage();
    await fetchClaudeUsage("2.1.259");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns unavailable when the token read fails", async () => {
    const { getClaudeOAuthToken } = await import("../server/claude/auth.js");
    vi.mocked(getClaudeOAuthToken).mockRejectedValueOnce(new Error("Keychain locked"));

    const result = await fetchClaudeUsage("2.1.259");
    expect(result).toEqual({ available: false, reason: "Keychain locked" });
  });

  it("retries once on 401 then returns the fresh data", async () => {
    const { getClaudeOAuthToken, clearCachedToken } = await import("../server/claude/auth.js");
    const body = { session: { utilization: 50 }, weekly: { utilization: 60 } };
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("Unauthorized", { status: 401 });
      return new Response(JSON.stringify(body), { status: 200 });
    }));

    const result = await fetchClaudeUsage("2.1.259");
    expect(result.available).toBe(true);
    if (result.available) expect(result.session.utilization).toBe(50);
    expect(vi.mocked(clearCachedToken)).toHaveBeenCalled();
  });

  it("returns stale cache on 429", async () => {
    const body = { session: { utilization: 10 }, weekly: { utilization: 20 } };
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify(body), { status: 200 });
      return new Response("Too Many Requests", { status: 429 });
    }));

    await fetchClaudeUsage("2.1.259");
    clearCachedUsage();
    const result = await fetchClaudeUsage("2.1.259");
    expect(result.available).toBe(false);
  });

  it("returns unavailable on non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Server Error", { status: 500 })));

    const result = await fetchClaudeUsage("2.1.259");
    expect(result).toEqual({ available: false, reason: "HTTP 500" });
  });

  it("sends an honest User-Agent, not claude-code", async () => {
    const body = { session: { utilization: 10 }, weekly: { utilization: 20 } };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchClaudeUsage("2.1.259");
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("dca-claude-usage/2.1.259");
    expect(headers["User-Agent"]).not.toContain("claude-code");
  });
});
