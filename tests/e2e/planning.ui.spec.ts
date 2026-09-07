import { expect, test } from "@playwright/test";

test.describe("project planning", () => {
  test("groups work by priority and keeps conflicts in triage", async ({ page }) => {
    await page.goto("/planning");

    await expect(page.getByTestId("opencode-planning")).toBeVisible();
    await expect(page.getByTestId("opencode-planning-list")).toBeVisible();
    await expect(page.getByTestId("opencode-planning-row")).toHaveCount(4);
    await expect(page.getByTestId("opencode-planning-section-conflict")).toHaveJSProperty("open", true);
    await expect(page.getByTestId("opencode-planning-section-high")).toHaveJSProperty("open", true);
    await expect(page.getByTestId("opencode-planning-section-medium")).toHaveJSProperty("open", false);
    await expect(page.getByTestId("opencode-planning-section-none")).toHaveJSProperty("open", false);
    await expect(page.getByText("Resolve contradictory priorities")).toBeVisible();
    await expect(page.getByText("Resolve priority conflict")).toBeVisible();
    await expect(page.getByText("Improve the mobile planning view")).toBeVisible();
    const highRow = page.getByTestId("opencode-planning-row").filter({ hasText: "Improve the mobile planning view" });
    const [statusBox, priorityBox] = await Promise.all([
      highRow.getByText("Open", { exact: true }).boundingBox(),
      highRow.getByText("priority:high", { exact: true }).boundingBox(),
    ]);
    expect(Math.abs((statusBox?.y ?? 0) - (priorityBox?.y ?? 0))).toBeLessThan(4);
    await page.getByTestId("opencode-planning-section-medium-toggle").click();
    await expect(page.getByText("Add the project planning feed")).toBeVisible();
    await expect(page.getByTestId("opencode-planning-group-high-frontend")).toBeVisible();
    await expect(page.getByText("Created Aug 12, 2026")).toBeVisible();
    await expect(page.getByText("Last activity Aug 21, 2026")).toBeVisible();

    const issueLink = page.getByTestId("opencode-planning-item-101");
    await expect(issueLink).toHaveAttribute("aria-haspopup", "dialog");
    const externalLink = page.getByTestId("opencode-planning-item-101-external");
    await expect(externalLink).toHaveAttribute("href", "https://github.com/leoncheng57/dcaleon/issues/101");
    await expect(externalLink).toHaveAttribute("target", "_blank");
    await expect(externalLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("collapses epics, persists keyboard expansion, and keeps closed child progress", async ({ page }) => {
    await page.goto("/planning");

    const toggle = page.getByTestId("opencode-planning-epic-101-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("opencode-planning-child-row")).toHaveCount(0);
    await expect(page.getByText("Polish compact planning controls")).toHaveCount(0);
    await expect(page.getByTestId("opencode-planning-epic-101-progress")).toHaveAttribute("aria-valuenow", "1");
    await expect(page.getByTestId("opencode-planning-epic-101-progress")).toHaveAttribute("aria-valuemax", "2");
    await expect(page.getByTestId("opencode-planning-section-high")).toContainText("1 epic");

    await toggle.focus();
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("opencode-planning-child-row")).toHaveCount(2);
    await expect(page.getByTestId("opencode-planning-child-row").filter({ hasText: "Document the mobile planning layout" })).toContainText("Closed");

    await page.reload();
    await expect(page.getByTestId("opencode-planning-epic-101-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Polish compact planning controls")).toBeVisible();

    await page.getByTestId("opencode-planning-item-106").click();
    await expect(page.getByTestId("opencode-planning-item-dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Polish compact planning controls" })).toBeVisible();
    await page.getByTestId("opencode-planning-item-close").click();

    await page.getByTestId("opencode-planning-epics-toggle-all").click();
    await expect(page.getByTestId("opencode-planning-epic-101-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("opencode-planning-child-row")).toHaveCount(0);
  });

  test("falls a child back to a parent breadcrumb when filters remove its epic", async ({ page }) => {
    await page.goto("/planning");
    await page.getByTestId("opencode-planning-state-closed").click();
    await page.getByTestId("opencode-planning-section-low-toggle").click();

    const child = page.getByTestId("opencode-planning-row").filter({ hasText: "Document the mobile planning layout" });
    await expect(child).toBeVisible();
    await expect(child.getByTestId("opencode-planning-item-107-parent")).toHaveText("Child of #101");
  });

  test("warns without blanking the feed when epic discovery is truncated", async ({ page }) => {
    await page.route("**/api/planning/items", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      await route.fulfill({ response, json: { ...snapshot, epicsTruncated: true } });
    });
    await page.goto("/planning");

    await expect(page.getByTestId("opencode-planning-epics-truncated")).toContainText("Some epic relationships were not loaded");
    await expect(page.getByTestId("opencode-planning-list")).toBeVisible();
    await expect(page.getByText("Improve the mobile planning view")).toBeVisible();
  });

  test("opens deep-linked issue and pull request details with safe Markdown comments", async ({ page }) => {
    await page.goto("/planning");
    const issueTrigger = page.getByTestId("opencode-planning-item-101");
    await issueTrigger.click();

    await expect(page).toHaveURL(/\/planning\?item=101$/u);
    await expect(page.getByTestId("opencode-planning-item-dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Improve the mobile planning view" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Planning context" })).toBeVisible();
    await expect(page.getByText("First planning comment.")).toBeVisible();
    await expect(page.getByTestId("opencode-planning-item-comment")).toHaveCount(2);
    await expect(page.locator("[data-unsafe-description], [data-unsafe-comment]")).toHaveCount(0);
    await expect(page.getByTestId("opencode-planning-item-external"))
      .toHaveAttribute("href", "https://github.com/leoncheng57/dcaleon/issues/101");

    await page.getByTestId("opencode-planning-item-close").click();
    await expect(page.getByTestId("opencode-planning-item-dialog")).toHaveCount(0);
    await expect(issueTrigger).toBeFocused();

    await page.goto("/planning?item=102");
    await expect(page.getByRole("heading", { name: "Add the project planning feed" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pull request description" })).toBeVisible();
    await expect(page.getByTestId("opencode-planning-item-dialog")).toContainText("Pull request");
  });

  test("changes labels, enforces one priority, and regroups the item immediately", async ({ page }) => {
    await page.goto("/planning");
    await page.getByTestId("opencode-planning-item-101").click();
    const high = page.getByTestId("opencode-planning-item-label-priority:high");
    const medium = page.getByTestId("opencode-planning-item-label-priority:medium");
    await expect(high).toBeChecked();
    await medium.check();
    await expect(medium).toBeChecked();
    await expect(high).not.toBeChecked();

    await page.getByTestId("opencode-planning-item-save").click();
    await expect(page.getByTestId("opencode-planning-item-save-success")).toHaveText("Labels updated.");
    await expect(page.getByTestId("opencode-planning-item-dialog")).toBeVisible();
    await page.getByTestId("opencode-planning-item-close").click();
    await expect(page.getByTestId("opencode-planning-item-101")).toBeFocused();

    const updatedRow = page.getByTestId("opencode-planning-row").filter({ hasText: "Improve the mobile planning view" });
    await expect(updatedRow).toBeVisible();
    await expect(updatedRow.getByText("priority:medium")).toBeVisible();
    await expect(page.getByTestId("opencode-planning-section-high")).toContainText("Improve the mobile planning view");
  });

  test("keeps a failed label edit selected and retryable", async ({ page }) => {
    let requests = 0;
    await page.route("**/api/planning/items/101/labels", async (route) => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Rejected by GitHub" }) });
    });
    await page.goto("/planning?item=101");
    const medium = page.getByTestId("opencode-planning-item-label-priority:medium");
    await medium.check();
    await page.getByTestId("opencode-planning-item-save").evaluate((button) => {
      button.click();
      button.click();
    });

    await expect(page.getByTestId("opencode-planning-item-save-error")).toContainText("Rejected by GitHub");
    await expect(medium).toBeChecked();
    await expect(page.getByTestId("opencode-planning-item-dialog")).toBeVisible();
    expect(requests).toBe(1);
  });

  test("filters by type and state and identifies merged pull requests", async ({ page }) => {
    await page.goto("/planning");
    await expect(page.getByTestId("opencode-planning-list")).toBeVisible();

    await page.getByTestId("opencode-planning-type-pull_request").click();
    await expect(page.getByTestId("opencode-planning-row")).toHaveCount(1);
    await page.getByTestId("opencode-planning-section-medium-toggle").click();
    await expect(page.getByText("Add the project planning feed")).toBeVisible();

    await page.getByTestId("opencode-planning-state-closed").click();
    await expect(page.getByTestId("opencode-planning-row")).toHaveCount(1);
    await page.getByTestId("opencode-planning-section-low-toggle").click();
    await expect(page.getByText("Ship session-first notifications")).toBeVisible();
    await expect(page.getByText("Merged", { exact: true })).toBeVisible();

    await page.getByTestId("opencode-planning-state-all").click();
    await expect(page.getByTestId("opencode-planning-row")).toHaveCount(2);
  });

  test("shows a sanitized API error", async ({ page }) => {
    await page.route("**/api/planning/items", async (route) => {
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Rate limited" }) });
    });
    await page.goto("/planning");
    await expect(page.getByRole("alert")).toHaveText("Planning data is unavailable: Rate limited");
  });

  test("fits the list at mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto("/planning");
    await expect(page.getByTestId("opencode-planning-list")).toBeVisible();

    const metrics = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
    await expect(page.getByText("Created Aug 12, 2026")).toBeVisible();
    await expect(page.getByText("Last activity Aug 21, 2026")).toBeVisible();
    await page.getByTestId("opencode-planning-epic-101-toggle").click();
    await expect(page.getByTestId("opencode-planning-child-row")).toHaveCount(2);
    const expandedMetrics = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(expandedMetrics.body).toBeLessThanOrEqual(expandedMetrics.viewport);
  });

  test("changes density and persists it across reloads", async ({ page }) => {
    await page.goto("/planning");
    const list = page.getByTestId("opencode-planning-list");
    await expect(list).toHaveAttribute("data-density", "densest");

    for (const density of ["comfortable", "compact", "dense", "denser", "densest", "comfortable"]) {
      await page.getByTestId(`opencode-planning-density-${density}`).click();
      await expect(list).toHaveAttribute("data-density", density);
      await expect(page.getByTestId(`opencode-planning-density-${density}`)).toHaveAttribute("aria-pressed", "true");
    }

    await page.reload();
    await expect(page.getByTestId("opencode-planning-list")).toHaveAttribute("data-density", "comfortable");
  });

  test("creates an issue with selected labels and restores focus", async ({ page }) => {
    await page.goto("/planning");
    const trigger = page.getByTestId("opencode-planning-create");
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "Create issue" })).toBeVisible();
    await expect(page.getByTestId("opencode-planning-create-title")).toBeFocused();
    await expect(page.getByTestId("opencode-planning-label-list")).toContainText("frontend");

    await page.getByTestId("opencode-planning-create-title").fill("Create issues from planning");
    await page.getByTestId("opencode-planning-create-body").fill("## Context\n\nCreated from the runner.");
    await page.getByTestId("opencode-planning-label-frontend").check();
    await page.getByTestId("opencode-planning-create-submit").click();

    await expect(page.getByTestId("opencode-planning-create-dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("opencode-planning-create-success")).toContainText("Issue #103 created");
    await expect(page.getByTestId("opencode-planning-created-link"))
      .toHaveAttribute("href", "https://github.com/leoncheng57/dcaleon/issues/103");
    const createdRow = page.getByTestId("opencode-planning-row").filter({ hasText: "Create issues from planning" });
    await page.getByTestId("opencode-planning-section-none-toggle").click();
    await expect(createdRow).toBeVisible();
    await expect(createdRow.getByText("frontend")).toBeVisible();
  });

  test("prevents duplicate submits and preserves a failed draft", async ({ page }) => {
    let requests = 0;
    await page.route("**/api/planning/issues", async (route) => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Rejected by GitHub" }) });
    });
    await page.goto("/planning?create=1");
    const title = page.getByTestId("opencode-planning-create-title");
    const body = page.getByTestId("opencode-planning-create-body");
    await title.fill("Keep this draft");
    await body.fill("Do not discard this body.");

    await page.getByTestId("opencode-planning-create-form").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId("opencode-planning-create-submit")).toBeDisabled();
    await expect(page.getByTestId("opencode-planning-create-submit")).toHaveText("Creating...");
    await expect(page.getByTestId("opencode-planning-create-error")).toHaveText("Rejected by GitHub");
    expect(requests).toBe(1);
    await expect(title).toHaveValue("Keep this draft");
    await expect(body).toHaveValue("Do not discard this body.");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("opencode-planning-create-dialog")).toHaveCount(0);
  });

  test("keeps the create dialog usable at mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto("/planning?create=1");
    await expect(page.getByTestId("opencode-planning-create-dialog")).toBeVisible();
    const metrics = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
    await expect(page.getByTestId("opencode-planning-create-submit")).toBeVisible();
  });

  test("keeps the item detail dialog usable at mobile width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto("/planning?item=101");
    await expect(page.getByTestId("opencode-planning-item-dialog")).toBeVisible();
    const metrics = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(metrics.body).toBeLessThanOrEqual(metrics.viewport);
    await expect(page.getByTestId("opencode-planning-item-save")).toBeVisible();
  });
});
