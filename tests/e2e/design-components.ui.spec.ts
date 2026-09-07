import { expect, test } from "@playwright/test";

// Local gallery state only; this file owns no shared BFF or mock session keys.
for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 740 }, { width: 1440, height: 900 }]) {
  test.describe(`design components at ${viewport.width}px`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1024 });
    test("previews shared panels with keyboard selection and focus restoration", async ({ page }) => {
      const browserRequests: string[] = [];
      page.on("request", (request) => {
        if (/^\/api\/(browser|minichats|terminal)\//.test(new URL(request.url()).pathname)) browserRequests.push(request.url());
      });
      await page.goto("/design-components");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Small screens. Shared details.");
      const opener = page.getByTestId("design-panel-open");
      await opener.click();
      const panel = page.getByTestId("design-panel");
      await expect(panel).toHaveAttribute("role", viewport.width < 1024 ? "dialog" : "complementary");
      await expect(panel).toBeFocused();
      const bounds = await panel.boundingBox();
      expect(bounds?.width).toBe(viewport.width < 1024 ? viewport.width : 672);
      const selector = page.getByTestId("design-panel-selector");
      if (viewport.width < 1024) {
        for (const control of [selector, page.getByTestId("design-panel-close")]) {
          const target = await control.boundingBox();
          expect(target?.height).toBeGreaterThanOrEqual(44);
          expect(target?.width).toBeGreaterThanOrEqual(44);
        }
      }
      await selector.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(selector).toContainText("Minichats");
      await expect(selector).toBeFocused();
      await expect.poll(async () => (await panel.boundingBox())?.width).toBe(viewport.width < 1024 ? viewport.width : 448);
      await selector.press("Enter");
      await selector.press("Escape");
      await expect(panel).toBeVisible();
      await expect(selector).toHaveAttribute("aria-expanded", "false");
      if (viewport.width < 1024) {
        await selector.press("Shift+Tab");
        await expect(page.getByTestId("design-panel-close")).toBeFocused();
        await page.getByTestId("design-panel-close").press("Tab");
        await expect(selector).toBeFocused();
      }
      await selector.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(opener).toBeFocused();
      await page.getByTestId("design-reconnect").click();
      await expect(page.getByTestId("design-state-disconnected")).toContainText("Connection restored");
      expect(browserRequests).toEqual([]);
    });

    test("is reachable from Docs and fits light, dark, and reduced-motion views", async ({ page }) => {
      await page.goto("/docs");
      await page.getByTestId("opencode-nav-more").click();
      await page.getByTestId("opencode-nav-design-components").click();
      await expect(page).toHaveURL(/\/design-components$/);
      await page.getByTestId("opencode-nav-more").click();
      await page.getByTestId("opencode-palette-open").click();
      await page.getByTestId("opencode-palette-input").fill("Design components");
      await page.getByTestId("opencode-palette-option").filter({ hasText: "Design components" }).click();
      await expect(page.getByTestId("opencode-command-palette")).toHaveCount(0);
      await page.goto("/docs");
      await page.getByTestId("opencode-docs-design-components").click();
      await expect(page).toHaveURL(/\/design-components$/);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await page.evaluate((theme) => { localStorage.setItem("theme", theme); document.documentElement.classList.toggle("dark", theme === "dark"); }, colorScheme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.getByTestId("design-panel-open").click();
        expect(await page.getByTestId("design-panel").evaluate((element) => getComputedStyle(element).transitionProperty)).toBe("none");
        await page.getByTestId("design-panel-close").click();
      }
      await page.getByTestId("design-guide-link").click();
      await expect(page).toHaveURL(/\/docs\/design-components-guide$/);
      await expect(page.getByRole("heading", { name: "Mobile first", exact: true })).toBeVisible();
    });
  });
}
