import { Router, type Response } from "express";
import { deleteClaudeMemory, listClaudeMemory } from "../claude/memory.js";
import { PathError, requireWorkspaceDirectory } from "../paths.js";

function fail(res: Response, error: unknown): void {
  const status = error instanceof PathError ? error.status : error instanceof Error && (error.message === "memory entry not found") ? 404 : 400;
  res.status(status).json({ error: error instanceof Error ? error.message : "failed to access Claude memory" });
}

export function memoryRoutes(): Router {
  const router = Router();
  router.get("/memory", (req, res) => {
    requireWorkspaceDirectory(req.query.directory).then(listClaudeMemory).then((memory) => res.json(memory)).catch((error: unknown) => fail(res, error));
  });
  router.delete("/memory/:filename", (req, res) => {
    requireWorkspaceDirectory(req.query.directory).then((directory) => deleteClaudeMemory(directory, req.params.filename)).then(() => res.status(204).end()).catch((error: unknown) => fail(res, error));
  });
  return router;
}
