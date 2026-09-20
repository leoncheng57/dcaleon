import { readCredentialHealth, isAlertable, type CredentialHealth, type CredentialState } from "./credentialHealth.js";
import type { PushSubscriptionStore } from "../notifications/webpush.js";
import { sendWebPush, webPushConfig } from "../notifications/webpush.js";

// The failure this exists for: on a headless host an unreadable Claude
// credential store stops every turn and tells nobody. The laptop had a human
// in front of it; the cloud box does not.
//
// Edge-triggered, not level-triggered. A box whose credentials are gone stays
// that way until someone logs in again, so alerting on the *state* would push
// once an hour forever and get muted. Alerting on the *transition* pushes once
// and then stays quiet until it recovers — which also makes recovery worth
// announcing, because otherwise the only way to learn the box is healthy again
// is to go and look.

export const DEFAULT_PROBE_INTERVAL_MS = 60 * 60 * 1000;

export interface CredentialWatchOptions {
  subscriptions: Pick<PushSubscriptionStore, "list">;
  /** Absent on a host that does not run the Claude island; the watch stays idle. */
  available: boolean;
  intervalMs?: number;
  /** Seam for tests; defaults to the real probe. */
  probe?: () => Promise<CredentialHealth>;
  send?: typeof sendWebPush;
  config?: () => ReturnType<typeof webPushConfig>;
  log?: (message: string) => void;
}

export interface Transition {
  from: CredentialState | null;
  to: CredentialState;
  alert: boolean;
  recovered: boolean;
}

/**
 * Pure, so every branch is testable without a timer or a push endpoint.
 * The first observation never alerts on a healthy state but does alert on a
 * broken one: a BFF that starts up with no credentials has a problem worth
 * hearing about immediately, not at the next state change.
 */
export function classifyTransition(previous: CredentialState | null, next: CredentialState): Transition {
  if (previous === next) return { from: previous, to: next, alert: false, recovered: false };
  const alert = isAlertable(next);
  const recovered = previous !== null && isAlertable(previous) && !isAlertable(next);
  return { from: previous, to: next, alert, recovered };
}

export function alertMessage(health: CredentialHealth): { title: string; body: string } {
  return {
    title: "Claude credentials unreadable",
    // The path is the whole diagnosis on a headless host, so it goes in the body.
    body: `Every Claude turn will fail until this is fixed. ${health.path ?? "credential store"}: ${health.reason ?? "unknown error"}`,
  };
}

export function recoveryMessage(): { title: string; body: string } {
  return { title: "Claude credentials readable again", body: "Turns can run. No action needed." };
}

export class CredentialWatch {
  private timer: NodeJS.Timeout | null = null;
  private last: CredentialState | null = null;
  private readonly intervalMs: number;
  private readonly probe: () => Promise<CredentialHealth>;
  private readonly send: typeof sendWebPush;
  private readonly config: () => ReturnType<typeof webPushConfig>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: CredentialWatchOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.probe = options.probe ?? (() => readCredentialHealth({ available: options.available }));
    this.send = options.send ?? sendWebPush;
    this.config = options.config ?? webPushConfig;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** The most recent observation, for `/api/health`. */
  state(): CredentialState | null {
    return this.last;
  }

  async check(): Promise<Transition> {
    const health = await this.probe();
    const transition = classifyTransition(this.last, health.state);
    this.last = health.state;
    if (transition.alert) {
      this.log(`[claude] credentials unreadable: ${health.reason ?? "unknown"} (${health.path ?? "unknown path"})`);
    } else if (transition.recovered) {
      this.log("[claude] credentials readable again");
    }
    if (transition.alert || transition.recovered) {
      await this.push(transition.alert ? alertMessage(health) : recoveryMessage());
    }
    return transition;
  }

  /**
   * A push that cannot be delivered must not take down the probe that produced
   * it: Web Push is optional configuration, and on a box with no VAPID keys or
   * no subscribed device this is simply a no-op with a log line.
   */
  private async push(message: { title: string; body: string }): Promise<void> {
    try {
      if (!this.config()) {
        this.log("[claude] no Web Push configuration — credential alert stays in the log only");
        return;
      }
      const subscriptions = await this.options.subscriptions.list();
      if (subscriptions.length === 0) {
        this.log("[claude] no push subscriptions — credential alert stays in the log only");
        return;
      }
      await this.send(subscriptions, { event: "error", priority: "high", ...message });
    } catch (err) {
      this.log(`[claude] credential alert push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(): void {
    if (this.timer || !this.options.available) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    // Never hold the process open for a diagnostic.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
