import { expect, test } from "@playwright/test";

const DIR = "/tmp/mock-project";

test.describe("landing page and runtime navigation", () => {
  test("the root is a minimal landing that points at the public repository", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("opencode-home")).toBeVisible();
    await expect(page.getByTestId("opencode-home-repository")).toHaveAttribute("href", "https://github.com/leoncheng57/custom-dca-opencode");
    // The OpenCode hub no longer owns the root.
    await expect(page.getByTestId("opencode-hub")).toHaveCount(0);
    await expect(page).toHaveTitle("DCA");
  });

  test("island selector opens and navigates to OpenCode, keeping the directory scope", async ({ page }) => {
    await page.goto(`/settings?directory=${encodeURIComponent(DIR)}`);
    const trigger = page.getByTestId("island-selector-trigger");
    await expect(trigger).toHaveAccessibleName("Switch runtime");
    await trigger.click();
    const panel = page.getByTestId("island-selector-panel");
    await expect(panel).toBeVisible();
    await page.getByTestId("island-selector-opencode").click();
    await expect(page).toHaveURL(`/opencode?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-hub")).toBeVisible();
    await expect(page).toHaveTitle("Sessions | DCA");
  });

  test("at phone width the island selector is still visible and the bar does not overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(`/settings?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("island-selector-trigger")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByTestId("island-selector-trigger").click();
    await page.getByTestId("island-selector-opencode").click();
    await expect(page).toHaveURL(`/opencode?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-hub")).toBeVisible();
  });

  test("the brand returns to the landing and the hub still prompts for a directory", async ({ page }) => {
    await page.goto("/opencode");
    await page.getByTestId("opencode-nav-home").click();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("opencode-home")).toBeVisible();
  });
});
