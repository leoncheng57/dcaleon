/**
 * Whether this BFF is allowed to deliver notifications at all.
 *
 * Issue #320: a forgotten `npm run dev` BFF and the supervised production BFF
 * shared one `.env` and one `.state`, so every notification was delivered
 * twice, history was double-written, and parked-permission alerts fired from
 * both processes. `NOTIFICATION_DELIVERY` lets the dev stack opt out of the
 * whole delivery lane — unset means on, so `npm start` and the LaunchAgent
 * are unchanged, while `scripts/dev.sh` defaults a dev BFF to `off` unless the
 * invoking shell explicitly opts it back in.
 */
export function notificationDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NOTIFICATION_DELIVERY?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0");
}

export const NOTIFICATION_DELIVERY_OFF_MESSAGE = "[notifications] delivery is off (NOTIFICATION_DELIVERY=off): this BFF will not send Web Push or ntfy, write notification history, or arm parked-permission alerts. Set NOTIFICATION_DELIVERY=on to enable it (npm run dev defaults to off).";
