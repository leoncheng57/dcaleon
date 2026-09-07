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
  async function createWorktreeBuildSession(page: import("@playwright/test").Page) {
    await page.goto("/claude");
    await page.getByTestId("claude-preset").selectOption("e2e-build");
    await page.getByTestId("claude-isolation-worktree").check();
    await page.getByTestId("claude-build-confirm").check();
    await page.getByTestId("claude-create").click();
    await expect(page).toHaveURL(/\/claude\/sessions\/claude-/u);
    // A worktree session shows its branch, so the isolation is visible, not implied.
    await expect(page.getByTestId("claude-branch")).toContainText("claude/");
  }

  test("a worktree Build session writes into its worktree, shows the diff, and merges into the project", async ({ page }) => {
    await createWorktreeBuildSession(page);
    await page.getByTestId("claude-prompt").fill("Please write a file for me");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Wrote claude-e2e.txt");
    // The turn's footprint is in the transcript; the raw file body is not.
    await expect(page.getByTestId("claude-transcript")).toContainText("claude-e2e.txt");
    await expect(page.getByTestId("claude-transcript")).not.toContainText("PRIVATE FILE BODY");

    await page.getByTestId("claude-open-changes").click();
    const drawer = page.getByTestId("claude-changes");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("claude-changes-files")).toContainText("claude-e2e.txt");
    await expect(page.getByTestId("claude-changes-diff")).toContainText("written by mock claude");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("claude-merge").click();
    await expect(page.getByText("Merged into project")).toBeVisible();
    // A merged worktree session is finished: its cwd is gone.
    await expect(page.getByTestId("claude-prompt")).toBeDisabled();
  });

  test("discarding a worktree session removes it without touching the project", async ({ page }) => {
    await createWorktreeBuildSession(page);
    await page.getByTestId("claude-prompt").fill("Please write a file for me");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Wrote claude-e2e.txt");
    await page.getByTestId("claude-open-changes").click();
    await expect(page.getByTestId("claude-changes-files")).toContainText("claude-e2e.txt");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("claude-discard").click();
    await expect(page.getByText("Worktree discarded")).toBeVisible();
    await expect(page.getByTestId("claude-prompt")).toBeDisabled();
  });

  test("a direct Build session offers Changes but no merge or discard", async ({ page }) => {
    await page.goto("/claude");
    await page.getByTestId("claude-preset").selectOption("e2e-build");
    await page.getByTestId("claude-isolation-direct").check();
    await page.getByTestId("claude-build-confirm").check();
    await page.getByTestId("claude-create").click();
    await expect(page).toHaveURL(/\/claude\/sessions\/claude-/u);
    await expect(page.getByTestId("claude-branch")).toHaveCount(0);
    await page.getByTestId("claude-open-changes").click();
    await expect(page.getByTestId("claude-changes")).toBeVisible();
    await expect(page.getByTestId("claude-merge")).toHaveCount(0);
    await expect(page.getByTestId("claude-discard")).toHaveCount(0);
  });
  test("browses workspace files and views file content", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("claude-open-files").click();
    await expect(page.getByTestId("claude-files")).toBeVisible();
    // The e2e project fixture has a README.md at the root.
    await page.getByTestId("claude-tree-file").filter({ hasText: "README.md" }).first().click();
    await expect(page.getByTestId("claude-file-pane")).toContainText("Claude e2e project");
  });

  test("shows a run log derived from the transcript", async ({ page }) => {
    await createWorktreeBuildSession(page);
    await page.getByTestId("claude-prompt").fill("Please write a file for me");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Wrote claude-e2e.txt");
    await page.getByTestId("claude-open-runlog").click();
    await expect(page.getByTestId("opencode-command-list")).toBeVisible();
    await expect(page.getByTestId("opencode-runlog-timeline")).toContainText("Write");
    // Filtering to edits keeps the Write; reads filter it out.
    await page.getByTestId("opencode-runlog-filter-edit").click();
    await expect(page.getByTestId("opencode-runlog-timeline")).toContainText("Write");
    await page.getByTestId("opencode-runlog-filter-read").click();
    await expect(page.getByTestId("opencode-runlog-empty")).toBeVisible();
  });

  test("offers Markdown and JSON export of the transcript", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
    // Export lives in the shared More menu, like OpenCode's secondary actions.
    await page.getByTestId("claude-session-menu-trigger").click();
    await page.getByTestId("claude-open-export").click();
    await expect(page.getByTestId("claude-export-md")).toBeVisible();
    await expect(page.getByTestId("claude-export-json")).toBeVisible();
  });

  test("lets a turn run on a different configured model", async ({ page }) => {
    await createSession(page);
    // The model picker is offered when multiple models are configured.
    await expect(page.getByTestId("claude-composer-model")).toBeVisible();
    // Open the model picker dialog and select a different model.
    await page.getByTestId("claude-composer-model").click();
    await page.locator('[data-testid="claude-composer-model-option"][data-model-key="anthropic/mock-claude-opus"]').click();
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
  });

  test("offers Push & open PR on a worktree session and reports a missing github origin clearly", async ({ page }) => {
    await createWorktreeBuildSession(page);
    await page.getByTestId("claude-prompt").fill("Please write a file for me");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Wrote claude-e2e.txt");
    await page.getByTestId("claude-open-changes").click();
    await expect(page.getByTestId("claude-open-pr")).toBeVisible();
    await page.getByTestId("claude-open-pr").click();
    // The e2e project has no github.com origin, so the action degrades with a clear message.
    await expect(page.getByTestId("claude-changes")).toContainText(/github\.com origin|GITHUB_TOKEN/u);
  });
  test("offers a Plan/Build mode toggle on a Build session and runs a Plan turn", async ({ page }) => {
    await createWorktreeBuildSession(page);
    await expect(page.getByTestId("claude-composer-mode")).toBeVisible();
    // A Build session can switch to Plan and back; both controls are enabled.
    await expect(page.getByTestId("claude-composer-mode-plan")).toBeEnabled();
    await expect(page.getByTestId("claude-composer-mode-build")).toBeEnabled();
    await page.getByTestId("claude-composer-mode-plan").click();
    await page.getByTestId("claude-prompt").fill("Outline a plan for this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toBeVisible();
  });

  test("read-only sessions default to Plan but allow switching to Build", async ({ page }) => {
    await createSession(page);
    await expect(page.getByTestId("claude-composer-mode")).toBeVisible();
    await expect(page.getByTestId("claude-composer-mode-build")).toBeEnabled();
    await expect(page.getByTestId("claude-composer-mode-plan")).toBeEnabled();
  });

  test("attaches a reminder from the composer and the binary receives it as a trusted block", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("composer-reminder-select").click();
    await page.locator('[data-testid="composer-reminder-option"][data-reminder-id="cite-file-lines"]').click();
    await page.getByTestId("claude-prompt").fill("Inspect this fixture with citations");
    await page.getByTestId("claude-send").click();
    // The mock names every sentinel block it was handed: injection happened
    // server-side, by id, not by the browser authoring text.
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Injected: reminder=cite-file-lines");
    // The user row keeps the human's words plus a chip; the raw sentinel never renders.
    const transcript = page.getByTestId("claude-transcript");
    await expect(transcript).toContainText("Inspect this fixture with citations");
    await expect(transcript).not.toContainText('<reminder name=');
    await expect(page.getByTestId("opencode-user-message").first()).toContainText("cite-file-lines");
    // Per-message: the selection does not ride on the next turn.
    await expect(page.getByTestId("composer-reminder-select")).not.toContainText("cite-file-lines");
  });

  test("offers only generic workflows, applies one to the composer, and injects it on send", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("composer-workflow-select").click();
    // Workflows whose submit path is an OpenCode route are not offered here.
    await expect(page.locator('[data-testid="composer-workflow-option"][data-workflow-id="goal"]')).toBeVisible();
    await expect(page.locator('[data-testid="composer-workflow-option"][data-workflow-id="managed-child"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-workflow-option"][data-workflow-id="start-dca-session"]')).toHaveCount(0);
    await page.locator('[data-testid="composer-workflow-option"][data-workflow-id="goal"]').click();
    await expect(page.getByTestId("claude-workflow-dialog")).toBeVisible();
    await expect(page.getByTestId("claude-workflow-apply")).toBeDisabled();
    await page.getByTestId("claude-workflow-argument").fill("Add a shout() helper");
    await page.getByTestId("claude-workflow-apply").click();
    await expect(page.getByTestId("claude-workflow-dialog")).toHaveCount(0);
    await expect(page.getByTestId("claude-prompt")).toHaveValue("Add a shout() helper");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Injected: workflow=goal");
    await expect(page.getByTestId("claude-transcript")).not.toContainText('<workflow name=');
  });

  test("a finished Claude turn raises a notification like an OpenCode idle does", async ({ page }) => {
    await createSession(page);
    const bell = page.getByTestId("opencode-nav-notifications");
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
    // Presence, not a count: sibling specs share the notification lane and may
    // be raising their own at the same time.
    await expect(bell).toHaveAttribute("aria-label", /unresolved/u);
  });

  test("opens a transcript file reference in the Files drawer", async ({ page }) => {
    await createSession(page);
    await page.getByTestId("claude-prompt").fill("Inspect this fixture");
    await page.getByTestId("claude-send").click();
    await expect(page.getByTestId("opencode-agent-message-body")).toContainText("Hello from mock claude");
    // The `README.md:2` reference renders as a clickable button; clicking it
    // opens the Files drawer on that file.
    const reference = page.getByTestId("opencode-file-reference").filter({ hasText: "README.md" }).first();
    await expect(reference).toBeVisible();
    await reference.click();
    await expect(page.getByTestId("claude-files")).toBeVisible();
    await expect(page.getByTestId("claude-file-pane")).toContainText("Claude e2e project");
  });
});
