import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publishClaudeRunEvents } from "../server/claude/notifications.js";
import { NotificationService } from "../server/notifications/service.js";
import { HistoryStore } from "../server/notifications/history.js";
import { normalizePreferences, PreferenceStore } from "../server/notifications/preferences.js";
import type { EventBus } from "../server/opencode/events.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

let sequence = 0;
function start(publicAppUrl: string | null = null) {
  // Any OpenCode round trip here is a failure: the point of the seeding event is
  // that the service never has to ask OpenCode about a Claude session.
  const lookup = vi.fn(async () => { throw new Error("must not look up a Claude session upstream"); });
  const excerpt = vi.fn(async () => "Both edits are in.");
  const bus = new EventEmitter() as EventBus;
  const history = new HistoryStore(path.join(os.tmpdir(), `dca-claude-notif-${process.pid}-${(sequence += 1)}-${Date.now()}.json`));
  const preferences = { read: async () => normalizePreferences({ ntfy: { enabled: true, server: "https://ntfy.sh", topic: "team" } }) } as PreferenceStore;
  const service = new NotificationService({ baseUrl: "http://opencode.test" }, bus, preferences, history, publicAppUrl, undefined, lookup, undefined, excerpt);
  service.start();
  return { bus, history, service, lookup };
}

const session = { id: "claude-0f3c", title: "Add a shout() helper", directory: "/tmp/scratch" };

describe("Claude run notifications", () => {
  it("reports a completed turn as a root session idle, titled from the Claude store, without asking OpenCode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const { bus, history, service, lookup } = start();

    publishClaudeRunEvents(bus, session, "completed");

    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    const [record] = await history.list();
    expect(record).toMatchObject({ kind: "idle", sessionID: "claude-0f3c", directory: "/tmp/scratch", sessionTitle: "Add a shout() helper" });
    expect(record.delivery.suppressed).toBeUndefined();
    expect(record.detail).toBe("Both edits are in.");
    expect(lookup).not.toHaveBeenCalled();
    service.stop();
  });

  it("reports a cancelled turn as an abort and a failed turn as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const { bus, history, service } = start();

    publishClaudeRunEvents(bus, { ...session, id: "claude-stopped" }, "cancelled");
    publishClaudeRunEvents(bus, { ...session, id: "claude-broken" }, "failed");

    await vi.waitFor(async () => expect(await history.list()).toHaveLength(2));
    const kinds = Object.fromEntries((await history.list()).map((record) => [record.sessionID, record.kind]));
    expect(kinds).toEqual({ "claude-stopped": "abort", "claude-broken": "error" });
    service.stop();
  });

  it("links the outbound click to the Claude surface when a public URL is configured", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { bus, history, service } = start("https://ide.example.test");

    publishClaudeRunEvents(bus, session, "completed");

    await vi.waitFor(async () => expect(await history.list()).toHaveLength(1));
    expect((await history.list())[0].click).toBe("https://ide.example.test/claude/sessions/claude-0f3c");
    service.stop();
  });

  it("publishes nothing for a turn that is still running", () => {
    const bus = new EventEmitter();
    const emit = vi.spyOn(bus, "emit");
    publishClaudeRunEvents(bus, session, "running");
    expect(emit).not.toHaveBeenCalled();
  });
});
