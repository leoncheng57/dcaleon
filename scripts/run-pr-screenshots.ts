import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createManifest, normalizeScreenshotRequests, parseScreenshotBlock } from "./pr-screenshots.js";

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const bodyFile = option("--body-file");
const requestFile = option("--request-file");
if (Boolean(bodyFile) === Boolean(requestFile)) throw new Error("provide exactly one of --body-file or --request-file");

const outputDir = path.resolve(option("--output-dir", "screenshot-output")!);
const prNumber = Number(option("--pr-number", "0"));
const sourceSha = option("--sha", "local")!;
const parsed = bodyFile
  ? parseScreenshotBlock(readFileSync(path.resolve(bodyFile), "utf8"))
  : { blockFound: true, requests: normalizeScreenshotRequests(JSON.parse(readFileSync(path.resolve(requestFile!), "utf8"))) };

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
const normalizedRequest = path.join(outputDir, ".request.json");
writeFileSync(normalizedRequest, `${JSON.stringify(parsed.requests, null, 2)}\n`);

if (parsed.requests.length > 0) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["playwright", "test", "tests/e2e/screenshots.ui.spec.ts", "--workers=1"], {
    stdio: "inherit",
    env: {
      ...process.env,
      CI: "true",
      PORT: process.env.PR_SCREENSHOT_APP_PORT ?? "13410",
      MOCK_OPENCODE_PORT: process.env.PR_SCREENSHOT_OPENCODE_PORT ?? "14599",
      MOCK_PREVIEW_PORT: process.env.PR_SCREENSHOT_PREVIEW_PORT ?? "14600",
      PR_SCREENSHOT_CAPTURE_REQUIRED: "true",
      PR_SCREENSHOT_REQUEST_FILE: normalizedRequest,
      PR_SCREENSHOT_OUTPUT_DIR: outputDir,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const manifest = createManifest(outputDir, parsed.requests, prNumber, sourceSha);
const coverageFile = option("--coverage-file");
if (coverageFile) manifest.coverage = JSON.parse(readFileSync(coverageFile, "utf8"));
writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(normalizedRequest);
console.log(`Validated ${manifest.screenshots.length} screenshot(s) in ${outputDir}`);
