import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publishDshRunEvents } from "../server/dsh/notifications.js";
import { NotificationService } from "../server/notifications/service.js";
import { HistoryStore } from "../server/notifications/history.js";
import { normalizePreferences, type PreferenceStore } from "../server/notifications/preferences.js";
import type { EventBus } from "../server/opencode/events.js";

afterEach(() => vi.unstubAllGlobals());

let sequence = 0;
function start() {
  const bus = new EventEmitter() as EventBus;
  const history = new HistoryStore(path.join(os.tmpdir(), `dca-dsh-notif-${process.pid}-${++sequence}-${Date.now()}.json`));
  const preferences = { read: async () => normalizePreferences({ ntfy: { enabled: true, server: "https://ntfy.sh", topic: "team" } }) } as PreferenceStore;
  const lookup = vi.fn(async () => { throw new Error("must not look up a local DSH session upstream"); });
  const service = new NotificationService({ baseUrl: "http://opencode.test" }, bus, preferences, history, null, undefined, lookup);
  service.start();
  return { bus, history, service, lookup };
}

const session = { id: "dsh-local-build", title: "Implement notification wiring" };
const directory = "/tmp/local-build";

describe("local DSH build notifications", () => {
  it("delivers a completed local build through the shared notification lane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const { bus, history, service, lookup } = start();
    publishDshRunEvents(bus, session, directory, "completed");
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    expect((await history.list())[0]).toMatchObject({ kind: "idle", sessionID: session.id, directory, sessionTitle: session.title });
    expect(lookup).not.toHaveBeenCalled();
    service.stop();
  });

  it("reports cancelled and failed local builds as abort and error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const { bus, history, service } = start();
    publishDshRunEvents(bus, { ...session, id: "dsh-cancelled" }, directory, "cancelled");
    publishDshRunEvents(bus, { ...session, id: "dsh-failed" }, directory, "failed");
    await vi.waitFor(async () => expect(await history.list()).toHaveLength(2));
    expect(Object.fromEntries((await history.list()).map((record) => [record.sessionID, record.kind])))
      .toEqual({ "dsh-cancelled": "abort", "dsh-failed": "error" });
    service.stop();
  });
});
