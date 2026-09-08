import { expect, test, type Locator, type Page } from "@playwright/test";

const DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const conversation = `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`;
const paginatedConversation = `/sessions/ses_mock_paginated?directory=${encodeURIComponent(DIR)}`;
const MOCK_URL = `http://127.0.0.1:${process.env.MOCK_OPENCODE_PORT || 4599}`;

async function openSessionShare(page: Page): Promise<Locator> {
  const menuTrigger = page.getByTestId("opencode-mobile-session-menu-trigger");
  await menuTrigger.click();
  const trigger = page.getByTestId("opencode-mobile-share-export-open");
  await trigger.focus();
  await trigger.click();
  return menuTrigger;
}

test.describe.serial("share and export", () => {
  test.beforeEach(async () => {
    // Only the session this file shares. `test.describe.serial` orders the tests
    // *inside* this file; it says nothing about the other files Playwright runs
    // in parallel against the same mock, and smoke.api.spec.ts is asserting on
    // its own share fixtures while these hooks fire.
    await fetch(`${MOCK_URL}/test/sharing/reset?session=ses_mock_done`, { method: "POST" });
  });

  test("runs the full modal operations without exporting tools or signatures and restores focus", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(conversation);
    let trigger = await openSessionShare(page);

    const dialog = page.getByTestId("opencode-share-export-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("opencode-share-target")).toHaveText("Full session");
    await expect(dialog.getByTestId("opencode-export-security")).toContainText("provider metadata and signatures");
    await expect(dialog.getByTestId("opencode-export-native-share")).toHaveCount(0);

    await dialog.getByTestId("opencode-export-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Add a health endpoint to the server.");
    expect(copied).toContain("I'll add the route now.");
    expect(copied).toContain("### Tool");
    // `coverage.reporter=text-summary` is a distinctive fragment of the bash
    // fixture's command (tests/fixtures/session-messages.json). It stands in for
    // "no tool input reaches the export"; keep it pointed at whatever that
    // fixture actually runs, or this guard silently starts passing on absence.
    expect(copied).not.toMatch(/export const app|OPAQUE_SIGNATURE|ENCRYPTED_ONLY|coverage\.reporter=text-summary|partial output|context excerpt/);

    const download = page.waitForEvent("download");
    await dialog.getByTestId("opencode-export-download").click();
    expect((await download).suggestedFilename()).toBe("Add-a-health-endpoint.md");
    const jsonDownload = page.waitForEvent("download");
    await dialog.getByTestId("opencode-export-download-json").click();
    expect((await jsonDownload).suggestedFilename()).toBe("Add-a-health-endpoint.json");

    await dialog.getByTestId("opencode-share-create").click();
    await expect(dialog.getByTestId("opencode-share-confirmation")).toContainText("full raw session");
    await dialog.getByTestId("opencode-share-confirm").click();
    await expect(dialog.getByTestId("opencode-share-url")).toHaveAttribute("href", "https://share.e2e.example.test/s/ses_mock_done");
    await dialog.getByTestId("opencode-share-export-close").click();
    await page.reload();
    trigger = await openSessionShare(page);
    await expect(page.getByTestId("opencode-share-url")).toHaveAttribute("href", "https://share.e2e.example.test/s/ses_mock_done");
    const reopenedDialog = page.getByTestId("opencode-share-export-dialog");
    await reopenedDialog.getByTestId("opencode-share-revoke").click();
    await expect(reopenedDialog.getByTestId("opencode-share-confirmation")).toContainText("revoking");
    await reopenedDialog.getByTestId("opencode-share-confirm").click();
    await expect(reopenedDialog.getByTestId("opencode-share-create")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(reopenedDialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("limits a transcript-row action to one user or assistant message", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(conversation);
    const rowExport = page.getByTestId("opencode-agent-share").first();
    await rowExport.focus();
    await rowExport.press("Enter");
    const dialog = page.getByTestId("opencode-share-export-dialog");
    await expect(dialog.getByTestId("opencode-share-target")).toHaveText("Assistant message");
    await expect(dialog.getByText("Public OpenCode link")).toHaveCount(0);
    await dialog.getByTestId("opencode-export-copy").click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("I'll add the route now.");
    expect(copied).not.toContain("Add a health endpoint to the server.");
    expect(copied).not.toMatch(/export const app|OPAQUE_SIGNATURE/);
  });

  test("freshly fetches every page for a complete chronological full-session export", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    let newestRequests = 0;
    let releaseExport!: () => void;
    const exportGate = new Promise<void>((resolve) => { releaseExport = resolve; });
    await page.route("**/api/sessions/ses_mock_paginated/messages?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (!requestUrl.searchParams.has("before") && ++newestRequests === 2) await exportGate;
      await route.continue();
    });
    await page.goto(paginatedConversation);
    await expect(page.getByText("Paged message 1", { exact: true })).toHaveCount(0);

    await openSessionShare(page);
    const dialog = page.getByTestId("opencode-share-export-dialog");
    await expect(dialog.getByTestId("opencode-export-loading")).toBeVisible();
    await expect(dialog.getByTestId("opencode-export-copy")).toBeDisabled();
    releaseExport();
    await expect(dialog.getByTestId("opencode-export-copy")).toBeEnabled();
    await dialog.getByTestId("opencode-export-copy").click();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("Paged message 1");
    expect(copied).toContain("Paged message 125");
    expect(copied.indexOf("Paged message 1")).toBeLessThan(copied.indexOf("Paged message 125"));
  });

  test("loads earlier transcript pages only on deliberate request", async ({ page }) => {
    await page.goto(paginatedConversation);
    await expect(page.getByText("Paged message 126", { exact: true })).toBeVisible();
    await expect(page.getByText("Paged message 1", { exact: true })).toHaveCount(0);
    await page.getByTestId("opencode-load-earlier").click();
    await expect(page.getByText("Paged message 26", { exact: true })).toBeVisible();
    await expect(page.getByTestId("opencode-load-earlier")).toBeVisible();
  });

  test("refuses a partial full-session export and retries the complete fetch", async ({ page }) => {
    let newestRequests = 0;
    await page.route("**/api/sessions/ses_mock_paginated/messages?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (!requestUrl.searchParams.has("before") && ++newestRequests === 2) {
        await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "temporary export failure" }) });
        return;
      }
      await route.continue();
    });

    await page.goto(paginatedConversation);
    await openSessionShare(page);
    const dialog = page.getByTestId("opencode-share-export-dialog");
    await expect(dialog.getByTestId("opencode-export-error")).toContainText("temporary export failure");
    await expect(dialog.getByTestId("opencode-export-copy")).toBeDisabled();
    await dialog.getByTestId("opencode-export-retry").click();
    await expect(dialog.getByTestId("opencode-export-copy")).toBeEnabled();
  });

  test("uses native share only when the browser exposes it", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: ShareData) => { (globalThis as typeof globalThis & { sharedData?: ShareData }).sharedData = data; },
      });
    });
    await page.goto(conversation);
    await openSessionShare(page);
    await page.getByTestId("opencode-export-native-share").click();
    const shared = await page.evaluate(() => (globalThis as typeof globalThis & { sharedData?: ShareData }).sharedData);
    expect(shared?.text).toContain("Add a health endpoint to the server.");
    expect(shared?.text).not.toMatch(/OPAQUE_SIGNATURE|export const app/);
  });

  test("keeps a failed public-share operation visible and retryable", async ({ page }) => {
    let attempts = 0;
    await page.route("**/api/sessions/ses_mock_done/share?**", async (route) => {
      if (route.request().method() === "POST" && attempts++ === 0) {
        await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "temporary share failure" }) });
        return;
      }
      await route.continue();
    });
    await page.goto(conversation);
    await openSessionShare(page);
    await page.getByTestId("opencode-share-create").click();
    const confirm = page.getByTestId("opencode-share-confirm");
    await confirm.click();
    await expect(page.getByTestId("opencode-share-export-status")).toContainText("temporary share failure");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId("opencode-share-url")).toBeVisible();
  });

  test("contains the modal and controls at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(conversation);
    await openSessionShare(page);
    const dialog = page.getByTestId("opencode-share-export-dialog");
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(382);
    await expect(dialog.getByTestId("opencode-share-export-close")).toBeVisible();
  });
});
