import { expect, test, type Locator, type Page } from "@playwright/test";

// This spec owns its directory because auto permissions is in-memory BFF state.
const TOOLBAR_DIR = process.platform === "darwin"
  ? "/private/tmp/mock-toolbar-project"
  : "/tmp/mock-toolbar-project";
const MAIN_DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const conversation = `/sessions/ses_mock_toolbar?directory=${encodeURIComponent(TOOLBAR_DIR)}`;
const runningConversation = `/sessions/ses_mock_running?directory=${encodeURIComponent(MAIN_DIR)}`;
const DESKTOP = { width: 1280, height: 800 } as const;
const MOBILE = { width: 390, height: 740 } as const;

async function resetAutoPermissions(page: Page): Promise<void> {
  await page.request.patch(`/api/auto-approve?directory=${encodeURIComponent(TOOLBAR_DIR)}`, {
    data: { enabled: false },
  });
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect, "element should have a layout box").not.toBeNull();
  return rect!;
}

test.describe("mobile conversation action bar", () => {
  test.use({ viewport: MOBILE, hasTouch: true });

  test("uses compact icon controls, an Auto pill, and an info control without horizontal overflow", async ({ page }) => {
    await resetAutoPermissions(page);
    await page.goto(conversation);

    const actions = page.getByTestId("opencode-mobile-conversation-actions");
    await expect(actions).toBeVisible();
    await expect(actions).not.toContainText("Workspace");
    await expect(actions).not.toContainText("Run log");
    await expect(page.getByTestId("opencode-mobile-mrs-open")).toHaveCount(0);

    const controls = [
      page.getByTestId("opencode-mobile-workspace-open"),
      page.getByTestId("opencode-mobile-reviews-open"),
      page.getByTestId("opencode-mobile-auto-permissions-toggle"),
      page.getByTestId("opencode-mobile-auto-permissions-info"),
      page.getByTestId("opencode-mobile-runlog-open"),
      page.getByTestId("opencode-mobile-session-menu-trigger"),
    ];
    for (const control of controls) {
      const rect = await box(control);
      expect(rect.height).toBeGreaterThanOrEqual(control === controls[2] || control === controls[3] ? 36 : 44);
      expect(rect.width).toBeGreaterThanOrEqual(control === controls[2] ? 64 : control === controls[3] ? 36 : 48);
      await expect(control).toHaveAttribute("title", /.+/);
    }
    await expect(controls[0]).toHaveAccessibleName("Open workspace");
    // The reviews opener appends the session's unique-link count when there is
    // one, so match the shape rather than this fixture's current total.
    await expect(controls[1]).toHaveAccessibleName(/^Open reviews(, \d+ links?)?$/);
    await expect(controls[2]).toHaveAttribute("role", "switch");
    await expect(controls[2]).toHaveAttribute("aria-checked", "false");
    await expect(controls[2]).toHaveAccessibleName("Turn auto permissions on");
    await expect(controls[3]).toHaveAccessibleName("Auto permissions safety");
    await expect(controls[4]).toHaveAccessibleName("Open run log");
    await expect(controls[5]).toHaveAccessibleName("More session actions");
    await expect(controls[2]).toContainText("OFF");
    const autoGroup = page.getByTestId("opencode-mobile-auto-permissions-group");
    const autoBox = await box(autoGroup);
    const runlogBox = await box(controls[4]);
    expect(runlogBox.x).toBeGreaterThanOrEqual(autoBox.x + autoBox.width);
    await expect(autoGroup.getByTestId("opencode-mobile-auto-permissions-state")).toHaveText("OFF");
    await expect(page.getByTestId("opencode-mobile-auto-permissions-group")).toContainText("OFF");
    for (const control of [controls[0], controls[1], controls[3], controls[4], controls[5]]) {
      expect(await control.evaluate((element) => getComputedStyle(element).backgroundColor)).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("requires confirmation before stopping a running agent", async ({ page }) => {
    let aborts = 0;
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    await page.route("**/api/sessions/ses_mock_running/abort?*", async (route) => {
      aborts += 1;
      await abortGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ aborted: true }) });
    });
    await page.goto(runningConversation);

    const trigger = page.getByTestId("opencode-mobile-stop-open");
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName("Stop running agent");
    expect((await box(trigger)).height).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const dialog = page.getByTestId("opencode-stop-confirmation");
    await expect(dialog).toContainText("The agent will stop immediately. Its current work may be incomplete.");
    expect(aborts).toBe(0);

    await dialog.getByTestId("opencode-stop-keep-running").click();
    await expect(dialog).toHaveCount(0);
    expect(aborts).toBe(0);
    await trigger.click();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(aborts).toBe(0);

    await trigger.click();
    await dialog.getByTestId("opencode-stop-confirm").click();
    await expect(dialog.getByTestId("opencode-stop-confirm")).toHaveText("Stopping...");
    await expect(dialog.getByTestId("opencode-stop-keep-running")).toBeDisabled();
    expect(aborts).toBe(1);
    releaseAbort();
    await expect(dialog).toHaveCount(0);
    expect(aborts).toBe(1);
  });

  test("does not show Stop for an idle session", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-mobile-stop-open")).toHaveCount(0);
  });

  test("opens workspace and requested inspector tabs directly", async ({ page }) => {
    await resetAutoPermissions(page);
    await page.goto(conversation);

    await page.getByTestId("opencode-mobile-workspace-open").click();
    await expect(page.getByTestId("opencode-workspace-panels")).toBeVisible();
    await page.getByTestId("opencode-workspace-close").click();

    await page.getByTestId("opencode-mobile-reviews-open").click();
    const inspector = page.getByTestId("opencode-mobile-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByTestId("opencode-merge-request-list")).toBeVisible();
    await page.getByTestId("opencode-mobile-inspector-close").click();

    await page.getByTestId("opencode-mobile-runlog-open").click();
    await expect(inspector.getByTestId("opencode-command-list")).toBeVisible();
  });

  test("keeps only wrap, share, and catalog in More", async ({ page }) => {
    await resetAutoPermissions(page);
    await page.goto(conversation);

    const menu = page.getByTestId("opencode-mobile-session-menu");
    await page.getByTestId("opencode-mobile-session-menu-trigger").click();
    for (const id of ["opencode-mobile-wrap-toggle", "opencode-mobile-share-export-open", "opencode-mobile-catalog-open"]) {
      const item = page.getByTestId(id);
      await expect(item).toBeVisible();
      expect((await box(item)).height).toBeGreaterThanOrEqual(44);
    }
    await expect(menu).not.toContainText("Auto permissions safety");

    await page.getByTestId("opencode-mobile-catalog-open").click();
    await expect(page.getByTestId("opencode-mobile-inspector").getByTestId("opencode-catalog")).toBeVisible();

    await page.getByTestId("opencode-mobile-inspector-close").click();
    await page.getByTestId("opencode-mobile-auto-permissions-info").click();
    const safety = page.getByTestId("opencode-mobile-auto-permissions-safety-sheet");
    await expect(safety).toContainText("This affects every session using this project directory and resets to off when the BFF restarts.");
    await safety.getByTestId("opencode-mobile-auto-permissions-safety-close").click();
    await page.getByTestId("opencode-mobile-auto-permissions-toggle").click();
    const toggle = page.getByTestId("opencode-mobile-auto-permissions-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAccessibleName("Turn auto permissions off");
    await expect(page.getByTestId("opencode-mobile-auto-permissions-state")).toHaveText("ON");
    expect(await page.getByTestId("opencode-mobile-auto-permissions-group").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    await resetAutoPermissions(page);
  });
});

test.describe("desktop conversation action bar", () => {
  test.use({ viewport: DESKTOP, hasTouch: false });

  test("uses the same icon-led actions as mobile", async ({ page }) => {
    await resetAutoPermissions(page);
    await page.goto(conversation);

    const actions = page.getByTestId("opencode-mobile-conversation-actions");
    await expect(actions).toBeVisible();
    await expect(actions).not.toContainText("Workspace");
    const actionsBox = await box(actions);
    expect(DESKTOP.width - (actionsBox.x + actionsBox.width)).toBeLessThanOrEqual(20);
    for (const id of [
      "opencode-mobile-workspace-open",
      "opencode-mobile-reviews-open",
      "opencode-mobile-runlog-open",
      "opencode-mobile-auto-permissions-toggle",
      "opencode-mobile-auto-permissions-info",
    ]) {
      await expect(actions.getByTestId(id)).toBeVisible();
    }
  });

  test("separates Reviews and Catalog from the persistent sidebar", async ({ page }) => {
    await page.goto(conversation);
    const sidebar = page.getByTestId("opencode-session-inspector");
    await expect(sidebar.getByTestId("opencode-inspector-reviews")).toHaveCount(0);
    await expect(sidebar.getByTestId("opencode-inspector-catalog")).toHaveCount(0);

    const reviews = page.getByTestId("opencode-mobile-reviews-open");
    await reviews.click();
    const surface = page.getByTestId("opencode-desktop-inspector");
    await expect(surface.getByTestId("opencode-merge-request-list")).toBeVisible();
    await surface.getByTestId("opencode-desktop-inspector-close").click();
    await expect(reviews).toBeFocused();

    await page.getByTestId("opencode-mobile-session-menu-trigger").click();
    await page.getByTestId("opencode-mobile-catalog-open").click();
    await expect(surface.getByTestId("opencode-catalog")).toBeVisible();

    // #55: the catalog reports what the process says, and must not let any of
    // that read as "this capability was proven to run".
    await expect(surface.getByTestId("opencode-catalog-legend")).toContainText("not what has been proven to run");
    await expect(surface.getByTestId("opencode-catalog-mcp-caveat")).toContainText("does not enumerate");
    await expect(surface.getByTestId("opencode-catalog-skills")).toContainText("loaded at startup");
    await expect(surface.getByTestId("opencode-catalog-commands")).toContainText("loaded at startup");

    // The registered-tool list is the one honest signal about invocability, and
    // it is built-ins only — the mock ships an MCP-looking id to prove the copy
    // does not claim MCP tools appear here.
    const tools = surface.getByTestId("opencode-catalog-tools");
    await expect(tools).toContainText("invocable");
    await expect(tools.getByTestId("opencode-catalog-tools-list")).toContainText("bash");
    await expect(tools).toContainText("MCP tools are never listed here");
  });

  test("opens dedicated inspector panels from the URL", async ({ page }) => {
    await page.goto(`${conversation}&panel=reviews`);
    await expect(page.getByTestId("opencode-desktop-inspector")).toHaveAttribute("aria-label", "Reviews");
    await page.goto(`${conversation}&panel=catalog`);
    await expect(page.getByTestId("opencode-desktop-inspector")).toHaveAttribute("aria-label", "Catalog");
  });

  test("uses the title-row Stop control from mobile", async ({ page }) => {
    await page.goto(runningConversation);
    await expect(page.getByTestId("opencode-mobile-stop-open")).toBeVisible();
    await expect(page.getByTestId("opencode-abort")).toHaveCount(0);
  });
});
