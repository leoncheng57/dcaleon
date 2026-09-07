// Boundary tests for the live session browser (issue #229).
//
// Per CONTRIBUTING.md, security-sensitive surfaces need explicit boundary
// tests. The SSRF policy is the load-bearing control: without it the managed
// Chromium can reach the unauthenticated OpenCode server on 127.0.0.1:4096,
// the LAN, and cloud metadata. These tests pin the refusal set.

import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessTarget,
  assessWebSocketTarget,
  isBlockedHostname,
  isPrivateAddress,
  parseLiveBrowserConfig,
  resetPolicyCache,
} from "../server/browser/policy.js";
import { validSessionID } from "../server/browser/errors.js";
import { parseLiveBrowserInput, parseStreamProfile } from "../server/browser/routes.js";
import { BrowserManager, DEFAULT_BROWSER_URL, screencastOptions, streamFrameInterval } from "../server/browser/manager.js";
import { assertPrivateBrowserProfile, BrowserProfilePermissionError } from "../server/browser/profile.js";

const temporaryProfiles: string[] = [];

describe("new Browser homepage", () => {
  it("uses leoncheng.dev only on creation and preserves existing pages unless explicitly navigated", async () => {
    const manager = new BrowserManager({ enabled: true, maxPages: 2, idleMinutes: 1 }, "/unused-mocked-browser-profile");
    let url = "about:blank";
    const page = { on: vi.fn(), url: () => url, title: async () => "Fixture" };
    const cdp = { send: vi.fn().mockResolvedValue({ currentIndex: 0, entries: [] }) };
    vi.spyOn(manager as unknown as { contextOrLaunch(): Promise<unknown> }, "contextOrLaunch").mockResolvedValue({
      newPage: async () => page, newCDPSession: async () => cdp,
    });
    const navigate = vi.spyOn(manager, "navigate").mockImplementation(async (sessionID, request) => {
      if (request.action === "goto") url = request.url;
      return manager.state(sessionID);
    });
    try {
      expect(DEFAULT_BROWSER_URL).toBe("https://leoncheng.dev");
      await expect(manager.open("ses_homepage")).resolves.toMatchObject({ url: DEFAULT_BROWSER_URL });
      expect(navigate).toHaveBeenLastCalledWith("ses_homepage", { action: "goto", url: DEFAULT_BROWSER_URL });
      await manager.navigate("ses_homepage", { action: "goto", url: "https://example.com/retained" });
      navigate.mockClear();
      await expect(manager.open("ses_homepage")).resolves.toMatchObject({ url: "https://example.com/retained" });
      expect(navigate).not.toHaveBeenCalled();
      await manager.open("ses_explicit", "https://example.com/linked");
      expect(navigate).toHaveBeenLastCalledWith("ses_explicit", { action: "goto", url: "https://example.com/linked" });
    } finally {
      await manager.shutdown();
    }
  });
});
afterEach(() => {
  for (const profile of temporaryProfiles.splice(0)) rmSync(profile, { recursive: true, force: true });
});

describe("parseLiveBrowserConfig", () => {
  it("is disabled by default with a cap of 10 and a 30 minute reaper", () => {
    const config = parseLiveBrowserConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.maxPages).toBe(10);
    expect(config.idleMinutes).toBe(30);
    expect(config.executablePath).toBeUndefined();
  });

  it("enables only on the literal string true and clamps the cap", () => {
    expect(parseLiveBrowserConfig({ LIVE_BROWSER_ENABLED: "1" } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(parseLiveBrowserConfig({ LIVE_BROWSER_ENABLED: "true" } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(parseLiveBrowserConfig({ BROWSER_MAX_PAGES: "0" } as NodeJS.ProcessEnv).maxPages).toBe(1);
    expect(parseLiveBrowserConfig({ BROWSER_MAX_PAGES: "9999" } as NodeJS.ProcessEnv).maxPages).toBe(32);
    expect(parseLiveBrowserConfig({ BROWSER_MAX_PAGES: "garbage" } as NodeJS.ProcessEnv).maxPages).toBe(10);
  });
});

describe("isPrivateAddress", () => {
  it("blocks URL-normalized IPv4-mapped private literals", () => {
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:c0a8:101")).toBe(true);
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
  });
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT (Tailscale range)
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.0.10",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "140.82.112.3", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:4700::6810:84e5", "2a00:1450:4001::71"])(
    "allows public %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("fails closed on garbage", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "LOCALHOST", "foo.localhost", "printer.local", "service.internal", "127.0.0.1", "[::1]"])(
    "blocks %s without touching DNS",
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    },
  );

  it("does not block ordinary public hostnames", () => {
    expect(isBlockedHostname("github.com")).toBe(false);
    expect(isBlockedHostname("example.com.")).toBe(false);
  });
});

describe("assessTarget", () => {
  it("refuses non-http(s) schemes outright", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://example.com/", "chrome://settings"]) {
      const verdict = await assessTarget(url);
      expect(verdict.ok).toBe(false);
    }
  });

  it("refuses credentials, empty hosts and unparseable URLs", async () => {
    expect((await assessTarget("https://user:pass@example.com/")).ok).toBe(false);
    expect((await assessTarget("not a url")).ok).toBe(false);
  });

  it("refuses loopback and private IP literals before DNS", async () => {
    resetPolicyCache();
    for (const url of [
      "http://127.0.0.1:4096/", // the unauthenticated OpenCode server
      "http://localhost:3000/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:4096/",
    ]) {
      const verdict = await assessTarget(url);
      expect(verdict.ok).toBe(false);
    }
  });

  it("refuses hostnames that do not resolve, failing closed", async () => {
    resetPolicyCache();
    const verdict = await assessTarget("https://this-host-does-not-exist.invalid/");
    expect(verdict.ok).toBe(false);
  });
});

describe("assessWebSocketTarget", () => {
  it("applies the same private-address boundary to WebSockets", async () => {
    expect(await assessWebSocketTarget("ws://127.0.0.1:4096/event")).toMatchObject({ ok: false });
    expect(await assessWebSocketTarget("wss://[::1]/socket")).toMatchObject({ ok: false });
  });

  it("allows public WebSocket targets and refuses other protocols", async () => {
    expect(await assessWebSocketTarget("wss://8.8.8.8/socket")).toMatchObject({ ok: true });
    expect(await assessWebSocketTarget("https://example.com/socket")).toMatchObject({ ok: false });
  });
});

describe("live browser input parsing", () => {
  it("refuses duplicate touch identifiers and out-of-bounds coordinates", () => {
    expect(parseLiveBrowserInput({ type: "touch", phase: "start", points: [{ id: 0, x: 2, y: 3 }, { id: 0, x: 4, y: 5 }] })).toBeNull();
    expect(parseLiveBrowserInput({ type: "touch", phase: "move", points: [{ id: 0, x: -1, y: 3 }] })).toBeNull();
  });
  it("accepts bounded integer viewport updates", () => {
    expect(parseLiveBrowserInput({ type: "viewport", width: 390, height: 740 })).toEqual({
      type: "viewport",
      width: 390,
      height: 740,
    });
    expect(parseLiveBrowserInput({ type: "viewport", width: 319, height: 740 })).toBeNull();
    expect(parseLiveBrowserInput({ type: "viewport", width: 390.5, height: 740 })).toBeNull();
    expect(parseLiveBrowserInput({ type: "viewport", width: 390, height: 1201 })).toBeNull();
  });

  it("accepts valid touch sequences and rejects malformed or excessive points", () => {
    expect(parseLiveBrowserInput({ type: "touch", phase: "start", points: [{ x: 12, y: 18, id: 0 }] })).toEqual({
      type: "touch",
      phase: "start",
      points: [{ x: 12, y: 18, id: 0 }],
    });
    expect(parseLiveBrowserInput({ type: "touch", phase: "end", points: [] })).toEqual({ type: "touch", phase: "end", points: [] });
    expect(parseLiveBrowserInput({ type: "touch", phase: "start", points: [] })).toBeNull();
    expect(parseLiveBrowserInput({ type: "touch", phase: "end", points: [{ x: 1, y: 1 }] })).toBeNull();
    expect(parseLiveBrowserInput({ type: "touch", phase: "move", points: [{ x: Number.NaN, y: 1 }] })).toBeNull();
    expect(parseLiveBrowserInput({
      type: "touch",
      phase: "move",
      points: Array.from({ length: 11 }, (_, id) => ({ x: id, y: id, id })),
    })).toBeNull();
  });

  it("uses only the two server-owned stream profiles", () => {
    expect(parseStreamProfile("coarse")).toBe("coarse");
    expect(parseStreamProfile("anything-else")).toBe("default");
    expect(screencastOptions("coarse").quality).toBeLessThan(screencastOptions("default").quality);
    expect(screencastOptions("coarse").everyNthFrame).toBe(1);
    expect(screencastOptions("default").everyNthFrame).toBe(1);
    expect(streamFrameInterval("coarse")).toBeGreaterThan(streamFrameInterval("default"));
  });
});

describe("persistent browser profile permissions", () => {
  function profile(): string {
    const created = mkdtempSync(path.join(tmpdir(), "dcaleon-browser-profile-"));
    temporaryProfiles.push(created);
    chmodSync(created, 0o700);
    return created;
  }

  it("accepts a private directory tree", () => {
    const root = profile();
    mkdirSync(path.join(root, "Default"), { mode: 0o700 });
    writeFileSync(path.join(root, "Default", "Cookies"), "fixture", { mode: 0o600 });
    expect(() => assertPrivateBrowserProfile(root)).not.toThrow();
  });

  it("refuses group/other access and symbolic links", () => {
    const root = profile();
    const cookies = path.join(root, "Cookies");
    writeFileSync(cookies, "fixture", { mode: 0o600 });
    chmodSync(root, 0o755);
    expect(() => assertPrivateBrowserProfile(root)).toThrow(BrowserProfilePermissionError);
    chmodSync(root, 0o700);
    chmodSync(cookies, 0o644);
    expect(() => assertPrivateBrowserProfile(root)).not.toThrow();
    symlinkSync(cookies, path.join(root, "linked-cookies"));
    expect(() => assertPrivateBrowserProfile(root)).toThrow(/symbolic link/);
  });
});

describe("validSessionID", () => {
  it("accepts OpenCode session ids and refuses path-shaped input", () => {
    expect(validSessionID("ses_abc123-XYZ")).toBe(true);
    expect(validSessionID("")).toBe(false);
    expect(validSessionID("../etc")).toBe(false);
    expect(validSessionID("a".repeat(129))).toBe(false);
    expect(validSessionID("a b")).toBe(false);
  });
});
