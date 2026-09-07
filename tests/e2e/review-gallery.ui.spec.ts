import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { galleryFilename, THEMES, validateScenarios } from "../../scripts/review-gallery.js";
import { VIEWPORTS } from "../../scripts/pr-screenshots.js";
import { prepareReviewState } from "./review-capture.js";

const requestFile = process.env.REVIEW_GALLERY_REQUEST;
const output = process.env.REVIEW_GALLERY_OUTPUT;
const scenarios = requestFile && output ? validateScenarios(JSON.parse(readFileSync(requestFile, "utf8"))) : [];
test.describe("local review gallery", () => {
  if (!scenarios.length) test.skip("run with screenshots:gallery", () => {});
  for (const scenario of scenarios) for (const theme of THEMES) for (const viewport of ["desktop", "mobile"] as const) {
    test(`${scenario.id} ${theme} ${viewport} @gallery`, async ({ page, baseURL }) => {
      // Block external browser traffic, including attempted credential-bearing image requests.
      await page.context().route("**/*", route => {
        const url = new URL(route.request().url());
        return url.origin === new URL(baseURL!).origin ? route.continue() : route.abort();
      });
      await page.context().routeWebSocket("**/*", socket => socket.close());
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(value => localStorage.setItem("theme", value), theme);
      await page.setViewportSize(VIEWPORTS[viewport]);
      await prepareReviewState(page, scenario);
      const filename = path.join(output!, galleryFilename(scenario.id, theme, viewport));
      if (scenario.target) await page.getByTestId(scenario.target).filter({ visible: true }).screenshot({ path: filename });
      else await page.screenshot({ path: filename, fullPage: true });
    });
  }
});
