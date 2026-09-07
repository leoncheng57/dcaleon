import { expect, test } from "@playwright/test";

test("serves an interactive, credential-free PR simulator", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("./");
  await page.waitForLoadState("networkidle");
  expect(pageErrors).toEqual([]);
  await expect(page.getByTestId("opencode-public-simulator-banner")).toContainText("fixture data only");
  // The front page is now a runtime picker; navigate to the OpenCode hub.
  await expect(page.getByTestId("runtime-card-opencode")).toBeVisible();
  await page.getByTestId("runtime-card-opencode").click();
  await expect(page.getByTestId("opencode-upstream-badge")).toContainText("1.18.23+dca.2");
  // "3. Existing sessions" is a <details> that ships collapsed, so its contents
  // are in the DOM but not visible until the toggle is clicked.
  await page.getByTestId("opencode-sessions-picker-toggle").click();
  await expect(page.getByTestId("opencode-session-list")).toContainText("Build the PR preview pipeline");

  await page.getByTestId("opencode-session-list").getByText("Build the PR preview pipeline").click();
  await expect(page).toHaveURL(/#\/sessions\/ses_preview_done/u);
  await expect(page.getByTestId("opencode-transcript")).toContainText("All verification passed");
  await expect(page.getByTestId("opencode-todo-list")).toContainText("Review the PR deployment");

  await page.goto("./#/playbooks/workflows");
  await expect(page.getByTestId("opencode-playbook-workflow-card")).toHaveCount(14);
  await page.getByTestId("opencode-playbook-workflow-start-dca-session").click();
  await expect(page.getByTestId("opencode-playbook-workflow-injector")).toContainText("independent root session");
  await page.getByTestId("opencode-playbook-close").click();
  await expect(page).toHaveURL(/#\/playbooks\/workflows/u);

  await page.goto(`./#/sessions/ses_preview_done?directory=${encodeURIComponent("/tmp/mock-project")}`);

  const composer = page.getByTestId("opencode-composer");
  await composer.fill("Demonstrate the simulated follow-up");
  await page.getByTestId("opencode-send").click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("opencode-transcript")).toContainText("No model or external service was called");

  await page.getByTestId("opencode-file-reference").filter({ hasText: "server/index.ts:98" }).click();
  await expect(page.getByTestId("opencode-workspace-panels")).toBeVisible();
  await page.getByTestId("opencode-workspace-preview").click();
  await expect(page.getByTestId("opencode-preview-frame").contentFrame().getByRole("heading"))
    .toHaveText("Simulated application preview");
  await page.getByTestId("opencode-workspace-close").click();

  await page.locator("nav[aria-label='Main']").getByTestId("opencode-nav-planning").click();
  await expect(page).toHaveURL(/#\/planning/u);
  await expect(page.getByTestId("opencode-planning-list")).toContainText("Use GitHub's deployment infra");

  // A notification has to reach its session here too. The deep link used to be
  // record.click, which the server only fills in when PUBLIC_APP_URL is set and
  // which no fixture carries — so every notification in this simulator rendered
  // as plain text, and the preview could not demonstrate the one interaction
  // the notification centre exists for.
  await page.getByTestId("opencode-nav-notifications").click();
  const group = page.getByTestId("opencode-notification-group").first();
  await expect(group).toHaveAttribute("data-expanded", "false");
  await group.getByTestId("opencode-notification-group-link").click();
  await expect(page).toHaveURL(/#\/sessions\/ses_preview_done/u);

  await page.getByTestId("opencode-nav-notifications").click();
  await page.getByTestId("opencode-notification-group").first()
    .getByTestId("opencode-notification-group-toggle")
    .click();
  await page.getByTestId("opencode-notification-record").first()
    .getByTestId("opencode-notification-link")
    .click();
  await expect(page).toHaveURL(/#\/sessions\/ses_preview_done/u);
  await expect(page.getByTestId("opencode-notification-popover")).toHaveCount(0);

  // Session resolution works in the public simulator too, so the PR preview
  // demonstrates the real interaction rather than stopping at a dead fixture
  // route.
  await page.getByTestId("opencode-nav-notifications").click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByTestId("opencode-notification-group-resolve").click();
  await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText("0");
  expect(pageErrors).toEqual([]);
});
