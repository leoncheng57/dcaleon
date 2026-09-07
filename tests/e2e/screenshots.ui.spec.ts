import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { resolveCaptureConfig, screenshotRequestLabel, screenshotStableRoot, SCREENSHOT_VIEWPORTS, VIEWPORTS, type ScreenshotRequest } from "../../scripts/pr-screenshots.js";
import { reviewScenario } from "../../scripts/review-scenarios.js";
import { installReviewFixtures, prepareReviewState } from "./review-capture.js";

const config = resolveCaptureConfig(process.env, process.env.PR_SCREENSHOT_CAPTURE_REQUIRED === "true");
const requests = config
  ? JSON.parse(readFileSync(config.requestFile, "utf8")) as ScreenshotRequest[]
  : [];

test.describe("requested PR screenshots", () => {
  if (!config) {
    test.skip("@shots requires the screenshot runner", () => {});
    return;
  }
  for (const request of requests) {
    test(`${request.scenarioId ?? screenshotRequestLabel(request.requestedRoute, request.fullPage)} @shots`, async ({ page }) => {
      await installReviewFixtures(page);
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.addInitScript(() => localStorage.setItem("theme", "dark"));
      for (const viewport of SCREENSHOT_VIEWPORTS) {
        await page.setViewportSize(VIEWPORTS[viewport]);
        if (request.scenarioId) {
          const scenario = reviewScenario(request.scenarioId);
          await prepareReviewState(page, scenario);
          const filename = path.join(config.outputDir, request.filenames[viewport]);
          if (scenario.target) await page.getByTestId(scenario.target).filter({ visible: true }).screenshot({ path: filename });
          else await page.screenshot({ path: filename, fullPage: true });
          continue;
        }
        const response = await page.goto(request.requestedRoute, { waitUntil: "domcontentloaded" });
        expect(response?.ok(), `route ${request.requestedRoute} should load`).toBe(true);

        const pathname = new URL(request.requestedRoute, "http://screenshot.invalid").pathname;
        const stableRoot = screenshotStableRoot(pathname);
        // Unreachable via the runner, which validates every route against the same
        // table. Asserted anyway so a hand-written request file names the missing
        // map entry instead of timing out on whatever a fallback guessed.
        expect(stableRoot, `route ${request.requestedRoute} has no stable root testid in SCREENSHOT_ROUTES`).not.toBeNull();
        await expect(page.getByTestId(stableRoot as string)).toBeVisible();
        if (pathname === "/planning") {
          await expect(page.getByTestId("opencode-planning-list")).toBeVisible();
          if (new URL(request.requestedRoute, "http://screenshot.invalid").searchParams.get("create") === "1") {
            await expect(page.getByTestId("opencode-planning-create-dialog")).toBeVisible();
            await expect(page.getByTestId("opencode-planning-label-list")).toContainText("frontend");
          }
        }
        const url = new URL(request.requestedRoute, "http://screenshot.invalid");
        if (url.searchParams.get("panel") === "subagents") {
          await expect(page.locator('[data-testid="opencode-subagents"]:visible')).toBeVisible();
          await expect(page.locator('[data-testid="opencode-subagent-row"]:visible, [data-testid="opencode-subagents-empty"]:visible').first()).toBeVisible();
        }
        if (pathname === "/settings") {
          await expect(page.getByTestId("opencode-setting-subagent-depth")).toBeVisible();
        }
        await expect(page.locator("html")).toHaveClass(/dark/);
        await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
        await page.evaluate(async () => await document.fonts.ready);
        await expect(page.getByTestId("opencode-error")).toHaveCount(0);
        await page.screenshot({ path: path.join(config.outputDir, request.filenames[viewport]), fullPage: request.fullPage });
      }
    });
  }
});
