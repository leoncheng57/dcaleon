import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { Response } from "express";
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
    const first = response();
    await manager.attachStream("ses_browser_lifecycle", first);
    const second = response();
    await manager.attachStream("ses_browser_lifecycle", second, "coarse");
    first.emit("close"); // delayed old-response cleanup must not detach replacement
    expect(manager.slots()[0].streaming).toBe(true);
    second.destroy();
    await expect.poll(() => manager.slots()[0].streaming).toBe(false);
    const state = await manager.open("ses_browser_lifecycle");
    expect(state.url).toBe("about:blank");
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
