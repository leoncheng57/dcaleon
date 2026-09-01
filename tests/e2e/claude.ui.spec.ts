import { expect, test } from "@playwright/test";

test.describe("Claude Code runtime", () => {
  async function createSession(page: import("@playwright/test").Page) {
    await page.goto("/claude");
    await expect(page.getByTestId("claude-home")).toBeVisible();
    await page.getByTestId("claude-create").click();
    await expect(page).toHaveURL(/\/claude\/sessions\/claude-/u);
  }

  test("creates a read-only session and renders streamed output", async ({ page }) => {
    await createSession(page);
    await expect(page.getByText("Read only", { exact: true }).first()).toBeVisible();
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
    await expect(page.getByTestId("claude-prompt")).toBeEnabled();
  });

  test("does not leak tool inputs or init data into the transcript", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
    const transcript = page.getByTestId("claude-transcript");
    await expect(transcript).not.toContainText("PRIVATE TOOL INPUT");
    await expect(transcript).not.toContainText("PRIVATE INIT DATA");
  });

  test("requires explicit confirmation before creating a Build session", async ({ page }) => {
    await page.goto("/claude");
    await page.getByTestId("claude-preset").selectOption("e2e-build");
    await expect(page.getByText("Build · may edit files", { exact: true })).toBeVisible();
    await expect(page.getByTestId("claude-build-confirmation")).toContainText("Writes outside that workspace");
    await expect(page.getByTestId("claude-create")).toBeDisabled();
    await page.getByTestId("claude-build-confirm").check();
    await expect(page.getByTestId("claude-create")).toBeEnabled();
    await page.getByTestId("claude-create").click();
    await expect(page).toHaveURL(/\/claude\/sessions\/claude-/u);
    await expect(page.getByText("Build · may edit files", { exact: true })).toBeVisible();
  });

  test("keeps the interactive controls usable at the phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await createSession(page);
    await expect(page.getByTestId("claude-prompt")).toBeInViewport();
    await expect(page.getByTestId("claude-send")).toBeInViewport();
  });

  test("cancels a running Claude turn and reopens the composer", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("claude-prompt").fill("stay running until cancelled");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("claude-cancel")).toBeVisible();
    await page.getByTestId("claude-cancel").click();
    await expect(page.getByText("Cancelled by user")).toBeVisible();
    await expect(page.getByTestId("claude-prompt")).toBeEnabled();
  });
});
