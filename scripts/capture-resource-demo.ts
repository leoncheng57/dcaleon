import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createGalleryManifest, galleryFilename, THEMES } from "./review-gallery.js";
import { VIEWPORTS } from "./pr-screenshots.js";
import type { ReviewScenario } from "./review-scenarios.js";

// Dedicated offline HTML capture, published through the same validated gallery
// format as app screenshots. Does not start a BFF, agent, or shared test fixture.
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit the demo before capture so the gallery identifies reproducible source.");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const html = readFileSync("design/resource-monitor-demo.html", "utf8");
mkdirSync("screenshot-output", { recursive: true });
const output = mkdtempSync(path.resolve("screenshot-output/resource-demo-"));
const scenarios: ReviewScenario[] = [
  { id: "resource-demo-header", title: "Standalone HTML demo — indicator beside Claude usage", route: "/design/resource-monitor-demo.html",
    steps: [{ testId: "demo-resource-trigger", action: "text", value: "CPU 65.5%" }] },
  { id: "resource-demo-panel", title: "Standalone HTML demo — expanded resource breakdown", route: "/design/resource-monitor-demo.html",
    steps: [{ testId: "demo-resource-trigger", action: "click" }, { testId: "demo-resource-dialog", action: "text", value: "Whole host" }] },
];
const browser = await chromium.launch();
try {
  for (const theme of THEMES) for (const viewport of ["desktop", "mobile"] as const) for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: VIEWPORTS[viewport], colorScheme: theme });
    await page.route("**/*", route => route.abort());
    await page.setContent(html);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const step of scenario.steps) {
      if (step.action === "click") await page.getByTestId(step.testId).click();
      else await expect(page.getByTestId(step.testId)).toContainText(step.value!);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(output, galleryFilename(scenario.id, theme, viewport)) });
    if (scenario.id.endsWith("panel")) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("demo-resource-dialog")).not.toBeVisible();
      await expect(page.getByTestId("demo-resource-trigger")).toBeFocused();
    }
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(path.join(output, "manifest.json"), JSON.stringify(createGalleryManifest(output, sha, scenarios), null, 2));
console.log(`Gallery: ${output}`);
