import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";

import { MAX_PUSH_SUBSCRIPTIONS, PushSubscriptionStore, sendWebPush, webPushConfig } from "../server/notifications/webpush.js";
import { NotificationService } from "../server/notifications/service.js";
import { normalizePreferences, PreferenceStore } from "../server/notifications/preferences.js";
import { HistoryStore } from "../server/notifications/history.js";
import type { EventBus } from "../server/opencode/events.js";
import { AutoPermissionService } from "../server/opencode/autoPermissions.js";
import { notificationRoutes } from "../server/routes/notifications.js";
import { matchesApplicationServerKey } from "../client/lib/webPush.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Web Push configuration", () => {
  it("is optional but requires a complete VAPID configuration", () => {
    const vapid = webpush.generateVAPIDKeys();
    expect(webPushConfig({})).toBeNull();
    expect(() => webPushConfig({ VAPID_PUBLIC_KEY: "public" })).toThrow(/configured together/u);
    expect(() => webPushConfig({ VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private", VAPID_SUBJECT: "owner" })).toThrow(/configured together/u);
    expect(() => webPushConfig({ VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private", VAPID_SUBJECT: "mailto:owner@example.com" })).toThrow();
    expect(webPushConfig({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:owner@example.com" }))
      .toEqual({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "mailto:owner@example.com" });
  });
});

describe("Web Push subscriptions", () => {
  it("persists, replaces, removes, and rejects malformed subscriptions", async () => {
    const file = path.join(os.tmpdir(), `dca-web-push-${process.pid}-${Date.now()}.json`);
    const store = new PushSubscriptionStore(file);
    const first = { endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "one", auth: "auth" } };
    await store.add(first);
    await store.add({ ...first, keys: { p256dh: "two", auth: "new-auth" } });
    expect(await store.list()).toEqual([{ ...first, keys: { p256dh: "two", auth: "new-auth" } }]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, subscriptions: [{ endpoint: first.endpoint }] });
    await expect(store.add({ endpoint: "https://evil.example.test/device", keys: first.keys })).rejects.toThrow(/invalid/u);
    await store.remove(first.endpoint);
    expect(await store.list()).toEqual([]);
  });

  it("does not remove refreshed keys when an older delivery expires", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-refresh-${process.pid}-${Date.now()}.json`));
    const endpoint = "https://fcm.googleapis.com/refreshed";
    const oldKeys = { p256dh: "old", auth: "old-auth" };
    const newKeys = { p256dh: "new", auth: "new-auth" };
    await store.add({ endpoint, keys: oldKeys });
    await store.add({ endpoint, keys: newKeys });
    await store.remove(endpoint, oldKeys);
    expect(await store.list()).toEqual([{ endpoint, keys: newKeys }]);
  });

  it("rejects corrupt state and caps registered devices", async () => {
    const file = path.join(os.tmpdir(), `dca-web-push-bounds-${process.pid}-${Date.now()}.json`);
    const store = new PushSubscriptionStore(file);
    await writeFile(file, "not json");
    await expect(store.list()).rejects.toThrow();
    await expect(store.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "key", auth: "auth" } })).rejects.toThrow();

    const bounded = new PushSubscriptionStore(`${file}.bounded`);
    for (let index = 0; index < MAX_PUSH_SUBSCRIPTIONS; index += 1) {
      await bounded.add({ endpoint: `https://fcm.googleapis.com/device-${index}`, keys: { p256dh: `key-${index}`, auth: "auth" } });
    }
    await expect(bounded.add({ endpoint: "https://fcm.googleapis.com/overflow", keys: { p256dh: "key", auth: "auth" } }))
      .rejects.toThrow(String(MAX_PUSH_SUBSCRIPTIONS));
    expect(await bounded.list()).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
  });

  it("replaces existing subscription by installationId instead of appending", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-installation-${process.pid}-${Date.now()}.json`));
    const installationId = "test-installation-id";
    
    // Add first subscription with installation ID
    await store.add({
      endpoint: "https://fcm.googleapis.com/device-old",
      keys: { p256dh: "old-key", auth: "old-auth" },
      installationId,
    });
    expect(await store.list()).toHaveLength(1);
    const firstList = await store.list();
    expect(firstList[0].endpoint).toBe("https://fcm.googleapis.com/device-old");
    
    // Add second subscription with same installation ID but different endpoint/keys
    await store.add({
      endpoint: "https://fcm.googleapis.com/device-new",
      keys: { p256dh: "new-key", auth: "new-auth" },
      installationId,
    });
    
    // Should still only have one subscription, with updated endpoint/keys
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].endpoint).toBe("https://fcm.googleapis.com/device-new");
    expect(list[0].keys).toEqual({ p256dh: "new-key", auth: "new-auth" });
    expect(list[0].installationId).toBe(installationId);
  });

  it("removes subscription by ID", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-remove-by-id-${process.pid}-${Date.now()}.json`));
    await store.add({ endpoint: "https://fcm.googleapis.com/device-1", keys: { p256dh: "key-1", auth: "auth" } });
    await store.add({ endpoint: "https://fcm.googleapis.com/device-2", keys: { p256dh: "key-2", auth: "auth" } });
    
    const summaries = await store.summaries();
    expect(summaries).toHaveLength(2);
    
    // Remove first subscription by ID
    await store.removeById(summaries[0].id);
    
    const remaining = await store.summaries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(summaries[1].id);
  });

  it("removes all subscriptions", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-remove-all-${process.pid}-${Date.now()}.json`));
    await store.add({ endpoint: "https://fcm.googleapis.com/device-1", keys: { p256dh: "key-1", auth: "auth" } });
    await store.add({ endpoint: "https://fcm.googleapis.com/device-2", keys: { p256dh: "key-2", auth: "auth" } });
    
    expect(await store.list()).toHaveLength(2);
    
    await store.removeAll();
    
    expect(await store.list()).toHaveLength(0);
    expect(await store.summaries()).toHaveLength(0);
  });

  it("summaries never leak endpoint or keys", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-summaries-${process.pid}-${Date.now()}.json`));
    const endpoint = "https://fcm.googleapis.com/secret-endpoint";
    const keys = { p256dh: "secret-p256dh", auth: "secret-auth" };
    
    await store.add({ endpoint, keys });
    
    const summaries = await store.summaries();
    expect(summaries).toHaveLength(1);
    
    // Verify summaries only contain safe fields
    expect(summaries[0]).toHaveProperty("id");
    expect(summaries[0]).toHaveProperty("addedAt");
    expect(summaries[0]).toHaveProperty("label");
    expect(Object.keys(summaries[0])).toEqual(["id", "addedAt", "label", "platform"]);
    
    // Verify endpoint and keys are not in the JSON
    const json = JSON.stringify(summaries);
    expect(json).not.toContain(endpoint);
    expect(json).not.toContain("p256dh");
    expect(json).not.toContain(keys.p256dh);
    expect(json).not.toContain(keys.auth);
  });

  it("names the push platform and echoes the installation token a device can recognise", async () => {
    const store = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-platform-${process.pid}-${Date.now()}.json`));
    await store.add({ endpoint: "https://web.push.apple.com/device", keys: { p256dh: "k", auth: "a" }, installationId: "install-apple" });
    await store.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "k", auth: "a" } });

    const summaries = await store.summaries();
    const apple = summaries.find((item) => item.installationId === "install-apple");
    const google = summaries.find((item) => item.installationId === undefined);

    expect(apple?.platform).toBe("Apple (Safari or iOS)");
    // A record registered before installation tracking has nothing to echo, so
    // the field is absent rather than guessed at.
    expect(google?.platform).toBe("Google (Chrome or Android)");
    expect(google).not.toHaveProperty("installationId");
    expect(JSON.stringify(summaries)).not.toContain("web.push.apple.com");
  });

  it("backfills a legacy record's date once instead of re-dating it on every read", async () => {
    const file = path.join(os.tmpdir(), `dca-web-push-backfill-${process.pid}-${Date.now()}.json`);
    // Pre-#278 shape: no id, no addedAt.
    await writeFile(file, JSON.stringify({
      version: 1,
      subscriptions: [{ endpoint: "https://fcm.googleapis.com/legacy", keys: { p256dh: "k", auth: "a" } }],
    }));
    const store = new PushSubscriptionStore(file);

    const first = await store.summaries();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.summaries();

    // Recomputing on read is what collapsed every device onto one instant.
    expect(second[0].addedAt).toBe(first[0].addedAt);
    expect(second[0].id).toBe(first[0].id);

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      subscriptions: Array<{ id?: string; addedAt?: number }>;
    };
    expect(persisted.subscriptions[0].id).toBe(first[0].id);
    expect(persisted.subscriptions[0].addedAt).toBe(first[0].addedAt);
  });

  it("does not re-date an already-backfilled record when another device registers", async () => {
    const file = path.join(os.tmpdir(), `dca-web-push-backfill-add-${process.pid}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({
      version: 1,
      subscriptions: [{ endpoint: "https://fcm.googleapis.com/legacy", keys: { p256dh: "k", auth: "a" } }],
    }));
    const store = new PushSubscriptionStore(file);
    const legacy = (await store.summaries())[0];

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.add({ endpoint: "https://web.push.apple.com/new", keys: { p256dh: "k", auth: "a" }, installationId: "install-new" });

    const after = await store.summaries();
    const preserved = after.find((item) => item.id === legacy.id);
    expect(preserved?.addedAt).toBe(legacy.addedAt);
    expect(after).toHaveLength(2);
  });

  it("does not create a store file when reading a directory that has none", async () => {
    const file = path.join(os.tmpdir(), `dca-web-push-absent-${process.pid}-${Date.now()}.json`);
    const store = new PushSubscriptionStore(file);
    expect(await store.summaries()).toEqual([]);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Web Push delivery", () => {
  it("fails honestly when VAPID is not configured", async () => {
    await expect(sendWebPush(
      [{ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "key", auth: "auth" } }],
      { event: "idle", title: "Done", body: "Waiting" },
      null,
    )).rejects.toThrow("Web Push is not configured");
  });

  it("identifies expired provider subscriptions for removal", async () => {
    const vapid = webpush.generateVAPIDKeys();
    vi.spyOn(webpush, "sendNotification").mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const result = await sendWebPush(
      [{ endpoint: "https://fcm.googleapis.com/expired", keys: { p256dh: "key", auth: "auth" } }],
      { event: "idle", title: "Done", body: "Waiting" },
      { ...vapid, subject: "mailto:owner@example.com", privateKey: vapid.privateKey, publicKey: vapid.publicKey },
    );
    expect(result).toEqual({
      sent: 0,
      failed: 1,
      expired: ["https://fcm.googleapis.com/expired"],
      failures: ["Google (Chrome or Android): 410"],
    });
    expect(webpush.sendNotification).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({ timeout: 10_000 }));
  });

  it("attributes a provider's refusal to its platform without leaking the endpoint", async () => {
    const vapid = webpush.generateVAPIDKeys();
    // The failure that motivated this: Apple refuses an unrecognised key with a
    // status that never retires the subscription, so the only visible symptom is
    // a device that stays registered and receives nothing.
    vi.spyOn(webpush, "sendNotification").mockRejectedValue(
      Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: '{"reason":"BadJwtToken"}' }),
    );
    const endpoint = "https://web.push.apple.com/QDbJPmR6-secret-capability-path";
    const result = await sendWebPush(
      [{ endpoint, keys: { p256dh: "key", auth: "auth" } }],
      { event: "idle", title: "Done", body: "Waiting" },
      { ...vapid, subject: "mailto:owner@example.com" },
    );

    expect(result.failures).toEqual(['Apple (Safari or iOS): 403 {"reason":"BadJwtToken"}']);
    expect(result.expired).toEqual([]);
    expect(result.failures.join()).not.toContain("secret-capability-path");
  });

  it("delivers independently from ntfy and records the result", async () => {
    const vapid = webpush.generateVAPIDKeys();
    vi.stubEnv("VAPID_PUBLIC_KEY", vapid.publicKey);
    vi.stubEnv("VAPID_PRIVATE_KEY", vapid.privateKey);
    vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
    const send = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const subscriptions = new PushSubscriptionStore(path.join(os.tmpdir(), `dca-web-push-delivery-${process.pid}-${Date.now()}.json`));
    await subscriptions.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "key", auth: "auth" } });
    const history = new HistoryStore(path.join(os.tmpdir(), `dca-web-push-history-${process.pid}-${Date.now()}.json`));
    await history.append({
      kind: "idle",
      directory: "/tmp/other-project",
      title: "Other project",
      body: "",
      delivery: { ntfy: "off", desktop: "off", webPush: "sent" },
    });
    await history.append({
      kind: "idle",
      directory: "/tmp/hidden-child",
      title: "Suppressed child",
      body: "",
      delivery: { ntfy: "off", desktop: "off", webPush: "off", suppressed: "subagent" },
    });
    const preferences = {
      read: async () => normalizePreferences({
        ntfy: { enabled: false, server: "https://ntfy.sh", topic: "" },
        webPush: { enabled: true },
      }),
    } as PreferenceStore;
    const bus = new EventEmitter() as EventBus;
    const service = new NotificationService(
      { baseUrl: "http://opencode.test" },
      bus,
      preferences,
      history,
      null,
      undefined,
      async (_directory, sessionID) => ({ id: sessionID }),
      subscriptions,
    );
    service.start();
    bus.emit("event", { type: "session.idle", directory: "/tmp/project", properties: { sessionID: "ses_push" } });

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const payload = JSON.parse(String(send.mock.calls[0][1])) as { badgeCount: number; badgeRevision: number; tag: string };
    expect(payload.badgeCount).toBe(2);
    expect(payload.badgeRevision).toBeGreaterThan(0);
    // Session-scoped, so the service worker replaces this session's previous
    // card instead of piling a new one into the OS notification center.
    expect(payload.tag).toBe("ses_push");
    await vi.waitFor(async () => expect((await history.list()).find((record) => record.sessionID === "ses_push")?.delivery)
      .toMatchObject({ ntfy: "off", webPush: "sent" }));
    service.stop();
  });

  it("does not deliver auto-approved permissions received through a directory alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dca-web-push-auto-permission-"));
    const directory = path.join(root, "project");
    const alias = path.join(root, "alias");
    await mkdir(directory);
    await symlink(directory, alias);
    vi.stubEnv("PROJECTS_DIR", root);
    const vapid = webpush.generateVAPIDKeys();
    vi.stubEnv("VAPID_PUBLIC_KEY", vapid.publicKey);
    vi.stubEnv("VAPID_PRIVATE_KEY", vapid.privateKey);
    vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
    const push = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/permission" && init?.method === "GET") return Response.json([]);
      if (url.pathname === "/permission/perm_alias/reply") return Response.json(true);
      return new Response("unexpected delivery", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const subscriptions = new PushSubscriptionStore(path.join(root, "subscriptions.json"));
    await subscriptions.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "key", auth: "auth" } });
    const preferences = {
      read: async () => normalizePreferences({
        ntfy: { enabled: true, server: "https://ntfy.sh", topic: "team" },
        browser: { desktop: true },
        webPush: { enabled: true },
      }),
    } as PreferenceStore;
    const bus = new EventEmitter() as EventBus;
    const autoPermissions = new AutoPermissionService({ baseUrl: "http://opencode.test" }, bus);
    autoPermissions.start();
    await autoPermissions.setEnabled(await realpath(directory), true);
    fetchMock.mockClear();
    const history = new HistoryStore(path.join(root, "history.json"));
    const service = new NotificationService(
      { baseUrl: "http://opencode.test" },
      bus,
      preferences,
      history,
      null,
      (eventDirectory) => autoPermissions.isEnabledCanonical(eventDirectory),
      async (_eventDirectory, sessionID) => ({ id: sessionID }),
      subscriptions,
    );
    service.start();
    const recorded: Array<Record<string, unknown>> = [];
    bus.on("event", (event: { type: string; properties: Record<string, unknown> }) => {
      if (event.type === "notification.recorded") recorded.push(event.properties);
    });

    bus.emit("event", {
      type: "permission.asked",
      directory: alias,
      properties: {
        id: "perm_alias",
        sessionID: "ses_alias",
        permission: "bash",
        patterns: ["npm test"],
        metadata: {},
        always: [],
      },
    });

    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0][0])).toContain("/permission/perm_alias/reply");
    expect(push).not.toHaveBeenCalled();
    expect((await history.list())[0].delivery).toEqual({
      ntfy: "off",
      desktop: "off",
      webPush: "off",
      suppressed: "auto-permissions",
    });
    expect(recorded).toMatchObject([{ kind: "permission", suppressed: "auto-permissions" }]);
    service.stop();
    autoPermissions.stop();
  });
});

describe("notification service worker", () => {
  it("handles push and clicks without intercepting requests or caching agent data", async () => {
    const source = await readFile(path.resolve("client/public/sw.js"), "utf8");
    expect(source).toContain('addEventListener("push"');
    expect(source).toContain('addEventListener("notificationclick"');
    expect(source).toContain("target.origin === self.location.origin");
    expect(source).toContain("setAppBadge");
    expect(source).toContain("clearAppBadge");
    expect(source).toContain("SYNC_BADGE");
    expect(source).toContain("storedBadgeState");
    expect(source).not.toContain('addEventListener("fetch"');
    expect(source).not.toMatch(/caches\.|CacheStorage/u);
    // Re-registering a rotated subscription is the worker's one network write.
    // Calling fetch is not intercepting it, but the scope has to stay this
    // narrow: a second URL here would be a request path nothing else audits.
    expect([...source.matchAll(/fetch\(\s*"([^"]+)"/gu)].map((match) => match[1]))
      .toEqual(["/api/notifications/push-subscriptions"]);
  });

  it("does not need message-passing for closing stale notifications", async () => {
    // Stale notification cleanup (issue #270) uses the page-side
    // ServiceWorkerRegistration.getNotifications() API directly, which works
    // identically whether called from page or worker context. No service
    // worker message handler needed — simpler and more direct.
    const source = await readFile(path.resolve("client/public/sw.js"), "utf8");
    expect(source).not.toContain("CLOSE_SESSION_NOTIFICATIONS");
    expect(source).not.toContain("CLOSE_STALE");
  });

  it("agrees with the page on where the push identity is mirrored", async () => {
    // sw.js is a plain public asset and cannot import from client/lib, so the
    // IndexedDB coordinates are duplicated. Drift would silently disable
    // self-healing: the worker would read an empty record and give up.
    const worker = await readFile(path.resolve("client/public/sw.js"), "utf8");
    const page = await readFile(path.resolve("client/lib/webPush.ts"), "utf8");
    const constant = (source: string, name: string): string | undefined =>
      new RegExp(`${name} = "([^"]+)"`, "u").exec(source)?.[1];

    expect(constant(worker, "BADGE_DB")).toBe(constant(page, "PUSH_STATE_DB"));
    expect(constant(worker, "BADGE_STORE")).toBe(constant(page, "PUSH_STATE_STORE"));
    expect(constant(worker, "PUSH_IDENTITY_KEY")).toBe(constant(page, "PUSH_IDENTITY_KEY"));
    expect(constant(worker, "PUSH_IDENTITY_KEY")).toBeTruthy();
  });
});

interface PushIdentityRecord {
  installationId?: unknown;
  applicationServerKey?: unknown;
}

/**
 * Runs the real sw.js in a throwaway realm so the handler is exercised rather
 * than pattern-matched. Only the host objects a worker would supply are stubbed.
 */
async function runServiceWorker(options: {
  identity: PushIdentityRecord | undefined;
  subscribe?: () => Promise<unknown>;
  fetchResponse?: () => Promise<{ ok: boolean; status: number }>;
}): Promise<{
  dispatch: (type: string, event: Record<string, unknown>) => Promise<void>;
  subscribeCalls: Array<Record<string, unknown>>;
  fetchCalls: Array<{ url: string; init: { method?: string; body?: string } }>;
  warnings: unknown[][];
}> {
  const vm = await import("node:vm");
  const source = await readFile(path.resolve("client/public/sw.js"), "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const subscribeCalls: Array<Record<string, unknown>> = [];
  const fetchCalls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
  const warnings: unknown[][] = [];

  const openRequest = () => {
    const request: Record<string, unknown> = { onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      request.result = {
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const get: Record<string, unknown> = { result: options.identity, onsuccess: null, onerror: null };
              queueMicrotask(() => (get.onsuccess as (() => void) | null)?.());
              return get;
            },
          }),
        }),
        close: () => undefined,
      };
      (request.onsuccess as (() => void) | null)?.();
    });
    return request;
  };

  const sandbox = {
    indexedDB: { open: openRequest },
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: async (url: string, init: { method?: string; body?: string }) => {
      fetchCalls.push({ url, init });
      return options.fetchResponse ? options.fetchResponse() : { ok: true, status: 204 };
    },
    self: {
      addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
      location: { origin: "https://app.test" },
      navigator: {},
      registration: {
        pushManager: {
          subscribe: async (subscribeOptions: Record<string, unknown>) => {
            subscribeCalls.push(subscribeOptions);
            return options.subscribe
              ? options.subscribe()
              : { toJSON: () => ({ endpoint: "https://web.push.apple.com/rotated", keys: { p256dh: "new", auth: "new" } }) };
          },
        },
      },
    },
  };

  vm.runInNewContext(source, sandbox);

  return {
    subscribeCalls,
    fetchCalls,
    warnings,
    dispatch: async (type, event) => {
      const handler = listeners.get(type);
      if (!handler) throw new Error(`sw.js registered no ${type} listener`);
      let waited: Promise<unknown> = Promise.resolve();
      handler({ ...event, waitUntil: (value: Promise<unknown>) => { waited = value; } });
      await waited;
    },
  };
}

interface FakeNotification {
  title: string;
  body: string;
  closed: boolean;
  close: () => void;
}

/**
 * Runs the real sw.js push handler against stub notification APIs, so the
 * collapsing behaviour is exercised rather than asserted from the source text.
 */
async function runPushWorker(options: {
  existing?: Array<{ title: string; body: string }>;
  getNotificationsThrows?: boolean;
  failShowOnce?: boolean;
} = {}): Promise<{
  push: (payload: unknown) => Promise<void>;
  pushConcurrent: (payload: unknown) => Promise<unknown>;
  shown: Array<{ title: string; body: string; tag?: string }>;
  notifications: FakeNotification[];
}> {
  const vm = await import("node:vm");
  const source = await readFile(path.resolve("client/public/sw.js"), "utf8");
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Array<{ title: string; body: string; tag?: string }> = [];
  const notifications: FakeNotification[] = (options.existing ?? []).map((n) => ({
    ...n,
    closed: false,
    close() { this.closed = true; },
  }));

  const openRequest = () => {
    const request: Record<string, unknown> = { onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      request.result = {
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const get: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => (get.onsuccess as (() => void) | null)?.());
              return get;
            },
            put: () => undefined,
          }),
          oncomplete: null,
          onerror: null,
        }),
        close: () => undefined,
      };
      (request.onsuccess as (() => void) | null)?.();
    });
    return request;
  };

  const sandbox = {
    indexedDB: { open: openRequest },
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    console: { warn: () => undefined },
    setTimeout, clearTimeout, queueMicrotask,
    fetch: async () => ({ ok: true, status: 204 }),
    self: {
      addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
      location: { origin: "https://app.test" },
      navigator: {},
      registration: {
        pushManager: { subscribe: async () => ({ toJSON: () => ({}) }) },
        getNotifications: async () => {
          if (options.getNotificationsThrows) throw new Error("not permitted");
          return notifications.filter((n) => !n.closed);
        },
        showNotification: async (title: string, opts: { body: string; tag?: string }) => {
          if (options.failShowOnce && shown.length === 0) {
            shown.push({ title, body: opts.body, ...(opts.tag ? { tag: opts.tag } : {}) });
            throw new Error("show failed");
          }
          shown.push({ title, body: opts.body, ...(opts.tag ? { tag: opts.tag } : {}) });
          notifications.push({ title, body: opts.body, closed: false, close() { this.closed = true; } });
        },
      },
    },
  };

  vm.runInNewContext(source, sandbox);

  return {
    shown,
    notifications,
    push: async (payload: unknown) => {
      const handler = listeners.get("push");
      if (!handler) throw new Error("sw.js registered no push listener");
      let waited: Promise<unknown> = Promise.resolve();
      handler({ data: { json: () => payload }, waitUntil: (v: Promise<unknown>) => { waited = v; } });
      await waited;
    },
    /** Dispatches without awaiting, so two handlers can be made to overlap. */
    pushConcurrent: (payload: unknown) => {
      const handler = listeners.get("push");
      if (!handler) throw new Error("sw.js registered no push listener");
      let waited: Promise<unknown> = Promise.resolve();
      handler({ data: { json: () => payload }, waitUntil: (v: Promise<unknown>) => { waited = v; } });
      return waited;
    },
  };
}

describe("duplicate push notifications", () => {
  it("leaves exactly one card when the same content arrives twice", async () => {
    // iOS ignores `tag`, so a repeat stacks instead of replacing. Verified on
    // device: two pushes seconds apart with an identical tag produced two cards.
    const worker = await runPushWorker();

    await worker.push({ title: "Session", body: "All three done.", tag: "ses_1" });
    await worker.push({ title: "Session", body: "All three done.", tag: "ses_1" });

    // Both pushes show — userVisibleOnly demands it — but the earlier card is
    // closed first, so only one is left on screen.
    expect(worker.shown).toHaveLength(2);
    expect(worker.notifications.filter((n) => !n.closed)).toHaveLength(1);
    expect(worker.notifications.filter((n) => n.closed)).toHaveLength(1);
  });

  it("leaves one card when duplicates arrive together, not seconds apart", async () => {
    // The real failure. showCollapsed is check-then-act, so two handlers
    // running concurrently both read an empty list before either has shown,
    // neither closes anything, and two cards appear. Observed on device:
    // pushes 8s apart collapsed correctly while a duplicate arriving within
    // milliseconds did not.
    const worker = await runPushWorker();
    const payload = { title: "Session", body: "Sent - five pushes", tag: "ses_1" };

    await Promise.all([worker.pushConcurrent(payload), worker.pushConcurrent(payload)]);

    expect(worker.shown).toHaveLength(2);
    expect(worker.notifications.filter((n) => !n.closed)).toHaveLength(1);
  });

  it("keeps concurrent distinct notifications", async () => {
    // Serializing must not collapse genuinely different content.
    const worker = await runPushWorker();

    await Promise.all([
      worker.pushConcurrent({ title: "Session", body: "First", tag: "ses_1" }),
      worker.pushConcurrent({ title: "Session", body: "Second", tag: "ses_1" }),
    ]);

    expect(worker.notifications.filter((n) => !n.closed).map((n) => n.body).sort())
      .toEqual(["First", "Second"]);
  });

  it("keeps showing notifications after one fails", async () => {
    // The queue chains through rejection as well as fulfilment, so a single
    // failure must not wedge every later notification.
    const worker = await runPushWorker({ failShowOnce: true });

    await worker.push({ title: "Session", body: "Fails", tag: "ses_1" }).catch(() => undefined);
    await worker.push({ title: "Session", body: "Succeeds", tag: "ses_1" });

    expect(worker.shown.some((n) => n.body === "Succeeds")).toBe(true);
  });

  it("stamps the worker version onto diagnostic pushes only", async () => {
    // Decision 18 activates a new worker only on explicit user approval, so
    // the deployed sw.js and the executing sw.js routinely differ. A diag
    // push makes the card itself name the worker that rendered it; a real
    // notification must never carry the suffix.
    const worker = await runPushWorker();

    await worker.push({ title: "DIAG", body: "probe", diag: true });
    await worker.push({ title: "Session", body: "Real notification" });

    const source = await readFile(path.resolve("client/public/sw.js"), "utf8");
    const version = /SW_VERSION = "([^"]+)"/u.exec(source)?.[1];
    expect(version).toBeTruthy();
    expect(worker.shown[0].body).toBe(`probe [sw v${version}]`);
    expect(worker.shown[1].body).toBe("Real notification");
  });

  it("never resolves without showing a notification", async () => {
    // The subscription is userVisibleOnly: a push handler that shows nothing
    // invites the browser's own "updated in the background" notification, so
    // suppressing a duplicate outright would trade a useful card for a useless
    // one.
    const worker = await runPushWorker();
    await worker.push({ title: "Session", body: "Same", tag: "ses_1" });
    await worker.push({ title: "Session", body: "Same", tag: "ses_1" });
    await worker.push({ title: "Session", body: "Same", tag: "ses_1" });
    expect(worker.shown).toHaveLength(3);
  });

  it("keeps a different notification from the same session", async () => {
    // The tag is session-scoped, so two distinct records share one. Matching on
    // tag would wrongly close a card the user has not seen.
    const worker = await runPushWorker();

    await worker.push({ title: "Session", body: "First result", tag: "ses_1" });
    await worker.push({ title: "Session", body: "Second result", tag: "ses_1" });

    const open = worker.notifications.filter((n) => !n.closed);
    expect(open.map((n) => n.body).sort()).toEqual(["First result", "Second result"]);
  });

  it("does not close an unrelated notification", async () => {
    const worker = await runPushWorker({ existing: [{ title: "Other session", body: "Needs approval" }] });

    await worker.push({ title: "Session", body: "Done", tag: "ses_1" });

    expect(worker.notifications.find((n) => n.title === "Other session")?.closed).toBe(false);
  });

  it("still shows the card when getNotifications is unavailable", async () => {
    // Failing here must never cost a notification; a duplicate is the cheaper
    // mistake.
    const worker = await runPushWorker({ getNotificationsThrows: true });

    await worker.push({ title: "Session", body: "Done", tag: "ses_1" });

    expect(worker.shown).toEqual([{ title: "Session", body: "Done", tag: "ses_1" }]);
  });
});

describe("rotated push subscriptions", () => {
  it("re-subscribes with the mirrored key and re-registers under the same installation", async () => {
    const worker = await runServiceWorker({
      identity: { installationId: "install-1", applicationServerKey: "BFakeKey_-" },
    });

    await worker.dispatch("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });

    expect(worker.subscribeCalls).toHaveLength(1);
    expect(worker.subscribeCalls[0].userVisibleOnly).toBe(true);
    expect(worker.fetchCalls).toHaveLength(1);
    expect(worker.fetchCalls[0].url).toBe("/api/notifications/push-subscriptions");
    expect(worker.fetchCalls[0].init.method).toBe("POST");
    // Without the installation token the server matches on the endpoint, which
    // by definition just changed — leaving the dead record beside the live one.
    const body = JSON.parse(String(worker.fetchCalls[0].init.body)) as { installationId?: string; endpoint?: string };
    expect(body.installationId).toBe("install-1");
    expect(body.endpoint).toBe("https://web.push.apple.com/rotated");
    expect(worker.warnings).toEqual([]);
  });

  it("uses a replacement the browser supplies instead of subscribing again", async () => {
    const worker = await runServiceWorker({ identity: { installationId: "install-1", applicationServerKey: "BFakeKey_-" } });

    await worker.dispatch("pushsubscriptionchange", {
      newSubscription: { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/handed-over", keys: { p256dh: "p", auth: "a" } }) },
      oldSubscription: null,
    });

    expect(worker.subscribeCalls).toHaveLength(0);
    const body = JSON.parse(String(worker.fetchCalls[0].init.body)) as { endpoint?: string; installationId?: string };
    expect(body.endpoint).toBe("https://fcm.googleapis.com/handed-over");
    expect(body.installationId).toBe("install-1");
  });

  it("prefers the key the expiring subscription carries over the mirrored copy", async () => {
    const worker = await runServiceWorker({ identity: { installationId: "install-1", applicationServerKey: "BFakeKey_-" } });
    const key = new Uint8Array([1, 2, 3]);

    await worker.dispatch("pushsubscriptionchange", {
      newSubscription: null,
      oldSubscription: { options: { applicationServerKey: key } },
    });

    expect(worker.subscribeCalls[0].applicationServerKey).toBe(key);
  });

  it("fails quietly when there is nothing to re-subscribe with", async () => {
    const worker = await runServiceWorker({ identity: undefined });

    await worker.dispatch("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });

    expect(worker.subscribeCalls).toHaveLength(0);
    expect(worker.fetchCalls).toHaveLength(0);
    // Recorded, never rethrown: an unhandled rejection here would take down
    // unrelated push handling, and re-saving Settings is still the fallback.
    expect(worker.warnings).toHaveLength(1);
    expect(String(worker.warnings[0][0])).toContain("[web-push]");
  });

  it("does not throw when the server rejects the re-registration", async () => {
    const worker = await runServiceWorker({
      identity: { installationId: "install-1", applicationServerKey: "BFakeKey_-" },
      fetchResponse: async () => ({ ok: false, status: 503 }),
    });

    await worker.dispatch("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });

    expect(worker.warnings).toHaveLength(1);
    expect(String(worker.warnings[0][1])).toContain("503");
  });

  it("still re-registers when the mirrored identity predates installation tracking", async () => {
    const worker = await runServiceWorker({ identity: { applicationServerKey: "BFakeKey_-" } });

    await worker.dispatch("pushsubscriptionchange", { newSubscription: null, oldSubscription: null });

    const body = JSON.parse(String(worker.fetchCalls[0].init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("installationId");
    expect(body.endpoint).toBe("https://web.push.apple.com/rotated");
  });
});

const nativeFetch = globalThis.fetch;

async function withNotificationRoutes(
  run: (baseUrl: string, store: PushSubscriptionStore) => Promise<void>,
): Promise<void> {
  const file = path.join(os.tmpdir(), `dca-web-push-routes-${process.pid}-${Date.now()}.json`);
  const store = new PushSubscriptionStore(file);
  const vapid = webpush.generateVAPIDKeys();
  vi.stubEnv("VAPID_PUBLIC_KEY", vapid.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", vapid.privateKey);
  vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");
  
  const app = express();
  app.use(express.json());
  const preferences = {
    read: async () => normalizePreferences({ webPush: { enabled: true } }),
    write: async (value: unknown) => normalizePreferences(value),
  } as PreferenceStore;
  const history = new HistoryStore(path.join(os.tmpdir(), `dca-routes-history-${process.pid}-${Date.now()}.json`));
  app.use("/api", notificationRoutes(preferences, history, store));
  
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`, store);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("push subscription routes", () => {
  it("lists summaries without leaking endpoint or keys", async () => {
    await withNotificationRoutes(async (baseUrl, store) => {
      await store.add({
        endpoint: "https://fcm.googleapis.com/secret-endpoint-1",
        keys: { p256dh: "secret-key-1", auth: "secret-auth-1" },
      });
      await store.add({
        endpoint: "https://fcm.googleapis.com/secret-endpoint-2",
        keys: { p256dh: "secret-key-2", auth: "secret-auth-2" },
      });
      
      const response = await nativeFetch(`${baseUrl}/api/notifications/push-subscriptions`);
      expect(response.status).toBe(200);
      
      const data = await response.json() as { subscriptions: Array<{ id: string; addedAt: number; label: string }> };
      expect(data.subscriptions).toHaveLength(2);
      
      // Verify only safe fields are present
      for (const sub of data.subscriptions) {
        expect(sub).toHaveProperty("id");
        expect(sub).toHaveProperty("addedAt");
        expect(sub).toHaveProperty("label");
        expect(Object.keys(sub)).toEqual(["id", "addedAt", "label", "platform"]);
      }
      
      // Verify endpoint and keys are not in the response
      const json = JSON.stringify(data);
      expect(json).not.toContain("secret-endpoint");
      expect(json).not.toContain("secret-key");
      expect(json).not.toContain("secret-auth");
      expect(json).not.toContain("p256dh");
    });
  });

  it("removes subscription by ID", async () => {
    await withNotificationRoutes(async (baseUrl, store) => {
      await store.add({
        endpoint: "https://fcm.googleapis.com/device-1",
        keys: { p256dh: "key-1", auth: "auth" },
      });
      await store.add({
        endpoint: "https://fcm.googleapis.com/device-2",
        keys: { p256dh: "key-2", auth: "auth" },
      });
      
      const summaries = await store.summaries();
      expect(summaries).toHaveLength(2);
      
      const response = await nativeFetch(
        `${baseUrl}/api/notifications/push-subscriptions/${encodeURIComponent(summaries[0].id)}`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(204);
      
      const remaining = await store.list();
      expect(remaining).toHaveLength(1);
    });
  });

  it("removes all subscriptions", async () => {
    await withNotificationRoutes(async (baseUrl, store) => {
      await store.add({
        endpoint: "https://fcm.googleapis.com/device-1",
        keys: { p256dh: "key-1", auth: "auth" },
      });
      await store.add({
        endpoint: "https://fcm.googleapis.com/device-2",
        keys: { p256dh: "key-2", auth: "auth" },
      });
      
      expect(await store.list()).toHaveLength(2);
      
      const response = await nativeFetch(
        `${baseUrl}/api/notifications/push-subscriptions/all`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(204);
      
      expect(await store.list()).toHaveLength(0);
    });
  });
});

describe("VAPID key binding", () => {
  it("only reuses a subscription that carries the server's current key", () => {
    const current = webpush.generateVAPIDKeys().publicKey;
    const superseded = webpush.generateVAPIDKeys().publicKey;
    const subscription = (key: ArrayBuffer | null) =>
      ({ options: { applicationServerKey: key } }) as unknown as Parameters<typeof matchesApplicationServerKey>[0];
    const asBuffer = (value: string) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    };

    expect(matchesApplicationServerKey(subscription(asBuffer(current)), current)).toBe(true);
    // Apple answers 403 BadJwtToken rather than 410, so a subscription minted
    // under a superseded key is never retired by delivery failure alone.
    expect(matchesApplicationServerKey(subscription(asBuffer(superseded)), current)).toBe(false);
    // Unreportable keys count as mismatched: silently keeping one that cannot be
    // proven current is the failure this guards.
    expect(matchesApplicationServerKey(subscription(null), current)).toBe(false);
  });
});
