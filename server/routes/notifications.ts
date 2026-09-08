import { Router } from "express";

import { sendNtfy } from "../notifications/ntfy.js";
import { HistoryStore } from "../notifications/history.js";
import { NOTIFY_EVENTS, PreferenceStore, type NotifyEvent } from "../notifications/preferences.js";
import { PushSubscriptionStore, sendWebPush, webPushConfig } from "../notifications/webpush.js";

export const NTFY_TEST_MESSAGE = {
  event: "idle" as const,
  title: "OpenCode notification test",
  body: "Your phone notification path is working.",
};

export const WEB_PUSH_TEST_MESSAGE = {
  ...NTFY_TEST_MESSAGE,
  body: "Your PWA push notification path is working.",
  diag: true,
};

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function queryKind(value: unknown): NotifyEvent | undefined {
  const candidate = queryString(value);
  return candidate && (NOTIFY_EVENTS as readonly string[]).includes(candidate)
    ? (candidate as NotifyEvent)
    : undefined;
}

function queryState(value: unknown): "all" | "active" | "resolved" {
  const candidate = queryString(value);
  return candidate === "active" || candidate === "resolved" ? candidate : "all";
}

/**
 * Absent means "do not filter". The noise filters are a UI preference, so the
 * default has to be the unfiltered log: an omitted flag must never hide a
 * record from a caller that did not ask.
 */
function queryFlag(value: unknown): boolean {
  const candidate = queryString(value);
  return candidate === "1" || candidate === "true";
}

export function notificationRoutes(
  store: PreferenceStore,
  history: HistoryStore,
  pushSubscriptions = new PushSubscriptionStore(),
): Router {
  const router = Router();
  router.get("/notifications", (_req, res) => {
    store.read().then((preferences) =>
      res.json({
        preferences,
        tokenConfigured: Boolean(process.env.NTFY_TOKEN),
        webPush: { configured: Boolean(webPushConfig()), publicKey: webPushConfig()?.publicKey ?? null },
      }),
    );
  });
  router.patch("/notifications", (req, res) => {
    store
      .update(req.body)
      .then((preferences) => res.json({
        preferences,
        tokenConfigured: Boolean(process.env.NTFY_TOKEN),
        webPush: { configured: Boolean(webPushConfig()), publicKey: webPushConfig()?.publicKey ?? null },
      }))
      .catch((error: unknown) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  });
  router.post("/notifications/test", (_req, res) => {
    store
      .read()
      .then((preferences) =>
        sendNtfy(preferences, NTFY_TEST_MESSAGE),
      )
      .then(() => res.json({ sent: true }))
      .catch((error: unknown) => res.status(502).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.get("/notifications/push-subscriptions", (_req, res) => {
    pushSubscriptions.summaries()
      .then((subscriptions) => res.json({ subscriptions }))
      .catch((error: unknown) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.post("/notifications/push-subscriptions", (req, res) => {
    if (!webPushConfig()) {
      res.status(503).json({ error: "Web Push is not configured" });
      return;
    }
    pushSubscriptions.add(req.body)
      .then(() => res.status(204).end())
      .catch((error: unknown) => res.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.delete("/notifications/push-subscriptions/all", (_req, res) => {
    pushSubscriptions.removeAll()
      .then(() => res.status(204).end())
      .catch((error: unknown) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.delete("/notifications/push-subscriptions/:id", (req, res) => {
    pushSubscriptions.removeById(req.params.id)
      .then(() => res.status(204).end())
      .catch((error: unknown) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.delete("/notifications/push-subscriptions", (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    pushSubscriptions.remove(endpoint)
      .then(() => res.status(204).end())
      .catch((error: unknown) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.post("/notifications/test-web-push", (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    Promise.all([pushSubscriptions.list(), Promise.resolve(webPushConfig())])
      .then(([subscriptions, config]) => {
        if (!config) throw new Error("Web Push is not configured");
        const subscription = subscriptions.find((item) => item.endpoint === endpoint);
        if (!subscription) throw new Error("This PWA push subscription is not registered");
        return sendWebPush([subscription], WEB_PUSH_TEST_MESSAGE, config)
          .then(async (result) => {
            if (result.expired.length) await pushSubscriptions.remove(subscription.endpoint, subscription.keys);
            return result;
          });
      })
      .then((result) => result.sent > 0
        ? res.json(result)
        : res.status(502).json({ error: "Web Push delivery failed" }))
      .catch((error: unknown) => res.status(502).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  router.get("/notifications/history", (req, res) => {
    Promise.resolve()
      .then(async () => {
        const limitParam = Number(queryString(req.query.limit));
        const directory = queryString(req.query.directory);
        const kind = queryKind(req.query.kind);
        // Applied to the rows and the counter together: a badge that counts
        // records the caller asked not to see just relocates the clutter.
        const filters = {
          hideAutoApproved: queryFlag(req.query.hideAutoApproved),
          hideSubagent: queryFlag(req.query.hideSubagent),
          hidePreferenceOff: queryFlag(req.query.hidePreferenceOff),
        };
        const [records, activeCount, appBadge, suppressedActive] = await Promise.all([
          history.list({
            ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
            ...(kind ? { kind } : {}),
            // History remains global; directory scopes only the nav/header
            // counter returned alongside it.
            state: queryState(req.query.state),
            ...filters,
          }),
          history.activeCount(directory, filters),
          history.appBadgeSnapshot(),
          history.suppressedActiveCounts(directory),
        ]);
        res.json({ records, activeCount, appBadgeCount: appBadge.count, appBadgeRevision: appBadge.revision, suppressedActive });
      })
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  router.post("/notifications/resolve", (req, res) => {
    const ids = req.body?.ids;
    const directory = queryString(req.query.directory);
    if (
      !Array.isArray(ids)
      || ids.length === 0
      || ids.length > 1_000
      || ids.some((id) => typeof id !== "string" || !id)
    ) {
      res.status(400).json({ error: "body must contain 1 to 1000 notification ids" });
      return;
    }
    history
      .resolveMany([...new Set(ids)])
      .then(async (records) => {
        const appBadge = await history.appBadgeSnapshot();
        res.json({ records, activeCount: await history.activeCount(directory), appBadgeCount: appBadge.count, appBadgeRevision: appBadge.revision });
      })
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  router.patch("/notifications/:id", (req, res) => {
    if (typeof req.body?.resolved !== "boolean" || Object.keys(req.body).some((key) => key !== "resolved")) {
      res.status(400).json({ error: "body must contain only a boolean 'resolved' field" });
      return;
    }
    history
      .setResolved(req.params.id, req.body.resolved)
      .then(async (record) => {
        if (!record) {
          res.status(404).json({ error: "notification not found" });
          return;
        }
        const appBadge = await history.appBadgeSnapshot();
        res.json({ record, activeCount: await history.activeCount(), appBadgeCount: appBadge.count, appBadgeRevision: appBadge.revision });
      })
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  // Kept for the already-deployed v1 client; dismiss is a user action and maps
  // to the same persisted checked state.
  router.post("/notifications/:id/dismiss", (req, res) => {
    const id = req.params.id;
    history
      .find(id)
      .then(async (record) => {
        if (!record) {
          res.status(404).json({ error: "notification not found" });
          return;
        }
        await history.setResolved(id, true);
        const appBadge = await history.appBadgeSnapshot();
        res.json({ dismissed: true, activeCount: await history.activeCount(), appBadgeCount: appBadge.count, appBadgeRevision: appBadge.revision });
      })
      .catch((error: unknown) =>
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) }),
      );
  });

  return router;
}
