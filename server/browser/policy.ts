// server/browser/policy.ts — the SSRF boundary for the live session browser.
//
// A headless browser is itself an SSRF engine, and this one is driven by an
// unauthenticated endpoint reachable from every tailnet peer. Without this
// module the panel can reach 127.0.0.1:4096 — the OpenCode server that runs
// shell commands as the host user — plus the LAN and cloud metadata ranges.
// The block applies to NAVIGATION and SUBRESOURCES alike: an <img> pointing at
// a loopback URL is the same hole as typing it in the address bar.
//
// Design doc: "Live Browser and Right Tools Panel — 2026-09-07".

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LiveBrowserConfig {
  enabled: boolean;
  maxPages: number;
  idleMinutes: number;
  executablePath?: string;
}

/** Off by default, mirroring PREVIEW_ALLOWED_PORTS being disabled unless set. */
export function parseLiveBrowserConfig(env: NodeJS.ProcessEnv): LiveBrowserConfig {
  const maxPages = clampInt(env.BROWSER_MAX_PAGES, 10, 1, 32);
  const idleMinutes = clampInt(env.BROWSER_IDLE_MINUTES, 30, 1, 24 * 60);
  return {
    enabled: env.LIVE_BROWSER_ENABLED === "true",
    maxPages,
    idleMinutes,
    ...(env.BROWSER_EXECUTABLE_PATH ? { executablePath: env.BROWSER_EXECUTABLE_PATH } : {}),
  };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * True for any address the browser must never reach: loopback, RFC1918,
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, unspecified,
 * broadcast, and their IPv6 equivalents including v4-mapped forms.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  // Not an IP literal at all: treat as private so a parser disagreement
  // between Node and Chromium fails closed rather than open.
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  // v4-mapped / v4-compatible forms carry the v4 answer.
  const v4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (v4) return isPrivateV4(v4[1]);
  const compact = lower.replace(/^\[|\]$/g, "");
  // URL normalisation converts mapped dotted IPv4 to hexadecimal hextets.
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(compact);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (compact === "::" || compact === "::1") return true;
  const head = firstHextet(compact);
  if (head === null) return true;
  if (head >= 0xfc00 && head <= 0xfdff) return true; // unique local fc00::/7
  if (head >= 0xfe80 && head <= 0xfebf) return true; // link-local fe80::/10
  if (head >= 0xff00) return true; // multicast
  return false;
}

function firstHextet(address: string): number | null {
  const raw = address.startsWith("::") ? "0" : address.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

/** Hostnames refused without touching DNS at all. */
export function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name.endsWith(".local") || name.endsWith(".internal")) return true;
  if (isIP(name.replace(/^\[|\]$/g, ""))) return isPrivateAddress(name.replace(/^\[|\]$/g, ""));
  return false;
}

export type NavigationVerdict = { ok: true; url: string } | { ok: false; reason: string };

// DNS answers are cached briefly so subresource storms do not become a
// resolver storm. This is not DNS pinning: Chromium resolves separately, so
// deployment-level egress controls are required against DNS rebinding.
const DNS_TTL_MS = 30_000;
const dnsCache = new Map<string, { at: number; private: boolean }>();

async function resolvesPrivate(hostname: string): Promise<boolean> {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.private;
  let verdict = true; // resolution failure fails closed
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    verdict = answers.length === 0 || answers.some((entry) => isPrivateAddress(entry.address));
  } catch {
    verdict = true;
  }
  dnsCache.set(hostname, { at: Date.now(), private: verdict });
  if (dnsCache.size > 512) {
    const oldest = dnsCache.keys().next().value;
    if (oldest !== undefined) dnsCache.delete(oldest);
  }
  return verdict;
}

/**
 * The single authority deciding whether the managed browser may fetch a URL.
 * Used for address-bar navigations AND for every intercepted request, so a
 * redirect or subresource cannot widen what the address bar allows.
 */
export async function assessTarget(rawUrl: string): Promise<NavigationVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol.replace(/:$/, "")} is not allowed` };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials in URLs are not allowed" };
  const hostname = url.hostname;
  if (!hostname) return { ok: false, reason: "URL has no host" };
  if (isBlockedHostname(hostname)) return { ok: false, reason: "host is private or local" };
  if (await resolvesPrivate(hostname)) return { ok: false, reason: "host resolves to a private address" };
  return { ok: true, url: url.toString() };
}

/** WebSockets bypass ordinary request routing, but share the same host rule. */
export async function assessWebSocketTarget(rawUrl: string): Promise<NavigationVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, reason: `scheme ${url.protocol.replace(/:$/, "")} is not allowed` };
  }
  const transport = new URL(url.toString());
  transport.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const verdict = await assessTarget(transport.toString());
  return verdict.ok ? { ok: true, url: url.toString() } : verdict;
}

/** Test seam: clear the DNS verdict cache. */
export function resetPolicyCache(): void {
  dnsCache.clear();
}
