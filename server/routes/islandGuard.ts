import { Router, type RequestHandler } from "express";

import type { IslandAvailability } from "../islands.js";

// Routes owned by the OpenCode island, declared here rather than discovered by
// walking the mounted routers: a list is stable across Express versions and can
// be unit-tested without an app. `tests/islands.test.ts` cross-checks it
// against the paths the OpenCode routers actually register, so a new route
// cannot quietly escape the guard.
//
// The Claude and DSH islands are namespaced (`/claude/*`, `/dsh/*`) and are
// guarded by their own `requireEnabled`, so nothing here overlaps them.
export const OPENCODE_ROUTE_PREFIXES: readonly string[] = [
  "/auto-approve",
  "/catalog",
  "/events",
  "/lsp",
  "/managed-child-agents",
  "/mcp",
  "/models",
  "/observability",
  "/permission-requests",
  "/permissions",
  "/session-agents",
  "/session-workflows",
  "/sessions",
  "/settings",
  "/workspace",
  "/worktrees",
];

/** True when `pathname` (BFF-relative, so without the `/api` mount) is an OpenCode route. */
export function isOpencodeRoute(pathname: string, prefixes: readonly string[] = OPENCODE_ROUTE_PREFIXES): boolean {
  const normalized = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

/**
 * Answers 503 with the island's reason for every OpenCode route when the host
 * does not run that island.
 *
 * 503 rather than 404 on purpose: the route exists, this host just does not
 * serve it, and the client distinguishes "unavailable here" from "you asked
 * for something that is not a route". Mounted ahead of the real routers so it
 * short-circuits before any upstream fetch is attempted — the failure mode
 * this replaces was connection errors and SSE reconnect storms against an
 * OpenCode server that is not running.
 */
export function opencodeIslandGuard(island: IslandAvailability): RequestHandler {
  return (req, res, next) => {
    if (island.available || !isOpencodeRoute(req.path)) return next();
    res.status(503).json({
      error: "The OpenCode island is not available on this host",
      island: "opencode",
      reason: island.reason,
    });
  };
}

/** Convenience wrapper so `server/index.ts` mounts this the same way as every other router. */
export function islandGuardRoutes(island: IslandAvailability): Router {
  const router = Router();
  router.use(opencodeIslandGuard(island));
  return router;
}
