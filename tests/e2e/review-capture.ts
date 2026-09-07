import { expect, type Page } from "@playwright/test";
import type { ReviewScenario } from "../../scripts/review-scenarios.js";

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
