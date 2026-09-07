import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { TranscriptEvent } from "../../client/lib/transcript.js";

// All state is owned by this page's routes, never by a shared BFF fixture.
const ID = "claude-performance";
const prose = (index: number): TranscriptEvent => ({
  id: `row-${index}`, messageId: `message-${index}`, timestamp: "2026-09-07T12:00:00Z",
  kind: "agent", text: `Activity ${index}\n\n${"Long transcript content. ".repeat(25)}`,
});

async function fixture(page: Page, running = false) {
  let events: TranscriptEvent[] = Array.from({ length: 232 }, (_, i) => prose(i));
  let requests = 0;
  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends EventTarget {
      constructor(url: string | URL) {
        super();
        if (!String(url).includes("/api/claude/events")) return new NativeEventSource(url);
        sources.push(this);
      }
      close() {}
    } as typeof EventSource;
    Object.assign(window, {
      performanceNudge: () => sources.forEach((source) => source.dispatchEvent(new Event("update"))),
      performanceVisibility: (hidden: boolean) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    });
    // Observe React's actual memo boundary, not just DOM mutations (React can
    // spend time rerendering unchanged markdown without mutating any DOM).
    let previous: unknown;
    Object.assign(window, { transcriptCommits: 0, transcriptIdentityChanges: 0 });
    Object.assign(window, { __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: (_id: number, root: any) => {
        const walk = (fiber: any) => {
          if (!fiber) return;
          if (fiber.memoizedProps?.collapseCompletedByDefault && Array.isArray(fiber.memoizedProps?.items)) {
            const state = window as any;
            if (fiber.flags & 1) state.transcriptCommits++;
            if (previous !== fiber.memoizedProps.items) state.transcriptIdentityChanges++;
            previous = fiber.memoizedProps.items;
          }
          walk(fiber.child); walk(fiber.sibling);
        };
        walk(root.current);
      },
      onCommitFiberUnmount: () => {},
    } });
  });
  await page.route(`**/api/claude/sessions/${ID}`, (route) => {
    requests++;
    return route.fulfill({ json: { session: {
      id: ID, title: "Long conversation", mode: "plan", presetId: "e2e-plan", workspaceId: "e2e",
      createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z", running,
    }, events } });
  });
  await page.goto(`/claude/sessions/${ID}`);
  await expect(page.locator("[data-transcript-item]")).toHaveCount(50);
  return {
    requests: () => requests,
    append: () => { events = [...events, prose(events.length)]; },
    replace: (next: TranscriptEvent[]) => { events = next; },
  };
}

const nudge = (page: Page) => page.evaluate(() => (window as any).performanceNudge());
const visibility = (page: Page, hidden: boolean) => page.evaluate((value) => (window as any).performanceVisibility(value), hidden);

test("unchanged active polls and SSE preserve the transcript render boundary", async ({ page }) => {
  const state = await fixture(page, true);
  await expect(page.locator('[data-transcript-item="row-231"]')).toBeVisible();
  const before = await page.evaluate(() => ({ commits: (window as any).transcriptCommits, identities: (window as any).transcriptIdentityChanges }));
  expect(before.identities).toBeGreaterThan(0);
  const requests = state.requests();
  await nudge(page);
  await expect.poll(state.requests).toBeGreaterThan(requests);
  await expect.poll(state.requests, { timeout: 10_000 }).toBeGreaterThan(requests + 1);
  expect(await page.evaluate(() => ({ commits: (window as any).transcriptCommits, identities: (window as any).transcriptIdentityChanges }))).toEqual(before);
});

test("loads history with a stable anchor and retains it when new activity arrives", async ({ page }) => {
  const state = await fixture(page);
  const scroller = page.getByTestId("claude-transcript");
  await scroller.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await test.info().attach("claude-transcript-window", { body: await page.screenshot(), contentType: "image/png" });
  const anchor = page.locator('[data-transcript-item="row-182"]');
  const top = (await anchor.boundingBox())!.y;
  await page.getByTestId("claude-load-earlier").click();
  await expect(page.locator("[data-transcript-item]")).toHaveCount(100);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(3);
  state.append();
  await nudge(page);
  await expect(page.locator("[data-transcript-item]")).toHaveCount(101);
  await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - top)).toBeLessThan(3);
  await page.getByTestId("claude-jump-to-latest").click();
  await expect(page.locator("[data-transcript-item]")).toHaveCount(50);
  await expect(page.locator('[data-transcript-item="row-232"]')).toBeInViewport();
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.getByTestId("claude-show-all").click();
  await expect(page.locator("[data-transcript-item]")).toHaveCount(233);
  await expect(page.locator('[data-transcript-item="row-0"]')).toBeAttached();
});

test("hidden tabs ignore SSE and polls and catch up once visible", async ({ page }) => {
  const state = await fixture(page, true);
  await visibility(page, true);
  const before = state.requests();
  state.append();
  await nudge(page);
  await page.waitForTimeout(3_500);
  expect(state.requests()).toBe(before);
  await expect(page.locator('[data-transcript-item="row-232"]')).toHaveCount(0);
  await visibility(page, false);
  await expect(page.locator('[data-transcript-item="row-232"]')).toBeAttached();
  expect(state.requests()).toBe(before + 1);
});

test("completed groups collapse while running and failed tools stay visible", async ({ page }) => {
  const state = await fixture(page);
  const tool = (id: string, status: "completed" | "running" | "error"): TranscriptEvent => ({
    id, messageId: id, timestamp: "2026-09-07T12:00:00Z", kind: "tool", name: "bash", status,
    title: id, attachments: [], output: "finished", error: status === "error" ? "Tool failed" : undefined,
  });
  state.replace([prose(0), tool("done-1", "completed"), tool("done-2", "completed"), tool("active", "running"), tool("failed", "error")]);
  await nudge(page);
  const toggle = page.getByTestId("opencode-action-group-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("opencode-tool")).toHaveCount(2);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("opencode-tool")).toHaveCount(4);
});

test("idle polling slows down but retains a durable fallback", async ({ page }) => {
  const state = await fixture(page);
  await page.clock.install();
  const before = state.requests();
  await page.clock.runFor(6_000);
  expect(state.requests()).toBe(before);
  state.append();
  await page.clock.runFor(30_000);
  await expect(page.locator('[data-transcript-item="row-232"]')).toBeAttached();
  await expect(page.locator("[data-transcript-item]")).toHaveCount(50);
});

test("export, reference discovery and run log include history outside the window", async ({ page }) => {
  const state = await fixture(page);
  let paths: string[] = [];
  await page.route(`**/api/claude/sessions/${ID}/references`, (route) => {
    paths = route.request().postDataJSON().paths;
    return route.fulfill({ json: { references: [] } });
  });
  state.replace([
    { ...prose(0), text: "Review `src/old.ts:12`" },
    { id: "old-tool", messageId: "old-tool", timestamp: "2026-09-07T12:00:00Z", kind: "tool", name: "bash", status: "completed", title: "Historical command", commandText: "echo historical", attachments: [] },
    ...Array.from({ length: 232 }, (_, i) => prose(i + 1)),
  ]);
  await nudge(page);
  await expect.poll(() => paths).toContain("src/old.ts");
  await expect(page.locator('[data-transcript-item="row-0"]')).toHaveCount(0);
  await page.getByTestId("claude-open-runlog").click();
  await expect(page.getByTestId("opencode-runlog-timeline")).toContainText("Historical command");
  await page.getByTestId("claude-session-menu-trigger").click();
  await page.getByTestId("claude-open-export").click();
  const downloading = page.waitForEvent("download");
  await page.getByTestId("claude-export-json").click();
  const download = await downloading;
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain("src/old.ts:12");
  expect(JSON.parse(exported).entries).toHaveLength(234);
  expect(JSON.parse(exported).entries).toContainEqual(expect.objectContaining({ type: "tool", label: "bash", status: "completed" }));
  expect(exported).not.toContain("echo historical");
  expect(exported).toContain("Activity 232");
});
