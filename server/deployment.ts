/**
 * What is running on this host, and is it serving the right bytes.
 *
 * Motivated by a real incident: `npm run build:preview` empties and rebuilds
 * `dist/client` (`vite.config.ts` sets `emptyOutDir` unconditionally and
 * `publicDir: false` under the simulator flag), which is the directory the
 * live BFF serves via `express.static`. Running the preview suite in the
 * deployment checkout therefore deleted the service worker and the manifest
 * from under a running server. No restart was involved, so every process-level
 * health check stayed green while `/sw.js` returned the SPA fallback as
 * `text/html`.
 *
 * That is the gap this module closes: process health and served-asset
 * integrity are different questions, and only the second would have caught it.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { OpencodeConfig } from "./opencode/client.js";
import { listSessionsAcross } from "./opencode/sessions.js";

const execFileAsync = promisify(execFile);

export const DEPLOYMENT_LIMITS = {
  probeTimeoutMs: 3_000,
  subprocessTimeoutMs: 3_000,
  subprocessMaxBuffer: 512 * 1024,
  /** Bounded like every other fan-out; see AGENTS.md decision 12. */
  busyDirectories: 25,
  cacheMs: 5_000,
} as const;

/**
 * Fixed labels. Never taken from request input -- this module shells out, and
 * an attacker-chosen service name is not a thing we want to be possible.
 */
const SERVICES = [
  { label: "ai.dcaleon.bff", role: "bff" as const },
  { label: "ai.opencode.serve", role: "opencode" as const },
];

export interface ServiceStatus {
  label: string;
  role: "bff" | "opencode";
  loaded: boolean;
  pid: number | null;
  /**
   * Restart cost is documentation, not measurement, and it is asymmetric.
   * `deploy/README.md` states the BFF restart leaves active agent turns
   * untouched, while an OpenCode restart interrupts the current turn and
   * nothing resumes it automatically (AGENTS.md decision 5).
   */
  restartCost: "safe" | "destructive";
  restartNote: string;
}

export interface ServedAsset {
  path: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  /** Populated when the check failed, in operator-facing language. */
  problem?: string;
}

/**
 * `not-built` matters as much as `corrupted`.
 *
 * A development checkout serves its UI from Vite, so `dist/client` is simply
 * absent and every asset probe falls through to the SPA handler -- identical
 * symptoms to the corruption case, entirely different meaning. The two are
 * separated by whether `index.html` survived: a preview build REPLACES the
 * bundle (index.html present, `public/` contents gone), while an unbuilt
 * checkout has no bundle at all. Reporting corruption in development would
 * train the reader to ignore this panel.
 */
export type AssetsVerdict = "ok" | "corrupted" | "not-built";

export interface DeploymentSnapshot {
  platform: string;
  /** False off macOS: the process table reads launchctl and nothing else can. */
  servicesAvailable: boolean;
  servicesNote?: string;
  services: ServiceStatus[];
  assets: ServedAsset[];
  assetsVerdict: AssetsVerdict;
  assetsNote: string;
  bundle: { indexHtmlSha1: string | null; hasServiceWorker: boolean; hasManifest: boolean; directory: string };
  busySessions: { count: number | null; directoriesChecked: number; note: string };
  readAt: string;
}

/**
 * Mirrors `server/index.ts`: `dist/server/index.js` resolves `../client`.
 *
 * `compiled` matters because running from source under tsx resolves the same
 * relative path to the SOURCE `client/` directory, which has its own
 * `index.html` and would otherwise look like a bundle that lost its assets.
 * Only the compiled layout is serving anything, so only it can be corrupt.
 */
function clientDirectory(): { directory: string; compiled: boolean } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    directory: path.resolve(here, "../client"),
    compiled: here.split(path.sep).includes("dist"),
  };
}

async function launchctlServices(): Promise<{ available: boolean; note?: string; services: ServiceStatus[] }> {
  const describe = (label: string, role: ServiceStatus["role"], loaded: boolean, pid: number | null): ServiceStatus => ({
    label,
    role,
    loaded,
    pid,
    restartCost: role === "bff" ? "safe" : "destructive",
    restartNote:
      role === "bff"
        ? "Rebuilds before swapping; browsers reconnect briefly. Active agent turns are unaffected."
        : "Interrupts the running turn. Session history survives but nothing resumes automatically.",
  });

  if (process.platform !== "darwin") {
    return {
      available: false,
      note: `Process table reads launchctl and is only available on macOS (this host is ${process.platform}).`,
      services: SERVICES.map(({ label, role }) => describe(label, role, false, null)),
    };
  }

  try {
    const { stdout } = await execFileAsync("launchctl", ["list"], {
      timeout: DEPLOYMENT_LIMITS.subprocessTimeoutMs,
      maxBuffer: DEPLOYMENT_LIMITS.subprocessMaxBuffer,
    });
    const rows = new Map<string, number | null>();
    for (const line of stdout.split("\n")) {
      const columns = line.split("\t");
      if (columns.length < 3) continue;
      const pid = Number(columns[0]);
      rows.set(columns[2].trim(), Number.isInteger(pid) ? pid : null);
    }
    return {
      available: true,
      services: SERVICES.map(({ label, role }) =>
        describe(label, role, rows.has(label), rows.get(label) ?? null),
      ),
    };
  } catch (error) {
    return {
      available: false,
      note: `launchctl was not readable: ${error instanceof Error ? error.message : String(error)}`,
      services: SERVICES.map(({ label, role }) => describe(label, role, false, null)),
    };
  }
}

/**
 * Fetch our own static assets over loopback.
 *
 * This is the only check that exercises the SPA catch-all in `server/index.ts`,
 * which is what turned a missing `sw.js` into a 200 of `text/html`. A disk
 * check alone would report the absence but not the misleading success.
 */
async function servedAssets(port: number): Promise<ServedAsset[]> {
  const targets = [
    { path: "/sw.js", expect: /javascript/u, label: "JavaScript" },
    { path: "/manifest.webmanifest", expect: /manifest\+json|application\/json/u, label: "a web manifest" },
  ];

  return Promise.all(
    targets.map(async ({ path: assetPath, expect, label }): Promise<ServedAsset> => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${assetPath}`, {
          signal: AbortSignal.timeout(DEPLOYMENT_LIMITS.probeTimeoutMs),
          redirect: "error",
        });
        const contentType = response.headers.get("content-type");
        const body = await response.arrayBuffer();
        const typeOk = contentType !== null && expect.test(contentType);
        const ok = response.ok && typeOk;
        return {
          path: assetPath,
          ok,
          status: response.status,
          contentType,
          bytes: body.byteLength,
          problem: ok
            ? undefined
            : !response.ok
              ? `Returned HTTP ${response.status}.`
              : `Served as ${contentType ?? "an unknown type"} rather than ${label}. A preview build may have overwritten dist/client.`,
        };
      } catch (error) {
        return {
          path: assetPath,
          ok: false,
          status: null,
          contentType: null,
          bytes: null,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

async function bundleState(): Promise<DeploymentSnapshot["bundle"] & { compiled: boolean }> {
  const { directory, compiled } = clientDirectory();
  const [index, worker, manifest] = await Promise.all([
    readFile(path.join(directory, "index.html")).catch(() => null),
    stat(path.join(directory, "sw.js")).then(() => true).catch(() => false),
    stat(path.join(directory, "manifest.webmanifest")).then(() => true).catch(() => false),
  ]);
  return {
    directory,
    compiled,
    indexHtmlSha1: index ? createHash("sha1").update(index).digest("hex") : null,
    hasServiceWorker: worker,
    hasManifest: manifest,
  };
}

/**
 * Busy sessions across pinned projects.
 *
 * Deliberately not claimed as global. `/session/status` is directory-scoped
 * and process-local, and project discovery is capped at 500 directories at two
 * upstream calls each, so an honest bounded answer beats an expensive
 * misleading one. A non-zero count is a reliable "do not restart OpenCode";
 * zero only means none were seen among the directories checked.
 */
async function busySessions(
  config: OpencodeConfig,
  directories: string[],
): Promise<DeploymentSnapshot["busySessions"]> {
  const checked = directories.slice(0, DEPLOYMENT_LIMITS.busyDirectories);
  if (checked.length === 0) {
    return { count: null, directoriesChecked: 0, note: "No pinned projects to check." };
  }
  try {
    const sessions = await listSessionsAcross(config, checked, { perDirectoryLimit: 20 });
    return {
      count: sessions.filter((session) => session.running).length,
      directoriesChecked: checked.length,
      note: `Across ${checked.length} pinned project${checked.length === 1 ? "" : "s"}. Session status is process-local, so zero is not proof of idle.`,
    };
  } catch {
    return { count: null, directoriesChecked: checked.length, note: "Session status was unavailable." };
  }
}

let cached: { snapshot: DeploymentSnapshot; expiresAt: number } | null = null;
let inFlight: Promise<DeploymentSnapshot> | null = null;

/** Tests only. */
export function resetDeploymentCache(): void {
  cached = null;
  inFlight = null;
}

export function getDeploymentSnapshot(input: {
  config: OpencodeConfig;
  port: number;
  directories: string[];
  refresh?: boolean;
}): Promise<DeploymentSnapshot> {
  if (!input.refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.snapshot);
  if (inFlight) return inFlight;

  const request = (async (): Promise<DeploymentSnapshot> => {
    const [services, assets, bundle, busy] = await Promise.all([
      launchctlServices(),
      servedAssets(input.port),
      bundleState(),
      busySessions(input.config, input.directories),
    ]);

    const allOk = assets.every((asset) => asset.ok);
    const bundlePresent = bundle.compiled && bundle.indexHtmlSha1 !== null;
    const verdict: AssetsVerdict = allOk ? "ok" : bundlePresent ? "corrupted" : "not-built";
    const note =
      verdict === "ok"
        ? "Service worker and manifest are being served with the correct content types."
        : verdict === "not-built"
          ? "No production bundle in this checkout, so these requests fall through to the SPA handler. Expected in development, where the UI is served by Vite."
          : "The bundle exists but its assets are not being served correctly. A preview build overwrites dist/client in place, which produces exactly this without restarting anything.";

    return {
      platform: process.platform,
      servicesAvailable: services.available,
      servicesNote: services.note,
      services: services.services,
      assets,
      assetsVerdict: verdict,
      assetsNote: note,
      bundle: { directory: bundle.directory, indexHtmlSha1: bundle.indexHtmlSha1, hasServiceWorker: bundle.hasServiceWorker, hasManifest: bundle.hasManifest },
      busySessions: busy,
      readAt: new Date().toISOString(),
    };
  })()
    .then((snapshot) => {
      cached = { snapshot, expiresAt: Date.now() + DEPLOYMENT_LIMITS.cacheMs };
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });

  inFlight = request;
  return request;
}
