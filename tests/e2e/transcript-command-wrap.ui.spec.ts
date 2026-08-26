import { expect, test, type Locator } from "@playwright/test";

// Issue #159: a long terminal command in a transcript action header used to be
// clipped with a CSS ellipsis, so the interesting tail of the command — the very
// thing you open a transcript to read — was unreachable without expanding a row
// that shows output, not input.
//
// This file stubs its OWN messages payload with `page.route` rather than adding
// a fixture to tests/e2e/mock-opencode.ts. Playwright runs spec files in
// parallel against one mock and one BFF, so a per-page route mutates nothing
// another file can observe (see tests/e2e-shared-state-ownership.test.ts). It
// also lets this file pin the exact geometry it asserts on.

const DIR = process.platform === "darwin" ? "/private/tmp/mock-project" : "/tmp/mock-project";
const conversation = `/sessions/ses_mock_done?directory=${encodeURIComponent(DIR)}`;

/** 136 characters: long enough to need several lines, under toolDetail's 160 cap. */
const LONG_COMMAND =
  "npm test -- --reporter=verbose --coverage --coverage.reporter=text-summary --coverage.include='client/**' --coverage.exclude='**/*.d.ts'";
const LONG_OUTPUT = "Statements 94.21% | Branches 88.04% | Functions 91.30%";
const SHORT_COMMAND = "git status";

/**
 * Count the line boxes a wrapped span occupies.
 *
 * A flex item is blockified, so `getClientRects()` on the element itself always
 * returns one rect however many lines it renders. A Range over its contents
 * reports one rect per line fragment, which is the thing under test.
 */
function lineCount(span: Locator): Promise<number> {
  return span.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length;
  });
}

test.describe("transcript terminal command wrapping", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/permission-requests?**", (route) => route.fulfill({ json: { requests: [] } }));
    await page.route("**/api/sessions/ses_mock_done/questions?**", (route) => route.fulfill({ json: { requests: [] } }));
    // Two completed bash calls separated by prose: consecutive successful calls
    // collapse into one "N actions completed" group (client/lib/derive.ts), and
    // this file needs both headers rendered directly.
    await page.route("**/api/sessions/ses_mock_done/messages?**", (route) => route.fulfill({
      json: {
        messages: [
          {
            info: { id: "msg_wrap_user", role: "user", agent: "build", time: { created: 1787100000000 } },
            parts: [{ id: "prt_wrap_prompt", messageID: "msg_wrap_user", type: "text", text: "Run the coverage suite" }],
          },
          {
            info: {
              id: "msg_wrap_agent",
              role: "assistant",
              parentID: "msg_wrap_user",
              mode: "build",
              time: { created: 1787100001000, completed: 1787100009000 },
            },
            parts: [
              { id: "prt_wrap_prose_a", messageID: "msg_wrap_agent", type: "text", text: "Running the suite with coverage." },
              {
                id: "prt_wrap_long",
                messageID: "msg_wrap_agent",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: LONG_COMMAND, timeout: 120000 },
                  output: LONG_OUTPUT,
                  metadata: {},
                  time: { start: 1787100002000, end: 1787100006500 },
                },
              },
              { id: "prt_wrap_prose_b", messageID: "msg_wrap_agent", type: "text", text: "Then a quick status check." },
              {
                id: "prt_wrap_short",
                messageID: "msg_wrap_agent",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: SHORT_COMMAND },
                  output: "nothing to commit, working tree clean",
                  metadata: {},
                  time: { start: 1787100007000, end: 1787100007300 },
                },
              },
            ],
          },
        ],
        nextCursor: null,
      },
    }));
  });

  test("wraps a long command in full, keeps duration, and still hides output until expanded", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);

    const row = page.locator('[data-event-id="prt_wrap_long"]');
    const detail = row.getByTestId("opencode-tool-detail");
    await expect(detail).toBeVisible();

    // Every character is in the DOM, and nothing was ellipsized — by the adapter
    // (toolDetail's 160 cap) or by CSS.
    await expect(detail).toHaveText(LONG_COMMAND);
    expect(await detail.textContent()).not.toContain("…");
    const overflow = await detail.evaluate((element) => ({
      clipped: element.scrollWidth - element.clientWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
      textOverflow: getComputedStyle(element).textOverflow,
    }));
    expect(overflow.clipped).toBeLessThanOrEqual(1);
    expect(overflow.whiteSpace).not.toBe("nowrap");
    expect(overflow.textOverflow).toBe("clip");

    // The header is now taller than one line, which is the actual fix.
    expect(await lineCount(detail)).toBeGreaterThan(1);

    // Duration survives the wrap and stays on the header's first line.
    const duration = row.getByTestId("opencode-tool-duration");
    await expect(duration).toBeVisible();
    await expect(duration).toHaveText("4.5s");
    const geometry = await row.evaluate((element) => {
      const toggle = element.querySelector<HTMLElement>('[data-testid="opencode-tool-toggle"]')!;
      const durationEl = element.querySelector<HTMLElement>('[data-testid="opencode-tool-duration"]')!;
      const detailEl = element.querySelector<HTMLElement>('[data-testid="opencode-tool-detail"]')!;
      return {
        headerHeight: toggle.getBoundingClientRect().height,
        detailHeight: detailEl.getBoundingClientRect().height,
        durationTop: durationEl.getBoundingClientRect().top,
        detailTop: detailEl.getBoundingClientRect().top,
        durationLines: durationEl.getClientRects().length,
      };
    });
    expect(geometry.headerHeight).toBeGreaterThan(geometry.detailHeight / 2);
    expect(geometry.durationLines).toBe(1);
    // Baseline alignment: the duration sits beside the command's FIRST line, not
    // pushed down beside its last one.
    expect(Math.abs(geometry.durationTop - geometry.detailTop)).toBeLessThanOrEqual(6);

    // Expanding is unchanged: output is hidden until the disclosure is used.
    await expect(row).not.toContainText(LONG_OUTPUT);
    const toggle = row.getByTestId("opencode-tool-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(row).toContainText(LONG_OUTPUT);
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(row).not.toContainText(LONG_OUTPUT);
  });

  test("leaves a short command on a single line", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(conversation);

    const short = page.locator('[data-event-id="prt_wrap_short"]').getByTestId("opencode-tool-detail");
    await expect(short).toHaveText(SHORT_COMMAND);
    expect(await lineCount(short)).toBe(1);

    const long = page.locator('[data-event-id="prt_wrap_long"]').getByTestId("opencode-tool-detail");
    const heights = await Promise.all([
      short.evaluate((element) => element.getBoundingClientRect().height),
      long.evaluate((element) => element.getBoundingClientRect().height),
    ]);
    expect(heights[1]).toBeGreaterThan(heights[0]);
  });

  test("reads the whole command on a phone without a horizontal scrollbar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(conversation);

    const row = page.locator('[data-event-id="prt_wrap_long"]');
    const detail = row.getByTestId("opencode-tool-detail");
    await expect(detail).toHaveText(LONG_COMMAND);
    expect(await lineCount(detail)).toBeGreaterThan(1);
    await expect(row.getByTestId("opencode-tool-duration")).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    expect(await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
});
