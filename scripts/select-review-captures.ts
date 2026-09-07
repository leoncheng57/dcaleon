import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseScreenshotBlock, normalizeScreenshotRequests } from "./pr-screenshots.js";
import { selectReviewScenarios } from "./review-scenarios.js";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
const pr = event.pull_request;
if (!pr || !/^[a-f0-9]{40}$/.test(pr.base.sha) || !/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error("invalid PR event identity");
const selection = parseScreenshotBlock(pr.body ?? "");
const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRT", `${pr.base.sha}...${pr.head.sha}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const coverage = selection.blockFound ? { reason: "Author override from the screenshots block (an empty block explicitly skips capture).", needsLocalReview: false } : selectReviewScenarios(files);
const requests = selection.blockFound ? selection.requests : normalizeScreenshotRequests(selectReviewScenarios(files).ids.map(scenarioId => ({ scenarioId })));
const requestFile = process.argv[2];
const coverageFile = process.argv[3];
if (!requestFile || !coverageFile) throw new Error("request and coverage output paths required");
writeFileSync(requestFile, JSON.stringify(requests));
writeFileSync(coverageFile, JSON.stringify(coverage));
console.log(`${requests.length} selected scenarios/routes: ${coverage.reason}`);
