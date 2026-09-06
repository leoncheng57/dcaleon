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

  test("OpenCode is a navbar runtime beside the others and opens the hub, keeping the directory scope", async ({ page }) => {
    await page.goto(`/settings?directory=${encodeURIComponent(DIR)}`);
    const opencode = page.getByTestId("opencode-nav-opencode");
    await expect(opencode).toHaveAccessibleName("OpenCode");
    // Order in the main nav: OpenCode precedes Planning (and any enabled lab).
    const order = await page.locator("nav[aria-label='Main'] > *").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(order.indexOf("opencode-nav-opencode")).toBeLessThan(order.indexOf("opencode-nav-planning"));
    await opencode.click();
    await expect(page).toHaveURL(`/opencode?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-hub")).toBeVisible();
    // The hub keeps its established tab title; only its route moved.
    await expect(page).toHaveTitle("Sessions | DCA");
  });

  test("at phone width OpenCode moves into More and the bar does not overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(`/settings?directory=${encodeURIComponent(DIR)}`);
    // One more icon in the bar overflows a 390px phone (the same reason the
    // build label hides here), so the bar entry yields and More carries it.
    await expect(page.getByTestId("opencode-nav-opencode")).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByTestId("opencode-nav-more").click();
    await page.getByTestId("opencode-nav-more-menu").getByTestId("opencode-nav-more-opencode").click();
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
