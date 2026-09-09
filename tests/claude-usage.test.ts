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

  it("accepts percent as an alternative to utilization", () => {
    expect(parseBucket({ percent: 70, resets_at: "2026-09-07T05:40:00Z" })).toEqual({
      utilization: 70,
      resetsAt: "2026-09-07T05:40:00Z",
    });
  });

  it("prefers percent over utilization when both are present", () => {
    expect(parseBucket({ utilization: 42, percent: 70 })).toEqual({ utilization: 70, resetsAt: null });
  });

  it("normalizes fractional utilization (0-1) to percentage (0-100)", () => {
    expect(parseBucket({ utilization: 0.42 })).toEqual({ utilization: 42, resetsAt: null });
    expect(parseBucket({ percent: 0.7 })).toEqual({ utilization: 70, resetsAt: null });
  });

  it("defaults to 0 and null for missing or invalid fields", () => {
    expect(parseBucket(undefined)).toEqual({ utilization: 0, resetsAt: null });
    expect(parseBucket({})).toEqual({ utilization: 0, resetsAt: null });
    expect(parseBucket({ utilization: "not a number" })).toEqual({ utilization: 0, resetsAt: null });
  });
});

describe("parseResponse", () => {
  it("parses the limits array with session, weekly_all, and weekly_scoped entries", () => {
    const body = {
      limits: [
        { kind: "session", group: "session", percent: 70, resets_at: "2026-09-07T05:40:00Z", is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 19, resets_at: "2026-09-10T14:00:00Z" },
        { kind: "weekly_scoped", group: "weekly", percent: 5, resets_at: null, scope: { model: { display_name: "Fable" } } },
      ],
    };
    const result = parseResponse(body);
    expect(result.available).toBe(true);
    expect(result.session).toEqual({ utilization: 70, resetsAt: "2026-09-07T05:40:00Z" });
    expect(result.weekly).toEqual({ utilization: 19, resetsAt: "2026-09-10T14:00:00Z" });
    expect(result.weeklyByModel).toEqual({ Fable: { utilization: 5, resetsAt: null } });
  });

  it("falls back to five_hour / seven_day when limits array is absent", () => {
    const body = {
      five_hour: { utilization: 65, resets_at: "2026-09-07T06:00:00Z" },
      seven_day: { utilization: 22, resets_at: "2026-09-10T14:00:00Z" },
    };
    const result = parseResponse(body);
    expect(result.session.utilization).toBe(65);
    expect(result.weekly.utilization).toBe(22);
  });

  it("ignores weekly_scoped entries without a model display_name", () => {
    const body = {
      limits: [
        { kind: "weekly_scoped", group: "weekly", percent: 10, scope: { model: {} } },
        { kind: "weekly_scoped", group: "weekly", percent: 8, scope: {} },
      ],
    };
    const result = parseResponse(body);
    expect(Object.keys(result.weeklyByModel)).toHaveLength(0);
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
  const REAL_BODY = {
    five_hour: { utilization: 70, resets_at: "2026-09-07T05:40:00Z" },
    seven_day: { utilization: 19, resets_at: "2026-09-10T14:00:00Z" },
    limits: [
      { kind: "session", group: "session", percent: 70, resets_at: "2026-09-07T05:40:00Z", is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 19, resets_at: "2026-09-10T14:00:00Z" },
    ],
  };

  it("fetches usage and caches the result", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(REAL_BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await fetchClaudeUsage("2.1.259");
    expect(first.available).toBe(true);
    if (first.available) expect(first.session.utilization).toBe(70);

    const second = await fetchClaudeUsage("2.1.259");
    expect(second.available).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache is cleared", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(REAL_BODY), { status: 200 }));
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
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("Unauthorized", { status: 401 });
      return new Response(JSON.stringify(REAL_BODY), { status: 200 });
    }));

    const result = await fetchClaudeUsage("2.1.259");
    expect(result.available).toBe(true);
    if (result.available) expect(result.session.utilization).toBe(70);
    expect(vi.mocked(clearCachedToken)).toHaveBeenCalled();
  });

  it("returns stale cache on 429", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify(REAL_BODY), { status: 200 });
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
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(REAL_BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await fetchClaudeUsage("2.1.259");
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("dca-claude-usage/2.1.259");
    expect(headers["User-Agent"]).not.toContain("claude-code");
  });
});
