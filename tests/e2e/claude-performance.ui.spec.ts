import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fixture, metrics, open, prose } from "./claude-performance-fixture.js";

test.use({ channel: process.env.CLAUDE_PERF_CHROME ? "chrome" : undefined });

test("real API bounds initial data and unchanged refreshes perform no transcript commit", async ({ page }) => {
  const server = await fixture();
  try {
    const session = server.create(true);
    const payloads = await open(page, server, session.id);
    await page.waitForTimeout(500);
    const before = await metrics(page);
    server.store.emit("update", session.id);
    await expect.poll(() => payloads.length).toBeGreaterThan(1);
    await page.waitForTimeout(400);
    expect((await metrics(page)).commits).toBe(before.commits);
    expect(payloads.at(-1)).toMatchObject({ count: 0, delta: true });
    expect(payloads.at(-1)!.bytes).toBeLessThan(2_000);
    expect(payloads[0].count).toBe(50);
    expect(payloads[0].bytes).toBeLessThan(150_000);
    session.events.push(prose(260)); server.store.emit("update", session.id);
    await expect(page.locator('[data-transcript-item="row-260"]')).toBeInViewport();
    expect(payloads.at(-1)).toMatchObject({ count: 1, delta: true });
    expect((await metrics(page)).rows).toBeLessThan(30);
  } finally { await page.close(); await server.close(); }
});

test("loading and evicting history preserves the visible anchor and supports forward navigation", async ({ page }) => {
  const server = await fixture();
  try {
    const session = server.create(); await open(page, server, session.id);
    const scroller = page.getByTestId("claude-transcript");
    for (let i = 0; i < 4; i++) {
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      await page.waitForTimeout(150);
      const anchor = await page.locator("[data-transcript-item]").evaluateAll((elements) => {
        const container = document.querySelector('[data-testid="claude-transcript"]')!.getBoundingClientRect();
        const row = elements.find((element) => element.getBoundingClientRect().bottom > container.top)!;
        return { id: row.getAttribute("data-transcript-item"), top: row.getBoundingClientRect().top };
      });
      await page.getByTestId("claude-load-earlier").click();
      await expect(page.getByTestId("claude-load-earlier")).toBeEnabled();
      await expect.poll(async () => Math.abs((await page.locator(`[data-transcript-item="${anchor.id}"]`).boundingBox())!.y - anchor.top)).toBeLessThan(4);
      expect((await metrics(page)).resident).toBeLessThanOrEqual(150);
      expect((await metrics(page)).rows).toBeLessThan(30);
    }
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await page.getByTestId("claude-load-newer").click();
    await page.getByTestId("claude-jump-to-latest").click();
    await expect(page.getByTestId("claude-history-controls")).toHaveAttribute("data-resident-events", "50");
    await expect(page.locator('[data-transcript-item="row-259"]')).toBeInViewport();
  } finally { await page.close(); await server.close(); }
});

test("hidden tabs close transcript SSE and issue no fetches until one bounded catch-up", async ({ page }) => {
  const server = await fixture();
  try {
    const session = server.create(true); const payloads = await open(page, server, session.id);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => server.store.listenerCount("update")).toBe(0);
    const before = payloads.length;
    session.events.push(prose(260)); server.store.emit("update", session.id);
    await page.waitForTimeout(3_500);
    expect(payloads).toHaveLength(before);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect(page.locator('[data-transcript-item="row-260"]')).toBeInViewport();
    expect(payloads).toHaveLength(before + 1);
    expect(payloads.at(-1)).toMatchObject({ count: 1, delta: true });
  } finally { await page.close(); await server.close(); }
});

test("search, references, run log and export reach history outside resident pages", async ({ page }) => {
  const server = await fixture();
  try {
    const session = server.create(); await open(page, server, session.id);
    await page.getByTestId("claude-transcript").evaluate((element) => { element.scrollTop = 0; });
    await page.getByTestId("claude-search-history").click();
    await page.getByTestId("claude-history-query").fill("Ancient reference");
    await page.getByTestId("claude-history-search").click();
    await expect(page.getByTestId("claude-history-results")).toContainText("Ancient reference");
    await expect(page.getByTestId("claude-history-results").getByRole("button", { name: /src\/old.ts/ })).toBeVisible();
    await page.getByTestId("claude-history-close").click();
    await page.getByTestId("claude-open-runlog").click();
    await page.getByTestId("claude-history-query").fill("Historical command 2");
    await page.getByTestId("claude-history-search").click();
    await expect(page.getByTestId("claude-history-results")).toContainText("Historical command 2");
    await page.getByTestId("claude-history-close").click();
    await page.getByTestId("claude-session-menu-trigger").click();
    await page.getByTestId("claude-open-export").click();
    const downloading = page.waitForEvent("download"); await page.getByTestId("claude-export-json").click();
    const body = await readFile((await (await downloading).path())!, "utf8");
    expect(body).toContain("Ancient reference"); expect(body).not.toContain("echo historical");
    expect(JSON.parse(body).entries.length).toBeGreaterThan(200);
    expect((await metrics(page)).resident).toBe(50);
  } finally { await page.close(); await server.close(); }
});

test("two simultaneous pages stay responsive during active updates (measured soak)", async ({ browser }) => {
  const duration = Number(process.env.CLAUDE_PERF_SOAK_MS || 15_000);
  test.setTimeout(duration + 90_000);
  const server = await fixture();
  const context = await browser.newContext();
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  const latencies: number[] = [];
  try {
    const sessions = [server.create(true), server.create()];
    const payloads = await Promise.all(pages.map((page, i) => open(page, server, sessions[i].id)));
    await Promise.all(pages.map((page) => page.evaluate(() => { (window as any).longTasks = []; })));
    const started = Date.now();
    let sequence = 260;
    while (Date.now() - started < duration) {
      sessions[0].events.push(prose(sequence++)); server.store.emit("update", sessions[0].id);
      for (const page of pages) {
        const begin = Date.now();
        await page.bringToFront();
        await page.getByTestId("claude-prompt").fill(`Responsiveness probe ${sequence}`, { timeout: 1_000 });
        await expect(page.getByTestId("claude-prompt")).toHaveValue(`Responsiveness probe ${sequence}`, { timeout: 1_000 });
        latencies.push(Date.now() - begin);
        const sample = await metrics(page);
        expect(sample.resident).toBeLessThanOrEqual(150);
        expect(sample.pages).toBeLessThanOrEqual(3);
        expect(sample.rows).toBeLessThan(30);
        expect(sample.reconcileMs).toBeLessThan(50);
      }
      await pages[0].waitForTimeout(2_000);
    }
    const samples = await Promise.all(pages.map(metrics));
    const evidence = { browser: browser.version(), durationMs: Date.now() - started, samples: latencies.length, maxInteractionMs: Math.max(...latencies), maxLongTaskMs: Math.max(0, ...samples.flatMap((sample) => sample.longTasks)), maxPayloadBytes: Math.max(...payloads.flat().map((payload) => payload.bytes)), maxDeltaBytes: Math.max(...payloads.flat().filter((payload) => payload.delta).map((payload) => payload.bytes)), final: samples };
    await test.info().attach("claude-two-tab-performance.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    expect(evidence.maxInteractionMs).toBeLessThan(500);
    expect(evidence.maxLongTaskMs).toBeLessThan(200);
    expect(evidence.maxPayloadBytes).toBeLessThan(150_000);
    expect(evidence.maxDeltaBytes).toBeLessThan(16_000);
  } finally { await context.close(); await server.close(); }
});
