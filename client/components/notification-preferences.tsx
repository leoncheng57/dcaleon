import { useEffect, useRef, useState } from "react";

import { Alert } from "../ds/alert.js";
import { Button } from "../ds/button.js";
import { api, type NotificationPreferences, type NotifyEvent, type PushSubscriptionSummary } from "../lib/api.js";
import {
  initializeDeviceNotificationPreferences,
  loadDeviceNotificationPreferences,
  NOTIFICATION_MEDIA_CHANGE_EVENT,
  saveDeviceNotificationPreferences,
  SOUND_PROFILES,
  type DeviceNotificationPreferences,
} from "../lib/notificationMedia.js";
import {
  notificationCapabilities,
  previewNotificationSound,
  previewNotificationSpeech,
} from "../lib/notificationMediaBrowser.js";
import {
  NEVER_DELIVERED,
  NOTIFY_EVENT_CATALOGUE,
  NOTIFY_EVENT_GROUPS,
  notifyEventsInGroup,
  RECOMMENDED_NOTIFY_EVENTS,
} from "../lib/notificationEvents.js";
import { notifyBrowser } from "../lib/useNotifyWatcher.js";
import { currentInstallationId, currentPushSubscription, subscribeWebPush, unsubscribeWebPush, webPushSupported } from "../lib/webPush.js";

const EVENTS: NotifyEvent[] = NOTIFY_EVENT_CATALOGUE.map((descriptor) => descriptor.event);

/**
 * Delivery preferences for notifications. Lives beside notification history at
 * /settings/notifications: the inbox and the controls that decide what reaches
 * it form one coherent notification centre, while /settings stays focused on
 * global OpenCode agent defaults.
 */
export function NotificationPreferencesSection() {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [devicePreferences, setDevicePreferences] = useState<DeviceNotificationPreferences>(() => loadDeviceNotificationPreferences().preferences);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [webPush, setWebPush] = useState<{ configured: boolean; publicKey: string | null }>({ configured: false, publicKey: null });
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null);
  const [pushSubscriptions, setPushSubscriptions] = useState<PushSubscriptionSummary[]>([]);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const saving = useRef(false);
  const [savePending, setSavePending] = useState(false);
  const capabilities = notificationCapabilities();

  const loadSubscriptions = async () => {
    try {
      const result = await api.listPushSubscriptions();
      setPushSubscriptions(result.subscriptions);
      // Summaries carry the opaque installation token the browser minted for
      // itself, so this device can recognise its own row without the server
      // ever disclosing an endpoint or key.
      setInstallationId(currentInstallationId());
    } catch {
      // Don't error out the whole preferences page if listing fails
      setPushSubscriptions([]);
    }
  };

  useEffect(() => {
    void api.notifications().then((result) => {
      setPreferences(result.preferences);
      setDevicePreferences(initializeDeviceNotificationPreferences(result.preferences.browser).preferences);
      setTokenConfigured(result.tokenConfigured);
      setWebPush(result.webPush);
      void currentPushSubscription().then((subscription) => {
        setPushSubscribed(Boolean(subscription));
        setPushEndpoint(subscription?.endpoint ?? null);
      }).catch(() => {
        setPushSubscribed(false);
        setPushEndpoint(null);
      });
      void loadSubscriptions();
    }).catch((e: Error) => setError(e.message));
  }, []);

  const save = async () => {
    if (!preferences || saving.current) return;
    saving.current = true;
    setSavePending(true);
    setError("");
    setMessage("");
    let previousSubscription: PushSubscription | null = null;
    let createdSubscription = false;
    let subscriptionChanged = false;
    try {
      if (preferences.webPush.enabled || pushSubscribed) {
        previousSubscription = await currentPushSubscription();
      }
      if (preferences.webPush.enabled) {
        if (!webPush.publicKey) throw new Error("Web Push is not configured on the server");
        const subscription = await subscribeWebPush(webPush.publicKey);
        createdSubscription = previousSubscription === null;
        subscriptionChanged = createdSubscription;
        setPushSubscribed(true);
        setPushEndpoint(subscription.endpoint);
      } else {
        await unsubscribeWebPush();
        subscriptionChanged = previousSubscription !== null;
        setPushSubscribed(false);
        setPushEndpoint(null);
      }
      const result = await api.saveNotifications(preferences);
      setPreferences(result.preferences);
      const savedDevicePreferences = saveDeviceNotificationPreferences(devicePreferences);
      setDevicePreferences(savedDevicePreferences);
      window.dispatchEvent(new Event("opencode-notification-preferences"));
      window.dispatchEvent(new CustomEvent(NOTIFICATION_MEDIA_CHANGE_EVENT, { detail: savedDevicePreferences }));
      setMessage("Saved");
    } catch (e) {
      // Keep the per-device subscription aligned with the last persisted
      // server preference when the second half of a save fails.
      try {
        if (preferences.webPush.enabled && createdSubscription) {
          await unsubscribeWebPush();
        } else if (!preferences.webPush.enabled && previousSubscription && webPush.publicKey) {
          await subscribeWebPush(webPush.publicKey);
        }
        if (subscriptionChanged) {
          const restored = await currentPushSubscription();
          setPushSubscribed(Boolean(restored));
          setPushEndpoint(restored?.endpoint ?? null);
        }
      } catch {
        // The original error remains the actionable failure; retrying Save
        // reconciles an incomplete rollback because every operation is idempotent.
      }
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setSavePending(false);
    }
  };

  const testBrowser = async () => {
    if (!preferences) return;
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    notifyBrowser(preferences, "idle", "OpenCode notification test", undefined, devicePreferences);
    setMessage("Browser test triggered");
  };

  const testWebPush = async () => {
    if (!webPush.publicKey) return;
    setError("");
    setMessage("");
    try {
      // iOS may rotate a PWA's endpoint. Re-register the subscription visible
      // to this worker immediately before the probe so a stale server record
      // cannot make the provider report success while the phone receives
      // nothing.
      const subscription = await subscribeWebPush(webPush.publicKey);
      setPushSubscribed(true);
      setPushEndpoint(subscription.endpoint);
      await api.testWebPush(subscription.endpoint);
      await loadSubscriptions();
      setMessage("PWA push test sent");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeSubscription = async (id: string) => {
    try {
      await api.removePushSubscriptionById(id);
      await loadSubscriptions();
      setMessage("Subscription removed");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeAllSubscriptions = async () => {
    const count = pushSubscriptions.length;
    if (count === 0) return;
    if (!window.confirm(`Remove all ${count} registered device${count === 1 ? "" : "s"}? You can re-subscribe later.`)) return;
    try {
      await api.removeAllPushSubscriptions();
      await loadSubscriptions();
      setMessage("All subscriptions removed");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="space-y-5" data-testid="opencode-notification-preferences">
      <header>
        <h2 className="text-lg font-bold">Delivery settings</h2>
        <p className="text-sm text-[var(--color-text-muted)]">
          Pick which events reach you through this browser, PWA push, and ntfy.
        </p>
      </header>
      {error && <Alert variant="danger">{error}</Alert>}
      {preferences && (
        <>
          <section className="space-y-3 rounded-lg border border-[var(--color-border-default)] p-4">
            <h3 className="font-semibold">Delivery</h3>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.ntfy.enabled} onChange={(e) => setPreferences({ ...preferences, ntfy: { ...preferences.ntfy, enabled: e.target.checked } })} data-testid="opencode-ntfy-enabled" />ntfy enabled</label>
            <label className="block text-sm"><span className="mb-1 block">Server (configured by NTFY_SERVER)</span><input value={preferences.ntfy.server} readOnly className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)] p-2 text-[var(--color-text-muted)]" data-testid="opencode-ntfy-server" /></label>
            <label className="block text-sm"><span className="mb-1 block">Topic</span><input value={preferences.ntfy.topic} onChange={(e) => setPreferences({ ...preferences, ntfy: { ...preferences.ntfy, topic: e.target.value } })} className="w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2" data-testid="opencode-ntfy-topic" /></label>
            <p className="text-xs text-[var(--color-text-muted)]">Token: {tokenConfigured ? "configured in the environment" : "not configured"}</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={preferences.webPush.enabled}
                disabled={!webPush.configured || !webPushSupported()}
                onChange={(e) => setPreferences({ ...preferences, webPush: { ...preferences.webPush, enabled: e.target.checked } })}
                data-testid="opencode-web-push-enabled"
              />
              PWA push enabled
            </label>
            <p className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-web-push-status">
              {!webPush.configured
                ? "Web Push is not configured on the server."
                : !webPushSupported()
                  ? "PWA push requires a secure origin and browser push support."
                  : pushSubscribed
                    ? "This device is subscribed."
                    : "This device will subscribe when you enable PWA push and save."}
            </p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={preferences.browser.desktop} onChange={(e) => setPreferences({ ...preferences, browser: { ...preferences.browser, desktop: e.target.checked } })} data-testid="opencode-browser-desktop" />Desktop notifications</label>
            <p className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-notification-capability">
              Desktop notifications: {capabilities.desktop ? capabilities.desktopPermission : "unavailable in this browser"}.
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">On iPhone and iPad, install this app on the Home Screen before enabling PWA push. ntfy remains an independent fallback.</p>
            <label className="block text-sm"><span className="mb-1 block">Parked permission after seconds</span><input type="number" min="5" max="3600" value={preferences.parkedPermissionSeconds} onChange={(e) => setPreferences({ ...preferences, parkedPermissionSeconds: Number(e.target.value) })} className="w-full rounded-md border border-[var(--color-border-default)] bg-transparent p-2" data-testid="opencode-parked-seconds" /></label>
          </section>

          <section className="space-y-4 rounded-lg border border-[var(--color-border-default)] p-4" data-testid="opencode-notification-media">
            <div>
              <h3 className="font-semibold">Notification sound &amp; speech</h3>
              <p className="text-xs text-[var(--color-text-muted)]">These settings stay on this device. Spoken alerts use only generic status phrases.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-3 rounded-md bg-[var(--color-background-surface-neutral-muted)] p-3">
                <label className="flex items-center justify-between gap-3 text-sm font-medium">
                  Sound
                  <input type="checkbox" checked={devicePreferences.sound.enabled} disabled={!capabilities.audio} onChange={(e) => setDevicePreferences({ ...devicePreferences, sound: { ...devicePreferences.sound, enabled: e.target.checked } })} data-testid="opencode-browser-sound" />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 flex justify-between"><span>Volume</span><span>{Math.round(devicePreferences.sound.volume * 100)}%</span></span>
                  <input type="range" min="0" max="1" step="0.05" value={devicePreferences.sound.volume} disabled={!capabilities.audio} onChange={(e) => setDevicePreferences({ ...devicePreferences, sound: { ...devicePreferences.sound, volume: Number(e.target.value) } })} className="w-full" data-testid="opencode-browser-volume" />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block">Profile</span>
                  <select value={devicePreferences.sound.profile} disabled={!capabilities.audio} onChange={(e) => setDevicePreferences({ ...devicePreferences, sound: { ...devicePreferences.sound, profile: e.target.value as DeviceNotificationPreferences["sound"]["profile"] } })} className="w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-background-surface)] p-2 capitalize" data-testid="opencode-sound-profile">
                    {SOUND_PROFILES.map((profile) => <option key={profile} value={profile}>{profile}</option>)}
                  </select>
                </label>
                <Button size="sm" variant="secondary" disabled={!capabilities.audio} onClick={() => void previewNotificationSound(devicePreferences).then((played) => setMessage(played ? "Sound preview played" : "Sound preview unavailable")).catch(() => setMessage("Sound preview unavailable"))} data-testid="opencode-preview-sound">Preview sound</Button>
                <p className="text-xs text-[var(--color-text-muted)]">{capabilities.audio ? "Audio starts after you interact with this page." : "WebAudio is unavailable in this browser."}</p>
              </div>

              <div className="space-y-3 rounded-md bg-[var(--color-background-surface-neutral-muted)] p-3">
                <label className="flex items-center justify-between gap-3 text-sm font-medium">
                  Speak session status
                  <input type="checkbox" checked={devicePreferences.speech.enabled} disabled={!capabilities.speech} onChange={(e) => setDevicePreferences({ ...devicePreferences, speech: { ...devicePreferences.speech, enabled: e.target.checked } })} data-testid="opencode-speech-enabled" />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 flex justify-between"><span>Speech rate</span><span>{devicePreferences.speech.rate.toFixed(1)}x</span></span>
                  <input type="range" min="0.7" max="1.3" step="0.1" value={devicePreferences.speech.rate} disabled={!capabilities.speech} onChange={(e) => setDevicePreferences({ ...devicePreferences, speech: { ...devicePreferences.speech, rate: Number(e.target.value) } })} className="w-full" data-testid="opencode-speech-rate" />
                </label>
                <Button size="sm" variant="secondary" disabled={!capabilities.speech} onClick={() => setMessage(previewNotificationSpeech(devicePreferences) ? "Speech preview played" : "Speech preview unavailable")} data-testid="opencode-preview-speech">Preview speech</Button>
                <p className="text-xs text-[var(--color-text-muted)]">{capabilities.speech ? "New speech replaces any status still being spoken." : "Speech synthesis is unavailable in this browser."}</p>
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Sound by event</legend>
              <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                {NOTIFY_EVENT_CATALOGUE.map(({ event, label }) => (
                  <label key={event} className="flex min-w-0 items-center gap-2 text-sm">
                    <input type="checkbox" checked={devicePreferences.sound.events[event]} disabled={!capabilities.audio} onChange={(e) => setDevicePreferences({ ...devicePreferences, sound: { ...devicePreferences.sound, events: { ...devicePreferences.sound.events, [event]: e.target.checked } } })} data-testid={`opencode-sound-event-${event}`} />
                    <span className="truncate">{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          {webPush.configured && (
            <section className="space-y-3 rounded-lg border border-[var(--color-border-default)] p-4" data-testid="opencode-registered-devices">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">Registered devices</h3>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Devices subscribed to receive PWA push notifications. A device that rotates its
                    subscription re-registers itself in place; a reinstall creates a new entry.
                  </p>
                </div>
                {pushSubscriptions.length > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void removeAllSubscriptions()}
                    data-testid="opencode-remove-all-subscriptions"
                  >
                    Remove all ({pushSubscriptions.length})
                  </Button>
                )}
              </div>
              {pushSubscriptions.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]" data-testid="opencode-no-subscriptions">
                  No devices are currently registered.
                </p>
              ) : (
                <div className="space-y-2">
                  {pushSubscriptions.map((subscription) => {
                    const isThisDevice = Boolean(installationId) && subscription.installationId === installationId;
                    return (
                    <div
                      key={subscription.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border-default)] p-3"
                      data-testid={`opencode-subscription-${subscription.id}`}
                      data-this-device={isThisDevice ? "true" : undefined}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm">{subscription.platform}</span>
                          {isThisDevice && (
                            <span
                              className="rounded-full bg-[var(--color-background-surface-info-muted)] px-2 py-0.5 text-xs text-[var(--color-text-info)]"
                              data-testid={`opencode-subscription-this-device-${subscription.id}`}
                            >
                              This device
                            </span>
                          )}
                          {!subscription.installationId && (
                            <span
                              className="rounded-full bg-[var(--color-background-surface-neutral-muted)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
                              title="Registered before this app tracked installations, so it cannot be matched to a device or replaced automatically."
                              data-testid={`opencode-subscription-legacy-${subscription.id}`}
                            >
                              Unlinked
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          Registered {new Date(subscription.addedAt).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void removeSubscription(subscription.id)}
                        data-testid={`opencode-remove-subscription-${subscription.id}`}
                      >
                        Remove
                      </Button>
                    </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <section
            className="space-y-3 rounded-lg border border-[var(--color-border-default)] p-4"
            data-testid="opencode-notification-events"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold">What gets sent</h3>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Each channel is independent, so you can page your phone for approvals while the desktop stays quiet.
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setPreferences({
                  ...preferences,
                  browser: { ...preferences.browser, events: { ...RECOMMENDED_NOTIFY_EVENTS } },
                  ntfy: { ...preferences.ntfy, events: { ...RECOMMENDED_NOTIFY_EVENTS } },
                  webPush: { ...preferences.webPush, events: { ...RECOMMENDED_NOTIFY_EVENTS } },
                })}
                data-testid="opencode-notify-reset-recommended"
              >
                Only what needs me
              </Button>
            </div>

            {/* A ticked box that stays silent all day looks like a bug unless
                the two suppressed categories are named right here. */}
            <div
              className="rounded-md bg-[var(--color-background-surface-neutral-muted)] p-3 text-xs text-[var(--color-text-muted)]"
              data-testid="opencode-notify-never-delivered"
            >
              <p className="font-medium text-[var(--color-text-default)]">Never sent, whatever is ticked below</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {NEVER_DELIVERED.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
              <p className="mt-1">
                Both are still recorded, and the notification history can show them on request.
              </p>
            </div>

            {!preferences.ntfy.enabled && (
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-notify-ntfy-inactive">
                ntfy is switched off above, so nothing in the ntfy column will fire yet.
              </p>
            )}
            {!preferences.webPush.enabled && (
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="opencode-notify-web-push-inactive">
                PWA push is switched off above, so nothing in the PWA push column will fire yet.
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border-default)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                    <th className="p-2 text-left font-semibold">Event</th>
                    <th className="w-20 p-2 font-semibold">Browser</th>
                    <th className="w-20 p-2 font-semibold">ntfy</th>
                    <th className="w-20 p-2 font-semibold">PWA push</th>
                  </tr>
                </thead>
                {NOTIFY_EVENT_GROUPS.map((group) => (
                  <tbody key={group.id} data-testid={`opencode-notify-group-${group.id}`}>
                    <tr className="border-b border-[var(--color-border-default)] bg-[var(--color-background-surface-neutral-muted)]">
                      <th className="p-2 text-left text-xs font-semibold" colSpan={4} scope="colgroup">
                        {group.title}
                        <span className="ml-2 font-normal text-[var(--color-text-muted)]">{group.summary}</span>
                      </th>
                    </tr>
                    {notifyEventsInGroup(group.id).map(({ event, label, description }) => (
                      <tr key={event} className="border-b border-[var(--color-border-default)] last:border-0">
                        <td className="p-2">
                          <span className="block font-medium">{label}</span>
                          <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>
                        </td>
                        {(["browser", "ntfy", "webPush"] as const).map((channel) => (
                          <td key={channel} className="p-2 text-center align-middle">
                            <input
                              type="checkbox"
                              // The visible label is the row's first cell, which a
                              // checkbox in another cell cannot claim implicitly.
                              aria-label={`${label} via ${channel === "ntfy" ? "ntfy" : channel === "webPush" ? "PWA push" : "browser"}`}
                              checked={preferences[channel].events[event]}
                              onChange={(e) => setPreferences({ ...preferences, [channel]: { ...preferences[channel], events: { ...preferences[channel].events, [event]: e.target.checked } } })}
                              data-testid={`opencode-notify-${channel}-${event}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </section>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={savePending} onClick={() => void save()} data-testid="opencode-notifications-save">{savePending ? "Saving..." : "Save"}</Button>
            <Button variant="secondary" onClick={() => void testBrowser()} data-testid="opencode-notifications-test-browser">Test browser</Button>
            <Button variant="secondary" disabled={!preferences.ntfy.enabled || !preferences.ntfy.topic} onClick={() => void api.testNtfy().then(() => setMessage("ntfy test sent")).catch((e: Error) => setError(e.message))} data-testid="opencode-notifications-test-ntfy">Test ntfy</Button>
            <Button variant="secondary" disabled={!preferences.webPush.enabled || !pushEndpoint || !webPush.publicKey} onClick={() => void testWebPush()} data-testid="opencode-notifications-test-web-push">Test PWA push</Button>
            {message && <span className="text-sm text-[var(--color-text-muted)]">{message}</span>}
          </div>
        </>
      )}
    </section>
  );
}
