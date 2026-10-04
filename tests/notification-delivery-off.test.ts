import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationService } from "../server/notifications/service.js";
import { notificationDeliveryEnabled } from "../server/notifications/delivery.js";
import { HistoryStore } from "../server/notifications/history.js";
import { normalizePreferences, PreferenceStore } from "../server/notifications/preferences.js";
import type { PushSubscriptionStore } from "../server/notifications/webpush.js";
import type { EventBus, OpencodeEvent } from "../server/opencode/events.js";
import type { SessionMetadata } from "../server/opencode/sessions.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let historySequence = 0;
function historyStore(): HistoryStore {
  const file = path.join(os.tmpdir(), `dca-history-off-${process.pid}-${(historySequence += 1)}-${Date.now()}.json`);
  return new HistoryStore(file);
}

function webPushPreferences(): PreferenceStore {
  return {
    read: async () => normalizePreferences({
      ntfy: { enabled: true, server: "https://ntfy.sh", topic: "team" },
      webPush: { enabled: true },
    }),
  } as PreferenceStore;
}

const rootSession = async (_directory: string, sessionID: string): Promise<SessionMetadata> => ({ id: sessionID });

function startService(deliveryEnabled: boolean) {
  const bus = new EventEmitter() as EventBus;
  const history = historyStore();
  const pushSubscriptions = { list: vi.fn(async () => []) };
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const recorded: OpencodeEvent[] = [];
  bus.on("event", (event: OpencodeEvent) => {
    if (event.type === "notification.recorded") recorded.push(event);
  });
  const service = new NotificationService(
    { baseUrl: "http://opencode.test" },
    bus,
    webPushPreferences(),
    history,
    null,
    undefined,
    rootSession,
    pushSubscriptions as unknown as PushSubscriptionStore,
    undefined,
    async () => false,
    deliveryEnabled,
  );
  service.start();
  return { bus, history, service, pushSubscriptions, fetchMock, recorded };
}

const idle = (directory: string, sessionID: string) => ({
  type: "session.idle",
  directory,
  properties: { sessionID },
});

const asked = (directory: string, sessionID: string) => ({
  type: "permission.asked",
  directory,
  properties: { sessionID, permission: "bash", requestID: "perm_1" },
});

describe("notificationDeliveryEnabled", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["on", true],
    ["true", true],
    ["1", true],
    ["banana", true],
    ["off", false],
    ["OFF", false],
    [" off ", false],
    ["false", false],
    ["0", false],
  ])("NOTIFICATION_DELIVERY=%j => %s", (value, expected) => {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) env.NOTIFICATION_DELIVERY = value;
    expect(notificationDeliveryEnabled(env)).toBe(expected);
  });
});

describe("delivery-disabled NotificationService", () => {
  it("never subscribes: no history, no push, no ntfy, no notification.recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bus, history, service, pushSubscriptions, fetchMock, recorded } = startService(false);

    bus.emit("event", asked("/tmp/project", "ses_a"));
    bus.emit("event", idle("/tmp/project", "ses_a"));
    // Give any wrongly-subscribed handler time to append.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await history.list()).toHaveLength(0);
    expect(pushSubscriptions.list).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("NOTIFICATION_DELIVERY=on");
    expect(() => service.stop()).not.toThrow();
  });

  it("positive control: an enabled service records and delivers the same events", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { bus, history, service, pushSubscriptions, recorded } = startService(true);

    bus.emit("event", idle("/tmp/project", "ses_b"));

    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    expect(pushSubscriptions.list).toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    service.stop();
  });
});
