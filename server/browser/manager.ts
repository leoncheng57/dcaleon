// server/browser/manager.ts — one Chromium, one Page per conversation session.
//
// Lifecycle contract (design doc "Live Browser and Right Tools Panel — 2026-09-07"):
//   - Chromium launches lazily on first open, never at BFF boot.
//   - One shared persistent context (shared cookie jar — deliberate trade so
//     logged-in browsing works across sessions), one Page per sessionID.
//   - Hard cap on live pages. At the cap, opening REFUSES and names the
//     sessions holding slots; it never evicts, because eviction would reload
//     work sitting in another conversation.
//   - A page not being streamed is frozen (timers halted, renderer
//     reclaimable); an idle reaper closes pages after BROWSER_IDLE_MINUTES.
//     Cookies survive reaping in the persistent profile.
//   - Popups/new tabs are intercepted, never honoured: the URL is surfaced to
//     the client so the panel can ask "open here or in a new tab?".

import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import { assessTarget, assessWebSocketTarget, type LiveBrowserConfig } from "./policy.js";
import {
  BROWSER_VIEWPORT,
  CapacityError,
  NavigationRefused,
  UnknownSessionError,
  validSessionID,
  type BrowserSlot,
  type BrowserStreamProfile,
  type BrowserViewport,
  type LiveBrowserInputEvent,
} from "./errors.js";
import { assertPrivateBrowserProfile } from "./profile.js";

const DEFAULT_VIEWPORT: BrowserViewport = {
  width: BROWSER_VIEWPORT.defaultWidth,
  height: BROWSER_VIEWPORT.defaultHeight,
};

export const DEFAULT_BROWSER_URL = "https://leoncheng.dev";

export function screencastOptions(profile: BrowserStreamProfile): {
  format: "jpeg";
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
} {
  return profile === "coarse"
    ? { format: "jpeg", quality: 42, maxWidth: BROWSER_VIEWPORT.maxWidth, maxHeight: BROWSER_VIEWPORT.maxHeight, everyNthFrame: 1 }
    : { format: "jpeg", quality: 68, maxWidth: BROWSER_VIEWPORT.maxWidth, maxHeight: BROWSER_VIEWPORT.maxHeight, everyNthFrame: 1 };
}

export const streamFrameInterval = (profile: BrowserStreamProfile): number => profile === "coarse" ? 150 : 50;

export interface PageState {
  sessionID: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Set when the page tried to open a new tab; cleared once read. */
  pendingPopup: string | null;
}

interface Managed {
  page: Page;
  cdp: CDPSession;
  lastUsedAt: number;
  loading: boolean;
  pendingPopup: string | null;
  viewport: BrowserViewport;
  streamOperation: Promise<void>;
  stream: { res: NodeJS.WritableStream & { destroyed?: boolean }; boundary: string } | null;
}

export class BrowserManager {
  private readonly config: LiveBrowserConfig;
  private readonly profileDir: string;
  private readonly defaultUrl: string | null;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private readonly pages = new Map<string, Managed>();
  private opening: Promise<unknown> = Promise.resolve();
  private readonly reaper: NodeJS.Timeout;

  // Internal callers may disable the homepage for offline transport fixtures;
  // browser requests cannot change this default or bypass navigation policy.
  constructor(config: LiveBrowserConfig, profileDir: string, defaultUrl: string | null = DEFAULT_BROWSER_URL) {
    this.config = config;
    this.profileDir = profileDir;
    this.defaultUrl = defaultUrl;
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  private async contextOrLaunch(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.launching ??= (async () => {
      // 0700: the profile is a credential store an unauthenticated BFF can
      // drive; it must not be readable by other local users.
      mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
      assertPrivateBrowserProfile(this.profileDir);
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: true,
        viewport: DEFAULT_VIEWPORT,
        acceptDownloads: false,
        serviceWorkers: "block",
        args: [
          "--disable-background-networking",
          "--disable-domain-reliability",
          "--disable-features=PreconnectToSearch",
          "--dns-prefetch-disable",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
        ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {}),
      });
      // The SSRF boundary, applied to every request the browser makes —
      // navigation and subresource alike — so a redirect or an <img> cannot
      // widen what the address bar allows.
      await context.route("**/*", async (route) => {
        const verdict = await assessTarget(route.request().url());
        if (verdict.ok) await route.continue().catch(() => undefined);
        else await route.abort("blockedbyclient").catch(() => undefined);
      });
      // WebSocket upgrades bypass HTTP request routing. Playwright holds the
      // socket closed until this policy explicitly connects it to the server.
      await context.routeWebSocket(/.*/, async (socket) => {
        const verdict = await assessWebSocketTarget(socket.url());
        if (verdict.ok) socket.connectToServer();
        else await socket.close({ code: 1008, reason: "private or local WebSocket blocked" });
      });
      // Persistent contexts may create a startup tab; it owns no session slot.
      await Promise.all(context.pages().map((page) => page.close()));
      context.on("close", () => {
        this.context = null;
        this.launching = null;
        this.pages.clear();
      });
      this.context = context;
      return context;
    })().catch((error: unknown) => {
      this.launching = null;
      throw error;
    });
    return this.launching;
  }

  /** Create or reattach the page for a session. Throws CapacityError at the cap. */
  async open(sessionID: string, initialUrl?: string): Promise<PageState> {
    const result = this.opening.then(() => this.openPage(sessionID, initialUrl));
    this.opening = result.catch(() => undefined);
    return result;
  }

  private async openPage(sessionID: string, initialUrl?: string): Promise<PageState> {
    const existing = this.pages.get(sessionID);
    if (existing) {
      existing.lastUsedAt = Date.now();
      if (initialUrl) await this.navigate(sessionID, { action: "goto", url: initialUrl });
      return this.state(sessionID);
    }
    if (this.pages.size >= this.config.maxPages) {
      throw new CapacityError(this.config.maxPages, this.slots());
    }
    const context = await this.contextOrLaunch();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const managed: Managed = {
      page,
      cdp,
      lastUsedAt: Date.now(),
      loading: false,
      pendingPopup: null,
      viewport: { ...DEFAULT_VIEWPORT },
      streamOperation: Promise.resolve(),
      stream: null,
    };
    this.pages.set(sessionID, managed);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true }).catch(() => undefined);

    page.on("popup", (popup) => {
      // Intercepted, not honoured: a session owns exactly one page. The URL
      // is parked for the panel's "open here or in a new tab?" prompt.
      void (async () => {
        await popup.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
        const url = popup.url();
        if (url && (await assessTarget(url)).ok) managed.pendingPopup = url;
        await popup.close().catch(() => undefined);
      })();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) managed.loading = false;
    });
    page.on("close", () => {
      this.endStream(managed);
      this.pages.delete(sessionID);
    });

    const destination = initialUrl ?? this.defaultUrl;
    if (destination) await this.navigate(sessionID, { action: "goto", url: destination });
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    return this.state(sessionID);
  }

  async state(sessionID: string): Promise<PageState> {
    const managed = this.require(sessionID);
    const history = await managed.cdp
      .send("Page.getNavigationHistory")
      .catch(() => ({ currentIndex: 0, entries: [] as unknown[] }));
    const pendingPopup = managed.pendingPopup;
    managed.pendingPopup = null;
    return {
      sessionID,
      url: managed.page.url(),
      title: await managed.page.title().catch(() => ""),
      canGoBack: history.currentIndex > 0,
      canGoForward: history.currentIndex < history.entries.length - 1,
      loading: managed.loading,
      pendingPopup,
    };
  }

  async navigate(
    sessionID: string,
    request: { action: "goto"; url: string } | { action: "back" | "forward" | "reload" },
  ): Promise<PageState> {
    const managed = this.require(sessionID);
    managed.lastUsedAt = Date.now();
    if (request.action === "goto") {
      // Bare hostnames are a UX affordance of the address bar, not of the policy.
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(request.url) ? request.url : `https://${request.url}`;
      const verdict = await assessTarget(candidate);
      if (!verdict.ok) throw new NavigationRefused(verdict.reason);
      managed.loading = true;
      try {
        await managed.page.goto(verdict.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      } finally { managed.loading = false; }
    } else if (request.action === "back") {
      await managed.page.goBack({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } else if (request.action === "forward") {
      await managed.page.goForward({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } else {
      await managed.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    }
    return this.state(sessionID);
  }

  async input(sessionID: string, event: LiveBrowserInputEvent): Promise<void> {
    const managed = this.require(sessionID);
    managed.lastUsedAt = Date.now();
    const { page } = managed;
    switch (event.type) {
      case "click":
        await page.mouse.click(clamp(event.x, managed.viewport.width), clamp(event.y, managed.viewport.height), {
          button: event.button === "right" ? "right" : "left",
        });
        break;
      case "move":
        await page.mouse.move(clamp(event.x, managed.viewport.width), clamp(event.y, managed.viewport.height));
        break;
      case "scroll":
        await page.mouse.move(clamp(event.x, managed.viewport.width), clamp(event.y, managed.viewport.height));
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, event.deltaY)));
        break;
      case "key":
        // Playwright validates key names; an unknown name throws rather than injects.
        await page.keyboard.press(event.key.slice(0, 32));
        break;
      case "type":
        await page.keyboard.type(event.text.slice(0, 1024));
        break;
      case "viewport":
        managed.viewport = { width: event.width, height: event.height };
        await page.setViewportSize(managed.viewport);
        break;
      case "touch":
        await managed.cdp.send("Input.dispatchTouchEvent", {
          type: event.phase === "start"
            ? "touchStart"
            : event.phase === "move"
              ? "touchMove"
              : event.phase === "end"
                ? "touchEnd"
                : "touchCancel",
          touchPoints: event.points.map((point) => ({
            x: clamp(point.x, managed.viewport.width),
            y: clamp(point.y, managed.viewport.height),
            id: point.id,
          })),
        });
        break;
    }
  }

  /**
   * Attach an MJPEG stream. Only the streamed page is "visible": everything
   * else stays frozen, which is what makes a cap of 10 defensible.
   */
  async attachStream(
    sessionID: string,
    res: import("express").Response,
    profile: BrowserStreamProfile = "default",
  ): Promise<void> {
    const managed = this.require(sessionID);
    this.endStream(managed);
    managed.lastUsedAt = Date.now();
    const boundary = "opencode-live-browser-frame";
    res.writeHead(200, {
      "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    managed.stream = { res, boundary };
    res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`);

    let pendingFrame: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFrameAt = 0;
    const flushFrame = () => {
      flushTimer = undefined;
      if (managed.stream?.res !== res || res.destroyed || pendingFrame === null) return;
      const image = Buffer.from(pendingFrame, "base64");
      pendingFrame = null;
      res.write(image);
      // Complete the next part's headers now: native image decoders can wait
      // for them before painting, otherwise static pages stay one frame behind.
      res.write(`\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`);
      lastFrameAt = managed.lastUsedAt = Date.now();
    };
    const onFrame = (frame: { data: string; sessionId: number }) => {
      if (managed.stream?.res !== res || res.destroyed) return;
      void managed.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      // Count-based CDP skipping loses the only repaint of a static page. Keep
      // one latest frame and always flush the trailing repaint instead.
      pendingFrame = frame.data;
      if (flushTimer) return;
      const delay = Math.max(0, streamFrameInterval(profile) - (Date.now() - lastFrameAt));
      if (delay === 0) flushFrame();
      else flushTimer = setTimeout(flushFrame, delay);
    };
    managed.cdp.on("Page.screencastFrame", onFrame);
    res.on("close", () => {
      managed.cdp.off("Page.screencastFrame", onFrame);
      clearTimeout(flushTimer);
      pendingFrame = null;
      if (managed.stream?.res !== res) return;
      managed.stream = null;
      managed.streamOperation = managed.streamOperation.catch(() => undefined).then(async () => {
        if (managed.stream) return;
        await managed.cdp.send("Page.stopScreencast");
        // A replacement may arrive during stop; it must not be frozen afterward.
        if (!managed.stream) await managed.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      }).catch(() => undefined);
    });
    const startup = managed.streamOperation.catch(() => undefined).then(async () => {
      if (managed.stream?.res !== res || res.destroyed) return;
      // Starting an already-running CDP screencast may not emit a fresh frame.
      await managed.cdp.send("Page.stopScreencast");
      if (managed.stream?.res !== res || res.destroyed) return;
      await managed.cdp.send("Page.setWebLifecycleState", { state: "active" });
      if (managed.stream?.res !== res || res.destroyed) return;
      await managed.cdp.send("Page.startScreencast", screencastOptions(profile));
    });
    managed.streamOperation = startup.catch(() => undefined);
    await startup;
  }

  async close(sessionID: string): Promise<void> {
    await this.opening;
    const managed = this.pages.get(sessionID);
    if (!managed) return;
    this.pages.delete(sessionID);
    this.endStream(managed);
    await managed.page.close().catch(() => undefined);
  }

  slots(): BrowserSlot[] {
    return [...this.pages.entries()].map(([sessionID, managed]) => ({
      sessionID,
      url: managed.page.url(),
      title: "", // titles are fetched lazily by state(); slots stay cheap
      lastUsedAt: managed.lastUsedAt,
      streaming: managed.stream !== null,
    }));
  }

  has(sessionID: string): boolean {
    return this.pages.has(sessionID);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    const context = this.context;
    this.context = null;
    this.pages.clear();
    await context?.close().catch(() => undefined);
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.idleMinutes * 60_000;
    for (const [sessionID, managed] of this.pages) {
      if (managed.stream === null && managed.lastUsedAt < cutoff) {
        await this.close(sessionID);
      }
    }
    // Last page reaped: shut Chromium down too so idle steady-state is ~0.
    if (this.pages.size === 0 && this.context) {
      const context = this.context;
      this.context = null;
      this.launching = null;
      await context.close().catch(() => undefined);
    }
  }

  private endStream(managed: Managed): void {
    const stream = managed.stream;
    managed.stream = null;
    if (stream && !("destroyed" in stream.res && stream.res.destroyed)) {
      try {
        stream.res.end();
      } catch {
        // already gone
      }
    }
  }

  private require(sessionID: string): Managed {
    const managed = this.pages.get(sessionID);
    if (!managed) throw new UnknownSessionError(sessionID);
    return managed;
  }
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
}

export { CapacityError, NavigationRefused, UnknownSessionError, validSessionID };
export type { BrowserSlot, LiveBrowserInputEvent };
