import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyReadable, isAlertable, readCredentialHealth } from "../server/claude/credentialHealth.js";
import {
  CredentialWatch,
  alertMessage,
  classifyTransition,
  recoveryMessage,
} from "../server/claude/credentialWatch.js";
import { clearCachedToken } from "../server/claude/auth.js";

const linux = { platform: "linux" as NodeJS.Platform };

async function credentialsDir(payload: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dcaleon-credhealth-"));
  await writeFile(path.join(dir, ".credentials.json"), payload, { mode: 0o600 });
  return dir;
}

function oauth(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt } });
}

afterEach(() => clearCachedToken());

describe("what counts as a credential problem", () => {
  // The whole point of the module. A days-wide expiry threshold would be
  // tripped permanently, because the access token only lives about eight hours.
  it("never treats expiry as alertable, however far past it is", () => {
    expect(isAlertable("ok")).toBe(false);
    expect(isAlertable("stale")).toBe(false);
    expect(isAlertable("unchecked")).toBe(false);
    expect(isAlertable("missing")).toBe(true);
  });

  it("calls a lapsed access token stale, not broken", () => {
    const now = Date.UTC(2026, 8, 20, 12, 0, 0);
    expect(classifyReadable({ expiresAt: now + 60_000, now })).toBe("ok");
    expect(classifyReadable({ expiresAt: now - 60_000, now })).toBe("stale");
  });

  // An absent expiry is not a failure: macOS reports none by design, because
  // re-shelling to the Keychain every probe is not worth the diagnostic.
  it("treats an unknown expiry as ok rather than inventing a verdict", () => {
    const now = Date.now();
    expect(classifyReadable({ expiresAt: null, now })).toBe("ok");
    expect(classifyReadable({ now })).toBe("ok");
  });
});

describe("reading the store", () => {
  it("reports ok with the expiry and the refresh time", async () => {
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const dir = await credentialsDir(oauth(expiresAt));
    const health = await readCredentialHealth({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } });
    expect(health.state).toBe("ok");
    expect(health.expiresAt).toBe(new Date(expiresAt).toISOString());
    expect(health.expiresInMs).toBeGreaterThan(0);
    expect(health.refreshedAt).not.toBeNull();
  });

  it("reports stale once the access token has lapsed", async () => {
    const dir = await credentialsDir(oauth(Date.now() - 60_000));
    const health = await readCredentialHealth({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } });
    expect(health.state).toBe("stale");
    expect(health.expiresInMs).toBeLessThan(0);
  });

  // The headless case: nobody has run `claude` `/login` on this box.
  it("reports missing and names the path when the file is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcaleon-credhealth-"));
    const health = await readCredentialHealth({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } });
    expect(health.state).toBe("missing");
    expect(health.path).toBe(path.join(dir, ".credentials.json"));
    expect(health.reason).toContain("Credentials file read failed");
  });

  it("reports missing when the JSON carries no access token", async () => {
    const dir = await credentialsDir(JSON.stringify({ claudeAiOauth: {} }));
    const health = await readCredentialHealth({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } });
    expect(health.state).toBe("missing");
  });

  it("stays quiet on a host that does not run the Claude island", async () => {
    const health = await readCredentialHealth({ ...linux, available: false });
    expect(health.state).toBe("unchecked");
    expect(health.reason).toContain("unavailable on this host");
  });

  // It runs on a timer; throwing would take the BFF down on a schedule.
  it("never throws, whatever the store contains", async () => {
    const dir = await credentialsDir("{ not json");
    await expect(readCredentialHealth({ ...linux, env: { CLAUDE_CONFIG_DIR: dir } })).resolves.toMatchObject({ state: "missing" });
  });
});

describe("alerting on the transition, not the state", () => {
  it("alerts once entering missing and stays quiet while it persists", () => {
    expect(classifyTransition("ok", "missing")).toMatchObject({ alert: true, recovered: false });
    expect(classifyTransition("missing", "missing")).toMatchObject({ alert: false, recovered: false });
  });

  it("announces recovery, because nothing else would", () => {
    expect(classifyTransition("missing", "ok")).toMatchObject({ alert: false, recovered: true });
  });

  // A BFF that starts with no credentials has a problem worth hearing about
  // now, not at whatever the next state change happens to be.
  it("alerts on a first observation that is already broken", () => {
    expect(classifyTransition(null, "missing")).toMatchObject({ alert: true });
    expect(classifyTransition(null, "ok")).toMatchObject({ alert: false });
  });

  it("does not alert moving between ok and stale", () => {
    expect(classifyTransition("ok", "stale").alert).toBe(false);
    expect(classifyTransition("stale", "ok").alert).toBe(false);
  });

  it("puts the diagnosis in the alert body, where a phone will show it", () => {
    const message = alertMessage({
      state: "missing", source: "file", path: "/home/dcaleon/.claude/.credentials.json",
      expiresAt: null, expiresInMs: null, refreshedAt: null, reason: "ENOENT",
    });
    expect(message.body).toContain("/home/dcaleon/.claude/.credentials.json");
    expect(message.body).toContain("ENOENT");
    expect(recoveryMessage().body).toContain("No action needed");
  });
});

describe("the watch", () => {
  function watch(states: Array<"ok" | "missing">, overrides = {}) {
    let index = 0;
    const sent: Array<{ title: string }> = [];
    const instance = new CredentialWatch({
      subscriptions: { list: async () => [{ endpoint: "https://example.test/x" } as never] },
      available: true,
      probe: async () => ({
        state: states[Math.min(index++, states.length - 1)],
        source: "file", path: "/tmp/.credentials.json",
        expiresAt: null, expiresInMs: null, refreshedAt: null, reason: "boom",
      }),
      config: () => ({ subject: "mailto:a@b.c", publicKey: "k", privateKey: "p" }),
      send: (async (_subs: unknown, message: { title: string }) => {
        sent.push(message);
        return { sent: 1, failed: 0, expired: [], failures: [] };
      }) as never,
      log: () => {},
      ...overrides,
    });
    return { instance, sent };
  }

  it("pushes once for a persistent failure, not once per probe", async () => {
    const { instance, sent } = watch(["missing", "missing", "missing"]);
    await instance.check();
    await instance.check();
    await instance.check();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Claude credentials unreadable");
  });

  it("pushes again when it recovers", async () => {
    const { instance, sent } = watch(["missing", "ok"]);
    await instance.check();
    await instance.check();
    expect(sent.map((m) => m.title)).toEqual(["Claude credentials unreadable", "Claude credentials readable again"]);
  });

  it("exposes the last observation for /api/health", async () => {
    const { instance } = watch(["missing"]);
    expect(instance.state()).toBeNull();
    await instance.check();
    expect(instance.state()).toBe("missing");
  });

  // Web Push is optional configuration. A box without it still logs, and the
  // probe must not fail because delivery is impossible.
  it("degrades to the log when Web Push is unconfigured", async () => {
    const logged: string[] = [];
    const { instance, sent } = watch(["missing"], { config: () => null, log: (m: string) => logged.push(m) });
    await expect(instance.check()).resolves.toMatchObject({ alert: true });
    expect(sent).toHaveLength(0);
    expect(logged.join(" ")).toContain("no Web Push configuration");
  });

  it("survives a push that throws", async () => {
    const { instance } = watch(["missing"], {
      send: async () => { throw new Error("endpoint gone"); },
    });
    await expect(instance.check()).resolves.toMatchObject({ alert: true });
  });

  it("stays idle on a host without the Claude island", () => {
    const probe = vi.fn();
    const instance = new CredentialWatch({
      subscriptions: { list: async () => [] },
      available: false,
      probe: probe as never,
    });
    instance.start();
    expect(probe).not.toHaveBeenCalled();
    instance.stop();
  });
});
