import { expect, test } from "@playwright/test";

// Sub-agent orchestration, end to end: the built SPA against the real BFF
// against the mock agent.
//
// The fixture lives in its own project directory and covers one child per
// evidence path: busy, a child whose own transcript completed, one settled
// only by a hand-back notice in the parent, and a background launch that was
// silently cancelled. The last is the interesting one — nothing upstream can
// settle it, and the requirement is that the UI admits that rather than
// guessing.

const DIR = process.platform === "darwin" ? "/private/tmp/mock-subagent-project" : "/tmp/mock-subagent-project";
const PARENT = "ses_mock_parent";
const CHILD_RUNNING = "ses_mock_child_running";
const CHILD_DONE = "ses_mock_child_done";
const CHILD_REPORTED = "ses_mock_child_reported";
const CHILD_UNKNOWN = "ses_mock_child_unknown";
const CHILD_FAILED = "ses_mock_child_failed";
const CHILD_LAUNCHED = "ses_mock_child_launched";

const hub = `/opencode?directory=${encodeURIComponent(DIR)}`;
const parentUrl = `/sessions/${PARENT}?directory=${encodeURIComponent(DIR)}`;
const childUrl = `/sessions/${CHILD_RUNNING}?directory=${encodeURIComponent(DIR)}`;

test.describe("hub hierarchy", () => {
  test("collapses nested sessions by default and expands each level", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    const rows = page.getByTestId("opencode-session-row");
    await expect(rows.first()).toContainText("Parallel investigation");
    await expect(rows.first()).toHaveAttribute("data-depth", "0");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Detached delegated session");

    const rootDisclosure = page.getByTestId("opencode-session-list-disclosure").first();
    await expect(rootDisclosure).toHaveAttribute("aria-expanded", "false");
    await expect(rootDisclosure).toHaveAccessibleName("Show 6 child sessions for Parallel investigation");
    await rootDisclosure.click();
    await expect(rootDisclosure).toHaveAttribute("aria-expanded", "true");
    await expect(rows).toHaveCount(8);
    const depths = await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-depth")));
    expect(depths).toEqual(["0", "1", "1", "1", "1", "1", "1", "0"]);
    await expect(page.getByText("Reproduce the flake", { exact: true })).toHaveCount(0);

    const nestedDisclosure = page.getByRole("button", { name: "Show 1 child session for Check the tests", exact: true });
    await nestedDisclosure.click();
    await expect(page.getByText("Reproduce the flake", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(9);
  });

  test("marks children with a sub pill and the root with its child count", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    const rows = page.getByTestId("opencode-session-row");
    await expect(rows.first().getByTestId("opencode-session-child-count")).toHaveText("6 sub");
    await page.getByTestId("opencode-session-list-disclosure").first().click();
    // The count is direct children only, so the nested delegation shows on the
    // sub-agent that actually made it.
    await expect(rows.nth(2).getByTestId("opencode-session-child-count")).toHaveText("1 sub");
    await expect(rows.first().getByTestId("opencode-session-list-row").first().getByTestId("opencode-subagent-pill")).toHaveCount(0);
    await expect(page.getByTestId("opencode-session-list").getByTestId("opencode-subagent-pill")).toHaveCount(7);
  });

  test("uses the same collapsed tree for recently opened and recently active", async ({ page }) => {
    await page.addInitScript(({ directory }) => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [{ id: "ses_mock_child_done", directory, openedAt: 1 }],
      }));
    }, { directory: DIR });
    await page.goto(hub);

    for (const testId of ["opencode-recently-opened", "opencode-recently-active"]) {
      const list = page.getByTestId(testId);
      await expect(list.getByText("Parallel investigation", { exact: true })).toBeVisible();
      await expect(list.getByText("Check the tests", { exact: true })).toHaveCount(0);
      await list.getByTestId(`${testId}-disclosure`).first().click();
      await expect(list.getByText("Check the tests", { exact: true })).toBeVisible();
      await list.getByText("Check the tests", { exact: true }).click();
      await expect(page).toHaveURL(new RegExp("/sessions/ses_mock_child_done"));
      if (testId === "opencode-recently-opened") await page.goto(hub);
    }
  });
});

test.describe("mobile hub hierarchy", () => {
  test.use({ viewport: { width: 390, height: 740 }, hasTouch: true });

  test("keeps disclosure touch targets and deep indentation mobile-safe", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    const rootDisclosure = page.getByTestId("opencode-session-list-disclosure").first();
    expect((await rootDisclosure.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await rootDisclosure.click();
    const nestedDisclosure = page.getByRole("button", { name: "Show 1 child session for Check the tests", exact: true });
    expect((await nestedDisclosure.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await nestedDisclosure.click();
    await expect(page.getByText("Reproduce the flake", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});

test.describe("child session identity", () => {
  test("badges a sub-agent transcript and links back to its parent", async ({ page }) => {
    await page.goto(childUrl);
    await expect(page.getByTestId("opencode-subagent-badge")).toBeVisible();
    const banner = page.getByTestId("opencode-parent-link");
    await expect(banner).toContainText("Parallel investigation");

    await banner.getByTestId("opencode-parent-open").click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${PARENT}`));
    await expect(page.getByTestId("opencode-session-title")).toHaveText("Parallel investigation");
  });

  test("does not badge a root session", async ({ page }) => {
    await page.goto(parentUrl);
    await expect(page.getByTestId("opencode-session-title")).toHaveText("Parallel investigation");
    await expect(page.getByTestId("opencode-subagent-badge")).toHaveCount(0);
    await expect(page.getByTestId("opencode-parent-link")).toHaveCount(0);
  });
});

test.describe("parent transcript", () => {
  test("renders task-only cards with verified execution metadata", async ({ page }) => {
    await page.goto(parentUrl);
    const cards = page.getByTestId("opencode-task-card");
    await expect(cards).toHaveCount(6);
    await expect(cards.first().getByTestId("opencode-task-metadata")).toContainText("Foreground");
    await expect(cards.first().getByTestId("opencode-task-metadata")).toContainText("Agent: explore");
    await expect(cards.first().getByTestId("opencode-task-metadata")).toContainText("claude-opus-5-with-an-intentionally-long-unbroken-model-name");
    await expect(cards.nth(2).getByTestId("opencode-task-metadata")).toContainText("Background");
    await expect(cards.nth(2).getByTestId("opencode-task-metadata")).toContainText("Agent: general");
  });

  test("keeps disclosure and child navigation as accessible sibling controls", async ({ page }) => {
    await page.goto(parentUrl);
    const card = page.locator(`[data-testid="opencode-task-card"][data-child-session="${CHILD_DONE}"]`);
    const toggle = card.getByTestId("opencode-task-toggle");
    const link = card.getByTestId("opencode-subagent-link");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAccessibleName(/completed: Expand task Check the tests/);
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAccessibleName(/completed: Collapse task Check the tests/);
    await expect(link).toBeVisible();
    await expect(toggle.locator("a")).toHaveCount(0);
  });

  test("links each delegation to the session that ran it", async ({ page }) => {
    await page.goto(parentUrl);
    const delegation = page.locator(`[data-child-session="${CHILD_DONE}"]`).first();
    await expect(delegation).toBeVisible();
    await delegation.getByTestId("opencode-subagent-link").first().click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${CHILD_DONE}`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(DIR);
  });

  test("keeps a successful delegation out of a collapsed action group", async ({ page }) => {
    await page.goto(parentUrl);
    // Six task calls in a row would otherwise fold into one "N actions
    // completed" chevron, hiding every link to the child work.
    await expect(page.getByTestId("opencode-action-group")).toHaveCount(0);
    await expect(page.getByTestId("opencode-task-card")).toHaveCount(6);
  });

  test("wraps task metadata without horizontal overflow on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(parentUrl);
    const card = page.getByTestId("opencode-task-card").first();
    await expect(card).toBeVisible();
    expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("renders a machine-authored hand-back as a status row, not a user message", async ({ page }) => {
    await page.goto(parentUrl);
    const notice = page.locator(`[data-testid="opencode-status-separator"][data-child-session="${CHILD_REPORTED}"]`);
    await expect(notice).toContainText("Sub-agent reported completion");
    await expect(page.getByTestId("opencode-user-message-body").filter({ hasText: CHILD_REPORTED })).toHaveCount(0);
  });
});

test.describe("subagents panel", () => {
  test("derives one row per child with honest evidence for each state", async ({ page }) => {
    await page.goto(parentUrl);
    await page.getByTestId("opencode-inspector-subagents").click();

    const rows = page.getByTestId("opencode-subagent-row");
    await expect(rows).toHaveCount(6);

    const running = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_RUNNING}"]`);
    await expect(running.getByTestId("opencode-subagent-state")).toHaveText("running");
    await expect(running.getByTestId("opencode-subagent-evidence")).toContainText("busy");

    const done = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_DONE}"]`);
    await expect(done.getByTestId("opencode-subagent-state")).toHaveText("completed");
    await expect(done.getByTestId("opencode-subagent-evidence")).toContainText("own final turn");

    // Settled only by the parent's hand-back notice: weaker provenance, and
    // the panel says which artefact it read.
    const reported = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_REPORTED}"]`);
    await expect(reported.getByTestId("opencode-subagent-state")).toHaveText("completed");
    await expect(reported.getByTestId("opencode-subagent-evidence")).toContainText("completion notice");

    // A background launch whose child never reported back. The parent task part
    // says "completed" — that only means the launch returned.
    const unknown = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_UNKNOWN}"]`);
    await expect(unknown.getByTestId("opencode-subagent-state")).toHaveText("unknown");
    await expect(unknown.getByTestId("opencode-subagent-evidence")).toContainText("cancelled");
    await expect(unknown.getByTestId("opencode-subagent-background")).toBeVisible();

    const failed = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_FAILED}"]`);
    await expect(failed.getByTestId("opencode-subagent-state")).toHaveText("failed");
    await expect(failed.getByTestId("opencode-subagent-detail")).toContainText("credentials were unavailable");

    const launched = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_LAUNCHED}"]`);
    await expect(launched.getByTestId("opencode-subagent-state")).toHaveText("launched");
    await expect(launched.getByTestId("opencode-subagent-evidence")).toContainText("no progress");
  });

  // Issue #182 gives human-authorized Managed Children their own accent. This
  // fixture has none, so every row here must stay in the native/unknown
  // treatment — an `unknown` child in particular must not be promoted to a
  // provenance it never proved.
  test("never applies managed styling to native or unknown children", async ({ page }) => {
    await page.goto(parentUrl);
    await page.getByTestId("opencode-inspector-subagents").click();
    const rows = page.getByTestId("opencode-subagent-row");
    await expect(rows).toHaveCount(6);
    await expect(page.locator('[data-testid="opencode-subagent-row"][data-origin="managed-human"]')).toHaveCount(0);
    await expect(page.getByTestId("opencode-subagent-origin").filter({ hasText: "Managed Child" })).toHaveCount(0);
    await expect(page.getByTestId("opencode-subagent-policy-status")).toHaveCount(0);

    const native = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_DONE}"]`);
    await expect(native).toHaveAttribute("data-origin", "native-task");
    await expect(native.getByTestId("opencode-subagent-origin")).toHaveText("Native task");

    // A row settled by nothing keeps its native provenance and its plain
    // surface; `unknown` state is not evidence of a managed launch.
    const unknown = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_UNKNOWN}"]`);
    await expect(unknown).toHaveAttribute("data-state", "unknown");
    await expect(unknown).not.toHaveAttribute("data-origin", "managed-human");
    expect(await rows.evaluateAll((items) => items.every((item) => {
      const style = getComputedStyle(item);
      return style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent";
    }))).toBe(true);
  });

  test("keeps every hub child on the neutral sub pill without managed metadata", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    await page.getByTestId("opencode-session-list-disclosure").first().click();
    const pills = page.getByTestId("opencode-session-list").getByTestId("opencode-subagent-pill");
    await expect(pills.first()).toHaveText("sub");
    expect(await pills.evaluateAll((items) => items.every((item) => item.getAttribute("data-managed") === "false"))).toBe(true);
  });

  test("offers Stop only for work the connected server is actually running", async ({ page }) => {
    await page.goto(parentUrl);
    await page.getByTestId("opencode-inspector-subagents").click();
    await expect(page.getByTestId("opencode-subagent-row")).toHaveCount(6);

    await expect(page.getByTestId("opencode-subagent-abort")).toHaveCount(1);
    const running = page.locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_RUNNING}"]`);
    await expect(running.getByTestId("opencode-subagent-abort")).toBeVisible();
  });

  test("navigates from a panel row to the child transcript", async ({ page }) => {
    await page.goto(parentUrl);
    await page.getByTestId("opencode-inspector-subagents").click();
    await page
      .locator(`[data-testid="opencode-subagent-row"][data-session="${CHILD_DONE}"]`)
      .getByTestId("opencode-subagent-open")
      .click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${CHILD_DONE}`));
  });

  test("summarizes states and counts sub-agents on the tab", async ({ page }) => {
    await page.goto(parentUrl);
    await page.getByTestId("opencode-inspector-subagents").click();
    await expect(page.getByTestId("opencode-subagents-summary")).toContainText("1 running");
    await expect(page.getByTestId("opencode-subagents-summary")).toContainText("1 unknown");
    await expect(page.getByTestId("opencode-inspector-subagents")).toContainText("6");
  });

  test("says plainly when a session delegated nothing", async ({ page }) => {
    await page.goto(childUrl);
    await page.getByTestId("opencode-inspector-subagents").click();
    await expect(page.getByTestId("opencode-subagents-empty")).toBeVisible();
    await expect(page.getByTestId("opencode-subagent-row")).toHaveCount(0);
  });

  test("is reachable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(parentUrl);
    await page.getByTestId("opencode-mobile-runlog-open").click();
    const sheet = page.getByTestId("opencode-mobile-inspector");
    await expect(sheet).toBeVisible();
    await sheet.getByTestId("opencode-inspector-subagents").click();
    await expect(sheet.getByTestId("opencode-subagent-row")).toHaveCount(6);
  });

  test("opens the requested panel directly on desktop", async ({ page }) => {
    await page.goto(`${parentUrl}&panel=subagents`);
    await expect(page.getByTestId("opencode-subagent-row")).toHaveCount(6);
    await expect(page.getByTestId("opencode-inspector-subagents")).toHaveClass(/font-semibold/);
  });

  test("opens the requested panel as a mobile sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(`${parentUrl}&panel=subagents`);
    const sheet = page.getByTestId("opencode-mobile-inspector");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("opencode-subagent-row")).toHaveCount(6);
  });

  test("ignores an unknown panel value", async ({ page }) => {
    await page.goto(`${parentUrl}&panel=not-a-panel`);
    await expect(page.getByTestId("opencode-todo-list")).toBeVisible();
    await expect(page.getByTestId("opencode-mobile-inspector")).toHaveCount(0);
  });
});
