import { Router } from "express";

import type { IslandConfig } from "../islands.js";
import { publicIslands } from "../islands.js";

export function appConfigRoutes(
  publicAppUrl: string | null,
  dshEnabled = false, dshConfigured = false,
  claudeEnabled = false, claudeConfigured = false,
  islands?: IslandConfig,
): Router {
  const router = Router();
  router.get("/app-config", (_req, res) => {
    res.json({
      publicAppUrl,
      dshEnabled, dshConfigured,
      claudeEnabled, claudeConfigured,
      // Per-island availability for this host: the env allowlist ANDed with
      // what the platform supports. `dshEnabled`/`claudeConfigured` above stay
      // as they were — they report the island's own env configuration, which is
      // a different question from whether this host runs the island at all.
      islands: islands ? publicIslands(islands) : [],
    });
  });
  return router;
}
