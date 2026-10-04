import { expect, test, type Page } from "@playwright/test";

const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

// Playwright's Chromium always reports `(pointer: coarse)` false, even with
// `hasTouch`, so promote those rules to apply the 44px phone touch targets.
async function applyCoarsePointerRules(page: Page) {
  const promoted = await page.evaluate(() => {
    const rules: string[] = [];
    const collect = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("pointer: coarse")) {
          rules.push(...Array.from(rule.cssRules, (inner) => inner.cssText));
        } else if (rule instanceof CSSGroupingRule) {
          collect(rule.cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) collect(sheet.cssRules);
    const style = document.createElement("style");
    style.textContent = rules.join("\n");
    document.head.append(style);
    return rules.length;
  });
  expect(promoted).toBeGreaterThan(0);
  await expect(page.getByTestId("opencode-nav-refresh")).toHaveCSS("width", "44px");
}

test.describe("appearance", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("appearance-test-ready")) return;
      localStorage.removeItem("theme");
      sessionStorage.setItem("appearance-test-ready", "true");
    });
  });

  test("defaults to System and follows resolved device appearance", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");

    await expect(page.getByTestId("opencode-appearance-system")).toBeChecked();
    await expect(page.getByTestId("opencode-appearance-status")).toHaveText("Selected: System (Dark)");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0a0a0b");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.getByTestId("opencode-appearance-status")).toHaveText("Selected: System (Light)");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    // Tracks --color-browser-chrome, which darkened with the primary green in
    // the paper repaint (#518) so the focus ring clears 3:1 against beige.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0f7a3d");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  });

  test("toggles the resolved appearance from the top navigation", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByTestId("opencode-nav-theme-toggle");
    await expect(toggle).toHaveAccessibleName("Use dark appearance");
    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Use light appearance");
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");
  });

  test("keeps Refresh app between the brand and the appearance control", async ({ page }) => {
    await page.goto("/");
    const refresh = page.getByTestId("opencode-nav-refresh");
    await expect(refresh).toHaveAccessibleName("Refresh app");
    await expect(refresh).toHaveAttribute("title", "Refresh app");
    const order = await page.locator("nav[aria-label='Main'] [data-testid]").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(order).toEqual(expect.arrayContaining([
      "opencode-nav-home",
      "opencode-nav-version",
      "opencode-nav-refresh",
      "opencode-nav-theme-toggle",
      "opencode-nav-planning",
    ]));
    // Search moved into More and is reached by Cmd/Ctrl+K, so it is no longer
    // in the bar.
    expect(order).not.toContain("opencode-palette-open");
    expect(order.indexOf("opencode-nav-home")).toBeLessThan(order.indexOf("opencode-nav-refresh"));
    expect(order.indexOf("opencode-nav-home")).toBeLessThan(order.indexOf("opencode-nav-version"));
    expect(order.indexOf("opencode-nav-version")).toBeLessThan(order.indexOf("opencode-nav-refresh"));
    expect(order.indexOf("opencode-nav-refresh")).toBeLessThan(order.indexOf("opencode-nav-theme-toggle"));
    expect(order.indexOf("opencode-nav-theme-toggle")).toBeLessThan(order.indexOf("opencode-nav-planning"));
  });

  for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 740 }, { width: 1280, height: 800 }]) {
    for (const touch of [false, true]) {
      test(`shows the semantic version beside the brand at ${viewport.width}px${touch ? " with touch-sized controls" : ""}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto("/");
        const version = page.getByTestId("opencode-nav-version");
        await expect(version).toBeVisible();
        if (touch) await applyCoarsePointerRules(page);

        await expect(version).toHaveText(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
        await expect(version).toHaveAttribute("title", /^DCA v\d+\.\d+\.\d+\S*(?: \([0-9a-f]{7}\))?$/u);
        // Fully rendered, not clipped by its own truncation.
        expect(await version.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);

        const nav = (await page.locator("nav[aria-label='Main']").boundingBox())!;
        const home = (await page.getByTestId("opencode-nav-home").boundingBox())!;
        const label = (await version.boundingBox())!;
        // Phones stack the version under the brand; wider screens keep it inline.
        if (viewport.width < 480) expect(label.y).toBeGreaterThanOrEqual(home.y + home.height - 1);
        else expect(label.x).toBeGreaterThanOrEqual(home.x + home.width);
        expect(label.y).toBeGreaterThanOrEqual(nav.y);
        expect(label.y + label.height).toBeLessThanOrEqual(nav.y + nav.height);

        const more = (await page.getByTestId("opencode-nav-more").boundingBox())!;
        expect(more.x + more.width).toBeGreaterThan(viewport.width - 16);
        expect(more.x + more.width).toBeLessThanOrEqual(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      });
    }
  }

  test("asks before discarding an unsent conversation draft", async ({ page }) => {
    await page.goto("/sessions/ses_mock_done?directory=/tmp/mock-project");
    const composer = page.getByTestId("opencode-composer");
    await composer.fill("Do not lose this");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByTestId("opencode-nav-refresh").click();
    await expect(composer).toHaveValue("Do not lose this");
  });

  test("preserves explicit choices across reloads and can return to System", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/settings");

    await page.getByTestId("opencode-appearance-dark").locator("..").click();
    await expect(page.getByTestId("opencode-appearance-dark")).toBeChecked();
    await expect(page.getByTestId("opencode-appearance-status")).toHaveText("Selected: Dark");
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");

    await page.reload();
    await expect(page.getByTestId("opencode-appearance-dark")).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.getByTestId("opencode-appearance-system").locator("..").click();
    await expect(page.getByTestId("opencode-appearance-status")).toHaveText("Selected: System (Light)");
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("system");
  });

  test("offers explicit System, Light, and Dark palette actions", async ({ page }) => {
    await page.goto("/settings");

    for (const appearance of ["dark", "light", "system"] as const) {
      await page.keyboard.press(shortcut);
      await page.getByTestId("opencode-palette-input").fill(`${appearance} appearance`);
      const action = page.getByRole("option", {
        name: new RegExp(`Use ${appearance} appearance`, "i"),
      });
      await expect(action).toBeVisible();
      await action.click();
      expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(appearance);
    }
  });
});
