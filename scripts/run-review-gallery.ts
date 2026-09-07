import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createGalleryManifest, GALLERY_MARKER, validateScenarios } from "./review-gallery.js";
import { REVIEW_SCENARIOS, reviewScenario, selectReviewScenarios } from "./review-scenarios.js";
import { assertPublishTarget, githubApi, publishGallery, updateGalleryComment } from "./review-github.js";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000 }).trim();
async function port(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(error => error ? reject(error) : resolve(value)); }); });
}

async function main() {
  if (args.includes("--help")) {
    console.log("screenshots:gallery [--list | --plan] [--base origin/main] [--scenarios id,id | --states file.json] [--pr N] [--publish --reviewed --bundle path]");
    return;
  }
  if (args.includes("--list")) { console.log(JSON.stringify(REVIEW_SCENARIOS, null, 2)); return; }
  const sha = git("rev-parse", "HEAD");
  const number = option("--pr");
  const pr = number ? Number(number) : undefined;
  if (number && (!Number.isSafeInteger(pr) || pr! < 1)) throw new Error("--pr must be a positive integer");
  const repository = pr ? JSON.parse(execFileSync("gh", ["repo", "view", "--json", "nameWithOwner"], { encoding: "utf8" })).nameWithOwner as string : undefined;
  if (pr) await assertPublishTarget(githubApi, repository!, pr, sha);
  if (args.includes("--publish")) {
    if (!pr || !args.includes("--reviewed") || !option("--bundle")) throw new Error("publication requires --pr, --bundle, and --reviewed after inspecting every image");
    if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("publication requires a clean source checkout");
    const lock = path.join(os.tmpdir(), `dcaleon-review-${repository!.replace("/", "-")}-${pr}.lock`);
    const fd = openSync(lock, "wx", 0o600);
    try {
      const result = await publishGallery({ directory: path.resolve(option("--bundle")!), repository: repository!, pr, sha });
      console.log(`Published ${result.manifest.images.length} verified images for PR #${pr} on ${result.branch}`);
    } finally { closeSync(fd); unlinkSync(lock); }
    return;
  }
  const base = option("--base") ?? "origin/main";
  if (base.startsWith("-")) throw new Error("invalid base ref");
  const files = git("diff", "--name-only", "--diff-filter=ACDMRT", `${base}...HEAD`).split("\n").filter(Boolean);
  const coverage = selectReviewScenarios(files);
  const states = option("--states");
  const ids = option("--scenarios");
  if (states && ids) throw new Error("choose --states or --scenarios");
  const scenarios = states ? validateScenarios(JSON.parse(readFileSync(states, "utf8"))) : (ids ? ids.split(",") : coverage.ids).map(reviewScenario);
  if (args.includes("--plan")) { console.log(JSON.stringify({ files, coverage, scenarios }, null, 2)); return; }
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("capture requires a clean commit; commit source and scenario changes first so evidence identifies reproducible code");
  if (!scenarios.length) {
    if (pr) await updateGalleryComment(githubApi, repository!, pr, sha, `${GALLERY_MARKER}\n## Playwright review gallery\n\nSource: \`${sha}\`\n\n${coverage.reason}`);
    console.log(coverage.reason); return;
  }
  const outputRoot = path.resolve("screenshot-output");
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(path.join(outputRoot, "gallery-"));
  const request = path.join(outputRoot, `${path.basename(output)}.request.json`);
  writeFileSync(request, JSON.stringify(validateScenarios(scenarios), null, 2));
  if (pr) await updateGalleryComment(githubApi, repository!, pr, sha, `${GALLERY_MARKER}\n## Playwright review gallery\n\nSource: \`${sha}\`\n\nCapture in progress. Previous gallery has been superseded.\n\n${coverage.reason}`);
  const ports = new Set<number>();
  while (ports.size < 3) ports.add(await port());
  const [appPort, mockPort, previewPort] = [...ports];
  // No GH/AI tokens are inherited by the captured checkout or mock processes.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SystemRoot", "PLAYWRIGHT_BROWSERS_PATH"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { CI: "true", PORT: String(appPort), MOCK_OPENCODE_PORT: String(mockPort), MOCK_PREVIEW_PORT: String(previewPort), REVIEW_GALLERY_REQUEST: request, REVIEW_GALLERY_OUTPUT: output });
  const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "tests/e2e/review-gallery.ui.spec.ts", "--workers=1", "--retries=0"], { stdio: "inherit", env, timeout: 12 * 60_000 });
  unlinkSync(request);
  if (result.status !== 0 || result.error) {
    if (pr) await updateGalleryComment(githubApi, repository!, pr, sha, `${GALLERY_MARKER}\n## Playwright review gallery\n\nSource: \`${sha}\`\n\nCapture failed. No current images published. Rerun the local gallery command; inspect the local Playwright report.`);
    throw new Error("gallery capture failed; partial output is not publishable");
  }
  if (git("rev-parse", "HEAD") !== sha || git("status", "--porcelain", "--untracked-files=normal")) throw new Error("source changed during capture; recapture before publication");
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(createGalleryManifest(output, sha, scenarios), null, 2));
  console.log(`Gallery: ${output}\nInspect every image, then publish with:\nnpm run screenshots:gallery -- --pr ${pr ?? "<number>"} --publish --reviewed --bundle ${output}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
