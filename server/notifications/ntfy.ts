import { trustedNtfyOrigin, type NotificationPreferences, type NotifyEvent } from "./preferences.js";

export interface NotificationMessage {
  event: NotifyEvent;
  title: string;
  body: string;
  priority?: "default" | "high";
  click?: string;
  /** Global unresolved delivered-notification count for installed PWA badges. */
  badgeCount?: number;
  /** Monotonic revision prevents out-of-order pushes from regressing a badge. */
  badgeRevision?: number;
  /**
   * Record id, forwarded to the service worker as an OS notification tag so a
   * foreground PWA and its own push do not both buzz for one record.
   */
  tag?: string;
  /** Marks a test push so the worker can expose its running version. */
  diag?: boolean;
}

export async function sendNtfy(
  preferences: NotificationPreferences,
  message: NotificationMessage,
  token = process.env.NTFY_TOKEN,
): Promise<void> {
  const { ntfy } = preferences;
  if (!ntfy.enabled || !ntfy.topic || !ntfy.events[message.event]) return;
  const trusted = trustedNtfyOrigin();
  if (ntfy.server !== trusted) throw new Error("refusing to send ntfy credentials to an untrusted origin");
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: message.title,
    Priority: message.priority ?? "default",
    Tags: message.event,
  };
  if (message.click) headers.Click = message.click;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${trusted}/${encodeURIComponent(ntfy.topic)}`, {
    method: "POST",
    headers,
    body: message.body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}`);
}
