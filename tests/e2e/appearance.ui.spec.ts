import { expect, test } from "@playwright/test";

const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

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
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#16a34a");
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
    const order = await page.locator("nav[aria-label='Main'] > *").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")));
    expect(order).toEqual(expect.arrayContaining([
      "opencode-nav-home",
      "opencode-nav-version",
      "opencode-nav-refresh",
      "opencode-nav-theme-toggle",
      "opencode-nav-planning",
    ]));
    // Search moved into More and is reached by Cmd/Ctrl+K, so it is no longer
    // a direct child of the bar. The More menu is a wrapper with no testid,
    // hence the `null` entries in this array.
    expect(order).not.toContain("opencode-palette-open");
    expect(order.indexOf("opencode-nav-home")).toBeLessThan(order.indexOf("opencode-nav-refresh"));
    expect(order.indexOf("opencode-nav-home")).toBeLessThan(order.indexOf("opencode-nav-version"));
    expect(order.indexOf("opencode-nav-version")).toBeLessThan(order.indexOf("opencode-nav-refresh"));
    expect(order.indexOf("opencode-nav-refresh")).toBeLessThan(order.indexOf("opencode-nav-theme-toggle"));
    expect(order.indexOf("opencode-nav-theme-toggle")).toBeLessThan(order.indexOf("opencode-nav-planning"));
  });

  test("shows the deployed build when the navbar has room", async ({ page }) => {
    await page.setViewportSize({ width: 479, height: 740 });
    await page.goto("/");
    const version = page.getByTestId("opencode-nav-version");
    await expect(version).toBeHidden();
    const moreBox = await page.getByTestId("opencode-nav-more").boundingBox();
    expect(moreBox?.x).toBeGreaterThan(420);

    await page.setViewportSize({ width: 480, height: 740 });
    await expect(version).toBeVisible();
    await expect(version).toHaveText(/^v\d+\.\d+\.\d+(?:\+[0-9a-f]{7})?$/u);
  });

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
