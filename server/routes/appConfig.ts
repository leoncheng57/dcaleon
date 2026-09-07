import { Router } from "express";

export function appConfigRoutes(
  publicAppUrl: string | null,
  dshEnabled = false, dshConfigured = false,
  claudeEnabled = false, claudeConfigured = false,
): Router {
  const router = Router();
  router.get("/app-config", (_req, res) => {
    res.json({ publicAppUrl, dshEnabled, dshConfigured, claudeEnabled, claudeConfigured });
  });
  return router;
}
