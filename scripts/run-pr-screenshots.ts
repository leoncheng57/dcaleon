import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createManifest, MAX_GIF_WIDTH, normalizeScreenshotRequests, parseScreenshotBlock, recordingFilenames, type ScreenshotRequest } from "./pr-screenshots.js";

const MAX_PREVIEW_SECONDS = 15;

// Recordings are a bonus on top of the PNGs: without ffmpeg (a typical laptop),
// the WebMs are dropped and the bundle is screenshots-only, exactly as before.
function convertRecordings(directory: string, requests: ScreenshotRequest[]): void {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  for (const request of requests) {
    const { video, preview } = recordingFilenames(request.filenames.desktop);
    const videoPath = path.join(directory, video);
    if (!existsSync(videoPath)) continue;
    if (ffmpeg.status !== 0) { rmSync(videoPath); continue; }
    const filter = `fps=8,scale=${MAX_GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse`;
    const result = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-t", String(MAX_PREVIEW_SECONDS), "-i", videoPath, "-vf", filter, path.join(directory, preview)], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`ffmpeg could not convert ${video} to a GIF preview`);
  }
  if (ffmpeg.status !== 0) console.log("ffmpeg not found; publishing screenshots without recordings");
}

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
  rmSync(path.join(outputDir, ".recording"), { recursive: true, force: true });
  convertRecordings(outputDir, parsed.requests);
}

const manifest = createManifest(outputDir, parsed.requests, prNumber, sourceSha);
const coverageFile = option("--coverage-file");
if (coverageFile) manifest.coverage = JSON.parse(readFileSync(coverageFile, "utf8"));
writeFileSync(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(normalizedRequest);
const recordings = manifest.screenshots.filter((shot) => shot.recording).length;
console.log(`Validated ${manifest.screenshots.length} screenshot(s) and ${recordings} recording(s) in ${outputDir}`);
