import { expect, test } from "@playwright/test";

const DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const settings = `/settings?directory=${encodeURIComponent(DIR)}`;
const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";
const MOCK_URL = `http://127.0.0.1:${process.env.MOCK_OPENCODE_PORT || 4599}`;

async function sessionListRequestCount(): Promise<number> {
  const result = await (await fetch(`${MOCK_URL}/test/session-list-requests`)).json() as { count: number };
  return result.count;
}

test.describe("command palette", () => {
  test("opens globally with accessible keyboard navigation", async ({ page }) => {
    await page.goto(settings);
    // Search moved off the bar into the More menu; the row names the shortcut
    // because the trigger no longer carries aria-keyshortcuts on the bar.
    await page.getByTestId("opencode-nav-more").click();
    const trigger = page.getByTestId("opencode-palette-open");
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("\u2318K");
    await trigger.click();

    const input = page.getByRole("combobox", { name: "Search commands and conversations" });
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.getByRole("option", { name: /Home/ })).toHaveAttribute("aria-selected", "true");

    // Navigation order: Home, OpenCode (the hub, since / became a landing), MCPs.
    await input.press("ArrowDown");
    await expect(page.getByRole("option", { name: /OpenCode/ })).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(page.getByRole("option", { name: /MCPs/ })).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/tools\\?directory=${encodeURIComponent(DIR)}`));
  });

  test("finds and opens a current-project conversation", async ({ page }) => {
    await page.goto(settings);
    await page.keyboard.press(shortcut);
    const input = page.getByTestId("opencode-palette-input");
    await input.fill("health endpoint");
    const option = page.getByRole("option", { name: /Add a health endpoint/ });
    await expect(option).toHaveAttribute("data-kind", "conversation");
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/sessions/ses_mock_done\\?directory=${encodeURIComponent(DIR)}`));
  });

  test("shows no matches and restores trigger focus on Escape", async ({ page }) => {
    await page.goto(settings);
    // The Search row lives inside More and closes it on activation, so the
    // control focus must come back to is the More trigger, not the row itself.
    const more = page.getByTestId("opencode-nav-more");
    await more.click();
    await page.getByTestId("opencode-palette-open").click();
    const input = page.getByTestId("opencode-palette-input");
    await input.fill("no command has this phrase");
    await expect(page.getByTestId("opencode-palette-empty")).toHaveText("No matching commands");
    await input.press("Escape");
    await expect(page.getByTestId("opencode-command-palette")).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("fetches sessions freshly on every open", async ({ page }) => {
    await page.goto(settings);
    const before = await sessionListRequestCount();
    const openSearch = async () => {
      await page.getByTestId("opencode-nav-more").click();
      await page.getByTestId("opencode-palette-open").click();
    };

    await openSearch();
    await expect(page.getByRole("option", { name: /Add a health endpoint/ })).toBeVisible();
    await page.getByTestId("opencode-palette-input").press("Escape");
    await openSearch();
    await expect(page.getByRole("option", { name: /Add a health endpoint/ })).toBeVisible();
    await expect.poll(sessionListRequestCount).toBeGreaterThanOrEqual(before + 2);
  });

  test("keeps static commands available without a directory", async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto("/settings");
    await page.keyboard.press(shortcut);
    await expect(page.getByRole("option", { name: /Home/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Docs/ })).toBeVisible();
    await expect(page.getByTestId("opencode-palette-status")).toContainText("Set a project directory");
    await expect(page.locator('[role="option"][data-kind="conversation"]')).toHaveCount(0);
  });

  test("opens the docs center from the nav overflow menu", async ({ page }) => {
    await page.goto(settings);
    await page.getByTestId("opencode-nav-more").click();
    await page.getByTestId("opencode-nav-docs").click();
    await expect(page).toHaveURL(new RegExp(`/docs\\?directory=${encodeURIComponent(DIR)}`));
    await expect(page.getByTestId("opencode-docs")).toBeVisible();
  });

  test("runs existing actions", async ({ page }) => {
    await page.goto(settings);
    await page.keyboard.press(shortcut);
    await page.getByTestId("opencode-palette-input").fill("open on phone");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("opencode-phone-transfer-dialog")).toBeVisible();
  });

  test("fits without horizontal overflow at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(settings);
    await page.getByTestId("opencode-nav-more").click();
    await page.getByTestId("opencode-palette-open").click();
    await expect(page.getByTestId("opencode-command-palette")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
