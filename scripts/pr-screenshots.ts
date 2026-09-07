import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_SCREENSHOTS = 10;
export const MAX_ROUTE_LENGTH = 2_048;
export const MAX_BLOCK_LENGTH = 24_000;
export const MAX_PNG_BYTES = 10 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 128 * 1024;
export const MAX_FULL_PAGE_HEIGHT = 20_000;
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 740 },
} as const;

export type ScreenshotViewport = keyof typeof VIEWPORTS;
export const SCREENSHOT_VIEWPORTS = Object.keys(VIEWPORTS) as ScreenshotViewport[];

/**
 * Every capturable UI route, paired with the testid that proves its page rendered.
 *
 * This is deliberately ONE table. It was two — an allowlist here and a ternary
 * chain in the capture spec — and the pair drifted twice: `/dsh` was allowlisted
 * while the spec still fell through to `opencode-hub` (#253), and the same gap
 * reappeared for `/claude`. Both directions of that drift fail badly. A route
 * with no map entry passes validation and then burns a full Playwright timeout
 * waiting on a testid its page never renders, which reads like a flaky capture
 * rather than a missing line here; a map entry with no allowlist pattern is
 * simply unreachable. Pairing them means a route cannot be added half-way.
 *
 * Patterns are anchored and mutually exclusive, so the first match is the only
 * match and ordering is presentation. `tests/pr-screenshots.test.ts` asserts
 * both properties, since an accidentally overlapping pattern would silently
 * shadow a later route's stable root.
 */
export const SCREENSHOT_ROUTES: ReadonlyArray<{ readonly pattern: RegExp; readonly stableRoot: string }> = [
  { pattern: /^\/$/, stableRoot: "opencode-home" },
  { pattern: /^\/opencode$/, stableRoot: "opencode-hub" },
  { pattern: /^\/sessions\/[A-Za-z0-9_-]+$/, stableRoot: "opencode-conversation" },
  { pattern: /^\/settings$/, stableRoot: "opencode-settings" },
  { pattern: /^\/settings\/notifications$/, stableRoot: "opencode-notifications" },
  { pattern: /^\/tools$/, stableRoot: "opencode-tools" },
  { pattern: /^\/docs$/, stableRoot: "opencode-docs" },
  { pattern: /^\/docs\/[A-Za-z0-9_-]+$/, stableRoot: "opencode-doc" },
  { pattern: /^\/planning$/, stableRoot: "opencode-planning" },
  { pattern: /^\/observability$/, stableRoot: "opencode-observability" },
  { pattern: /^\/playbooks(?:\/(?:workflows|reminders)(?:\/[A-Za-z0-9_-]+)?)?$/, stableRoot: "opencode-playbooks" },
  { pattern: /^\/dsh$/, stableRoot: "dsh-home" },
  { pattern: /^\/dsh\/sessions\/[A-Za-z0-9_-]+$/, stableRoot: "dsh-conversation" },
  { pattern: /^\/claude$/, stableRoot: "claude-home" },
  { pattern: /^\/claude\/sessions\/[A-Za-z0-9_-]+$/, stableRoot: "claude-conversation" },
];

/**
 * The testid that proves `pathname` finished rendering, or `null` when the route
 * is not capturable. Returning `null` rather than a default is the point: the
 * old `: "opencode-hub"` fallback turned an unmapped route into a wrong wait.
 */
export function screenshotStableRoot(pathname: string): string | null {
  return SCREENSHOT_ROUTES.find((route) => route.pattern.test(pathname))?.stableRoot ?? null;
}

export type ScreenshotRequest = {
  requestedRoute: string;
  fullPage: boolean;
  filenames: Record<ScreenshotViewport, string>;
};

type ScreenshotCapture = {
  filename: string;
  dimensions: { width: number; height: number };
  bytes: number;
  sha256: string;
};

export type ScreenshotManifest = {
  schemaVersion: 2;
  prNumber: number;
  sourceSha: string;
  capturedAt: string;
  screenshots: Array<Omit<ScreenshotRequest, "filenames"> & {
    captures: Record<ScreenshotViewport, ScreenshotCapture>;
  }>;
};

export function resolveCaptureConfig(
  env: NodeJS.ProcessEnv,
  required = false,
): { requestFile: string; outputDir: string } | null {
  const requestFile = env.PR_SCREENSHOT_REQUEST_FILE;
  const outputDir = env.PR_SCREENSHOT_OUTPUT_DIR;
  if (requestFile && outputDir) return { requestFile, outputDir };
  if (required) throw new Error("screenshot capture requires PR_SCREENSHOT_REQUEST_FILE and PR_SCREENSHOT_OUTPUT_DIR");
  return null;
}

export function decidePublication(input: {
  repository: string;
  runHeadSha: string;
  prHeadSha: string;
  prHeadRepository: string;
}): { publish: boolean; reason: "same-repository" | "fork" | "sha-mismatch" } {
  if (input.prHeadSha !== input.runHeadSha) return { publish: false, reason: "sha-mismatch" };
  if (input.prHeadRepository !== input.repository) return { publish: false, reason: "fork" };
  return { publish: true, reason: "same-repository" };
}

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
}

function decodeRepeatedly(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function validateRoute(route: string): void {
  if (route.length > MAX_ROUTE_LENGTH) throw new Error(`route exceeds ${MAX_ROUTE_LENGTH} characters`);
  if (!route.startsWith("/") || route.startsWith("//")) {
    throw new Error(`route ${JSON.stringify(route)} must begin with one "/" and may not specify a host`);
  }
  if (/[\s\u0000-\u001f\u007f\\]/u.test(route)) {
    throw new Error(`route ${JSON.stringify(route)} contains whitespace, a control character, or a backslash`);
  }

  let decoded: string;
  try {
    decoded = decodeRepeatedly(route);
  } catch {
    throw new Error(`route ${JSON.stringify(route)} contains malformed percent encoding`);
  }
  if (/[\s\u0000-\u001f\u007f\\]/u.test(decoded)) {
    throw new Error(`route ${JSON.stringify(route)} contains encoded whitespace, controls, or backslashes`);
  }
  const decodedPath = decoded.split(/[?#]/u, 1)[0];
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`route ${JSON.stringify(route)} contains path traversal`);
  }

  const url = new URL(route, "http://screenshot.invalid");
  if (url.origin !== "http://screenshot.invalid") throw new Error(`route ${JSON.stringify(route)} may not specify a scheme or host`);
  if (screenshotStableRoot(url.pathname) === null) {
    throw new Error(`route ${JSON.stringify(route)} is not a known UI route`);
  }
}

export function screenshotFilename(route: string, fullPage: boolean, index: number, viewport: ScreenshotViewport): string {
  const url = new URL(route, "http://screenshot.invalid");
  const readable = `${url.pathname === "/" ? "home" : url.pathname.slice(1)}${url.search}`
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 80) || "page";
  const digest = createHash("sha256").update(`${viewport}:${fullPage}:${route}`).digest("hex").slice(0, 8);
  return `${String(index + 1).padStart(2, "0")}-${readable}-${digest}--${viewport}${fullPage ? "--full" : ""}.png`;
}

/**
 * The identity of a request: a route captured at viewport height and the same route
 * captured full-page are two different requests, so `fullPage` is part of the label.
 * Because `validateRoute()` requires a leading "/", a route can never itself begin with
 * "full:", which makes this mapping injective. Used both to reject exact duplicates here
 * and to title the capture tests, so validation and test generation cannot disagree.
 */
export function screenshotRequestLabel(route: string, fullPage: boolean): string {
  return `${fullPage ? "full:" : ""}${route}`;
}

export function normalizeScreenshotRequests(value: unknown): ScreenshotRequest[] {
  if (!Array.isArray(value)) throw new Error("screenshot request must be an array");
  if (value.length > MAX_SCREENSHOTS) throw new Error(`at most ${MAX_SCREENSHOTS} screenshots may be requested`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    assertRecord(raw, `screenshot ${index + 1}`);
    if (typeof raw.requestedRoute !== "string" || typeof raw.fullPage !== "boolean") {
      throw new Error(`screenshot ${index + 1} has invalid route metadata`);
    }
    validateRoute(raw.requestedRoute);
    const label = screenshotRequestLabel(raw.requestedRoute, raw.fullPage);
    if (seen.has(label)) {
      throw new Error(`route ${JSON.stringify(label)} is requested more than once; a route may appear at most once on its own and at most once as "full:"`);
    }
    seen.add(label);
    return {
      requestedRoute: raw.requestedRoute,
      fullPage: raw.fullPage,
      filenames: {
        desktop: screenshotFilename(raw.requestedRoute, raw.fullPage, index, "desktop"),
        mobile: screenshotFilename(raw.requestedRoute, raw.fullPage, index, "mobile"),
      },
    };
  });
}

export function parseScreenshotBlock(body: string): { blockFound: boolean; requests: ScreenshotRequest[] } {
  const matches = [...body.matchAll(/^```screenshots[\t ]*\r?\n([\s\S]*?)^```[\t ]*$/gmu)];
  if (matches.length === 0) {
    if (/^```screenshots\b/mu.test(body)) throw new Error("screenshots block is malformed or missing its closing fence");
    return { blockFound: false, requests: [] };
  }
  if (matches.length > 1) throw new Error("PR body must contain at most one ```screenshots block");
  const block = matches[0][1];
  if (block.length > MAX_BLOCK_LENGTH) throw new Error(`screenshots block exceeds ${MAX_BLOCK_LENGTH} characters`);

  const rawRequests: Array<{ requestedRoute: string; fullPage: boolean }> = [];
  for (const rawLine of block.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line !== rawLine) throw new Error(`route ${JSON.stringify(rawLine)} has leading or trailing whitespace`);
    const fullPage = line.startsWith("full:");
    rawRequests.push({ requestedRoute: fullPage ? line.slice("full:".length) : line, fullPage });
  }
  return { blockFound: true, requests: normalizeScreenshotRequests(rawRequests) };
}

export function pngDimensions(buffer: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("file is not a PNG with an IHDR header");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function createManifest(outputDir: string, requests: ScreenshotRequest[], prNumber: number, sourceSha: string): ScreenshotManifest {
  if (!Number.isSafeInteger(prNumber) || prNumber < 0) throw new Error("prNumber must be a non-negative integer");
  if (!/^(local|[0-9a-f]{40})$/u.test(sourceSha)) throw new Error("sourceSha must be local or a 40-character lowercase commit SHA");
  const capturedAt = new Date().toISOString();
  const screenshots = requests.map(({ requestedRoute, fullPage, filenames }) => {
    const captures = Object.fromEntries(SCREENSHOT_VIEWPORTS.map((viewport) => {
      const filename = filenames[viewport];
      const buffer = readFileSync(path.join(outputDir, filename));
      if (buffer.length > MAX_PNG_BYTES) throw new Error(`${filename} exceeds ${MAX_PNG_BYTES} bytes`);
      const dimensions = pngDimensions(buffer);
      const expected = VIEWPORTS[viewport];
      if (dimensions.width !== expected.width || (fullPage
        ? dimensions.height < expected.height || dimensions.height > MAX_FULL_PAGE_HEIGHT
        : dimensions.height !== expected.height)) {
        throw new Error(`${filename} has invalid capture dimensions`);
      }
      return [viewport, {
        filename,
        dimensions,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      }];
    })) as Record<ScreenshotViewport, ScreenshotCapture>;
    return { requestedRoute, fullPage, captures };
  });
  return { schemaVersion: 2, prNumber, sourceSha, capturedAt, screenshots };
}

export function validateAndPublishBundle(bundleDir: string, destination: string, expectedPr: number, expectedSha: string): ScreenshotManifest {
  const entries = readdirSync(bundleDir);
  if (entries.some((entry) => lstatSync(path.join(bundleDir, entry)).isSymbolicLink())) throw new Error("bundle must not contain symbolic links");
  if (!entries.includes("manifest.json")) throw new Error("bundle is missing manifest.json");
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) throw new Error("manifest is too large");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  assertRecord(raw, "manifest");
  if (raw.schemaVersion !== 2 || raw.prNumber !== expectedPr || raw.sourceSha !== expectedSha || typeof raw.capturedAt !== "string" || !Array.isArray(raw.screenshots)) {
    throw new Error("manifest identity does not match the trusted workflow run");
  }
  const requests = normalizeScreenshotRequests(raw.screenshots.map((item, index) => {
    assertRecord(item, `manifest screenshot ${index + 1}`);
    return { requestedRoute: item.requestedRoute, fullPage: item.fullPage };
  }));
  const expectedFiles = new Set(["manifest.json", ...requests.flatMap(({ filenames }) => SCREENSHOT_VIEWPORTS.map((viewport) => filenames[viewport]))]);
  if (entries.length !== expectedFiles.size || entries.some((entry) => !expectedFiles.has(entry))) throw new Error("bundle contains an unexpected or missing file");

  const manifest = raw as unknown as ScreenshotManifest;
  for (const [index, request] of requests.entries()) {
    const declared = manifest.screenshots[index];
    assertRecord(declared?.captures, `manifest screenshot ${index + 1} captures`);
    for (const viewport of SCREENSHOT_VIEWPORTS) {
      const expectedFilename = request.filenames[viewport];
      const capture = declared.captures[viewport];
      const filePath = path.join(bundleDir, expectedFilename);
      if (capture?.filename !== expectedFilename || !existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`manifest file ${index + 1} ${viewport} is invalid`);
      const buffer = readFileSync(filePath);
      const dimensions = pngDimensions(buffer);
      const digest = createHash("sha256").update(buffer).digest("hex");
      const expectedDimensions = VIEWPORTS[viewport];
      const validDimensions = dimensions.width === expectedDimensions.width
        && (request.fullPage
          ? dimensions.height >= expectedDimensions.height && dimensions.height <= MAX_FULL_PAGE_HEIGHT
          : dimensions.height === expectedDimensions.height);
      if (!validDimensions || buffer.length > MAX_PNG_BYTES || capture.bytes !== buffer.length || capture.sha256 !== digest || capture.dimensions?.width !== dimensions.width || capture.dimensions?.height !== dimensions.height) {
        throw new Error(`${expectedFilename} does not match its manifest metadata`);
      }
    }
  }

  rmSync(destination, { recursive: true, force: true });
  if (requests.length === 0) return manifest;
  mkdirSync(destination, { recursive: true });
  for (const { filenames } of requests) {
    for (const viewport of SCREENSHOT_VIEWPORTS) {
      copyFileSync(path.join(bundleDir, filenames[viewport]), path.join(destination, filenames[viewport]));
    }
  }
  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
