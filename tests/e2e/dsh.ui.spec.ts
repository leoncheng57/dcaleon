import { expect, test } from "@playwright/test";

test.describe("experimental DSH workspace", () => {
  async function createSession(page: import("@playwright/test").Page) {
    await page.goto("/dsh");
    await expect(page.getByTestId("dsh-home")).toBeVisible();
    await page.getByTestId("dsh-create").click();
    await expect(page).toHaveURL(/\/dsh\/sessions\/dsh-/);
  }

  test("creates a read-only session and renders streamed output", async ({ page }) => {
    await createSession(page);
    await expect(page.getByText("Read only", { exact: true }).first()).toBeVisible();
    await page.getByTestId("dsh-prompt").fill("Inspect this fixture");
    await page.getByTestId("dsh-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock DSH");
    await expect(page.getByTestId("dsh-prompt")).toBeEnabled();
  });

  test("requires explicit confirmation before creating a Build session", async ({ page }) => {
    await page.goto("/dsh");
    await page.getByTestId("dsh-preset").click();
    await page.getByTestId("dsh-preset-panel").getByRole("option", { name: /E2E Build/u }).click();
    await expect(page.getByText("Build · may edit files", { exact: true })).toBeVisible();
    await expect(page.getByTestId("dsh-build-confirmation")).toContainText("Writes outside that workspace");
    await expect(page.getByTestId("dsh-create")).toBeDisabled();
    await page.getByTestId("dsh-build-confirm").check();
    await expect(page.getByTestId("dsh-create")).toBeEnabled();
    await page.getByTestId("dsh-create").click();
    await expect(page).toHaveURL(/\/dsh\/sessions\/dsh-/u);
    await expect(page.getByText("Build · may edit files", { exact: true })).toBeVisible();
  });

  test("opens the existing bounded preview experience", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("dsh-open-preview").click();
    await expect(page.getByTestId("dsh-preview")).toBeVisible();
    await expect(page.getByTestId("dsh-preview-frame")).toHaveAttribute("sandbox", "allow-forms allow-modals allow-popups allow-scripts");
  });

  test("keeps the interactive controls usable at the phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await createSession(page);
    await expect(page.getByTestId("dsh-prompt")).toBeInViewport();
    await expect(page.getByTestId("dsh-send")).toBeInViewport();
    await page.getByTestId("dsh-open-preview").click();
    await expect(page.getByTestId("dsh-preview")).toHaveCSS("width", "390px");
  });

  test("renders the DSH-native captured trajectory without exposing sensitive payloads", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await createSession(page);
    await page.getByTestId("dsh-prompt").fill("Inspect this fixture");
    await page.getByTestId("dsh-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock DSH");
    await page.getByTestId("dsh-open-trajectory").click();
    const inspector = page.getByTestId("dsh-trajectory-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveCSS("width", "390px");
    await expect(inspector.getByText(/Turn 1/).first()).toBeVisible();
    await expect(inspector.getByText("Tool called", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Tool result committed", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Compaction summary committed", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Child descriptor committed", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Surface replace 6-9", { exact: true })).toBeVisible();
    await expect(inspector).not.toContainText("PRIVATE MOCK SYSTEM");
    await expect(inspector).not.toContainText("/private/mock-secret");
    await expect(inspector).not.toContainText("PRIVATE TOOL OUTPUT");
    await expect(page.getByTestId("dsh-trajectory-detail-toggle")).toHaveCount(0);
    await expect(page.getByTestId("dsh-trajectory-export-full")).toHaveCount(0);
    const roleColor = (kind: string) => inspector.locator(`[data-visual-kind="${kind}"]`).first().getByTestId("dsh-trajectory-role-tag").evaluate((element) => getComputedStyle(element).color);
    const requestColor = await roleColor("request");
    const assistantColor = await roleColor("assistant");
    const toolColor = await roleColor("tool");
    expect(new Set([requestColor, assistantColor, toolColor]).size).toBe(3);
    const assistantRow = inspector.locator('[data-visual-kind="assistant"]').first();
    await assistantRow.getByTestId("dsh-trajectory-row-toggle").click();
    await expect(assistantRow.getByTestId("dsh-trajectory-row-detail")).toBeVisible();
    await expect(assistantRow.getByText("Identity", { exact: true })).toBeVisible();
    await expect(assistantRow.getByText("Timing", { exact: true })).toBeVisible();
    await page.getByTestId("dsh-trajectory-filter-tools").click();
    await expect(page.getByTestId("dsh-trajectory-entry")).toHaveCount(2);
  });

  test("cancels a running DSH turn and reopens the composer", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("dsh-prompt").fill("stay running until cancelled");
    await page.getByTestId("dsh-send").click();
    await expect(page.getByTestId("dsh-cancel")).toBeVisible();
    await page.getByTestId("dsh-cancel").click();
    await expect(page.getByText("Cancelled by user")).toBeVisible();
    await expect(page.getByTestId("dsh-prompt")).toBeEnabled();
  });
});
