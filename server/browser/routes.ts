// server/browser/routes.ts — browser-facing API for the live session browser.
//
// Disabled unless LIVE_BROWSER_ENABLED=true (routes then answer 403 with the
// reason rather than 404, so the panel can explain itself). The manager is
// created lazily by index.ts only when enabled, so a disabled deployment
// never loads playwright-core at all.

import { Router, type Request, type Response } from "express";

import {
  CapacityError,
  BROWSER_VIEWPORT,
  NavigationRefused,
  UnknownSessionError,
  validSessionID,
  type LiveBrowserInputEvent,
  type BrowserStreamProfile,
} from "./errors.js";
import type { BrowserManager } from "./manager.js";
import type { LiveBrowserConfig } from "./policy.js";

export function liveBrowserRoutes(config: LiveBrowserConfig, manager: BrowserManager | null): Router {
  const router = Router();

  router.get("/browser/config", (_req, res) => {
    res.json({ enabled: config.enabled, maxPages: config.maxPages, idleMinutes: config.idleMinutes });
  });

  if (!config.enabled || !manager) {
    router.all(/^\/browser(\/.*)?$/, (_req, res) => {
      res.status(403).json({ error: "live browser is disabled; set LIVE_BROWSER_ENABLED=true" });
    });
    return router;
  }

  const sessionID = (req: Request, res: Response): string | null => {
    const value = String(req.params.sessionID ?? "");
    if (!validSessionID(value)) {
      res.status(400).json({ error: "invalid session id" });
      return null;
    }
    return value;
  };

  const fail = (res: Response, error: unknown): void => {
    if (error instanceof CapacityError) {
      res.status(409).json({ error: error.message, slots: error.slots });
    } else if (error instanceof UnknownSessionError) {
      res.status(404).json({ error: error.message });
    } else if (error instanceof NavigationRefused) {
      res.status(400).json({ error: `navigation refused: ${error.message}` });
    } else {
      res.status(502).json({ error: error instanceof Error ? error.message : "live browser unavailable" });
    }
  };

  router.get("/browser/slots", (_req, res) => {
    res.json({ slots: manager.slots(), maxPages: config.maxPages });
  });

  router.post("/browser/:sessionID/open", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    const url = typeof req.body?.url === "string" ? req.body.url.slice(0, 2048) : undefined;
    try {
      res.json(await manager.open(id, url));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/browser/:sessionID/state", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    try {
      res.json(await manager.state(id));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/browser/:sessionID/stream", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    try {
      await manager.attachStream(id, res, parseStreamProfile(req.query.profile));
    } catch (error) {
      if (!res.headersSent) fail(res, error);
      else res.end();
    }
  });

  router.post("/browser/:sessionID/navigate", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    const body = req.body ?? {};
    const action = body.action;
    try {
      if (action === "goto") {
        const url = typeof body.url === "string" ? body.url.slice(0, 2048) : "";
        if (!url) {
          res.status(400).json({ error: "goto requires a url" });
          return;
        }
        res.json(await manager.navigate(id, { action, url }));
      } else if (action === "back" || action === "forward" || action === "reload") {
        res.json(await manager.navigate(id, { action }));
      } else {
        res.status(400).json({ error: "action must be goto, back, forward or reload" });
      }
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/browser/:sessionID/input", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    const event = parseLiveBrowserInput(req.body);
    if (!event) {
      res.status(400).json({ error: "unrecognized input event" });
      return;
    }
    try {
      await manager.input(id, event);
      res.status(204).end();
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete("/browser/:sessionID", async (req, res) => {
    const id = sessionID(req, res);
    if (!id) return;
    await manager.close(id);
    res.status(204).end();
  });

  return router;
}

export function parseLiveBrowserInput(body: unknown): LiveBrowserInputEvent | null {
  if (!body || typeof body !== "object") return null;
  const event = body as Record<string, unknown>;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  switch (event.type) {
    case "click": {
      const x = num(event.x);
      const y = num(event.y);
      if (x === null || y === null) return null;
      return { type: "click", x, y, ...(event.button === "right" ? { button: "right" as const } : {}) };
    }
    case "move": {
      const x = num(event.x);
      const y = num(event.y);
      return x !== null && y !== null ? { type: "move", x, y } : null;
    }
    case "scroll": {
      const x = num(event.x);
      const y = num(event.y);
      const deltaY = num(event.deltaY);
      return x !== null && y !== null && deltaY !== null ? { type: "scroll", x, y, deltaY } : null;
    }
    case "key":
      return typeof event.key === "string" && event.key.length > 0 ? { type: "key", key: event.key } : null;
    case "type":
      return typeof event.text === "string" && event.text.length > 0 ? { type: "type", text: event.text } : null;
    case "viewport": {
      const width = num(event.width);
      const height = num(event.height);
      if (width === null || height === null || !Number.isInteger(width) || !Number.isInteger(height)) return null;
      if (width < BROWSER_VIEWPORT.minWidth || width > BROWSER_VIEWPORT.maxWidth) return null;
      if (height < BROWSER_VIEWPORT.minHeight || height > BROWSER_VIEWPORT.maxHeight) return null;
      return { type: "viewport", width, height };
    }
    case "touch": {
      const phase = event.phase;
      if (phase !== "start" && phase !== "move" && phase !== "end" && phase !== "cancel") return null;
      if (!Array.isArray(event.points) || event.points.length > 10) return null;
      if ((phase === "start" || phase === "move") && event.points.length === 0) return null;
      if ((phase === "end" || phase === "cancel") && event.points.length !== 0) return null;
      const points = event.points.map((raw, index) => {
        if (!raw || typeof raw !== "object") return null;
        const point = raw as Record<string, unknown>;
        const x = num(point.x);
        const y = num(point.y);
        const id = point.id === undefined ? index : num(point.id);
        if (x === null || y === null || x < 0 || y < 0 || x > BROWSER_VIEWPORT.maxWidth || y > BROWSER_VIEWPORT.maxHeight || id === null || !Number.isInteger(id) || id < 0 || id > 31) return null;
        return { x, y, id };
      });
      if (points.some((point) => point === null)) return null;
      if (new Set(points.map((point) => point!.id)).size !== points.length) return null;
      return { type: "touch", phase, points: points as Array<{ x: number; y: number; id: number }> };
    }
    default:
      return null;
  }
}

export function parseStreamProfile(value: unknown): BrowserStreamProfile {
  return value === "coarse" ? "coarse" : "default";
}
