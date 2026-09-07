import { expect, test } from "@playwright/test";
import type { ResourceSnapshot } from "../../server/resource-types.js";

const snapshot: ResourceSnapshot = {
  sampledAt: "2026-09-07T12:00:00Z", available: true,
  host: { cpuPercent: 24, cores: 8, usedMemoryBytes: 10 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 },
  total: { cpuPercent: 142, memoryBytes: 640 * 1024 ** 2, processCount: 2, warmingCount: 0 },
  processes: [
    { pid: 102, parentPid: 101, label: "Claude", cpuPercent: 140, memoryBytes: 512 * 1024 ** 2 },
    { pid: 101, parentPid: 1, label: "DCA server", cpuPercent: 2, memoryBytes: 128 * 1024 ** 2 },
  ], truncated: false, opencode: "remote",
};

for (const width of [390, 1280]) {
  test(`resource breakdown, keyboard dismissal and sizing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.route("**/api/observability/resources", (route) => route.fulfill({ json: snapshot }));
    await page.goto("/sessions/ses_mock_done?directory=/tmp/mock-project");
    const trigger = page.getByTestId("resource-trigger");
    await expect(trigger).toContainText("CPU 142.0% · 640 MB");
    await trigger.click();
    const panel = page.getByTestId("resource-dialog");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Browser tabs on this device are not included");
    await expect(panel).toContainText("Remote OpenCode usage cannot be measured here");
    await expect(page.getByTestId("resource-total")).toContainText("142.0%");
    await expect(page.getByTestId("resource-host")).toContainText("24.0%");
    await expect(page.getByTestId("resource-processes")).toContainText("Claude");
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await test.info().attach(`resources-${width}`, { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

test("hidden tabs stop resource requests and refresh when visible again", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/observability/resources", (route) => { requests++; return route.fulfill({ json: snapshot }); });
  await page.goto("/sessions/ses_mock_done?directory=/tmp/mock-project");
  await expect(page.getByTestId("resource-trigger")).toContainText("640 MB");
  await page.clock.install();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const before = requests;
  await page.clock.runFor(20_000);
  expect(requests).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests).toBe(before + 1);
});

test("unavailable samples never look like zero usage and recover on a later poll", async ({ page }) => {
  let unavailable = true;
  await page.route("**/api/observability/resources", (route) => unavailable
    ? route.fulfill({ status: 503, json: { error: "offline" } }) : route.fulfill({ json: snapshot }));
  await page.goto("/sessions/ses_mock_done?directory=/tmp/mock-project");
  await expect(page.getByTestId("resource-trigger")).toContainText("unavailable");
  await page.getByTestId("resource-trigger").click();
  await expect(page.getByTestId("resource-unavailable")).toContainText("Retrying automatically");
  unavailable = false;
  await expect(page.getByTestId("resource-total")).toContainText("640 MB", { timeout: 10_000 });
});

test("real resource endpoint is private and does not expose command paths", async ({ request }) => {
  const response = await request.get("/api/observability/resources?pid=1&command=secret");
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const body = await response.json() as ResourceSnapshot;
  expect(body.available).toBe(true);
  expect(body.processes.some((row) => row.label === "DCA server")).toBe(true);
  for (const row of body.processes) {
    expect(Object.keys(row).sort()).toEqual(["cpuPercent", "label", "memoryBytes", "parentPid", "pid"]);
    expect(row.label).not.toContain("/");
  }
});

test("Claude places Resources beside its usage meter and labels its running child", async ({ page, request }) => {
  await page.route("**/api/claude/usage", (route) => route.fulfill({ json: {
    available: true, session: { utilization: 48, resetsAt: null }, weekly: { utilization: 20, resetsAt: null },
    weeklyByModel: {}, subscriptionType: null, rateLimitTier: null,
  } }));
  await page.goto("/claude");
  await page.getByTestId("claude-create").click();
  const resource = page.getByTestId("resource-trigger");
  const usage = page.getByTestId("claude-usage-trigger");
  await expect(resource).toBeVisible();
  await expect(usage).toContainText("48%");
  const usageBox = (await usage.boundingBox())!;
  const resourceBox = (await resource.boundingBox())!;
  expect(resourceBox.x).toBeGreaterThan(usageBox.x);
  expect(Math.abs((usageBox.y + usageBox.height / 2) - (resourceBox.y + resourceBox.height / 2))).toBeLessThan(3);
  await test.info().attach("claude-header-resources", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByTestId("claude-prompt").fill("stay running until cancelled");
  await page.getByTestId("claude-send").click();
  await expect(page.getByTestId("claude-cancel")).toBeVisible();
  try {
    await expect.poll(async () => {
      const response = await request.get("/api/observability/resources");
      const sample = await response.json() as ResourceSnapshot;
      return sample.processes.map((row) => row.label);
    }, { timeout: 15_000 }).toContain("Claude");
  } finally {
    await page.getByTestId("claude-cancel").click();
  }
});
