import { Router, type Response } from "express";

import type { OpencodeConfig } from "../opencode/client.js";
import { getDeploymentSnapshot } from "../deployment.js";
import { getLogSnapshot, isLogSource, LOG_SOURCES } from "../logs.js";
import { ProjectPinStore } from "../projects.js";
import { ResourceMonitor } from "../resources.js";

/**
 * Log contents carry directory paths and inspected exception objects, so they
 * get the same header set as DSH trajectory payloads (`routes/dsh.ts`) rather
 * than the default cacheable JSON treatment.
 */
function privateRead(res: Response): void {
  res.set({
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Read-only observability routes.
 *
 * No route accepts a filesystem path. The log source is a closed enum resolved
 * server-side; see `server/logs.ts` for why widening the workspace path guard
 * was the wrong alternative.
 */
export function observabilityRoutes(config: OpencodeConfig, port: number, store = new ProjectPinStore()): Router {
  const router = Router();
  const resources = new ResourceMonitor(config.baseUrl);

  router.get("/observability/resources", (_req, res) => {
    privateRead(res);
    void resources.read().then((snapshot) => res.json(snapshot)).catch(() => res.status(503).json({ error: "Resource monitor unavailable" }));
  });

  router.get("/observability/logs", (req, res) => {
    privateRead(res);
    const source = req.query.source ?? "audit";
    if (!isLogSource(source)) {
      res.status(400).json({ error: `'source' must be one of: ${LOG_SOURCES.join(", ")}` });
      return;
    }
    void getLogSnapshot(source, req.query.refresh === "1")
      .then((snapshot) => res.json(snapshot))
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  router.get("/observability/deployment", (req, res) => {
    privateRead(res);
    void store
      .read()
      // A failed pin read must not blank the whole panel; the busy-session row
      // degrades to "nothing to check" on its own.
      .catch(() => [] as string[])
      .then((directories) =>
        getDeploymentSnapshot({ config, port, directories, refresh: req.query.refresh === "1" }),
      )
      .then((snapshot) => res.json(snapshot))
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  return router;
}
