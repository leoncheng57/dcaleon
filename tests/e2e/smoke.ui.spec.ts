import { expect, test, type Page } from "@playwright/test";

// Browser tier — the built SPA against the real BFF against the mock agent.

const DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const SECOND_DIR = process.platform === "darwin" ? "/private/tmp/mock-second-project" : "/tmp/mock-second-project";
const hub = `/opencode?directory=${encodeURIComponent(DIR)}`;
const MOCK_URL = `http://127.0.0.1:${process.env.MOCK_OPENCODE_PORT || 4599}`;
const FORGE_URL = `http://127.0.0.1:${process.env.MOCK_PREVIEW_PORT || 4600}`;

/**
 * Constrain the cross-project recents pool to named fixture sessions.
 *
 * The mock's session list is global mutable state: any test that starts an
 * agent adds a session stamped with Date.now(), which sorts above every
 * fixture. Ordering assertions have to pin the pool or they depend on which
 * other tests happen to be running in parallel.
 */
async function pinRecentsTo(page: import("@playwright/test").Page, ids: string[]): Promise<void> {
  await page.route("**/api/recent-sessions?*", async (route) => {
    const url = new URL(route.request().url());
    // Request the fixtures by id as well as by recency. Filtering the response
    // alone is not enough: the BFF returns a newest-N window, and a session
    // another test just created can push a fixture out of it before the filter
    // ever runs.
    for (const id of ids) url.searchParams.append("session", id);
    const response = await route.fetch({ url: url.toString() });
    const payload = await response.json() as { sessions: Array<{ id: string }> };
    await route.fulfill({
      response,
      json: { ...payload, sessions: payload.sessions.filter(({ id }) => ids.includes(id)) },
    });
  });
}

async function promptPayload(text: string): Promise<Record<string, unknown> | undefined> {
  const payloads = await (await fetch(`${MOCK_URL}/test/prompt-payloads`)).json() as Array<Record<string, unknown>>;
  return payloads.find((item) => {
    const parts = item.parts as Array<{ type?: string; text?: string }> | undefined;
    return parts?.some((part) => part.type === "text" && part.text === text);
  });
}

async function selectModel(page: Page, testId: string, key: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.locator(`[data-testid="${testId}-option"][data-model-key="${key}"]`).getByRole("option").click();
}

test.describe("hub", () => {
  test("uses route and session names in browser tabs", async ({ page }) => {
    await page.goto(hub);
    await expect(page).toHaveTitle("Sessions | DCA");

    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await expect(page).toHaveTitle("Add a health endpoint | DCA");

    await page.goto("/planning");
    await expect(page).toHaveTitle("Planning | DCA");
  });

  test("lists sessions for the directory", async ({ page }) => {
    await page.goto(hub);
    // "3. Existing sessions" is collapsed by default; expand it first.
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    await expect(page.getByTestId("opencode-session-list")).toBeVisible();
    const rows = page.getByTestId("opencode-session-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("opencode-session-list").getByText("Add a health endpoint")).toBeVisible();
    await expect(page.getByText("Old archived work")).toHaveCount(0);
  });

  test("shows a running pill for the busy session", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    const pills = page.getByTestId("opencode-session-list").getByTestId("opencode-status-pill");
    await expect(pills.filter({ hasText: "running" })).toHaveCount(1);
  });

  test("needs attention merges a session that is both running and notifying into one row, and hides entirely when empty", async ({ page }) => {
    // Constrain recents to the one known-running fixture so the running band
    // is deterministic regardless of other tests' cross-project activity.
    await pinRecentsTo(page, ["ses_mock_running"]);
    await page.route("**/api/notifications/history*", async (route) => {
      await route.fulfill({
        json: {
          records: [
            {
              id: "ntf_attention_1",
              kind: "permission",
              at: Date.UTC(2026, 7, 28, 12, 0, 0),
              directory: DIR,
              sessionID: "ses_mock_done",
              sessionTitle: "Add a health endpoint",
              title: "OpenCode needs permission",
              body: "bash: npm test",
              displayBody: "Needs approval to run bash",
              delivery: { ntfy: "off", desktop: "off" },
            },
            // Same session as the running fixture (ses_mock_running): this
            // must merge into the running row, not render as a second row.
            {
              id: "ntf_attention_2",
              kind: "idle",
              at: Date.UTC(2026, 7, 28, 12, 1, 0),
              directory: DIR,
              sessionID: "ses_mock_running",
              sessionTitle: "Refactor the parser",
              title: "Session finished",
              body: "seeded",
              displayBody: "Finished its turn and is waiting for you",
              delivery: { ntfy: "off", desktop: "off" },
            },
          ],
          activeCount: 2,
          appBadgeCount: 2,
          appBadgeRevision: 1,
          suppressedActive: { "auto-permissions": 0, subagent: 0, "preference-off": 0 },
        },
      });
    });
    await page.goto(hub);

    const attention = page.getByTestId("opencode-needs-attention");
    await expect(attention).toBeVisible();
    const rows = attention.getByTestId("opencode-attention-row");
    await expect(rows).toHaveCount(2);

    // The running + notifying session merges into one row with both markers.
    const merged = rows.filter({ hasText: "Refactor the parser" });
    await expect(merged).toHaveCount(1);
    await expect(merged).toHaveAttribute("data-running", "true");
    await expect(merged).toHaveAttribute("data-notify", "true");
    await expect(merged.getByTestId("opencode-status-pill")).toContainText("running");
    await expect(merged).toContainText("notif active");
    await expect(merged).toContainText("idle");

    // The notification-only session is its own row, with no running pill.
    const notifyOnly = rows.filter({ hasText: "Add a health endpoint" });
    await expect(notifyOnly).toHaveCount(1);
    await expect(notifyOnly).toHaveAttribute("data-running", "false");
    await expect(notifyOnly).toHaveAttribute("data-notify", "true");
    await expect(notifyOnly).toContainText("permission");

    // Clicking a notify-only row navigates to the session that produced it.
    await notifyOnly.click();
    await expect(page).toHaveURL(/\/sessions\/ses_mock_done\?/);

    await page.goto(hub);
    await page.route("**/api/notifications/history*", async (route) => {
      await route.fulfill({
        json: { records: [], activeCount: 0, appBadgeCount: 0, appBadgeRevision: 1, suppressedActive: { "auto-permissions": 0, subagent: 0, "preference-off": 0 } },
      });
    });
    await page.addInitScript(() => localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({ version: 1, entries: [] })));
    await page.route("**/api/recent-sessions?*", async (route) => {
      await route.fulfill({ json: { sessions: [], directories: [] } });
    });
    await page.goto(hub);
    await expect(page.getByTestId("opencode-needs-attention")).toHaveCount(0);
  });

  test("reports the upstream agent version", async ({ page }) => {
    await page.goto(hub);
  await expect(page.getByTestId("opencode-upstream-badge")).toContainText("1.18.23+dca.2");
  });

  test("shows compact directory-wide auto permissions controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(hub);
    const control = page.getByTestId("opencode-hub-auto-permissions");
    const toggle = control.getByTestId("opencode-hub-auto-permissions-toggle");
    await expect(toggle).toHaveAttribute("role", "switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleName("Turn auto permissions on");
    expect((await control.boundingBox())?.height).toBeLessThanOrEqual(40);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAccessibleName("Turn auto permissions off");
    expect((await control.boundingBox())?.height).toBeLessThanOrEqual(40);
    await expect(control.getByTestId("opencode-hub-auto-permissions-warning")).toHaveCount(0);
    await control.getByTestId("opencode-hub-auto-permissions-details").click();
    await expect(control.getByTestId("opencode-hub-auto-permissions-warning")).toContainText("arbitrary shell commands");
    await expect(control).toContainText("every session using this project directory");
    await toggle.click();
    await expect(control.getByTestId("opencode-hub-auto-permissions-warning")).toHaveCount(0);
  });

  test("selects the configured model from the safe catalogue", async ({ page }) => {
    await page.goto(hub);
    const picker = page.getByTestId("opencode-hub-model");
    await expect(picker).toHaveAttribute("value", "anthropic/claude-opus-5");
    await picker.click();
    const pinned = page.getByTestId("opencode-hub-model-pinned-group");
    await expect(pinned).toContainText("GPT-5.6 Sol");
    await expect(pinned).toContainText("Claude Opus 5");
    await expect(page.getByTestId("opencode-hub-model-panel")).toContainText("Claude Retired");
    await expect(page.getByTestId("opencode-hub-model-panel")).toContainText("GPT-5");
  });

  test("searches models and persists user-managed pins", async ({ page }) => {
    let pins = [
      { providerID: "openai", modelID: "gpt-5.6-sol" },
      { providerID: "anthropic", modelID: "claude-opus-5" },
    ];
    await page.route("**/api/model-pins", async (route) => {
      if (route.request().method() === "PATCH") {
        pins = (route.request().postDataJSON() as { models: typeof pins }).models;
      }
      await route.fulfill({ json: { models: pins } });
    });
    await page.goto(hub);
    await page.getByTestId("opencode-hub-model").click();
    await page.getByTestId("opencode-hub-model-search").fill("sol");
    await expect(page.getByTestId("opencode-hub-model-panel")).toContainText("GPT-5.6 Sol");
    await expect(page.getByTestId("opencode-hub-model-panel")).not.toContainText("Claude Opus 5");
    const sol = page.locator('[data-testid="opencode-hub-model-option"][data-model-key="openai/gpt-5.6-sol"]');
    await sol.getByTestId("opencode-hub-model-pin").click();
    await expect.poll(() => pins).toEqual([{ providerID: "anthropic", modelID: "claude-opus-5" }]);
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByTestId("opencode-hub-model").click();
    await expect(page.getByTestId("opencode-hub-model-pinned-group")).not.toContainText("GPT-5.6 Sol");
    await expect(page.getByTestId("opencode-hub-model-panel")).toContainText("GPT-5.6 Sol");
  });

  test("prompts for a directory when none is set", async ({ page }) => {
    await page.goto("/opencode");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/opencode");
    await expect(page.getByTestId("opencode-start")).toBeDisabled();
  });

  test("searches project cards and keeps manual paths as an advanced fallback", async ({ page }) => {
    await page.goto(hub);
    // The project picker is collapsed by default; expand it before reaching
    // into its search box or card list.
    await page.getByTestId("opencode-project-picker-toggle").click();
    const mockProject = page.getByTestId("opencode-project-card").filter({
      has: page.getByText("mock-project", { exact: true }),
    });
    await expect(mockProject).toBeVisible();
    const projectList = page.getByTestId("opencode-project-list");
    expect(await projectList.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    expect(await projectList.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(288);
    expect((await mockProject.boundingBox())?.height).toBeLessThanOrEqual(48);
    await page.getByTestId("opencode-project-search").fill("no-project-has-this-name");
    await expect(mockProject).toHaveCount(0);
    await expect(page.getByTestId("opencode-directory-input")).not.toBeVisible();
    await page.getByTestId("opencode-directory-advanced-toggle").click();
    await expect(page.getByTestId("opencode-directory-input")).toBeVisible();
  });

  test("pins a project with the always-visible card action", async ({ page }) => {
    let directories: string[] = [];
    await page.route("**/api/project-pins", async (route) => {
      if (route.request().method() === "PATCH") {
        directories = (route.request().postDataJSON() as { directories: string[] }).directories;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ directories }) });
    });
    await page.goto(hub);
    await page.getByTestId("opencode-project-picker-toggle").click();
    const mockProject = page.getByTestId("opencode-project-card").filter({
      has: page.getByText("mock-project", { exact: true }),
    });
    const pin = mockProject.getByTestId("opencode-project-pin");
    await expect(pin).toBeVisible();
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
  });

  test("shows an advisory running-session warning only outside isolated mode", async ({ page }) => {
    await page.goto(hub);
    await expect(page.getByTestId("opencode-session-collision-warning")).toBeVisible();
    await page.getByTestId("opencode-isolated-workspace").check();
    await expect(page.getByTestId("opencode-session-collision-warning")).toHaveCount(0);
  });

  test("keeps an undiscovered URL workspace selected", async ({ page }) => {
    const other = `${DIR}/src`;
    await page.goto(`/opencode?directory=${encodeURIComponent(other)}`);
    await expect(page.getByTestId("opencode-other-workspace")).toContainText("Other workspace");
    await expect(page.getByTestId("opencode-project-select-other")).toHaveAttribute("aria-pressed", "true");
  });

  test("navigating to a session keeps the directory scope", async ({ page }) => {
    await page.goto(hub);
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    await page.getByTestId("opencode-session-row").first().click();
    await expect(page).toHaveURL(/\/sessions\/.*directory=/);
    await expect(page.getByTestId("opencode-conversation")).toBeVisible();
  });

  test("orders recently opened independently from recently active and persists reloads", async ({ page }) => {
    // Constrain the cross-project pool to this project so the ordering
    // assertions stay about opened-vs-active, not about project merging.
    await pinRecentsTo(page, ["ses_mock_done", "ses_mock_running", "ses_mock_unknown_model"]);
    await page.goto(hub);
    // The sessions picker is collapsed by default and resets on every Hub
    // remount, so it needs re-expanding after each "back to Sessions" navigation.
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    const sessions = page.getByTestId("opencode-session-list");

    await sessions.getByText("Add a health endpoint", { exact: true }).click();
    await page.getByRole("link", { name: "Sessions" }).click();
    await page.getByTestId("opencode-sessions-picker-toggle").click();
    await sessions.getByText("Refactor the parser", { exact: true }).click();
    await page.getByRole("link", { name: "Sessions" }).click();

    const openedRows = page.getByTestId("opencode-recently-opened-row");
    await expect(openedRows).toHaveCount(2);
    expect(await openedRows.allTextContents()).toEqual([
      expect.stringContaining("Refactor the parser"),
      expect.stringContaining("Add a health endpoint"),
    ]);

    const activeRows = page.getByTestId("opencode-recently-active-row");
    await expect(activeRows).toHaveCount(3);
    expect(await activeRows.allTextContents()).toEqual([
      expect.stringContaining("Imported unknown model"),
      expect.stringContaining("Refactor the parser"),
      expect.stringContaining("Add a health endpoint"),
    ]);
    for (const row of await openedRows.all()) {
      await expect(row).toHaveAttribute("href", new RegExp(`directory=${encodeURIComponent(DIR)}`));
    }
    for (const row of await activeRows.all()) {
      await expect(row).toHaveAttribute("href", new RegExp(`directory=${encodeURIComponent(DIR)}`));
    }

    await page.reload();
    await expect(page.getByTestId("opencode-recently-opened-row")).toHaveCount(2);
    expect(await page.getByTestId("opencode-recently-opened-row").allTextContents()).toEqual([
      expect.stringContaining("Refactor the parser"),
      expect.stringContaining("Add a health endpoint"),
    ]);
  });

  test("shows recents from another project, labelled by project", async ({ page }) => {
    // Previously this asserted the opposite — that an entry from another
    // directory stayed hidden. Recents are cross-project now, so the row must
    // appear, and it must be attributed to the project it came from.
    await page.addInitScript(({ directory }) => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [{ id: "ses_second_oldest", directory, openedAt: Date.now() }],
      }));
    }, { directory: SECOND_DIR });
    await page.goto(hub);

    const openedRows = page.getByTestId("opencode-recently-opened-row");
    await expect(openedRows).toHaveCount(1);
    await expect(openedRows.first()).toContainText("Second project oldest");
    await expect(openedRows.first()).toContainText("mock-second-project");
    await expect(openedRows.first()).toHaveAttribute(
      "href",
      new RegExp(`directory=${encodeURIComponent(SECOND_DIR)}`),
    );
  });

  test("ignores recents entries pointing outside the projects root", async ({ page }) => {
    // localStorage outlives renames and moves between machines; a stale path
    // must be dropped rather than breaking the whole panel.
    await page.addInitScript(() => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [{ id: "ses_mock_done", directory: "/nonexistent/project", openedAt: Date.now() }],
      }));
    });
    await page.goto(hub);
    await expect(page.getByTestId("opencode-recently-opened-empty")).toBeVisible();
    await expect(page.getByTestId("opencode-recently-active-row").first()).toBeVisible();
  });

  test("merges recently active across projects newest first", async ({ page }) => {
    await pinRecentsTo(page, [
      "ses_second_newest",
      "ses_mock_unknown_model",
      "ses_mock_running",
      "ses_mock_done",
      "ses_second_oldest",
    ]);
    await page.addInitScript(({ directory }) => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [{ id: "ses_second_oldest", directory, openedAt: Date.now() }],
      }));
    }, { directory: SECOND_DIR });
    await page.goto(hub);

    const activeRows = page.getByTestId("opencode-recently-active-row");
    await expect(activeRows).toHaveCount(5);
    // Interleaved by time, not grouped by project: that is the whole point.
    expect(await activeRows.allTextContents()).toEqual([
      expect.stringContaining("Second project newest"),
      expect.stringContaining("Imported unknown model"),
      expect.stringContaining("Refactor the parser"),
      expect.stringContaining("Add a health endpoint"),
      expect.stringContaining("Second project oldest"),
    ]);
    expect(await activeRows.first().textContent()).toContain("mock-second-project");
  });

  test("shows recents before any project is chosen", async ({ page }) => {
    await pinRecentsTo(page, ["ses_second_newest", "ses_second_oldest"]);
    await page.addInitScript(({ directory }) => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [{ id: "ses_second_oldest", directory, openedAt: Date.now() }],
      }));
    }, { directory: SECOND_DIR });
    // No ?directory= and no stored selection: the panel must still render.
    await page.goto("/opencode");

    await expect(page.getByTestId("opencode-recent-sessions")).toBeVisible();
    await expect(page.getByTestId("opencode-recently-active-row")).toHaveCount(2);
    await expect(page.getByTestId("opencode-recently-active-row").first())
      .toContainText("Second project newest");
    // Still genuinely unscoped: the session list below has no project to show.
    await expect(page.getByText("Pick a project directory to list its sessions.")).toBeVisible();
  });

  test("keeps recent rows usable without overflow at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.addInitScript(({ directory }) => {
      localStorage.setItem("opencode.recentSessions.v1", JSON.stringify({
        version: 1,
        entries: [
          { id: "ses_mock_running", directory, openedAt: 2 },
          { id: "ses_mock_done", directory, openedAt: 1 },
        ],
      }));
    }, { directory: DIR });
    await page.goto(hub);
    const recent = page.getByTestId("opencode-recent-sessions");
    const newTask = page.getByTestId("opencode-new-task");
    await expect(recent).toBeVisible();
    expect(await recent.evaluate((element, task) => Boolean(element.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING), await newTask.elementHandle())).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const componentBox = await recent.boundingBox();
    const newTaskBox = await newTask.boundingBox();
    expect(componentBox?.y).toBeLessThan(newTaskBox?.y ?? 0);
    expect(componentBox?.width).toBeLessThanOrEqual(358);
    for (const row of await page.getByTestId("opencode-recently-opened-row").all()) {
      expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("starts the initial prompt in Plan mode", async ({ page }) => {
    const text = `initial plan ${Date.now()}`;
    await page.goto(hub);
    await expect(page.getByTestId("opencode-hub-mode")).toBeVisible();
    await page.getByTestId("opencode-hub-mode-plan").click();
    await page.getByTestId("opencode-prompt").fill(text);
    await page.getByTestId("opencode-start").click();
    await expect(page).toHaveURL(/\/sessions\/ses_mock_new_/);
    await expect.poll(() => promptPayload(text)).toMatchObject({ agent: "plan" });
    await expect(page.getByTestId("opencode-composer-mode-plan")).toHaveAttribute("aria-pressed", "true");
  });

  test("starts with an explicit variant while keeping Plan independent", async ({ page }) => {
    const text = `initial variant plan ${Date.now()}`;
    await page.goto(hub);
    await page.getByTestId("opencode-hub-mode-plan").click();
    await page.getByTestId("opencode-hub-model").click();
    await page.getByTestId("opencode-hub-model-variant").filter({ hasText: "high" }).click();
    await expect(page.getByTestId("opencode-hub-mode-plan")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("opencode-prompt").fill(text);
    await page.getByTestId("opencode-start").click();
    await expect.poll(() => promptPayload(text)).toMatchObject({
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      variant: "high",
    });
  });
});

test.describe("phone transfer", () => {
  // Phone transfer moved into the nav "More" overflow menu, so every entry
  // point has to open that menu first.
  const openPhoneTransfer = async (page: import("@playwright/test").Page) => {
    await page.getByTestId("opencode-nav-more").click();
    await page.getByTestId("opencode-phone-transfer-open").click();
  };

  test("opens with the configured URL, copies it, and closes", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(hub);
    await openPhoneTransfer(page);

    const dialog = page.getByTestId("opencode-phone-transfer-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("opencode-phone-transfer-url")).toHaveText("https://ide.e2e.example.test:8443");
    await expect(dialog.getByRole("img")).toBeVisible();

    await page.getByTestId("opencode-phone-transfer-copy").click();
    await expect(page.getByTestId("opencode-phone-transfer-copy-status")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://ide.e2e.example.test:8443");

    await page.getByTestId("opencode-phone-transfer-close").click();
    await expect(dialog).toHaveCount(0);
  });

  test("targets the active conversation", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await openPhoneTransfer(page);

    await expect(page.getByTestId("opencode-phone-transfer-url")).toHaveText(
      `https://ide.e2e.example.test:8443/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`,
    );
  });

  test("dialog fits without horizontal overflow at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(hub);
    await openPhoneTransfer(page);
    await expect(page.getByTestId("opencode-phone-transfer-dialog")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("transcript", () => {
  const conversation = `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`;
  const mobileConversation = `/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`;
  const paginatedConversation = `/sessions/ses_mock_paginated?directory=${encodeURIComponent(DIR)}`;

  const navigateInApp = async (page: import("@playwright/test").Page, url: string) => {
    await page.evaluate((next) => {
      history.pushState({}, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, url);
  };

  test("renders every row kind from the fixture", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-transcript")).toBeVisible();
    await expect(page.getByTestId("opencode-user-message").first()).toBeVisible();
    await expect(page.getByTestId("opencode-agent-message")).toBeVisible();
    await expect(page.getByTestId("opencode-thought")).toHaveCount(1);
    await expect(page.getByTestId("opencode-status-separator").first()).toBeVisible();
  });

  test("rejects stale poll completions across A to B to A and hides old actionable state immediately", async ({ page }) => {
    let releaseMessages!: () => void;
    let releaseTodos!: () => void;
    let messagesHeld = false;
    let todosHeld = false;
    const messageGate = new Promise<void>((resolve) => { releaseMessages = resolve; });
    const todoGate = new Promise<void>((resolve) => { releaseTodos = resolve; });

    await page.route("**/api/sessions/ses_mock_done/messages?**", async (route) => {
      if (!messagesHeld) {
        messagesHeld = true;
        await messageGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            messages: [{ info: { id: "msg_stale", role: "assistant", time: { created: 1, completed: 1 } }, parts: [{ id: "prt_stale", messageID: "msg_stale", type: "text", text: "STALE A RESPONSE" }] }],
            running: false,
            nextCursor: null,
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/sessions/ses_mock_done/todos?**", async (route) => {
      if (!todosHeld) {
        todosHeld = true;
        await todoGate;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ todos: [{ content: "STALE TODO", status: "pending", priority: "high" }] }) });
        return;
      }
      await route.continue();
    });

    await page.goto(conversation);
    await expect.poll(() => messagesHeld && todosHeld).toBe(true);
    await navigateInApp(page, mobileConversation);
    await expect(page.getByTestId("opencode-session-title")).toHaveText("Mobile full session fixture");
    await expect(page.getByTestId("opencode-permission-request")).toHaveCount(0);
    await expect(page.getByTestId("opencode-question-request")).toHaveCount(0);
    await navigateInApp(page, conversation);
    await expect(page.getByText("Add a health endpoint to the server.")).toBeVisible();

    releaseMessages();
    releaseTodos();
    await expect(page.getByText("STALE A RESPONSE", { exact: true })).toHaveCount(0);
    await expect(page.getByText("STALE TODO", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("opencode-todo-list")).toContainText("Add the route");
  });

  test("hides seeded permission and question state on a session transition", async ({ page }) => {
    await fetch(`${MOCK_URL}/test/permissions/reset?directory=${encodeURIComponent(DIR)}`, { method: "POST" });
    await fetch(`${MOCK_URL}/test/questions/reset?scope=ui`, { method: "POST" });
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-permission-request")).toBeVisible();
    await expect(page.getByTestId("opencode-question-request")).toBeVisible();
    await navigateInApp(page, mobileConversation);
    await expect(page.getByTestId("opencode-permission-request")).toHaveCount(0);
    await expect(page.getByTestId("opencode-question-request")).toHaveCount(0);
  });

  test("rejects stale earlier-page completion after revisiting the same session", async ({ page }) => {
    let releaseBackfill!: () => void;
    let held = false;
    const gate = new Promise<void>((resolve) => { releaseBackfill = resolve; });
    await page.route("**/api/sessions/ses_mock_paginated/messages?**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.searchParams.has("before") && !held) {
        held = true;
        await gate;
      }
      await route.continue();
    });

    await page.goto(paginatedConversation);
    await page.getByTestId("opencode-load-earlier").click({ noWaitAfter: true });
    await expect.poll(() => held).toBe(true);
    await navigateInApp(page, mobileConversation);
    await expect(page.getByTestId("opencode-session-title")).toHaveText("Mobile full session fixture");
    await navigateInApp(page, paginatedConversation);
    await expect(page.getByText("Paged message 126", { exact: true })).toBeVisible();
    releaseBackfill();
    await expect(page.getByText("Paged message 1", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("opencode-load-earlier")).toBeVisible();
  });

  test("keeps older pages for newest part updates and cancels backfill for older updates", async ({ page }) => {
    let release!: () => void;
    let held = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/sessions/ses_mock_paginated/messages?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("before") === "25" && !held) { held = true; await gate; }
      await route.continue();
    });
    await page.goto(paginatedConversation);
    await page.getByTestId("opencode-load-earlier").click();
    await expect(page.getByText("Paged message 50", { exact: true })).toBeVisible();
    await fetch(`${MOCK_URL}/test/paginated/newest-update`, { method: "POST" });
    await expect(page.getByText("Paged message 50", { exact: true })).toBeVisible();
    await page.getByTestId("opencode-load-earlier").click({ noWaitAfter: true });
    await expect.poll(() => held).toBe(true);
    await fetch(`${MOCK_URL}/test/paginated/pending-update`, { method: "POST" });
    await expect(page.getByText("Paged message 50", { exact: true })).toBeVisible();
    release();
    await expect(page.getByText("Paged message 1", { exact: true })).toHaveCount(0);
  });

  test("cancels complete command export when the inspector unmounts", async ({ page }) => {
    let newestRequests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/sessions/ses_mock_paginated/messages?**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("before") && ++newestRequests === 2) await gate;
      await route.continue();
    });
    let downloads = 0;
    page.on("download", () => { downloads += 1; });
    await page.goto(paginatedConversation);
    await page.getByTestId("opencode-inspector-runlog").click();
    await page.getByTestId("opencode-export-commands").click({ noWaitAfter: true });
    await page.getByRole("link", { name: "Sessions" }).click();
    release();
    await page.waitForTimeout(200);
    expect(downloads).toBe(0);
  });

  test("shows the reasoning duration OpenHands could not", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-thought")).toContainText("2.0s");
  });

  test("shows muted per-message cost and latency with an ASCII breakdown", async ({ page }) => {
    await page.goto(conversation);
    const metrics = page.getByTestId("opencode-message-metrics");
    // The model comes first so a per-turn override is readable on the row it affected.
    await expect(metrics.locator("summary")).toContainText("claude-opus-5 · 8.0s · $0.0421 message · $0.0421 session · final");
    await expect(metrics.getByTestId("opencode-message-model")).toHaveAttribute("title", "Model: anthropic/claude-opus-5");
    await metrics.locator("summary").press("Enter");
    await expect(metrics.getByTestId("opencode-message-metrics-diagram")).toContainText("model:  anthropic/claude-opus-5");
    await expect(metrics.getByTestId("opencode-message-metrics-diagram")).toContainText("prompt -> agent turn -> response");
    await expect(metrics.getByTestId("opencode-message-metrics-diagram")).toContainText("100 in + 900 out + 250 reasoning");
  });

  test("shows live context usage against the model limit", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-context-tokens")).toContainText("%");
  });

  // Encrypted-only reasoning must not produce an empty row.
  test("drops reasoning that carries no readable text", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-thought")).toHaveCount(1);
  });

  test("expands a tool call to reveal its output", async ({ page }) => {
    await page.goto(conversation);
    const tool = page.getByTestId("opencode-tool").first();
    // The composer/question panel may geometrically overlap this transcript
    // row at CI's viewport. Keyboard activation tests the same accessible
    // button behavior without making the assertion depend on pointer layout.
    await tool.getByRole("button").press("Enter");
    await expect(tool).toContainText("export const app = express()");
  });

  test("keeps generic tool calls on the compact renderer", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-tool")).toHaveCount(3);
    await expect(page.getByTestId("opencode-task-card")).toHaveCount(0);
  });

  test("marks a failed tool call", async ({ page }) => {
    await page.goto(conversation);
    const failed = page.getByTestId("opencode-tool").filter({ hasText: "webfetch" });
    await expect(failed).toHaveAttribute("data-status", "error");
  });

  test("renders the task list from the todo endpoint", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    const tasks = page.getByTestId("opencode-todo-list");
    await expect(tasks).toContainText("1/3 done");
    await expect(tasks).toContainText("Add the route");
  });

  test("never leaks provider signatures into the DOM", async ({ page }) => {
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-transcript")).toBeVisible();
    const html = await page.getByTestId("opencode-transcript").innerHTML();
    expect(html).not.toContain("OPAQUE_SIGNATURE_MUST_NOT_RENDER");
    expect(html).not.toContain("ENCRYPTED_ONLY_NO_TEXT");
  });

  test("tolerates an unknown part type", async ({ page }) => {
    await page.goto(conversation);
    // The fixture contains "some-future-part-type"; the transcript must render.
    await expect(page.getByTestId("opencode-transcript")).toBeVisible();
    expect(await page.getByTestId("opencode-error").count()).toBe(0);
  });
});

test.describe("message mode", () => {
  const modes = `/sessions/ses_mock_modes?directory=${encodeURIComponent(DIR)}`;

  const prompt = (page: Page, text: string) =>
    page.getByTestId("opencode-user-message").filter({ hasText: text });
  const reply = (page: Page, text: string) =>
    page.getByTestId("opencode-agent-message").filter({ hasText: text });

  test("labels Plan and Build prose and leaves unclassifiable rows neutral", async ({ page }) => {
    await page.goto(modes);
    await expect(page.getByTestId("opencode-transcript")).toBeVisible();

    await expect(prompt(page, "Draft the migration approach.")).toHaveAttribute("data-mode", "plan");
    await expect(prompt(page, "Go ahead and implement it.")).toHaveAttribute("data-mode", "build");
    await expect(reply(page, "Planned response")).toHaveAttribute("data-mode", "plan");
    // No `mode` field on this message: the exact-agent fallback classified it.
    await expect(reply(page, "Build response")).toHaveAttribute("data-mode", "build");

    // Redundant with colour: a visible word, and a named field for AT.
    const planPill = reply(page, "Planned response").getByTestId("opencode-message-mode");
    await expect(planPill).toContainText("Message mode: Plan");
    await expect(planPill).toHaveAttribute("data-mode", "plan");
    await expect(reply(page, "Build response").getByTestId("opencode-message-mode"))
      .toContainText("Message mode: Build");

    // `info.mode` is the primary signal, so a sub-agent identity carrying one
    // is still classified. The pill is provenance, not proof of policy.
    await expect(reply(page, "Delegated response")).toHaveAttribute("data-mode", "build");

    // Nothing to classify, and a mode/agent conflict: both stay neutral.
    for (const text of ["Unstamped response", "Conflicted response"]) {
      const neutral = reply(page, text);
      await expect(neutral).toHaveCount(1);
      await expect(neutral).not.toHaveAttribute("data-mode");
      await expect(neutral.getByTestId("opencode-message-mode")).toHaveCount(0);
    }
  });

  test("gives Plan and Build distinct rails and pills in light and dark", async ({ page }) => {
    const surfaces = async () => {
      await expect(page.locator('[data-testid="opencode-agent-message"][data-mode="build"]').first()).toBeVisible();
      return page.evaluate(() => {
        const read = (mode: string) => {
          const body = document.querySelector(
            `[data-testid="opencode-agent-message"][data-mode="${mode}"] [data-testid="opencode-agent-message-body"]`,
          )!;
          const pill = document.querySelector(`[data-testid="opencode-message-mode"][data-mode="${mode}"]`)!;
          const style = getComputedStyle(body);
          const pillStyle = getComputedStyle(pill);
          return {
            background: style.backgroundColor,
            rail: style.borderLeftColor,
            railWidth: Number.parseFloat(style.borderLeftWidth),
            pillColor: pillStyle.color,
            pillBackground: pillStyle.backgroundColor,
          };
        };
        const neutralBody = document.querySelector(
          '[data-testid="opencode-agent-message"]:not([data-mode]) [data-testid="opencode-agent-message-body"]',
        )!;
        return {
          plan: read("plan"),
          build: read("build"),
          neutralBackground: getComputedStyle(neutralBody).backgroundColor,
        };
      });
    };

    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(modes);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    const light = await surfaces();

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const dark = await surfaces();

    for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
      expect(theme.plan.rail, `${name} rails differ`).not.toBe(theme.build.rail);
      expect(theme.plan.pillColor, `${name} pill text differs`).not.toBe(theme.build.pillColor);
      expect(theme.plan.pillBackground, `${name} pill fill differs`).not.toBe(theme.build.pillBackground);
      for (const mode of ["plan", "build"] as const) {
        expect(theme[mode].railWidth, `${name} ${mode} has a rail`).toBeGreaterThanOrEqual(2);
        // The rail is the whole treatment: a marked body must read exactly like
        // an unmarked one, with no wash behind the prose.
        expect(theme[mode].background, `${name} ${mode} body is untinted`).toBe(theme.neutralBackground);
      }
    }
    // Every token needs a .dark counterpart, or the accent survives the theme
    // switch and lands unreadable on the opposite surface.
    expect(dark.plan.rail).not.toBe(light.plan.rail);
    expect(dark.build.rail).not.toBe(light.build.rail);
    expect(dark.plan.pillBackground).not.toBe(light.plan.pillBackground);
    expect(dark.build.pillBackground).not.toBe(light.build.pillBackground);
  });

  test("keeps the user bubble inside its existing width ceiling", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(modes);
    const transcript = page.getByTestId("opencode-transcript");
    await expect(transcript).toBeVisible();
    const bubble = prompt(page, "Go ahead and implement it.").getByTestId("opencode-user-message-body");
    const [bubbleBox, transcriptBox] = await Promise.all([bubble.boundingBox(), transcript.boundingBox()]);
    expect(bubbleBox!.width).toBeLessThanOrEqual((transcriptBox?.width ?? 0) * 0.8);
  });
});

test.describe("interrupted runs", () => {
  // The mock's running session has no completed assistant turn, and the mock
  // reports it busy — so it must NOT be flagged.
  test("does not flag a session that is genuinely running", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_running?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-conversation")).toBeVisible();
    await expect(page.getByTestId("opencode-interrupted")).toHaveCount(0);
  });
});

test.describe("composer", () => {
  test("auto-approves once, leaves questions visible, and surfaces reply failures", async ({ page, request }) => {
    await request.patch(`/api/auto-approve?directory=${DIR}`, { data: { enabled: false } });
    await fetch(`${MOCK_URL}/test/permissions/reset?directory=${encodeURIComponent(DIR)}`, { method: "POST" });
    // scope=ui/ses_mock_done, not scope=api/ses_mock_running: smoke.api.spec.ts owns
    // the api-scoped question and answers it on another worker, so resetting it here
    // and asserting it stays visible is an assertion about that file's timing.
    await fetch(`${MOCK_URL}/test/questions/reset?scope=ui`, { method: "POST" });
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const control = page.getByTestId("opencode-mobile-auto-permissions");
    const toggle = control.getByTestId("opencode-mobile-auto-permissions-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    const id = `perm_auto_${Date.now()}`;
    await fetch(`${MOCK_URL}/test/permission?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sessionID: "ses_mock_done", permission: "bash", patterns: ["npm test"] }),
    });
    await expect.poll(async () => await (await fetch(`${MOCK_URL}/test/permission-replies`)).json())
      .toContainEqual({ id, reply: "once" });
    await expect(page.getByTestId("opencode-permission-request").filter({ hasText: "npm test" })).toHaveCount(0);
    await expect(page.getByTestId("opencode-question-request")).toBeVisible();

    const failedID = `perm_fail_auto_${Date.now()}`;
    await fetch(`${MOCK_URL}/test/permission?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: failedID, sessionID: "ses_mock_done", permission: "external_directory", patterns: ["/tmp/*"] }),
    });
    await expect(control.getByTestId("opencode-mobile-auto-permissions-error"))
      .toContainText("Could not auto-approve external_directory");
    await expect(page.getByTestId("opencode-permission-request").filter({ hasText: "/tmp/*" })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await fetch(`${MOCK_URL}/test/permissions/reset?directory=${encodeURIComponent(DIR)}`, { method: "POST" });
  });

  test("approves a permission and continues the conversation", async ({ page, request: apiRequest }) => {
    await apiRequest.patch(`/api/auto-approve?directory=${DIR}`, { data: { enabled: false } });
    const id = `perm_continue_${Date.now()}`;
    await fetch(`${MOCK_URL}/test/permission?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sessionID: "ses_mock_running", permission: "external_directory", patterns: [`${DIR}/${id}/*`] }),
    });
    await page.goto(`/sessions/ses_mock_running?directory=${encodeURIComponent(DIR)}`);
    const request = page.getByTestId("opencode-permission-request").filter({ hasText: id });
    await expect(request).toBeVisible();
    await request.getByTestId("opencode-permission-once").click();
    await expect(request).toHaveCount(0);
    await expect(page.getByTestId("opencode-agent-message").filter({ hasText: "Permission approved; continuing" })).toBeVisible();
    const replies = await (await fetch(`${MOCK_URL}/test/permission-replies`)).json() as Array<{ id: string; reply: string }>;
    expect(replies).toContainEqual({ id, reply: "once" });
  });

  test("keeps a failed permission reply visible and retryable", async ({ page, request: apiRequest }) => {
    await apiRequest.patch(`/api/auto-approve?directory=${DIR}`, { data: { enabled: false } });
    const id = `perm_fail_${Date.now()}`;
    await fetch(`${MOCK_URL}/test/permission?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, sessionID: "ses_mock_running", permission: "bash", patterns: [`npm test ${id}`] }),
    });
    await page.goto(`/sessions/ses_mock_running?directory=${encodeURIComponent(DIR)}`);
    const request = page.getByTestId("opencode-permission-request").filter({ hasText: id });
    await expect(request).toBeVisible();
    await request.getByTestId("opencode-permission-once").click();
    await expect(page.getByTestId("opencode-permission-error")).toContainText("mock permission reply failed");
    await expect(request).toBeVisible();
    await expect(request.getByTestId("opencode-permission-once")).toBeEnabled();
  });

  test("sends a follow-up", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-composer").fill("do the thing");
    await page.getByTestId("opencode-send").click();
    await expect(page.getByTestId("opencode-composer")).toHaveValue("");
  });

  test("submits on Enter and keeps Shift+Enter as a newline", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");

    await composer.click();
    await composer.type("first line");
    await composer.press("Shift+Enter");
    await composer.type("second line");
    await expect(composer).toHaveValue("first line\nsecond line");

    await composer.press("Enter");
    await expect(composer).toHaveValue("");
  });

  test("does not submit an empty or whitespace-only draft on Enter", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");

    await composer.click();
    await composer.press("Enter");
    await composer.type("   ");
    await composer.press("Enter");

    // Enter is swallowed rather than inserting a newline, and the draft is kept
    // rather than cleared, which is what sending would do. The transcript is
    // deliberately not asserted on: this mock session is shared with the other
    // composer tests, so its contents change underneath a parallel worker.
    await expect(composer).toHaveValue("   ");
    await expect(page.getByTestId("opencode-send")).toBeDisabled();
  });

  test("accepts an image attachment", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-attach").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
    await expect(page.getByTestId("opencode-attachment-chip")).toContainText("pixel.png");
    await page.getByTestId("opencode-composer").fill("inspect this");
    await page.getByTestId("opencode-send").click();
    await expect(page.getByTestId("opencode-attachment-chip")).toHaveCount(0);
  });

  test("pastes an image without consuming pasted text and reports invalid files", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");
    await composer.fill("keep this text");
    await composer.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(composer).toHaveValue("keep this text");
    await expect(page.getByTestId("opencode-attachment-chip")).toContainText("pasted.png");

    await page.getByTestId("opencode-attach").setInputFiles({ name: "page.html", mimeType: "text/html", buffer: Buffer.from("<img src=https://example.test/x.png>") });
    await expect(page.getByTestId("opencode-attachment-error")).toContainText("Use PNG, JPEG, GIF, or WebP");
  });

  test("disables send when empty", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-send")).toBeDisabled();
  });

  test("shows an actionable identity error when the server rejects a stale bounded client view", async ({ page }) => {
    await page.route("**/api/sessions/ses_mock_identity_mismatch/messages?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messages: [{ info: { id: "msg_client_build", role: "user", agent: "build" }, parts: [] }],
          running: false,
          nextCursor: null,
        }),
      });
    });
    await page.goto(`/sessions/ses_mock_identity_mismatch?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-composer").fill("do not silently switch agents");
    await expect(page.getByTestId("opencode-send")).toBeEnabled();
    await page.getByTestId("opencode-send").click();

    await expect(page.getByTestId("opencode-composer-error")).toContainText('uses OpenCode agent "explore"');
    await expect(page.getByTestId("opencode-composer-error")).toContainText("continue it in the TUI");
    await expect(page.getByTestId("opencode-composer-error")).not.toContainText("Could not send the prompt");
    await expect(page.getByTestId("opencode-composer")).toHaveValue("do not silently switch agents");
  });

  test("persists the selected mode from the latest message across reload", async ({ page }) => {
    const text = `follow-up plan ${Date.now()}`;
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-composer-mode")).toBeVisible();
    await page.getByTestId("opencode-composer-mode-plan").click();
    await page.getByTestId("opencode-composer").fill(text);
    await page.getByTestId("opencode-send").click();
    await expect.poll(() => promptPayload(text)).toMatchObject({ agent: "plan" });
    await page.reload();
    await expect(page.getByTestId("opencode-composer-mode-plan")).toHaveAttribute("aria-pressed", "true");
  });

  test("switches models once, persists the new current model, and omits unchanged overrides", async ({ page }) => {
    const initial = `model initial ${Date.now()}`;
    await page.goto(hub);
    await selectModel(page, "opencode-hub-model", "openai/gpt-5");
    await page.getByTestId("opencode-prompt").fill(initial);
    await page.getByTestId("opencode-start").click();
    await expect(page).toHaveURL(/\/sessions\/ses_mock_new_/);
    await expect.poll(() => promptPayload(initial)).toMatchObject({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
    });
    const picker = page.getByTestId("opencode-composer-model");
    await expect(picker).toHaveAttribute("value", "openai/gpt-5");
    await expect(page.getByTestId("opencode-current-model")).toBeHidden();

    const unchanged = `model unchanged ${Date.now()}`;
    await page.getByTestId("opencode-composer").fill(unchanged);
    await page.getByTestId("opencode-send").click();
    await expect.poll(() => promptPayload(unchanged)).not.toHaveProperty("model");

    const switched = `model switched ${Date.now()}`;
    await selectModel(page, "opencode-composer-model", "anthropic/claude-opus-5");
    await expect(page.getByTestId("opencode-current-model")).toContainText("switches next message");
    await page.getByTestId("opencode-composer").fill(switched);
    await page.getByTestId("opencode-send").click();
    await expect.poll(() => promptPayload(switched)).toMatchObject({
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    });
    await expect(page.getByTestId("opencode-current-model")).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("opencode-composer-model")).toHaveAttribute("value", "anthropic/claude-opus-5");
  });

  test("shows an image capability warning without changing Plan/Build", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-composer-mode-plan").click();
    await selectModel(page, "opencode-composer-model", "anthropic/claude-text");
    await expect(page.getByTestId("opencode-composer-mode-plan")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("opencode-attach").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") });
    await expect(page.getByTestId("opencode-model-image-warning")).toBeVisible();
  });

  test("keeps an unknown persisted model visible instead of silently replacing it", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_unknown_model?directory=${encodeURIComponent(DIR)}`);
    const picker = page.getByTestId("opencode-composer-model");
    await expect(picker).toHaveAttribute("value", "legacy/removed-model");
    await expect(picker).toContainText("unknown");
  });

  test("filters reminders by tag and by id, and clears back to the full list", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const picker = page.getByTestId("composer-reminder-select");
    await picker.click();
    const options = page.getByTestId("composer-reminder-option");
    await expect(options).toHaveCount(13);

    // Tags come from the reminder's Playbook skill; "worktrees" is on exactly
    // native-worktree-subagents and parallel-research-handoff.
    const worktrees = page.locator('[data-testid="composer-reminder-tag"][data-reminder-tag="worktrees"]');
    await expect(worktrees).toHaveAttribute("aria-pressed", "false");
    await worktrees.click();
    await expect(worktrees).toHaveAttribute("aria-pressed", "true");
    await expect(options).toHaveCount(2);
    await expect(page.locator('[data-testid="composer-reminder-option"][data-reminder-id="native-worktree-subagents"]')).toBeVisible();

    // Toggling the same tag off restores the full catalogue.
    await worktrees.click();
    await expect(options).toHaveCount(13);

    // Searching by id works even though no title contains the hyphenated form.
    await page.getByTestId("composer-reminder-search").fill("cite-file-lines");
    await expect(options).toHaveCount(1);
    await expect(page.getByTestId("composer-reminder-title")).toContainText("Cite File Lines");

    // Tag + text together are an AND, and an impossible pair shows the empty state.
    await page.getByTestId("composer-reminder-search").fill("grill");
    await page.locator('[data-testid="composer-reminder-tag"][data-reminder-tag="worktrees"]').click();
    await expect(options).toHaveCount(0);
    await expect(page.getByTestId("composer-reminder-empty")).toBeVisible();

    // Escape must still close the picker while a chip holds focus: the chip
    // guard covers activation keys only.
    await expect(page.locator('[data-testid="composer-reminder-tag"][data-reminder-tag="worktrees"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("composer-reminder-panel")).toHaveCount(0);
  });

  test("searches workflows and keeps the confirmation promise visible", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("composer-workflow-select").click();
    await expect(page.getByTestId("composer-workflow-search")).toBeFocused();
    await expect(page.getByTestId("composer-workflow-option")).toHaveCount(14);
    // Decision 21: this promise must survive the header gaining a search box.
    await expect(page.getByTestId("composer-workflow-panel")).toContainText("Nothing is sent or launched until you confirm.");

    // Search matters more now that the catalogue is 14 entries rather than six,
    // so the needle has to be specific: "PR review" alone also describes the
    // Playwright UI review workflow.
    await page.getByTestId("composer-workflow-search").fill("snippet-by-snippet");
    await expect(page.getByTestId("composer-workflow-option")).toHaveCount(1);
    await expect(page.getByTestId("composer-workflow-option")).toContainText("Post a snippet-by-snippet PR review");

    // Search covers title and id only. Matching descriptions was harmless at
    // six workflows and is not at 14: "review" used to surface "Send an update
    // to another session" and "Start a DCA session", whose descriptions say
    // "pre*view*" and "*review*ing" — tiles whose visible text does not contain
    // what was typed, which reads as a bug.
    //
    // Matching is still a plain substring, so "preview" genuinely does contain
    // "review" and "Choose, render, and preview documentation" is still a hit.
    // That is the property being locked in, not a leftover: every result now
    // contains the typed text in the title the tile actually shows, so the
    // result set is explicable from the screen. Neither of the two false hits
    // above is here.
    await page.getByTestId("composer-workflow-search").fill("review");
    const reviewHits = page.getByTestId("composer-workflow-option");
    await expect(reviewHits).toHaveCount(4);
    for (const text of await reviewHits.allInnerTexts()) expect(text.toLowerCase()).toContain("review");
    for (const id of ["session-update", "start-dca-session"]) {
      await expect(page.locator(`[data-testid="composer-workflow-option"][data-workflow-id="${id}"]`)).toHaveCount(0);
    }

    // A zero-match query must not divide by zero in the index math.
    await page.getByTestId("composer-workflow-search").fill("zzzz-no-such-workflow");
    await expect(page.getByTestId("composer-workflow-empty")).toBeVisible();
    await page.getByTestId("composer-workflow-search").press("ArrowDown");
    await page.getByTestId("composer-workflow-search").press("End");
    await expect(page.getByTestId("composer-workflow-panel")).toBeVisible();
  });

  test("round-trips two imported reminders by ID and resets the picker", async ({ page }) => {
    const sent: Array<Record<string, unknown>> = [];
    await page.route("**/api/reminders?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json() as { reminders: Array<{ id: string; title: string; description: string; triggers: string[]; tags: string[] }> };
      body.reminders.push({ id: "new-server-reminder", title: "New Server Reminder", description: "Exists only on a newer server.", triggers: [], tags: ["new"] });
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/sessions/*/prompt?*", async (route) => {
      sent.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const picker = page.getByTestId("composer-reminder-select");
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(page.getByTestId("composer-reminder-search")).toBeFocused();
    await expect(page.getByTestId("composer-reminder-group")).toHaveCount(7);
    await expect(page.getByTestId("composer-reminder-group").nth(0)).toHaveAccessibleName("Plan & Design");
    await expect(page.getByTestId("composer-reminder-option")).toHaveCount(14);
    await expect(page.getByTestId("composer-reminder-icon")).toHaveCount(14);
    const humanVerification = page.locator('[data-testid="composer-reminder-option"][data-reminder-id="human-verification-steps"]');
    await expect(humanVerification).toHaveAccessibleName("Attach Write Human Verification Steps");
    // Every reminder links to its OWN page. The old join pointed a reminder at
    // a workflow that merely shared its subject, so most tiles had no link at
    // all; parity means the link is now unconditional and always self-titled.
    const details = page.locator('[data-testid="composer-reminder-details"][data-reminder-id="human-verification-steps"]');
    await expect(details).toHaveAttribute("href", "/playbooks/reminders/human-verification-steps");
    await expect(details).toHaveAttribute("target", "_blank");
    await expect(details).toHaveAccessibleName("Open Write Human Verification Steps details in a new tab");
    // The details link is a real touch target in its own right (matching
    // this app's usual ~44px convention) but must still stay a minority of
    // the tile's width -- the button beside it is the large target, not this.
    const tile = page.locator('[data-testid="composer-reminder-tile"][data-reminder-id="human-verification-steps"]');
    const [detailsBox, tileBox] = await Promise.all([details.boundingBox(), tile.boundingBox()]);
    expect(detailsBox?.width, "details link is a real touch target").toBeGreaterThanOrEqual(40);
    expect(detailsBox?.height, "details link is a real touch target").toBeGreaterThanOrEqual(40);
    expect(detailsBox?.width, "the details link stays a minority of the tile, not the whole row").toBeLessThan((tileBox?.width ?? 0) / 2);
    const unknown = page.locator('[data-testid="composer-reminder-tile"][data-reminder-id="new-server-reminder"]');
    // A reminder this build has never heard of still gets a link. It used to
    // get none, because the target came from a hardcoded map — which meant a
    // newer server's reminder was the one thing on the page with no
    // documentation. The detail view resolves from the live catalogue, so the
    // link is real: it groups under "Other" and still renders.
    await expect(unknown.getByTestId("composer-reminder-details")).toHaveAttribute("href", "/playbooks/reminders/new-server-reminder");
    // cite-file-lines had no command and so never had a link; it has a page now
    // like every other reminder.
    await expect(page.locator('[data-testid="composer-reminder-tile"][data-reminder-id="cite-file-lines"]').getByTestId("composer-reminder-details")).toHaveAttribute("href", "/playbooks/reminders/cite-file-lines");
    await unknown.getByTestId("composer-reminder-option").click();
    await expect(picker).toHaveAttribute("value", "new-server-reminder");
    await picker.click();
    await page.getByTestId("composer-reminder-search").fill("Grill");
    await expect(page.getByTestId("composer-reminder-option")).toHaveCount(1);
    await expect(page.getByTestId("composer-reminder-title")).toContainText("Grill the Design");
    await page.getByTestId("composer-reminder-search").press("ArrowDown");
    await page.getByTestId("composer-reminder-search").press("Enter");
    await expect(picker).toHaveAttribute("value", "grill-me");
    await picker.click();
    await page.getByTestId("composer-reminder-option-none").click();
    await expect(picker).toHaveAttribute("value", "");
    await expect(picker).toBeFocused();

    const cases = [
      { id: "grill-me", text: `grill ${Date.now()}`, body: "Map the plan or design as a decision tree" },
      { id: "human-verification-steps", text: `manual QA ${Date.now()}`, body: "Run the repository's relevant automated checks" },
    ];
    for (const reminderCase of cases) {
      await picker.click();
      await page.locator(`[data-testid="composer-reminder-option"][data-reminder-id="${reminderCase.id}"]`).click();
      await expect(picker).toHaveAttribute("value", reminderCase.id);
      await page.getByTestId("opencode-composer").fill(reminderCase.text);
      await page.getByTestId("opencode-send").click();
      await expect(picker).toHaveAttribute("value", "");

      const user = page.getByTestId("opencode-user-message").filter({ hasText: reminderCase.text });
      await expect(user).toBeVisible();
      await expect(user.getByTestId("opencode-user-message-body")).toHaveText(reminderCase.text);
      const reminder = user.getByTestId("opencode-manual-reminder");
      await expect(reminder).toHaveAttribute("open", "");
      await expect(reminder).toContainText(reminderCase.id);
      await expect(reminder).toContainText(reminderCase.body);
      await expect(user).not.toContainText("<reminder");
    }

    expect(sent).toHaveLength(2);
    expect(sent.map(({ reminder }) => reminder)).toEqual(cases.map(({ id }) => id));
    for (const payload of sent) {
      expect(Object.keys(payload).sort()).toEqual(["mode", "reminder", "text"]);
      expect(payload).not.toHaveProperty("reminderBody");
      expect(JSON.stringify(payload)).not.toContain("source_commit");
    }
  });
});

test.describe("mobile", () => {
  // Mobile over Tailscale is a first-class surface, not an afterthought.
  test.use({ viewport: { width: 390, height: 740 }, hasTouch: true });

  test.beforeEach(async () => {
    await fetch(`${MOCK_URL}/test/mobile/reset`, { method: "POST" });
  });

  test("hub is usable on a phone", async ({ page }) => {
    await page.goto(hub);
    // The project picker and the sessions list are both collapsed by default;
    // their toggles are what should be reachable without scrolling on a
    // phone, not the (hidden) lists inside them.
    await expect(page.getByTestId("opencode-project-picker-toggle")).toBeVisible();
    await expect(page.getByTestId("opencode-sessions-picker-toggle")).toBeVisible();
    await expect(page.getByTestId("opencode-hub-mode")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "no horizontal scroll on a phone").toBeLessThanOrEqual(1);
  });

  test("transcript is the only scrolling region", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const transcript = page.getByTestId("opencode-transcript");
    await expect(transcript).toBeVisible();
    await expect(page.getByTestId("opencode-composer-mode")).toBeVisible();
    const autoPermissions = page.getByTestId("opencode-mobile-auto-permissions-toggle");
    await expect(autoPermissions).toHaveAttribute("aria-checked", "false");
    expect((await autoPermissions.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const containment = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
    }));
    expect(containment.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(containment.bodyOverscroll).toBe("none");
    expect(containment.documentScrollTop).toBe(0);
    expect(await transcript.evaluate((element) => getComputedStyle(element).overscrollBehaviorY)).toBe("contain");
  });

  test("gives the composer useful typing space and keeps controls reachable", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");
    const reminder = page.getByTestId("composer-reminder-select");
    const [composerBox, reminderBox, attachBox, sendBox] = await Promise.all([
      composer.boundingBox(),
      reminder.boundingBox(),
      page.getByTestId("opencode-attach-label").boundingBox(),
      page.getByTestId("opencode-send").boundingBox(),
    ]);
    expect(composerBox?.width).toBeGreaterThan((reminderBox?.width ?? 0) * 2);
    expect(composerBox?.height).toBeGreaterThanOrEqual(96);
    expect(attachBox?.height).toBeGreaterThanOrEqual(44);
    expect(sendBox?.height).toBeGreaterThanOrEqual(44);
    await expect(composer).toHaveAttribute("enterkeyhint", "enter");
    await expect(composer).toHaveAttribute("autocapitalize", "none");
    await reminder.click();
    const panel = page.getByTestId("composer-reminder-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("composer-reminder-option").first()).toHaveAccessibleName("Attach Grill the Design");
    await expect(page.getByTestId("composer-reminder-title").first()).toContainText("Grill the Design");
    const firstGrid = page.getByTestId("composer-reminder-group").first().locator("div.grid");
    expect(await firstGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
    const firstTile = page.getByTestId("composer-reminder-tile").first();
    const tileBox = await firstTile.boundingBox();
    expect(tileBox?.width).toBeGreaterThan((tileBox?.height ?? 0) * 2);
    const panelBox = await panel.boundingBox();
    expect(panelBox?.width).toBeLessThanOrEqual(390);
    expect(panelBox?.height).toBeLessThanOrEqual(740);
    await page.getByTestId("composer-reminder-close").click();
    await expect(reminder).toBeFocused();
  });

  test("collapses the composer without losing its draft", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");
    await composer.fill("unfinished mobile thought");
    const expandedHeight = (await page.getByTestId("opencode-conversation").locator("footer").boundingBox())?.height ?? 0;
    await page.getByTestId("opencode-composer-collapse").click();
    await expect(composer).toBeHidden();
    const collapsedHeight = (await page.getByTestId("opencode-conversation").locator("footer").boundingBox())?.height ?? 0;
    expect(collapsedHeight).toBeLessThan(expandedHeight / 2);
    await page.getByTestId("opencode-composer-expand").click();
    await expect(composer).toHaveValue("unfinished mobile thought");
    await expect(composer).toBeFocused();
  });

  // The Enter-vs-newline decision itself is covered in tests/composer-keys.test.ts:
  // Playwright launches Chromium with a browser-level primaryPointerType of
  // "fine", so `hasTouch` does not move `(pointer: coarse)` and this suite
  // cannot faithfully emulate the soft-keyboard branch.
  test("submits with Cmd/Ctrl+Enter regardless of pointer type", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const composer = page.getByTestId("opencode-composer");
    await composer.click();
    await composer.type("send from a phone");
    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveValue("");
  });

  test("contains hostile markdown width inside local code and table scrollers", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const transcript = page.getByTestId("opencode-transcript");
    await expect(transcript.getByText("Mobile width containment fixture.")).toBeVisible();
    const containment = await transcript.evaluate((element) => {
      const code = element.querySelector(".prose-markdown pre") as HTMLElement;
      const table = element.querySelector(".prose-markdown table") as HTMLElement;
      const prose = element.querySelector(".prose-markdown") as HTMLElement;
      return {
        transcriptOverflow: element.scrollWidth - element.clientWidth,
        proseOverflow: prose.scrollWidth - prose.clientWidth,
        codeScrollsLocally: code.scrollWidth > code.clientWidth,
        tableScrollsLocally: table.scrollWidth > table.clientWidth,
      };
    });
    expect(containment.transcriptOverflow).toBeLessThanOrEqual(1);
    expect(containment.proseOverflow).toBeLessThanOrEqual(1);
    expect(containment.codeScrollsLocally).toBe(true);
    expect(containment.tableScrollsLocally).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  // The mode rail adds a border and horizontal padding inside the prose
  // column, which is exactly the kind of change that reintroduces a document
  // scrollbar on a phone.
  test("contains a mode-marked assistant row at 390px", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_modes?directory=${encodeURIComponent(DIR)}`);
    const transcript = page.getByTestId("opencode-transcript");
    await expect(transcript.getByText("Containment fixture for a mode-marked row.")).toBeVisible();
    const marked = page.locator('[data-testid="opencode-agent-message"][data-mode="build"]').last();
    const containment = await marked.evaluate((element) => {
      const body = element.querySelector('[data-testid="opencode-agent-message-body"]') as HTMLElement;
      const code = element.querySelector(".prose-markdown pre") as HTMLElement;
      return {
        rowOverflow: element.scrollWidth - element.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        codeScrollsLocally: code.scrollWidth > code.clientWidth,
      };
    });
    expect(containment.rowOverflow).toBeLessThanOrEqual(1);
    expect(containment.bodyOverflow).toBeLessThanOrEqual(1);
    expect(containment.codeScrollsLocally).toBe(true);
    expect(await transcript.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("does not yank a scrolled-up reader and offers jump to latest for a growing live row", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const transcript = page.getByTestId("opencode-transcript");
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await transcript.evaluate((element) => {
      element.scrollTop = 240;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const before = await transcript.evaluate((element) => element.scrollTop);

    await fetch(`${MOCK_URL}/test/mobile/grow`, { method: "POST" });
    await expect(transcript.getByText("New live activity from the running agent.")).toBeAttached();
    await expect(page.getByTestId("opencode-jump-to-latest")).toBeVisible();
    expect(await transcript.evaluate((element) => element.scrollTop)).toBeCloseTo(before, 0);

    await page.getByTestId("opencode-jump-to-latest").click();
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("opencode-jump-to-latest")).toHaveCount(0);
  });

  test("does not show Jump to latest merely because a scrolled-up run goes idle", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    const transcript = page.getByTestId("opencode-transcript");
    await expect(page.getByText("running", { exact: true })).toBeVisible();
    await transcript.evaluate((element) => {
      element.scrollTop = 240;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(page.getByTestId("opencode-jump-to-latest")).toHaveCount(0);

    await fetch(`${MOCK_URL}/test/mobile/idle`, { method: "POST" });
    await expect(page.getByText("running", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("opencode-jump-to-latest")).toHaveCount(0);
  });

  test("stacks the Changes rail above the diff at phone width", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_mobile?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-mobile-workspace-open").click();
    await page.getByTestId("opencode-workspace-changes").click();
    const rail = page.getByTestId("opencode-changes-rail");
    const diff = page.getByTestId("opencode-diff-viewer");
    await expect(rail).toBeVisible();
    const [railBox, diffBox] = await Promise.all([rail.boundingBox(), diff.boundingBox()]);
    expect(diffBox?.y).toBeGreaterThanOrEqual((railBox?.y ?? 0) + (railBox?.height ?? 0) - 1);
    expect(railBox?.width).toBeCloseTo(diffBox?.width ?? 0, 0);
  });

  test("splits mobile reviews and catalog from the run log sheet", async ({ page }) => {
    await fetch(`${MOCK_URL}/test/catalog-requests`, { method: "POST" });
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-mobile-runlog-open").click();
    const sheet = page.getByTestId("opencode-mobile-inspector");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("opencode-command-list")).toBeVisible();
    await expect(sheet.getByTestId("opencode-inspector-reviews")).toHaveCount(0);
    await expect(sheet.getByTestId("opencode-inspector-catalog")).toHaveCount(0);
    await sheet.getByTestId("opencode-inspector-todo").click();
    await expect(sheet.getByTestId("opencode-todo-list")).toBeVisible();
    await sheet.getByTestId("opencode-mobile-inspector-close").click();

    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(sheet.getByTestId("opencode-merge-request-list")).toBeVisible();
    expect(await (await fetch(`${MOCK_URL}/test/catalog-requests`)).json()).toEqual({ count: 0 });
    await sheet.getByTestId("opencode-mobile-inspector-close").click();

    await page.getByTestId("opencode-mobile-session-menu-trigger").click();
    await page.getByTestId("opencode-mobile-catalog-open").click();
    await expect(sheet.getByTestId("opencode-catalog-mcp")).toContainText(/\d connected \/ 5 total/);
    await expect(sheet.getByTestId("opencode-catalog-mcp")).toContainText("needs client registration");
    await expect(sheet.getByTestId("opencode-catalog-skills")).toContainText("browser-check");
    await expect(sheet.getByTestId("opencode-catalog-commands")).toContainText("/verify");
    expect(await (await fetch(`${MOCK_URL}/test/catalog-requests`)).json()).toEqual({ count: 2 });
    await sheet.getByTestId("opencode-catalog-refresh").click();
    await expect.poll(async () => await (await fetch(`${MOCK_URL}/test/catalog-requests`)).json()).toEqual({ count: 4 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await sheet.getByTestId("opencode-mobile-inspector-close").click();
    await expect(sheet).toHaveCount(0);
    await page.getByTestId("opencode-mobile-runlog-open").click();
    await expect(sheet).toBeVisible();
    expect(await (await fetch(`${MOCK_URL}/test/catalog-requests`)).json()).toEqual({ count: 4 });
    await page.goBack();
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("question remote control", () => {
  test.beforeEach(async () => {
    await fetch(`${MOCK_URL}/test/questions/reset?scope=ui`, { method: "POST" });
  });

  test("renders every question and submits answers in order", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const request = page.getByTestId("opencode-question-request");
    await expect(request).toContainText("Where should this ship?");
    await expect(request).toContainText("Which checks should run?");
    await request.getByTestId("opencode-question-option").nth(0).check();
    await request.getByTestId("opencode-question-option").nth(2).check();
    await request.getByTestId("opencode-question-option").nth(3).check();
    await request.getByTestId("opencode-question-submit").click();
    await expect.poll(async () => {
      const replies = await (await fetch(`${MOCK_URL}/test/question-replies?id=que_mock`)).json() as unknown[];
      return replies;
    }).toEqual([{ id: "que_mock", answers: [["Staging"], ["Unit", "E2E"]] }]);
  });

  test("submits a custom multi-select answer", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    const request = page.getByTestId("opencode-question-request");
    await request.getByTestId("opencode-question-option").nth(0).check();
    await request.getByTestId("opencode-question-option").nth(2).check();
    await request.getByTestId("opencode-question-custom").fill("Lint");
    await request.getByTestId("opencode-question-submit").click();
    await expect.poll(async () => await (await fetch(`${MOCK_URL}/test/question-replies?id=que_mock`)).json()).toEqual([
      { id: "que_mock", answers: [["Staging"], ["Unit", "Lint"]] },
    ]);
  });

  // #508: two questions with several options overflow the banners wrapper's
  // 25% height cap, and the Submit/Reject bar used to sit below its fold. It
  // must be visible before any scrolling — toBeInViewport() intersects through
  // scrollable ancestors, so a button clipped behind the wrapper fails here even
  // though a click() would have auto-scrolled to it.
  test("keeps Submit and Reject visible without scrolling at both viewports", async ({ page }) => {
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 740 }]) {
      await page.setViewportSize(size);
      await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
      const request = page.getByTestId("opencode-question-request");
      await expect(request).toContainText("Which checks should run?");
      await expect(page.getByTestId("opencode-question-submit")).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId("opencode-question-reject")).toBeInViewport({ ratio: 1 });
    }
  });

  test("rejects a question", async ({ page }) => {
    await page.goto(`/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-question-reject").click();
    await expect.poll(async () => await (await fetch(`${MOCK_URL}/test/question-replies?id=que_mock`)).json()).toEqual([
      { id: "que_mock", rejected: true },
    ]);
  });
});

test.describe("settings and tools UI", () => {
  test("shows inherited defaults without turning them into overrides", async ({ page }) => {
    // The API tier mutates the mock's process-global config in parallel. This
    // assertion is specifically about the all-inherited response, so pin that
    // response at the browser boundary instead of depending on test order.
    await page.route("**/api/settings", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: {} }),
    }));
    await page.goto("/settings");
    await expect(page.getByTestId("opencode-setting-subagent-depth")).toHaveAttribute("readonly", "");
    await expect(page.getByTestId("opencode-setting-subagent-depth")).toHaveValue("1 (OpenCode default)");
    await expect(page.getByTestId("opencode-compaction-auto")).toHaveValue("default");
    await expect(page.getByTestId("opencode-compaction-auto").locator("option:checked")).toHaveText("Default (on)");
    await expect(page.getByTestId("opencode-compaction-prune").locator("option:checked")).toHaveText("Default (off)");
    await expect(page.getByTestId("opencode-compaction-reserved")).toHaveValue("");
  });

  test("edits compaction settings", async ({ page }) => {
    await page.goto("/settings");
    await page.getByTestId("opencode-setting-model").fill("anthropic/claude-opus-5");
    await page.getByTestId("opencode-compaction-auto").selectOption("on");
    await page.getByTestId("opencode-compaction-reserved").fill("4096");
    await page.getByTestId("opencode-settings-save").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  });

  test("shows MCP failures, LSP status and permissions", async ({ page }) => {
    await page.goto(`/tools?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-mcp-row").filter({ hasText: "docs" })).toContainText(/connected|mock connection refused/);
    await expect(page.getByTestId("opencode-lsp-status")).toContainText("typescript");
    await expect(page.getByTestId("opencode-effective-permissions")).toContainText("allow");
  });

  test("keeps browser and ntfy event toggles independent", async ({ page }) => {
    // Delivery preferences live beside history, so the inbox and the controls
    // deciding what reaches it stay in one place.
    await page.goto("/settings/notifications");
    const browser = page.getByTestId("opencode-notify-browser-idle");
    const ntfy = page.getByTestId("opencode-notify-ntfy-idle");
    const ntfyBefore = await ntfy.isChecked();
    await browser.click();
    expect(await ntfy.isChecked()).toBe(ntfyBefore);
  });

  test("explains the delivery matrix in plain language instead of wire values", async ({ page }) => {
    await page.goto("/settings/notifications");
    const events = page.getByTestId("opencode-notification-events");
    await expect(events).toBeVisible();

    // Grouped by what the event means for you. `idle` sits with the asks
    // because a finished turn is still the ball in your court.
    const waiting = page.getByTestId("opencode-notify-group-waiting");
    for (const label of [
      "Needs your permission",
      "Asked you a question",
      "Still waiting for permission",
      "Finished its turn",
    ]) {
      await expect(waiting).toContainText(label);
    }
    await expect(page.getByTestId("opencode-notify-group-failed")).toContainText("Run failed");
    await expect(page.getByTestId("opencode-notify-group-expected")).toContainText("You stopped it");

    // The row checkbox sits in a different cell from its label, so it carries
    // its own accessible name.
    await expect(page.getByTestId("opencode-notify-ntfy-parked"))
      .toHaveAttribute("aria-label", "Still waiting for permission via ntfy");

    // A ticked box that never fires is only explicable if the two suppressed
    // categories are named next to it.
    const never = page.getByTestId("opencode-notify-never-delivered");
    await expect(never).toContainText("Sub-agent activity");
    await expect(never).toContainText("Auto permissions");
  });

  test("restores the recommended profile in one click", async ({ page }) => {
    await page.goto("/settings/notifications");
    const abort = page.getByTestId("opencode-notify-browser-abort");
    const permission = page.getByTestId("opencode-notify-browser-permission");
    await abort.setChecked(true);
    await permission.setChecked(false);

    await page.getByTestId("opencode-notify-reset-recommended").click();

    // Everything that is waiting on you, plus failures; nothing you caused.
    for (const event of ["permission", "question", "parked", "idle", "error"]) {
      await expect(page.getByTestId(`opencode-notify-browser-${event}`)).toBeChecked();
      await expect(page.getByTestId(`opencode-notify-ntfy-${event}`)).toBeChecked();
    }
    await expect(abort).not.toBeChecked();
    await expect(page.getByTestId("opencode-notify-ntfy-abort")).not.toBeChecked();
  });

  test("badges unresolved notifications until the user checks them off", async ({ page }) => {
    const requestID = `perm_badge_${Date.now()}`;
    await fetch(`${MOCK_URL}/test/permission?directory=${encodeURIComponent(DIR)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: requestID, sessionID: "ses_mock_done", permission: "bash", patterns: ["npm test"] }),
    });

    await page.goto("/settings/notifications");
    // Grouping ships on and folded, so the rows sit behind their session
    // header. Opening them writes the persisted default, which is what keeps
    // them open across the reloads below.
    await page.getByTestId("opencode-notification-groups-expand-all").click();
    const badge = page.getByTestId("opencode-nav-notifications-badge");
    const bell = page.getByTestId("opencode-nav-notifications");
    // The exact count lives on the bell's accessible label, which is the real
    // contract; the pill is aria-hidden and caps at "99+", so it is only ever
    // asserted for presence, never parsed.
    const unresolvedCount = async () =>
      Number(/(\d+) unresolved/.exec(await bell.getAttribute("aria-label") ?? "")?.[1] ?? 0);
    await expect(badge).toBeVisible();
    await expect(bell).toHaveAttribute("aria-label", /unresolved/);
    await page.setViewportSize({ width: 390, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);

    const row = page.getByTestId("opencode-notification-record").filter({ hasText: "Needs approval to run bash" }).first();
    await expect(row).toHaveAttribute("data-active", "true");
    await expect(row).toContainText("ntfy off");

    // A pressed-state button, not a checkbox: the row's one action deserves a
    // real target.
    const resolved = row.getByTestId("opencode-notification-resolved");
    await expect(resolved).toHaveAttribute("aria-pressed", "false");
    // Icon-only, so the state lives in aria-pressed and the name in aria-label
    // rather than in visible text.
    await expect(resolved).toHaveAttribute("aria-label", "Resolve");
    const countBefore = await unresolvedCount();
    await resolved.click();
    if (countBefore > 1) {
      await expect(bell).toHaveAttribute("aria-label", `Notifications, ${countBefore - 1} unresolved`);
      await expect(badge).toBeVisible();
    } else {
      await expect(bell).toHaveAttribute("aria-label", "Notifications");
      await expect(badge).toBeHidden();
    }

    await page.reload();
    await expect(row.getByTestId("opencode-notification-resolved")).toHaveAttribute("aria-pressed", "true");
    // Still reversible, per decision 10.
    await row.getByTestId("opencode-notification-resolved").click();
    await expect(bell).toHaveAttribute("aria-label", `Notifications, ${countBefore} unresolved`);
    await expect(badge).toBeVisible();
    await row.getByTestId("opencode-notification-resolved").click();

    await fetch(`${MOCK_URL}/test/permissions/reset?directory=${encodeURIComponent(DIR)}`, { method: "POST" });
  });
});

test.describe("engineering docs UI", () => {
  test("opens the architecture guide from the visual docs center", async ({ page }) => {
    await page.goto(`/docs?directory=${encodeURIComponent(DIR)}`);
    await expect(page.getByTestId("opencode-docs")).toContainText("One server, every project");
    await page.getByTestId("opencode-docs-open-architecture").click();
    await expect(page).toHaveURL(new RegExp(`/docs/architecture\\?directory=${encodeURIComponent(DIR)}`));
    await expect(page.getByTestId("opencode-doc")).toContainText("Conversation lifecycle");
    await expect(page.getByTestId("opencode-doc-source")).toContainText("docs/architecture.md");
  });

  test("opens the pull request preview diagrams and BFF stub contract", async ({ page }) => {
    await page.goto(`/docs?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-doc-card-pr-previews").click();
    await expect(page).toHaveURL(new RegExp(`/docs/pr-previews\\?directory=${encodeURIComponent(DIR)}`));
    await expect(page.getByTestId("opencode-doc")).toContainText("Per-commit deployment flow");
    await expect(page.getByTestId("opencode-doc")).toContainText("Stubbed endpoint families");
    await expect(page.getByTestId("opencode-doc-source")).toContainText("docs/pr-previews.md");
  });

  test("opens the sub-agent guide and its retained-agent capability matrix", async ({ page }) => {
    await page.goto(`/docs?directory=${encodeURIComponent(DIR)}`);
    await page.getByTestId("opencode-doc-card-subagents").click();
    await expect(page).toHaveURL(new RegExp(`/docs/subagents\\?directory=${encodeURIComponent(DIR)}`));
    await expect(page.getByTestId("opencode-doc-source")).toContainText("docs/subagents.md");
    const doc = page.getByTestId("opencode-doc");
    await expect(doc).toContainText("Retained agents and the capability matrix");
    for (const agent of ["plan", "build", "explore", "general"]) {
      await expect(doc.locator("table").filter({ hasText: "Access class" }).locator("td code", { hasText: agent }).first()).toBeVisible();
    }
  });

  test("renders an unknown document state", async ({ page }) => {
    await page.goto("/docs/not-in-the-catalogue");
    await expect(page.getByTestId("opencode-doc")).toContainText("not in the in-app catalogue");
  });

  test("fits the docs center without horizontal overflow at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto("/docs");
    await expect(page.getByTestId("opencode-docs")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("workspace UI", () => {
  const conversation = `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`;

  test("opens files, changes, commands and preview", async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) => route.fulfill({ json: { requests: [] } }));
    await page.route("**/api/sessions/ses_mock_done/questions?**", (route) => route.fulfill({ json: { requests: [] } }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-session-inspector")).toBeVisible();
    await expect(page.getByTestId("opencode-mobile-inspector-open")).toBeHidden();
    await page.getByTestId("opencode-inspector-runlog").click();
    await expect(page.getByTestId("opencode-command-row")).toHaveCount(4);
    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(page.getByTestId("opencode-review-card")).toContainText("Mock pull request");
    await expect(page.getByTestId("opencode-review-card")).toContainText("checks passed");
    await page.getByTestId("opencode-review-details-toggle").click();
    // The PR body no longer renders; the commits section is what the expanded
    // details lead with, so assert the panel opened on that instead.
    await expect(page.getByTestId("opencode-review-details")).toContainText("Commits (1)");
    await expect(page.getByTestId("opencode-review-details")).not.toContainText("Ready to ship.");
    await expect(page.getByTestId("opencode-review-comment")).toContainText("Looks good.");
    const failed = page.getByTestId("opencode-review-check").filter({ hasText: "test" });
    await expect(failed).toHaveAttribute("data-status", "failed");
    await expect(failed.getByRole("link")).toHaveAttribute("rel", "noreferrer");
    const commit = page.getByTestId("opencode-review-commit").first();
    await expect(commit).toContainText("Add the mock route");
    await expect(commit).not.toContainText("Longer body text");
    await expect(commit.getByRole("link")).toHaveAttribute("href", "https://github.com/acme/demo/commit/abc123def4567890abc123def4567890abc12345");
    await expect(commit.getByRole("link")).toHaveAttribute("rel", "noreferrer");
    await page.getByTestId("opencode-desktop-inspector-close").click();
    await page.getByTestId("opencode-mobile-workspace-open").click();
    await page.getByTestId("opencode-tree-file").filter({ hasText: "README.md" }).click();
    await expect(page.getByTestId("opencode-code-viewer")).toContainText("Mock project");
    await page.getByTestId("opencode-workspace-changes").click();
    await expect(page.getByTestId("opencode-diff-viewer")).toContainText("+new");
    await page.getByTestId("opencode-workspace-preview").click();
    await expect(page.getByTestId("opencode-preview-frame")).toBeVisible();
  });

  test("indexes every session link into groups behind a counted badge", async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) => route.fulfill({ json: { requests: [] } }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-session-inspector")).toBeVisible();

    // 4 unique links live in the fixture transcript: one PR, one issue,
    // one Notion page, and one plain documentation URL.
    await expect(page.getByTestId("opencode-mobile-reviews-count")).toHaveText("4");
    await expect(page.getByTestId("opencode-mobile-reviews-open")).toHaveAttribute("aria-label", "Open reviews, 4 links");

    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(page.getByTestId("opencode-link-group-reviews")).toContainText("Mock pull request");
    await expect(page.getByTestId("opencode-link-group-issues")).toContainText("acme/demo#12");
    await expect(page.getByTestId("opencode-link-group-notion")).toContainText("Route Spec");

    // The groups a reader came for open themselves; the leftover bucket folds,
    // and its count is what stands in for the rows until it is opened.
    await expect(page.getByTestId("opencode-link-group-issues")).toHaveAttribute("data-expanded", "true");
    await expect(page.getByTestId("opencode-link-group-notion")).toHaveAttribute("data-expanded", "true");
    const other = page.getByTestId("opencode-link-group-other");
    await expect(other).toHaveAttribute("data-expanded", "false");
    await expect(other).not.toContainText("example.invalid");
    await other.getByTestId("opencode-link-group-toggle").click();
    await expect(other).toHaveAttribute("data-expanded", "true");
    await expect(other).toContainText("example.invalid");

    const issue = page.getByTestId("opencode-session-link").filter({ hasText: "acme/demo#12" });
    await expect(issue).toHaveAttribute("data-kind", "issue");
    await expect(issue.getByRole("link")).toHaveAttribute("href", "https://github.com/acme/demo/issues/12");
    await expect(issue.getByRole("link")).toHaveAttribute("rel", "noreferrer");
  });

  test("folds an expanded link group away on demand", async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) => route.fulfill({ json: { requests: [] } }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await expect(page.getByTestId("opencode-session-inspector")).toBeVisible();
    await page.getByTestId("opencode-mobile-reviews-open").click();

    const issues = page.getByTestId("opencode-link-group-issues");
    const issueRow = page.getByTestId("opencode-session-link").filter({ hasText: "acme/demo#12" });
    await expect(issues).toHaveAttribute("data-expanded", "true");
    await expect(issueRow).toHaveCount(1);

    // Collapsing has to remove the rows, not just restyle the header: a group
    // that reports itself folded while still rendering its links would make the
    // fold state a lie and defeat the point of folding the long buckets.
    const toggle = issues.getByTestId("opencode-link-group-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(issues).toHaveAttribute("data-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(issueRow).toHaveCount(0);
    // The header keeps carrying the count while folded.
    await expect(issues).toContainText("GitHub issues");

    await toggle.click();
    await expect(issues).toHaveAttribute("data-expanded", "true");
    await expect(issueRow).toHaveCount(1);
  });

  test("fetches expensive review details only after expansion", async ({ page }) => {
    await fetch(`${FORGE_URL}/test/forge-reset`, { method: "POST" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(page.getByTestId("opencode-review-card")).toContainText("Mock pull request");
    expect(await (await fetch(`${FORGE_URL}/test/forge-state`)).json()).toMatchObject({ detailRequests: 0 });
    await page.getByTestId("opencode-review-details-toggle").click();
    await expect(page.getByTestId("opencode-review-check")).toBeVisible();
    expect(await (await fetch(`${FORGE_URL}/test/forge-state`)).json()).toMatchObject({ detailRequests: 5 });
  });

  test("keeps merge confirmation bound to the reviewed SHA", async ({ page }) => {
    await fetch(`${FORGE_URL}/test/forge-reset`, { method: "POST" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(page.getByTestId("opencode-merge-review")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("opencode-merge-review").dispatchEvent("click");
    await expect(page.getByTestId("opencode-review-card")).toHaveAttribute("data-state", "merged");
    await expect.poll(async () => (await (await fetch(`${FORGE_URL}/test/forge-state`)).json()).mergeBody).toEqual({ sha: "abc123" });
  });

  test("review card remains width-safe in a mobile cockpit host", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-reviews-open").click();
    await expect(page.getByTestId("opencode-review-card")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 740 });
    const cardWidth = await page.getByTestId("opencode-review-card").evaluate((element) => element.getBoundingClientRect().width);
    expect(cardWidth).toBeLessThanOrEqual(390);
    const overflow = await page.getByTestId("opencode-review-card").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("workspace drawer fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(conversation);
    await page.getByTestId("opencode-mobile-workspace-open").click();
    await expect(page.getByTestId("opencode-workspace-panels")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
