import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { Response } from "express";
import type { Page } from "playwright-core";
import { BrowserManager, CapacityError } from "../../server/browser/manager.js";
import { bindBrowserSessionLifecycle } from "../../server/browser/lifecycle.js";

// Own Chromium/profile; no shared mock state or external network is used.
test("real Chromium preserves pages, enforces concurrent cap, detaches and relaunches its profile", async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "dcaleon-browser-lifecycle-"));
  const config = { enabled: true, maxPages: 1, idleMinutes: 1 };
  let manager = new BrowserManager(config, profile);
  const response = () => {
    const stream = new PassThrough();
    stream.resume();
    return Object.assign(stream, { writeHead: () => stream }) as unknown as Response;
  };
  try {
    const results = await Promise.allSettled([manager.open("ses_browser_lifecycle"), manager.open("ses_browser_other")]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(CapacityError) });
    expect(manager.slots()).toHaveLength(1);
    // Test-only page interception proves actual rendered frames without external traffic.
    const page = (manager as unknown as { pages: Map<string, { page: Page }> }).pages.get("ses_browser_lifecycle")!.page;
    await page.route("http://203.0.113.1/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>First navigation is visible</h1>" }));
    const first = response();
    let firstBytes = 0;
    const firstFrames: Buffer[] = [];
    first.on("data", (chunk: Buffer) => {
      firstBytes += chunk.length;
      if (chunk[0] === 0xff && chunk[1] === 0xd8) firstFrames.push(chunk);
    });
    await manager.attachStream("ses_browser_lifecycle", first);
    await expect.poll(() => firstFrames.length).toBeGreaterThan(0);
    const blankBytes = firstBytes;
    const blankFrame = firstFrames[0];
    await manager.navigate("ses_browser_lifecycle", { action: "goto", url: "http://203.0.113.1/first" });
    await expect.poll(() => firstBytes).toBeGreaterThan(blankBytes);
    await expect.poll(() => firstFrames.some((frame) => !frame.equals(blankFrame))).toBe(true);
    const second = response();
    let secondBytes = 0;
    let secondFrames = 0;
    second.on("data", (chunk: Buffer) => {
      secondBytes += chunk.length;
      if (chunk[0] === 0xff && chunk[1] === 0xd8) secondFrames++;
    });
    await manager.attachStream("ses_browser_lifecycle", second, "coarse");
    first.emit("close"); // delayed old-response cleanup must not detach replacement
    expect(manager.slots()[0].streaming).toBe(true);
    await expect.poll(() => secondFrames).toBeGreaterThan(0);
    const replacementBytes = secondBytes;
    await page.evaluate(() => { document.body.textContent = "Final static repaint must not be dropped"; });
    await expect.poll(() => secondBytes).toBeGreaterThan(replacementBytes);
    second.destroy();
    await expect.poll(() => manager.slots()[0].streaming).toBe(false);
    const state = await manager.open("ses_browser_lifecycle");
    expect(state.url).toBe("http://203.0.113.1/first");
    expect(manager.slots()).toHaveLength(1);
    await manager.input("ses_browser_lifecycle", { type: "viewport", width: 390, height: 600 });
    const bus = new EventEmitter();
    const unbind = bindBrowserSessionLifecycle(bus, manager);
    bus.emit("event", { type: "session.deleted", properties: { info: { id: "ses_browser_lifecycle" } } });
    await expect.poll(() => manager.slots().length).toBe(0);
    unbind();
    await manager.shutdown();
    manager = new BrowserManager(config, profile);
    await expect(manager.open("ses_browser_restart")).resolves.toMatchObject({ url: "about:blank" });
  } finally {
    await manager.shutdown();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a real image decoder displays the first static navigation without reopening", async ({ page: viewer }) => {
  const profile = await mkdtemp(path.join(tmpdir(), "dcaleon-browser-decode-"));
  const manager = new BrowserManager({ enabled: true, maxPages: 1, idleMinutes: 1 }, profile);
  const server = createServer((request, response) => {
    if (request.url === "/stream") {
      void manager.attachStream("ses_browser_decode", response as unknown as Response).catch(() => response.destroy());
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end('<img id="stream" src="/stream" alt="Test browser stream">');
    }
  });
  try {
    await manager.open("ses_browser_decode");
    const page = (manager as unknown as { pages: Map<string, { page: Page }> }).pages.get("ses_browser_decode")!.page;
    await page.route("http://203.0.113.1/**", (route) => route.fulfill({ contentType: "text/html", body: '<body style="margin:0;background:rgb(220,30,30)"><h1>Visible first navigation</h1></body>' }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener unavailable");
    await viewer.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => viewer.locator("#stream").evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await manager.navigate("ses_browser_decode", { action: "goto", url: "http://203.0.113.1/static" });
    await expect.poll(() => viewer.locator("#stream").evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(element as HTMLImageElement, -100, -100);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      return red > 180 && green < 60 && blue < 60;
    })).toBe(true);
  } finally {
    await viewer.close();
    await manager.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});
