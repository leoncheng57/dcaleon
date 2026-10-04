import { Router } from "express";

import {
  createPlanningIssue,
  getPlanningItemDetails,
  getPlanningLabels,
  getPlanningSnapshot,
  PlanningInputError,
  planningErrorBody,
  planningErrorStatus,
  updatePlanningItemLabels,
} from "../github-planning.js";

/** Fixed-repository planning routes. No route accepts repository identity or directory. */
export function planningRoutes(): Router {
  const router = Router();
  router.get("/planning/items", (req, res) => {
    void getPlanningSnapshot(req.query.refresh === "1")
      .then((snapshot) => res.json(snapshot))
      .catch((error: unknown) => res.status(planningErrorStatus(error)).json(planningErrorBody(error)));
  });
  router.get("/planning/labels", (_req, res) => {
    void getPlanningLabels()
      .then((result) => res.json(result))
      .catch((error: unknown) => res.status(planningErrorStatus(error)).json(planningErrorBody(error)));
  });
  router.get("/planning/items/:number", (req, res) => {
    void getPlanningItemDetails(req.params.number)
      .then((details) => res.json({ details }))
      .catch((error: unknown) => {
        if (error instanceof PlanningInputError) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.status(planningErrorStatus(error)).json(planningErrorBody(error));
      });
  });
  router.patch("/planning/items/:number/labels", (req, res) => {
    void updatePlanningItemLabels(req.params.number, req.body)
      .then((item) => res.json({ item }))
      .catch((error: unknown) => {
        if (error instanceof PlanningInputError) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.status(planningErrorStatus(error)).json(planningErrorBody(error));
      });
  });
  router.post("/planning/issues", (req, res) => {
    void createPlanningIssue(req.body)
      .then((issue) => res.status(201).json({ issue }))
      .catch((error: unknown) => {
        if (error instanceof PlanningInputError) {
          res.status(400).json({ error: error.message });
          return;
        }
        res.status(planningErrorStatus(error)).json(planningErrorBody(error));
      });
  });
  return router;
}
