import { expect, type Page } from "@playwright/test";
import type { ReviewScenario } from "../../scripts/review-scenarios.js";

/** The BFF's filesystem-backed discovery/memory aren't supplied by mock OpenCode. */
export async function installReviewFixtures(page: Page): Promise<void> {
  await page.route("**/api/projects", route => route.fulfill({ json: {
    root: "/tmp",
    projects: ["mock-project", "mock-subagent-project"].map(name => ({ name, relativePath: name, directory: `/tmp/${name}`, kind: "repository" })),
  } }));
  await page.route("**/api/memory?**", route => route.fulfill({ json: {
    index: "- [Review preferences](user_review.md) — concise review evidence",
    entries: [{ filename: "user_review.md", type: "user", description: "Concise review evidence", body: "Show desktop and mobile examples with synthetic data." }], truncated: false,
  } }));
  // Custom review interactions must never delete a host memory entry.
  await page.route("**/api/memory/*?**", route => route.fulfill({ status: 204 }));
}

/** Use visible-only testids: desktop/mobile copies can coexist in the DOM. */
export async function prepareReviewState(page: Page, scenario: ReviewScenario): Promise<void> {
  const response = await page.goto(scenario.route, { waitUntil: "domcontentloaded" });
  expect(response?.ok(), scenario.route).toBe(true);
  for (const step of scenario.steps) {
    const target = page.getByTestId(step.testId).filter({ visible: true });
    if (step.action === "click") await target.click();
    else if (step.action === "fill") await target.fill(step.value!);
    else if (step.action === "text") await expect(target).toContainText(step.value!);
    else await expect(target).toBeVisible();
  }
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.evaluate(() => document.fonts.ready);
}
