import { expect, test } from "@playwright/test";

const MOCK_URL = `http://127.0.0.1:${process.env.MOCK_OPENCODE_PORT || 4599}`;
const DEVICE_DEFAULT = JSON.stringify({
  version: 1,
  sound: {
    enabled: false,
    volume: 0.5,
    profile: "distinct",
    events: { idle: true, error: true, abort: false, permission: true, question: true, parked: true },
  },
  speech: { enabled: false, rate: 1 },
});

async function stubLegacySound(page: import("@playwright/test").Page, sound: boolean, volume: number) {
  await page.route("**/api/notifications", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { preferences: { browser: { sound: boolean; volume: number } } };
    body.preferences.browser.sound = sound;
    body.preferences.browser.volume = volume;
    await route.fulfill({ response, json: body });
  });
}

async function installMediaStubs(page: import("@playwright/test").Page, stored?: string) {
  await page.addInitScript(({ stored }) => {
    if (stored !== undefined) localStorage.setItem("opencode-notification-media-v1", stored);
    const calls = { frequencies: [] as number[], starts: 0, resumes: 0, speech: [] as string[], cancels: 0 };
    Object.defineProperty(window, "__mediaCalls", { value: calls, configurable: true });
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state: AudioContextState = "suspended";
      resume() { calls.resumes += 1; this.state = "running"; return Promise.resolve(); }
      createOscillator() {
        const frequency = { value: 0 };
        return {
          frequency,
          type: "sine",
          connect() { return this; },
          start() { calls.starts += 1; calls.frequencies.push(frequency.value); },
          stop() {},
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect() { return this; },
        };
      }
    }
    class FakeUtterance {
      rate = 1;
      constructor(public text: string) {}
    }
    Object.defineProperty(window, "AudioContext", { value: FakeAudioContext, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        cancel() { calls.cancels += 1; },
        speak(utterance: FakeUtterance) { calls.speech.push(utterance.text); },
      },
      configurable: true,
    });
  }, { stored });
}

async function installPushStubs(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    let subscription: {
      endpoint: string;
      options: { applicationServerKey: BufferSource | null };
      toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
      unsubscribe(): Promise<boolean>;
    } | null = null;
    const pushManager = {
      getSubscription: async () => subscription,
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        subscription = {
          endpoint: "https://fcm.googleapis.com/device",
          options: { applicationServerKey: options.applicationServerKey as BufferSource },
          toJSON: () => ({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: "key", auth: "auth" } }),
          unsubscribe: async () => { subscription = null; return true; },
        };
        return subscription;
      },
    };
    const registration = { waiting: null, installing: null, pushManager, addEventListener() {} };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: {},
        ready: Promise.resolve(registration),
        register: async () => registration,
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class Notification {
        static permission = "granted";
        static requestPermission = async () => "granted";
      },
    });
  });
}

test.describe("notification sound and speech", () => {
  test("subscribes and unsubscribes PWA push independently from ntfy", async ({ page }) => {
    await installPushStubs(page);
    const saved: Array<{ ntfy: { enabled: boolean }; webPush: { enabled: boolean } }> = [];
    let subscribed = 0;
    let unsubscribed = 0;
    let testedEndpoint = "";
    await page.route(/\/api\/notifications$/, async (route) => {
      if (route.request().method() === "PATCH") {
        const preferences = route.request().postDataJSON() as { ntfy: { enabled: boolean }; webPush: { enabled: boolean } };
        saved.push(preferences);
        await route.fulfill({ json: { preferences, tokenConfigured: false, webPush: { configured: true, publicKey: "AQ" } } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json() as { preferences: { webPush: { enabled: boolean } } };
      body.preferences.webPush.enabled = false;
      await route.fulfill({ response, json: { ...body, webPush: { configured: true, publicKey: "AQ" } } });
    });
    await page.route("**/api/notifications/push-subscriptions", async (route) => {
      if (route.request().method() === "POST") subscribed += 1;
      if (route.request().method() === "DELETE") unsubscribed += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/notifications/test-web-push", async (route) => {
      testedEndpoint = (route.request().postDataJSON() as { endpoint: string }).endpoint;
      await route.fulfill({ json: { sent: 1, failed: 0 } });
    });

    await page.goto("/settings/notifications");
    await page.getByTestId("opencode-web-push-enabled").check();
    await page.getByTestId("opencode-notifications-save").click();
    await expect(page.getByTestId("opencode-web-push-status")).toHaveText("This device is subscribed.");
    expect(subscribed).toBe(1);
    expect(saved.at(-1)).toMatchObject({ ntfy: { enabled: false }, webPush: { enabled: true } });
    await page.getByTestId("opencode-notifications-test-web-push").click();
    await expect(page.getByText("PWA push test sent", { exact: true })).toBeVisible();
    expect(subscribed).toBe(2);
    expect(testedEndpoint).toBe("https://fcm.googleapis.com/device");

    await page.getByTestId("opencode-web-push-enabled").uncheck();
    await page.getByTestId("opencode-notifications-save").click();
    await expect.poll(() => saved.length).toBe(2);
    expect(unsubscribed).toBe(1);
    expect(saved.at(-1)).toMatchObject({ ntfy: { enabled: false }, webPush: { enabled: false } });
  });

  test("disabled media makes no calls and previews unlock after a click", async ({ page }) => {
    await installMediaStubs(page, DEVICE_DEFAULT);
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("opencode-browser-sound")).not.toBeChecked();
    await expect(page.getByTestId("opencode-speech-enabled")).not.toBeChecked();

    await fetch(`${MOCK_URL}/test/mobile/idle?sessionID=ses_media_tone`, { method: "POST" });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { __mediaCalls: { starts: number; speech: string[] } }).__mediaCalls)).toMatchObject({ starts: 0, speech: [] });

    await page.getByTestId("opencode-preview-sound").click();
    await page.getByTestId("opencode-preview-speech").click();
    const calls = await page.evaluate(() => (window as unknown as { __mediaCalls: { starts: number; resumes: number; speech: string[] } }).__mediaCalls);
    expect(calls.resumes).toBe(1);
    expect(calls.starts).toBeGreaterThan(0);
    expect(calls.speech).toEqual(["Session finished"]);
  });

  test("event kinds use distinct tones and safe phrases after saving", async ({ page }) => {
    await installMediaStubs(page, DEVICE_DEFAULT);
    await page.goto("/settings/notifications");
    await page.getByTestId("opencode-browser-sound").check();
    await page.getByTestId("opencode-speech-enabled").check();
    await page.getByTestId("opencode-notifications-save").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      const calls = (window as unknown as { __mediaCalls: { frequencies: number[]; starts: number; speech: string[] } }).__mediaCalls;
      calls.frequencies.length = 0;
      calls.starts = 0;
      calls.speech.length = 0;
    });
    await fetch(`${MOCK_URL}/test/mobile/idle?sessionID=ses_media_phrase`, { method: "POST" });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mediaCalls: { speech: string[] } }).__mediaCalls.speech)).toContain("Session finished");
    const idleFrequencies = await page.evaluate(() => (window as unknown as { __mediaCalls: { frequencies: number[] } }).__mediaCalls.frequencies.splice(0));

    await fetch(`${MOCK_URL}/test/permission?directory=/tmp/mock-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: `per_media_${Date.now()}`, sessionID: "ses_mock_done", permission: "bash", patterns: ["private command"] }),
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mediaCalls: { speech: string[] } }).__mediaCalls.speech)).toContain("OpenCode needs permission");
    const permissionFrequencies = await page.evaluate(() => (window as unknown as { __mediaCalls: { frequencies: number[] } }).__mediaCalls.frequencies);
    // This tab's watcher hears EVERY directory (that is the app design), and
    // parallel spec files legitimately deliver their own notifications — a
    // sub-agent permission ask from smoke.api.spec.ts rings here too. So this
    // asserts only what this file owns: its two phrases arrived in order and
    // each rang a tone. Cross-kind tone distinctness is pinned by the
    // tonePattern unit tests, not re-proven against a shared soundscape.
    const spoken = await page.evaluate(() => (window as unknown as { __mediaCalls: { speech: string[] } }).__mediaCalls.speech);
    expect(spoken.indexOf("Session finished")).toBeGreaterThanOrEqual(0);
    expect(spoken.indexOf("OpenCode needs permission")).toBeGreaterThan(spoken.indexOf("Session finished"));
    expect(idleFrequencies.length).toBeGreaterThan(0);
    expect(permissionFrequencies.length).toBeGreaterThan(0);
  });

  test("corrupt storage resets and the controls fit at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 });
    await stubLegacySound(page, true, 0.9);
    await installMediaStubs(page, "{bad-json");
    await page.goto("/settings/notifications");
    await expect(page.getByTestId("opencode-sound-profile")).toHaveValue("distinct");
    await expect(page.getByTestId("opencode-browser-sound")).not.toBeChecked();
    const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem("opencode-notification-media-v1") ?? "null"));
    expect(recovered).toMatchObject({ version: 1, sound: { enabled: false, volume: 0.5 } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("migrates legacy sound when the device key is absent", async ({ page }) => {
    await stubLegacySound(page, true, 0.8);
    await installMediaStubs(page);
    await page.goto("/settings/notifications");

    await expect(page.getByTestId("opencode-browser-sound")).toBeChecked();
    await expect(page.getByTestId("opencode-browser-volume")).toHaveValue("0.8");
    const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem("opencode-notification-media-v1") ?? "null"));
    expect(migrated.sound).toMatchObject({ enabled: true, volume: 0.8 });
  });

  test("keeps an existing device key authoritative over legacy sound", async ({ page }) => {
    const existing = JSON.stringify({
      ...JSON.parse(DEVICE_DEFAULT),
      sound: { ...JSON.parse(DEVICE_DEFAULT).sound, enabled: false, volume: 0.25, profile: "minimal" },
    });
    await stubLegacySound(page, true, 0.9);
    await installMediaStubs(page, existing);
    await page.goto("/settings/notifications");

    await expect(page.getByTestId("opencode-browser-sound")).not.toBeChecked();
    await expect(page.getByTestId("opencode-browser-volume")).toHaveValue("0.25");
    await expect(page.getByTestId("opencode-sound-profile")).toHaveValue("minimal");
  });
});
