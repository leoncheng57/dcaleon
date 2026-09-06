import { expect, test, type Page } from "@playwright/test";

const DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const hub = `/opencode?directory=${encodeURIComponent(DIR)}`;
const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 800 } },
  { name: "mobile", size: { width: 390, height: 740 } },
] as const;

/** Unresolved rows visible under the default filters (both categories hidden). */
const ACTIVE_COUNT = 8;
const RESOLVED_COUNT = 6;
/** Unresolved rows each default-on filter is responsible for hiding. */
const AUTO_APPROVED_COUNT = 5;
const SUBAGENT_COUNT = 3;

const SESSION_TITLE = "Rewrite the notification popover so it reads as an overlay";

interface StubRecord {
  id: string;
  kind: string;
  at: number;
  directory: string;
  sessionID: string;
  sessionTitle?: string;
  title: string;
  body: string;
  displayBody?: string;
  detail?: string;
  resolvedAt?: number;
  resolvedBy?: string;
  delivery: { ntfy: "off"; desktop: "off"; suppressed?: "auto-permissions" | "subagent" };
}

function seedRecords(): StubRecord[] {
  const base = Date.UTC(2026, 7, 22, 12, 0, 0);
  const records: StubRecord[] = [];
  for (let index = 0; index < ACTIVE_COUNT; index += 1) {
    records.push({
      id: `ntf_active_${index}`,
      kind: "permission",
      at: base - index * 60_000,
      directory: DIR,
      sessionID: "ses_mock_done",
      sessionTitle: SESSION_TITLE,
      title: `OpenCode needs permission ${index}`,
      body: `bash: npm run seeded-${index}`,
      displayBody: `Needs approval to run bash ${index}`,
      detail: `Excerpt for active ${index}`,
      delivery: { ntfy: "off", desktop: "off" },
    });
  }
  for (let index = 0; index < RESOLVED_COUNT; index += 1) {
    records.push({
      id: `ntf_resolved_${index}`,
      kind: "idle",
      at: base - (ACTIVE_COUNT + index) * 60_000,
      directory: DIR,
      sessionID: "ses_mock_done",
      sessionTitle: SESSION_TITLE,
      title: `Session finished ${index}`,
      body: `seeded resolved ${index}`,
      displayBody: "Finished its turn and is waiting for you",
      resolvedAt: base,
      resolvedBy: "checked",
      delivery: { ntfy: "off", desktop: "off" },
    });
  }
  // The two categories the default filters fold away: preapproved permission
  // requests and delegated child sessions. Both are recorded, neither was
  // delivered, and neither may reach the badge while its filter is on.
  for (let index = 0; index < AUTO_APPROVED_COUNT; index += 1) {
    records.push({
      id: `ntf_auto_${index}`,
      kind: "permission",
      at: base - (100 + index) * 60_000,
      directory: DIR,
      sessionID: "ses_mock_done",
      sessionTitle: SESSION_TITLE,
      title: `Preapproved permission ${index}`,
      body: `bash: npm run auto-${index}`,
      displayBody: `Needs approval to run bash ${index}`,
      delivery: { ntfy: "off", desktop: "off", suppressed: "auto-permissions" },
    });
  }
  for (let index = 0; index < SUBAGENT_COUNT; index += 1) {
    records.push({
      id: `ntf_child_${index}`,
      kind: "idle",
      at: base - (200 + index) * 60_000,
      directory: DIR,
      sessionID: "ses_mock_child",
      sessionTitle: `Audit the delegated worktree ${index}`,
      title: `Sub-agent finished ${index}`,
      body: `child session ${index}`,
      displayBody: "Finished its turn and is waiting for you",
      delivery: { ntfy: "off", desktop: "off", suppressed: "subagent" },
    });
  }
  return records;
}

/**
 * The notification history file is shared by every e2e worker, so this suite
 * serves a deterministic history from a route stub instead of seeding real
 * notifications. That keeps the popover assertions exact and keeps this spec
 * from perturbing the counts other specs measure. The real BFF resolution path
 * stays covered by the badge test in smoke.ui.spec.ts.
 */
async function stubHistory(page: Page, records = seedRecords(), outsideWindowActive = 0) {
  const state = { records };
  let appBadgeRevision = Date.UTC(2026, 7, 22, 12, 0, 0);
  // Filtering is server-side precisely so the rows and the counter cannot
  // disagree, so the stub has to honour the flags on both.
  const visible = (record: StubRecord, hideAuto: boolean, hideSubagent: boolean) =>
    !(hideAuto && record.delivery.suppressed === "auto-permissions") &&
    !(hideSubagent && record.delivery.suppressed === "subagent");
  // The server's activeCount is unwindowed while `records` is only the newest
  // page, so the real total is the window's unresolved rows plus any older
  // unresolved records the window cannot reach. That divergence is the steady
  // state once the backlog outgrows HISTORY_LIMIT.
  const activeCount = (hideAuto: boolean, hideSubagent: boolean) =>
    outsideWindowActive +
    state.records.filter((record) => record.resolvedAt === undefined && visible(record, hideAuto, hideSubagent)).length;
  const suppressedActive = () => ({
    "auto-permissions": state.records.filter(
      (record) => record.resolvedAt === undefined && record.delivery.suppressed === "auto-permissions",
    ).length,
    subagent: state.records.filter(
      (record) => record.resolvedAt === undefined && record.delivery.suppressed === "subagent",
    ).length,
    "preference-off": 0,
  });
  await page.route("**/api/notifications/history*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const hideAuto = query.get("hideAutoApproved") === "1";
    const hideSubagent = query.get("hideSubagent") === "1";
    await route.fulfill({
      json: {
        records: state.records.filter((record) => visible(record, hideAuto, hideSubagent)),
        activeCount: activeCount(hideAuto, hideSubagent),
        appBadgeCount: activeCount(true, true),
        appBadgeRevision,
        suppressedActive: suppressedActive(),
      },
    });
  });
  await page.route("**/api/notifications/resolve*", async (route) => {
    const { ids } = route.request().postDataJSON() as { ids: string[] };
    const selected = new Set(ids);
    const records = state.records.filter((record) => selected.has(record.id) && record.resolvedAt === undefined);
    for (const record of records) {
      record.resolvedAt = Date.UTC(2026, 7, 22, 13, 0, 0);
      record.resolvedBy = "checked";
    }
    appBadgeRevision += 1;
    await route.fulfill({
      json: {
        records,
        activeCount: activeCount(true, true),
        appBadgeCount: activeCount(true, true),
        appBadgeRevision,
      },
    });
  });
  await page.route(/\/api\/notifications\/ntf_[^/]+$/, async (route) => {
    const { resolved } = route.request().postDataJSON() as { resolved: boolean };
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    const record = state.records.find((candidate) => candidate.id === id);
    if (!record) return route.fulfill({ status: 404, json: { error: "unknown record" } });
    if (resolved) {
      record.resolvedAt = Date.UTC(2026, 7, 22, 13, 0, 0);
      record.resolvedBy = "checked";
    } else {
      delete record.resolvedAt;
      delete record.resolvedBy;
    }
    appBadgeRevision += 1;
    await route.fulfill({ json: { record, activeCount: activeCount(true, true), appBadgeCount: activeCount(true, true), appBadgeRevision } });
  });
}

/** A backlog past the pill's cap. Manual-only resolution makes this realistic. */
function overflowRecords(count: number): StubRecord[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `ntf_overflow_${index}`,
    kind: "permission",
    at: Date.UTC(2026, 7, 22, 12, 0, 0) - index * 1_000,
    directory: DIR,
    sessionID: "ses_mock_done",
    title: `OpenCode needs permission ${index}`,
    body: `bash: npm run overflow-${index}`,
    delivery: { ntfy: "off", desktop: "off" } as const,
  }));
}

const VIEW_KEY = "opencode-notification-view-v1";

/**
 * Seed this device's view preferences before the app boots.
 *
 * Only seeds when the key is absent, because several tests below change a
 * preference and then reload to prove it stuck — re-seeding on every
 * navigation would overwrite exactly what they are asserting.
 */
async function seedNotificationView(page: Page, patch: Record<string, unknown>) {
  await page.addInitScript(
    ([key, value]) => {
      if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
    },
    [
      VIEW_KEY,
      JSON.stringify({
        version: 1,
        hideAutoApproved: true,
        hideSubagent: true,
        hidePreferenceOff: true,
        resolvedExpanded: false,
        groupBySession: true,
        groupsCollapsed: true,
        ...patch,
      }),
    ] as const,
  );
}

const bell = (page: Page) => page.getByTestId("opencode-nav-notifications");
const popover = (page: Page) => page.getByTestId("opencode-notification-popover");
const resolvedToggle = (page: Page) => page.getByTestId("opencode-notification-popover-resolved-toggle");
const groups = (page: Page) => popover(page).getByTestId("opencode-notification-group");

/** Resolved is an archive and starts collapsed, so most assertions open it first. */
async function expandResolved(page: Page) {
  await resolvedToggle(page).click();
  await expect(page.getByTestId("opencode-notification-popover-resolved")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`nav notification centre (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport.size);
      // These assertions are about sections, filters, resolution and badges —
      // all orthogonal to grouping — so they run against the flat list rather
      // than threading a group expansion through every one. The grouped
      // default has its own block below.
      await seedNotificationView(page, { groupBySession: false });
      await stubHistory(page);
    });

    test("shows the DCA brand, search inside More, and a badged bell", async ({ page }) => {
      await page.goto(hub);
      await expect(page.getByTestId("opencode-nav-home")).toHaveText("DCA");

      // Search is no longer a bar control; it lives in More and still opens on
      // Cmd/Ctrl+K, which the menu row names because the trigger no longer
      // carries aria-keyshortcuts on the bar.
      await expect(page.getByTestId("opencode-palette-open")).toHaveCount(0);
      await page.getByTestId("opencode-nav-more").click();
      const search = page.getByTestId("opencode-palette-open");
      await expect(search).toBeVisible();
      await expect(search).toContainText("Search");
      await expect(search).toContainText("⌘K");
      await search.click();
      await expect(page.getByTestId("opencode-command-palette")).toBeVisible();
      await page.getByTestId("opencode-palette-input").press("Escape");

      await page.keyboard.press(shortcut);
      await expect(page.getByTestId("opencode-command-palette")).toBeVisible();
      await page.getByTestId("opencode-palette-input").press("Escape");

      await expect(bell(page)).toBeVisible();
      await expect(bell(page)).toHaveAttribute("aria-haspopup", "dialog");
      await expect(bell(page)).toHaveAttribute("aria-expanded", "false");
      await expect(bell(page)).toHaveAttribute("aria-label", `Notifications, ${ACTIVE_COUNT} unresolved`);
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(String(ACTIVE_COUNT));
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveAttribute("aria-hidden", "true");
    });

    test("caps the decorative pill at 99+ while the label keeps the exact count", async ({ page }) => {
      const overflow = 137;
      await stubHistory(page, overflowRecords(overflow));
      await page.goto(hub);

      // The pill is decorative and bounded so it cannot swallow the bell.
      const badge = page.getByTestId("opencode-nav-notifications-badge");
      await expect(badge).toHaveText("99+");
      await expect(badge).toHaveAttribute("aria-hidden", "true");

      // The accessible label is the real contract and is never capped.
      await expect(bell(page)).toHaveAttribute("aria-label", `Notifications, ${overflow} unresolved`);

      // The capped pill still fits the nav without overflowing the viewport.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);
      const box = await badge.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(36);

      // Exactly 99 still prints literally: the cap is inclusive.
      await stubHistory(page, overflowRecords(99));
      await page.reload();
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText("99");
      await expect(bell(page)).toHaveAttribute("aria-label", "Notifications, 99 unresolved");
    });

    test("opens an accessible popover without navigating", async ({ page }) => {
      await page.goto(hub);
      const before = page.url();
      await bell(page).click();

      const panel = page.getByRole("dialog", { name: "Notifications" });
      await expect(panel).toBeVisible();
      await expect(bell(page)).toHaveAttribute("aria-expanded", "true");
      expect(page.url()).toBe(before);

      // Active and Resolved stay in their own sections. Resolved reports its
      // size while collapsed, so the archive is never silently invisible.
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT));
      await expect(page.getByTestId("opencode-notification-popover-resolved-count")).toHaveText(String(RESOLVED_COUNT));
      await expect(popover(page).getByRole("heading", { name: "Active" })).toBeVisible();
      await expect(popover(page).getByRole("heading", { name: "Resolved" })).toBeVisible();
      await expect(page.getByTestId("opencode-notification-popover-resolved")).toHaveCount(0);
      await expandResolved(page);

      // Both lists are bounded and scroll on their own.
      for (const testId of ["opencode-notification-popover-active", "opencode-notification-popover-resolved"]) {
        const metrics = await page.getByTestId(testId).evaluate((node) => ({
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        }));
        expect(metrics.clientHeight, `${testId} is bounded`).toBeLessThanOrEqual(240);
        expect(metrics.scrollHeight, `${testId} scrolls`).toBeGreaterThan(metrics.clientHeight);
      }

      await expect(page.getByTestId("opencode-notification-popover-history")).toHaveAttribute(
        "href",
        `/settings/notifications?directory=${encodeURIComponent(DIR)}`,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);
    });

    test("names unresolved records the loaded window cannot reach", async ({ page }) => {
      const outside = 10;
      await stubHistory(page, seedRecords(), outside);
      await page.goto(hub);
      await bell(page).click();

      // The bell reports the server total; the column header reports what it
      // actually rendered. Both are honest, so the gap has to be explained.
      await expect(bell(page)).toHaveAttribute("aria-label", `Notifications, ${ACTIVE_COUNT + outside} unresolved`);
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT));

      const notice = page.getByTestId("opencode-notification-popover-active-outside-window");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(`${outside} older unresolved records are outside this view`);
      // The notice points at the footer link, so it has to name what that link
      // actually says. Asserting the shared wording keeps the two from drifting
      // into an instruction for a control that is not on screen.
      const footerLabel = "See all notifications and settings";
      await expect(notice).toContainText(footerLabel);
      await expect(page.getByTestId("opencode-notification-popover-history")).toHaveText(footerLabel);

      // The history page reconciles its own badge the same way.
      await page.goto(`/settings/notifications?directory=${encodeURIComponent(DIR)}`);
      await expect(page.getByTestId("opencode-notifications-active-count")).toHaveText(String(ACTIVE_COUNT + outside));
      await expect(page.getByTestId("opencode-notification-history-outside-window"))
        .toContainText(`${outside} older unresolved records are outside this page`);
    });

    test("stays quiet when the window holds every unresolved record", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      await expect(bell(page)).toHaveAttribute("aria-label", `Notifications, ${ACTIVE_COUNT} unresolved`);
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT));
      await expect(page.getByTestId("opencode-notification-popover-active-outside-window")).toHaveCount(0);

      await page.goto(`/settings/notifications?directory=${encodeURIComponent(DIR)}`);
      await expect(page.getByTestId("opencode-notification-history-outside-window")).toHaveCount(0);
    });

    test("closes on Escape with focus restored, and on an outside click", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await expect(popover(page)).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(popover(page)).toHaveCount(0);
      await expect(bell(page)).toBeFocused();
      await expect(bell(page)).toHaveAttribute("aria-expanded", "false");

      await bell(page).click();
      await expect(popover(page)).toBeVisible();
      // The nav's own padding is outside the popover and navigates nowhere.
      await page.mouse.click(5, 5);
      await expect(popover(page)).toHaveCount(0);
    });

    test("resolves a record in place and decrements the badge", async ({ page }) => {
      await page.addInitScript(() => {
        const calls: number[] = [];
        Object.defineProperty(window, "__appBadgeCalls", { value: calls, configurable: true });
        Object.defineProperty(navigator, "setAppBadge", {
          configurable: true,
          value: async (count: number) => { calls.push(count); },
        });
        Object.defineProperty(navigator, "clearAppBadge", {
          configurable: true,
          value: async () => { calls.push(0); },
        });
      });
      await page.goto(hub);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __appBadgeCalls: number[] }).__appBadgeCalls.at(-1)))
        .toBe(ACTIVE_COUNT);
      const beforeResume = await page.evaluate(() => (window as unknown as { __appBadgeCalls: number[] }).__appBadgeCalls.length);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
      await expect.poll(() => page.evaluate(() => (window as unknown as { __appBadgeCalls: number[] }).__appBadgeCalls.length))
        .toBeGreaterThan(beforeResume);
      await bell(page).click();

      const activeList = page.getByTestId("opencode-notification-popover-active");
      const row = activeList.getByTestId("opencode-notification-record").first();
      await expect(row).toHaveAttribute("data-active", "true");
      await expect(row.getByTestId("opencode-notification-session")).toHaveAttribute("title", SESSION_TITLE);
      await expect(row.getByTestId("opencode-notification-action")).toHaveText("Needs approval to run bash 0");
      // click(), not check(): resolving moves the row into the Resolved column,
      // so check()'s post-click verification would re-resolve to the next
      // unresolved row and click forever.
      await row.getByTestId("opencode-notification-resolved").click();

      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(String(ACTIVE_COUNT - 1));
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT - 1));
      await expect(page.getByTestId("opencode-notification-popover-resolved-count")).toHaveText(String(RESOLVED_COUNT + 1));
      await expect(bell(page)).toHaveAttribute("aria-label", `Notifications, ${ACTIVE_COUNT - 1} unresolved`);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __appBadgeCalls: number[] }).__appBadgeCalls.at(-1)))
        .toBe(ACTIVE_COUNT - 1);

      // Reversible: unchecking it in the Resolved list puts the count back.
      await expandResolved(page);
      const resolvedList = page.getByTestId("opencode-notification-popover-resolved");
      const resolvedRow = resolvedList.getByTestId("opencode-notification-record").first();
      await expect(resolvedRow.getByTestId("opencode-notification-session")).toHaveAttribute("title", SESSION_TITLE);
      await expect(resolvedRow.getByTestId("opencode-notification-resolved")).toHaveAttribute("aria-pressed", "true");
      await resolvedRow.getByTestId("opencode-notification-resolved").click();
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(String(ACTIVE_COUNT));
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT));
      await expect.poll(() => page.evaluate(() => (window as unknown as { __appBadgeCalls: number[] }).__appBadgeCalls.at(-1)))
        .toBe(ACTIVE_COUNT);
    });

    test("folds away preapproved and sub-agent noise by default, and can unfold it", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      // Both filters start on, so neither category reaches the list or the
      // badge — but each states how much it is hiding.
      const auto = page.getByTestId("opencode-notification-filter-auto-approved");
      const subagent = page.getByTestId("opencode-notification-filter-subagent");
      await expect(auto).toBeChecked();
      await expect(subagent).toBeChecked();
      await expect(page.getByTestId("opencode-notification-filter-auto-approved-count")).toHaveText(
        `(${AUTO_APPROVED_COUNT})`,
      );
      await expect(page.getByTestId("opencode-notification-filter-subagent-count")).toHaveText(`(${SUBAGENT_COUNT})`);
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(String(ACTIVE_COUNT));
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);

      // Unfolding one category adds exactly its rows, to the list and the
      // badge together: a badge that counted hidden rows would just relocate
      // the clutter.
      await auto.uncheck();
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(
        String(ACTIVE_COUNT + AUTO_APPROVED_COUNT),
      );
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(
        ACTIVE_COUNT + AUTO_APPROVED_COUNT,
      );
      const preapproved = popover(page).locator('[data-suppressed="auto-permissions"]').first();
      await expect(preapproved.getByTestId("opencode-notification-session")).toHaveAttribute("title", SESSION_TITLE);
      await expect(preapproved.getByTestId("opencode-notification-action")).toHaveText("Auto-approved before you were notified");
      // The chip explains why a row nobody was asked about is on screen.
      await expect(preapproved.getByTestId("opencode-notification-suppression")).toHaveText("auto-approved");

      await subagent.uncheck();
      await expect(page.getByTestId("opencode-nav-notifications-badge")).toHaveText(
        String(ACTIVE_COUNT + AUTO_APPROVED_COUNT + SUBAGENT_COUNT),
      );
      await expect(
        popover(page).locator('[data-suppressed="subagent"]').first().getByTestId("opencode-notification-suppression"),
      ).toHaveText("sub-agent");

      // The choice is this device's, and it survives a reload.
      await page.reload();
      await bell(page).click();
      await expect(page.getByTestId("opencode-notification-filter-auto-approved")).not.toBeChecked();
      await expect(page.getByTestId("opencode-notification-filter-subagent")).not.toBeChecked();
    });

    test("names the session a notification came from, truncated", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      // The session title is the primary row label, ahead of generic event copy.
      const session = popover(page).getByTestId("opencode-notification-session").first();
      await expect(session).toHaveAttribute("title", SESSION_TITLE);
      const shown = (await session.textContent()) ?? "";
      expect(shown.length).toBeLessThan(SESSION_TITLE.length);
      expect(shown.endsWith("\u2026")).toBe(true);
      expect(SESSION_TITLE.startsWith(shown.slice(0, -1).trimEnd())).toBe(true);

      // The popover row has one line to spend, so delivery detail is dropped
      // there and kept on the full history page.
      const compactRow = popover(page).getByTestId("opencode-notification-record").first();
      await expect(compactRow).not.toContainText("ntfy");
      await page.goto(`/settings/notifications?directory=${encodeURIComponent(DIR)}`);
      await expect(page.getByTestId("opencode-notification-record").first()).toContainText("ntfy");
      await expect(page.getByTestId("opencode-notification-session").first()).toHaveAttribute("title", SESSION_TITLE);
    });

    test("keeps the resolved archive collapsed until asked, and remembers that", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      const toggle = resolvedToggle(page);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByTestId("opencode-notification-popover-resolved")).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByTestId("opencode-notification-popover-resolved").getByTestId("opencode-notification-record"),
      ).toHaveCount(RESOLVED_COUNT);

      await page.reload();
      await bell(page).click();
      await expect(resolvedToggle(page)).toHaveAttribute("aria-expanded", "true");
    });

    test("reads as a floating panel rather than part of the page", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      // A default-weight border and a plain shadow disappear against the dark
      // surface, which is what made this look like another page section.
      const elevation = await popover(page).evaluate((node) => {
        const style = getComputedStyle(node);
        return { boxShadow: style.boxShadow, background: style.backgroundColor };
      });
      expect(elevation.boxShadow).not.toBe("none");
      // A ring layer plus at least one cast shadow.
      expect(elevation.boxShadow.split("rgb").length - 1).toBeGreaterThanOrEqual(3);
      expect(elevation.background).not.toBe("rgba(0, 0, 0, 0)");

      // On a phone the panel spans the viewport, so a scrim does the work the
      // shadow does on desktop.
      const scrim = page.getByTestId("opencode-notification-popover-scrim");
      if (viewport.name === "mobile") {
        await expect(scrim).toBeVisible();
        await scrim.click({ position: { x: 5, y: 5 } });
        await expect(popover(page)).toHaveCount(0);
      } else {
        await expect(scrim).toBeHidden();
      }
    });

    test("keeps secondary navigation reachable from More", async ({ page }) => {
      await page.goto(hub);
      const more = page.getByTestId("opencode-nav-more");
      await expect(more).toHaveAttribute("aria-haspopup", "true");
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await more.click();
      await expect(more).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("opencode-nav-more-menu")).toBeVisible();
      for (const testId of ["opencode-palette-open", "opencode-phone-transfer-open", "opencode-nav-docs", "opencode-nav-tools", "opencode-nav-settings", "opencode-nav-playbooks"]) {
        await expect(page.getByTestId(testId)).toBeVisible();
      }

      // Planning remains a primary destination and must not also appear here.
      await expect(page.getByTestId("opencode-nav-more-menu").getByTestId("opencode-nav-planning")).toHaveCount(0);

      // A disclosure over links, not an APG menu: the three destinations stay
      // real links so assistive tech still lists them as such, and Tab is the
      // traversal model.
      for (const testId of ["opencode-nav-docs", "opencode-nav-tools", "opencode-nav-settings"]) {
        await expect(page.getByTestId(testId)).toHaveRole("link");
      }
      for (const testId of ["opencode-palette-open", "opencode-phone-transfer-open"]) {
        await expect(page.getByTestId(testId)).toHaveRole("button");
      }
      await expect(page.getByTestId("opencode-nav-more-menu").getByRole("menuitem")).toHaveCount(0);

      // Keyboard reachable: the first item takes focus, Tab walks the rest.
      await expect(page.getByTestId("opencode-palette-open")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("opencode-phone-transfer-open")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("opencode-nav-docs")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("opencode-nav-more-menu")).toHaveCount(0);
      await expect(more).toBeFocused();

      await more.click();
      await page.getByTestId("opencode-nav-tools").click();
      await expect(page).toHaveURL(new RegExp(`/tools\\?directory=${encodeURIComponent(DIR)}`));
    });

    test("keeps Planning on the bar and moves Playbooks into More", async ({ page }) => {
      await page.goto(hub);
      const bar = page.locator("nav[aria-label='Main']");
      await expect(bar.getByTestId("opencode-nav-playbooks")).toHaveCount(0);
      await expect(bar.getByTestId("opencode-nav-planning")).toBeVisible();
      await expect(bar.getByTestId("opencode-nav-planning")).toHaveRole("link");
      // Planning is not directory-scoped: it is a cross-project surface.
      await bar.getByTestId("opencode-nav-planning").click();
      await expect(page).toHaveURL(/\/planning$/);
    });

    test("still lists the moved destinations in the command palette", async ({ page }) => {
      await page.goto(hub);
      await page.keyboard.press(shortcut);
      for (const name of [/Docs/, /MCPs/, /Settings/, /Planning/, /Notifications/, /Open on phone/]) {
        await expect(page.getByRole("option", { name }).first()).toBeVisible();
      }
    });

    test("keeps history and notification delivery controls together", async ({ page }) => {
      await page.goto(`/settings/notifications?directory=${encodeURIComponent(DIR)}`);
      await expect(page.getByTestId("opencode-notifications")).toBeVisible();
      await expect(page.getByTestId("opencode-notification-history")).toBeVisible();
      await expect(page.getByTestId("opencode-notifications-active-count")).toHaveText(String(ACTIVE_COUNT));
      await expect(page.getByTestId("opencode-notification-record").first()).toBeVisible();
      await page.getByTestId("opencode-history-filter-resolved").click();
      await expect(page.getByTestId("opencode-notification-record")).toHaveCount(RESOLVED_COUNT);
      await page.getByTestId("opencode-history-filter-active").click();
      await expect(page.getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);
      await expect(page.getByTestId("opencode-notification-preferences")).toBeVisible();
      for (const testId of [
        "opencode-ntfy-enabled",
        "opencode-ntfy-server",
        "opencode-ntfy-topic",
        "opencode-browser-desktop",
        "opencode-notification-capability",
        "opencode-parked-seconds",
        "opencode-notification-media",
        "opencode-browser-sound",
        "opencode-notify-browser-idle",
        "opencode-notify-ntfy-idle",
        "opencode-notifications-save",
        "opencode-notifications-test-browser",
        "opencode-notifications-test-ntfy",
      ]) {
        await expect(page.getByTestId(testId)).toBeVisible();
      }

      // /settings is now agent defaults only, so it no longer has a second
      // notification settings surface that can drift from the inbox.
      await page.goto(`/settings?directory=${encodeURIComponent(DIR)}`);
      await expect(page.getByTestId("opencode-notification-preferences")).toHaveCount(0);
      await expect(page.getByTestId("opencode-notifications-save")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);
    });
  });

  test.describe(`notification session grouping (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport.size);
      // No seeded view: these run against the shipped defaults, which are
      // grouped and folded.
      await stubHistory(page);
    });

    test("folds each session behind a header that still says what is waiting", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      // Folded means folded: no rows at all until asked.
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(0);

      // One session produced every unresolved record in this fixture, so the
      // eight repeated titles collapse to a single header.
      await expect(groups(page)).toHaveCount(1);
      const group = groups(page).first();
      await expect(group).toHaveAttribute("data-expanded", "false");
      await expect(group).toHaveAttribute("data-group-key", "ses_mock_done");
      await expect(group.getByTestId("opencode-notification-group-count")).toHaveText(String(ACTIVE_COUNT));

      // A folded group has to say whether anything inside is waiting on a
      // human, or this default would hide unanswered permissions behind a
      // number. Issue #288 replaced the per-kind chip strip with that one bit;
      // the strip is gone, the guarantee is not (AGENTS.md decision 23).
      await expect(group.getByTestId("opencode-notification-group-chips")).toHaveCount(0);
      await expect(group.getByTestId("opencode-notification-group-chip-permission")).toHaveCount(0);
      await expect(group.getByTestId("opencode-notification-group-blocking")).toHaveText(/needs you/);

      // The header names the session, truncated, with the whole title kept in
      // the tooltip.
      const label = group.getByTestId("opencode-notification-group-label");
      await expect(label).toHaveAttribute("title", SESSION_TITLE);
      const shown = (await label.textContent()) ?? "";
      expect(shown.length).toBeLessThan(SESSION_TITLE.length);
      expect(shown.endsWith("\u2026")).toBe(true);

      await group.getByTestId("opencode-notification-group-toggle").click();
      await expect(group).toHaveAttribute("data-expanded", "true");
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);
    });

    test("lifts the repeated session title out of the rows without taking their link", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();

      // The title belonged to the session, not to each of its eight
      // notifications, so the header owns it now.
      const row = popover(page).getByTestId("opencode-notification-record").first();
      await expect(row.getByTestId("opencode-notification-session")).toHaveCount(0);
      // What is left is what actually distinguishes one row from its siblings.
      await expect(row.getByTestId("opencode-notification-action")).toHaveText("Needs approval to run bash 0");
      // Moving the title must not have cost the row its way to the work: the
      // first line is still what the reader aims at to reach the session.
      await expect(row.getByTestId("opencode-notification-link")).toHaveAttribute(
        "href",
        `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`,
      );
    });

    test("opens the session from a row, and gets out of the way", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();
      await popover(page).getByTestId("opencode-notification-record").first()
        .getByTestId("opencode-notification-link")
        .click();

      // A real client-side navigation, not a reload to some other origin.
      await expect(page).toHaveURL(new RegExp(`/sessions/ses_mock_done\\?directory=${encodeURIComponent(DIR)}`));
      // An overlay that stayed open would cover the session it just opened.
      await expect(popover(page)).toHaveCount(0);
    });

    test("opens the session from a folded group without expanding it first", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      const group = groups(page).first();
      await expect(group).toHaveAttribute("data-expanded", "false");
      const open = group.getByTestId("opencode-notification-group-link");
      await expect(open).toHaveAttribute("aria-label", new RegExp("^Open session "));
      await open.click();

      await expect(page).toHaveURL(new RegExp(`/sessions/ses_mock_done\\?directory=${encodeURIComponent(DIR)}`));
      await expect(popover(page)).toHaveCount(0);
    });

    test("keeps rows clickable with grouping switched off", async ({ page }) => {
      // The deep link is a property of the record, not of the grouping mode.
      await page.goto(hub);
      await bell(page).click();
      await page.getByTestId("opencode-notification-filter-group-session").uncheck();

      await popover(page).getByTestId("opencode-notification-link").first().click();
      await expect(page).toHaveURL(new RegExp(`/sessions/ses_mock_done\\?directory=${encodeURIComponent(DIR)}`));
    });

    test("says nothing needs you when a folded group holds only finished work", async ({ page }) => {
      // Every resolved fixture record is `idle` — work that already stopped —
      // so the marker must stay off. An indicator that is always on says
      // nothing, and a permanent "needs you" over the archive would be a
      // standing falsehood about requests the user already dealt with.
      await page.goto(hub);
      await bell(page).click();
      await expandResolved(page);

      const resolvedGroups = page
        .getByTestId("opencode-notification-popover-resolved")
        .getByTestId("opencode-notification-group");
      await expect(resolvedGroups.first()).toHaveAttribute("data-expanded", "false");
      await expect(
        resolvedGroups.first().getByTestId("opencode-notification-group-blocking"),
      ).toHaveCount(0);
    });

    test("says whether the session is still working, without claiming to know when it does not", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      // ses_mock_done exists in the mock's session list and is absent from
      // /session/status, so the fan-out answers it: a real, positive "idle".
      const group = groups(page).first();
      await expect(group.getByTestId("opencode-status-pill")).toHaveAttribute("data-status", "idle");

      // Grouped rows do not repeat it: the header already said it once for the
      // whole session, and status is a fact about the session rather than the
      // record. Repeating it on every row is the duplication grouping exists to
      // remove — the same reason a grouped row drops the session title.
      await group.getByTestId("opencode-notification-group-toggle").click();
      const row = popover(page).getByTestId("opencode-notification-record").first();
      await expect(row.getByTestId("opencode-status-pill")).toHaveCount(0);

      // With grouping off there is no header to carry it, so the row does.
      await page.getByTestId("opencode-notification-filter-group-session").uncheck();
      await expect(
        popover(page).getByTestId("opencode-notification-record").first().getByTestId("opencode-status-pill"),
      ).toHaveAttribute("data-status", "idle");
    });

    test("never renders a confident idle for a session the fan-out cannot answer for", async ({ page }) => {
      // ses_mock_unowned is not in the mock's session list at all — the shape
      // a session takes once the process that ran it is gone. /session/status
      // is process-local, so `idle` here would be a confident falsehood.
      await stubHistory(page, [
        {
          id: "ntf_unowned",
          kind: "permission",
          at: Date.UTC(2026, 7, 22, 12, 0, 0),
          directory: DIR,
          sessionID: "ses_mock_unowned",
          sessionTitle: "Work from a process that has since exited",
          title: "OpenCode needs permission",
          body: "bash: npm test",
          displayBody: "Needs approval to run bash",
          delivery: { ntfy: "off", desktop: "off" },
        },
      ]);
      await page.goto(hub);
      await bell(page).click();

      const pill = groups(page).first().getByTestId("opencode-status-pill");
      await expect(pill).toHaveAttribute("data-status", "unknown");
      // Styled apart from idle rather than sharing its treatment, so "we do
      // not know" cannot be read as "nothing is happening".
      await expect(pill).toHaveCSS("border-style", "dashed");
    });

    test("makes Open a real button-sized target that still behaves like a link", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();

      const open = popover(page).getByTestId("opencode-notification-link").first();
      // Still an anchor: middle-click, cmd-click and "copy link address" are
      // properties of the element, and a button calling navigate() loses them.
      await expect(open).toHaveJSProperty("tagName", "A");
      await expect(open).toHaveAttribute(
        "href",
        `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`,
      );

      // The point of the change: a tap target, not a ~13px run of underlined
      // heading text. Icon-only dropped the label but must not have dropped
      // the target with it, so both axes are asserted, not just the height.
      const box = await open.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
      // No visible label left, so the accessible name is the only thing naming
      // the destination. Losing it would make the control unusable by anyone
      // not looking at the icon.
      await expect(open).toHaveAttribute("aria-label", new RegExp("^Open session "));

      // Distinct from Resolve beside it. Primary is this app's green action
      // token and is already spent there, so two solid buttons in one colour
      // would have to be decoded.
      const resolve = popover(page).getByTestId("opencode-notification-record").first()
        .getByTestId("opencode-notification-resolved");
      const [openColor, resolveColor] = await Promise.all([
        open.evaluate((node) => getComputedStyle(node).backgroundColor),
        resolve.evaluate((node) => getComputedStyle(node).backgroundColor),
      ]);
      expect(openColor).not.toBe(resolveColor);
    });

    test("keeps the row readable once the actions no longer fit one line", async ({ page }) => {
      // A kind badge, readable text and two 44px actions do not fit a 390px
      // line. The row wraps rather than letting the text column absorb the
      // whole deficit, which truncated headings to a few characters.
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();

      const row = popover(page).getByTestId("opencode-notification-record").first();
      await expect(row.getByTestId("opencode-notification-action")).toHaveText("Needs approval to run bash 0");
      const heading = await row.getByTestId("opencode-notification-action").boundingBox();
      expect(heading?.width ?? 0).toBeGreaterThan(100);
      // Nothing may push the panel into a horizontal scrollbar at any width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1);
    });

    test("keeps the group resolve control one width whatever its count", async ({ page }) => {
      // This is the only control on the surface whose label embeds a number, so
      // it was the only one that changed size as the number did: a group going
      // from 9 to 10 shifted its own header, and two stacked groups with
      // different counts never lined up. The two seeded sessions differ by a
      // digit, which is exactly the case that used to diverge.
      await page.goto(hub);
      await bell(page).click();
      await page.getByTestId("opencode-notification-filter-subagent").uncheck();

      const resolves = popover(page).getByTestId("opencode-notification-group-resolve");
      await expect(resolves).toHaveCount(2);
      const [first, second] = await Promise.all([
        resolves.nth(0).boundingBox(),
        resolves.nth(1).boundingBox(),
      ]);
      // Different counts, identical box.
      await expect(resolves.nth(0)).toHaveText(String(ACTIVE_COUNT));
      await expect(resolves.nth(1)).toHaveText(String(SUBAGENT_COUNT));
      expect(first?.width).toBe(second?.width);
      // Wide enough to hold the largest count the window can produce without
      // the digits colliding with the icon.
      expect(first?.width ?? 0).toBeGreaterThanOrEqual(56);
    });

    test("expands every group at once and remembers that choice", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();

      const expandAll = page.getByTestId("opencode-notification-groups-expand-all");
      await expect(expandAll).toHaveText("Expand all");
      await expandAll.click();
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);
      await expect(expandAll).toHaveText("Collapse all");

      // The default is persisted per device, so a reader who prefers the open
      // view sets it once rather than every visit.
      await page.reload();
      await bell(page).click();
      await expect(page.getByTestId("opencode-notification-groups-expand-all")).toHaveText("Collapse all");
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);
    });

    test("orders groups by their newest notification", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      // Unfolding sub-agent noise brings a second session into the list.
      await page.getByTestId("opencode-notification-filter-subagent").uncheck();

      await expect(groups(page)).toHaveCount(2);
      await expect(groups(page).nth(0)).toHaveAttribute("data-group-key", "ses_mock_done");
      await expect(groups(page).nth(1)).toHaveAttribute("data-group-key", "ses_mock_child");
      await expect(groups(page).nth(1).getByTestId("opencode-notification-group-count")).toHaveText(
        String(SUBAGENT_COUNT),
      );
    });

    test("returns to a flat list when grouping is switched off", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await page.getByTestId("opencode-notification-filter-group-session").uncheck();

      await expect(groups(page)).toHaveCount(0);
      await expect(popover(page).getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);
      // The row goes back to naming its own session once no header does.
      await expect(popover(page).getByTestId("opencode-notification-session").first()).toHaveAttribute(
        "title",
        SESSION_TITLE,
      );
      // Expand/Collapse all is meaningless without groups and goes away.
      await expect(page.getByTestId("opencode-notification-groups-expand-all")).toHaveCount(0);
    });

    test("links the Active and Resolved views directly", async ({ page }) => {
      const historyPath = `/settings/notifications?directory=${encodeURIComponent(DIR)}`;

      // Landing straight on the link shows that view, without a click.
      await page.goto(`${historyPath}&state=active`);
      await expect(page.getByTestId("opencode-history-filter-active")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("opencode-notification-group").first()
        .getByTestId("opencode-notification-group-toggle").click();
      await expect(page.getByTestId("opencode-notification-record")).toHaveCount(ACTIVE_COUNT);

      await page.goto(`${historyPath}&state=resolved`);
      await expect(page.getByTestId("opencode-history-filter-resolved")).toHaveAttribute("aria-pressed", "true");

      // A stale or hand-edited link degrades to the whole history rather than
      // erroring or showing nothing.
      await page.goto(`${historyPath}&state=pending`);
      await expect(page.getByTestId("opencode-history-filter-all")).toHaveAttribute("aria-pressed", "true");

      // Clicking a pill writes the link, so the view can be shared afterwards.
      await page.getByTestId("opencode-history-filter-active").click();
      await expect(page).toHaveURL(/[?&]state=active/u);
      await expect(page).toHaveURL(new RegExp(`directory=${encodeURIComponent(encodeURIComponent(DIR))}|directory=`, "u"));
      // "All" is the absence of the parameter, so the canonical link stays bare.
      await page.getByTestId("opencode-history-filter-all").click();
      await expect(page).not.toHaveURL(/[?&]state=/u);
    });

    test("offers resolution as a real button, still reversible", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();

      const control = popover(page).getByTestId("opencode-notification-record").first()
        .getByTestId("opencode-notification-resolved");
      // A checkbox is a poor target for the row's only action, especially on a
      // thumb-driven popover.
      await expect(control).toHaveRole("button");
      await expect(control).toHaveAttribute("aria-pressed", "false");
      // Icon-only: the visible word is gone, so the accessible name is what
      // has to carry it, and the target has to hold on both axes rather than
      // collapsing to the width of an icon.
      await expect(control).toHaveAttribute("aria-label", "Resolve");
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
      const colors = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const primary = getComputedStyle(document.documentElement).getPropertyValue("--color-background-action-primary").trim();
        const probe = document.createElement("span");
        probe.style.backgroundColor = primary;
        document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: style.backgroundColor, expected };
      });
      expect(colors.actual).toBe(colors.expected);

      await control.click();
      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(ACTIVE_COUNT - 1));
    });

    test("resolves only one session group after explicit confirmation", async ({ page }) => {
      await page.goto(hub);
      await bell(page).click();
      page.on("dialog", (dialog) => dialog.accept());
      // Make a second session visible. The action must not spill over into it.
      await page.getByTestId("opencode-notification-filter-subagent").uncheck();

      const group = page.getByTestId("opencode-notification-group").first();
      const resolve = group.getByTestId("opencode-notification-group-resolve");
      // The control is icon + count now, so the count it acts on is asserted
      // through the accessible name rather than a visible sentence.
      await expect(resolve).toHaveText(String(ACTIVE_COUNT));
      await expect(resolve).toHaveAttribute("aria-label", new RegExp(`^Resolve all ${ACTIVE_COUNT} for `));
      await resolve.click();

      await expect(page.getByTestId("opencode-notification-popover-active-count")).toHaveText(String(SUBAGENT_COUNT));
      const childGroup = page.getByTestId("opencode-notification-group").filter({ hasText: "Audit the delegated worktree" });
      await expect(childGroup).toHaveCount(1);
      await expect(childGroup.getByTestId("opencode-notification-group-resolve")).toHaveText(String(SUBAGENT_COUNT));
      // The resolved archive retains the evidence; this only changed the
      // selected session, never a destructive global clear.
      await expandResolved(page);
      await expect(page.getByTestId("opencode-notification-popover-resolved-count"))
        .toHaveText(String(ACTIVE_COUNT + RESOLVED_COUNT));
    });

    test("says what the agent did, so same-session rows are told apart", async ({ page }) => {
      // Grouping made the duplication obvious: eight rows under one header all
      // reading "Needs approval to run bash". The excerpt is what distinguishes
      // them once the session title is no longer on every row.
      await page.goto(hub);
      await bell(page).click();
      await groups(page).first().getByTestId("opencode-notification-group-toggle").click();

      const details = popover(page).getByTestId("opencode-notification-detail");
      await expect(details.first()).toHaveText("Excerpt for active 0");
      await expect(details.nth(1)).toHaveText("Excerpt for active 1");
      const texts = await details.allTextContents();
      expect(new Set(texts).size).toBe(texts.length);
    });

    test("groups the full history page the same way", async ({ page }) => {
      await page.goto(`/settings/notifications?directory=${encodeURIComponent(DIR)}`);

      // Both surfaces share the component and the preference, so a session
      // folded in one is folded in the other.
      const pageGroups = page.getByTestId("opencode-notification-group");
      await expect(pageGroups).toHaveCount(1);
      await expect(page.getByTestId("opencode-notification-record")).toHaveCount(0);

      await pageGroups.first().getByTestId("opencode-notification-group-toggle").click();
      await expect(page.getByTestId("opencode-notification-record")).toHaveCount(
        ACTIVE_COUNT + RESOLVED_COUNT,
      );
      // Full-width rows keep their delivery detail; only the session title moved.
      await expect(page.getByTestId("opencode-notification-record").first()).toContainText("ntfy");
    });
  });
}
