import { expect, test } from "@playwright/test";

test("runs the DSH fixture flow under the nested public preview path", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByTestId("opencode-public-simulator-banner")).toContainText("fixture data only");

  const dshNav = page.getByTestId("dsh-nav");
  await expect(dshNav).toContainText("DSH");
  await expect(dshNav).toHaveRole("link");
  await page.getByTestId("opencode-nav-more").click();
  await expect(page.getByTestId("opencode-nav-more-menu").getByText("DSH lab", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await dshNav.click();
  await expect(page).toHaveURL(/\/dcaleon\/pr-previews\/pr-1\/#\/dsh$/u);
  await expect(page.getByTestId("dsh-home")).toBeVisible();

  await page.getByTestId("dsh-create").click();
  await expect(page).toHaveURL(/\/dcaleon\/pr-previews\/pr-1\/#\/dsh\/sessions\/dsh-/u);
  await expect(page.getByTestId("dsh-conversation")).toBeVisible();

  await page.getByTestId("dsh-prompt").fill("Inspect the public DSH fixture");
  await page.getByTestId("dsh-send").click();
  const transcript = page.getByTestId("dsh-transcript");
  await expect(transcript).toContainText("Simulated DSH fixture response");
  await expect(transcript).toContainText("No DSH runtime or model provider was called");

  await page.getByTestId("dsh-open-preview").click();
  const preview = page.getByTestId("dsh-preview-frame");
  await expect(preview).not.toHaveAttribute("src", /localhost|127\.0\.0\.1/u);
  await expect(preview).toHaveAttribute("srcdoc", /public fixture never contacts localhost/u);
  await expect(preview.contentFrame().getByRole("heading")).toHaveText("Simulated DSH preview");
  await expect(preview.contentFrame().getByText("Fixture action")).toBeVisible();
  await page.getByTestId("dsh-preview-close").click();
  await page.getByTestId("dsh-open-trajectory").click();
  await expect(page.getByTestId("dsh-trajectory-inspector")).toBeVisible();
  await expect(page.getByText("Tool called", { exact: true })).toBeVisible();
  await expect(page.getByText("Compaction surface replacement", { exact: true })).toBeVisible();
  await expect(page.getByText("Child agent started", { exact: true })).toBeVisible();
  await expect(page.getByText("+5s", { exact: true })).toBeVisible();
  await expect(page.getByText(/DCA-captured.*incomplete/u)).toBeVisible();
});
