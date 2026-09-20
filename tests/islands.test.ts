import { describe, expect, it } from "vitest";

import { readIslandConfig, publicIslands, ISLAND_IDS } from "../server/islands.js";
import { isOpencodeRoute, OPENCODE_ROUTE_PREFIXES } from "../server/routes/islandGuard.js";
import { islandAvailability } from "../client/lib/islands.js";

describe("readIslandConfig — the DCALEON_ISLANDS switch", () => {
  it("runs every island on macOS when the variable is unset", () => {
    const config = readIslandConfig({}, "darwin");
    expect(config.errors).toEqual([]);
    expect([config.opencode.available, config.dsh.available, config.claude.available]).toEqual([true, true, true]);
  });

  it("narrows to the named islands", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: "claude" }, "darwin");
    expect(config.claude.available).toBe(true);
    expect(config.opencode.available).toBe(false);
    expect(config.dsh.available).toBe(false);
    expect(config.opencode.reason).toContain("DCALEON_ISLANDS");
  });

  it("tolerates spacing and casing in the list", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: " Claude , OpenCode " }, "darwin");
    expect(config.errors).toEqual([]);
    expect(config.claude.available).toBe(true);
    expect(config.opencode.available).toBe(true);
    expect(config.dsh.available).toBe(false);
  });

  // The cloud box: Claude-only on Linux, which is the cut this phase ships.
  it("marks OpenCode and DSH unavailable for DCALEON_ISLANDS=claude on Linux", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: "claude" }, "linux");
    expect(config.claude.available).toBe(true);
    expect(config.opencode.available).toBe(false);
    expect(config.dsh.available).toBe(false);
  });

  // Two switches, not one: the OS vetoes DSH even when the operator asks for it.
  it("refuses DSH on Linux however the variable is set, and says why", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: "claude,dsh" }, "linux");
    expect(config.dsh.selected).toBe(true);
    expect(config.dsh.supported).toBe(false);
    expect(config.dsh.available).toBe(false);
    expect(config.dsh.reason).toContain("macOS");
  });

  it("leaves the Claude island platform-independent", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(readIslandConfig({}, platform).claude.supported).toBe(true);
    }
  });

  // A typo must not silently produce a host that runs nothing.
  it("reports an unknown name and falls back to every island", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: "clod" }, "darwin");
    expect(config.errors.join(" ")).toContain("clod");
    expect(config.claude.available).toBe(true);
    expect(config.opencode.available).toBe(true);
  });

  it("reports a set-but-empty value rather than disabling everything", () => {
    const config = readIslandConfig({ DCALEON_ISLANDS: " , " }, "darwin");
    expect(config.errors.join(" ")).toContain("selected no known island");
    expect(config.opencode.available).toBe(true);
  });

  it("puts every island on the wire, available or not", () => {
    const wire = publicIslands(readIslandConfig({ DCALEON_ISLANDS: "claude" }, "linux"));
    expect(wire.map((island) => island.id)).toEqual([...ISLAND_IDS]);
    expect(wire.find((island) => island.id === "opencode")?.reason).toBeTruthy();
  });
});

describe("isOpencodeRoute", () => {
  it("matches an OpenCode route and its children", () => {
    expect(isOpencodeRoute("/sessions")).toBe(true);
    expect(isOpencodeRoute("/sessions/ses_123/messages")).toBe(true);
    expect(isOpencodeRoute("/events")).toBe(true);
  });

  it("leaves the other islands and the shared routes alone", () => {
    for (const route of ["/claude/sessions", "/claude/events", "/dsh/sessions", "/app-config", "/health", "/notifications", "/recent-sessions"]) {
      expect(isOpencodeRoute(route)).toBe(false);
    }
  });

  it("does not match a longer name that merely starts with a prefix", () => {
    expect(isOpencodeRoute("/sessions-archive")).toBe(false);
    expect(isOpencodeRoute("/mcp-registry")).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isOpencodeRoute("/sessions/")).toBe(true);
  });
});

describe("islandAvailability — the badge the browser shows", () => {
  const configured = { dshEnabled: true, dshConfigured: true, claudeEnabled: true, claudeConfigured: true };

  it("reads an older BFF with no islands field as every island present", () => {
    expect(islandAvailability("opencode", configured).available).toBe(true);
    expect(islandAvailability("claude", configured).label).toBe("Available");
  });

  // The distinction the phase is about: a host that cannot run the island reads
  // differently from one where the island's own env is switched off.
  it("separates 'unavailable here' from 'not configured'", () => {
    const hostless = islandAvailability("opencode", {
      ...configured,
      islands: [{ id: "opencode", available: false, reason: "Not enabled on this host" }],
    });
    expect(hostless).toEqual({ available: false, label: "Unavailable here", reason: "Not enabled on this host" });

    const unconfigured = islandAvailability("dsh", { ...configured, dshConfigured: false });
    expect(unconfigured).toEqual({ available: false, label: "Not configured", reason: null });
  });

  it("prefers the host reason when the island is both unavailable and unconfigured", () => {
    const status = islandAvailability("dsh", {
      ...configured,
      dshConfigured: false,
      islands: [{ id: "dsh", available: false, reason: "Requires macOS" }],
    });
    expect(status.label).toBe("Unavailable here");
    expect(status.reason).toBe("Requires macOS");
  });
});

// The prefix list in islandGuard.ts is hand-maintained, so it is checked
// against what the OpenCode routers actually register. A new route that no
// prefix covers would otherwise slip past the guard and fail as a connection
// error on a host without the island — the exact failure this replaces.
describe("OPENCODE_ROUTE_PREFIXES covers every OpenCode route", () => {
  const OPENCODE_ROUTE_FILES = [
    "server/routes/sessions.ts",
    "server/routes/settings.ts",
    "server/routes/mcp.ts",
    "server/routes/workspace.ts",
    "server/routes/worktrees.ts",
    "server/routes/observability.ts",
  ];

  function registeredPaths(source: string): string[] {
    const matches = source.matchAll(/router\.(?:get|post|put|patch|delete)\(\s*(?:\/\*[\s\S]*?\*\/\s*)?"([^"]+)"/g);
    return [...matches].map((match) => match[1]);
  }

  it("names a prefix for each registered path", async () => {
    const { readFile } = await import("node:fs/promises");
    const uncovered: string[] = [];
    for (const file of OPENCODE_ROUTE_FILES) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const paths = registeredPaths(source);
      expect(paths.length, `${file} registered no routes — the scraper broke`).toBeGreaterThan(0);
      for (const route of paths) if (!isOpencodeRoute(route)) uncovered.push(`${file} ${route}`);
    }
    expect(uncovered).toEqual([]);
  });

  it("keeps the list free of prefixes nothing registers under", async () => {
    const { readFile } = await import("node:fs/promises");
    const all: string[] = [];
    for (const file of OPENCODE_ROUTE_FILES) {
      all.push(...registeredPaths(await readFile(new URL(`../${file}`, import.meta.url), "utf8")));
    }
    const unused = OPENCODE_ROUTE_PREFIXES.filter((prefix) => !all.some((route) => route === prefix || route.startsWith(`${prefix}/`)));
    expect(unused).toEqual([]);
  });
});
