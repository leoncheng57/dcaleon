# Phone notification support

PWA push and ntfy are independent. Either, both, or neither may be enabled. Browser
desktop notifications still require an open page; PWA push and ntfy can arrive while
the page is backgrounded or closed.

Installed PWAs also show an app-icon badge with the number of unresolved delivered
notifications across all projects. Auto-approved permission and sub-agent audit records
are excluded because they were never sent to the user. Opening the app and resolving or
reopening a record synchronizes the badge. Changes made on another device synchronize on
the phone's next push or app open.

## Support matrix

| Platform | Requirements | Background/closed delivery |
|---|---|---|
| iPhone/iPad | iOS/iPadOS 16.4+, HTTPS, install with Add to Home Screen, then grant permission | PWA push or ntfy |
| Android | HTTPS and browser notification permission; installation is recommended | PWA push or ntfy |
| Desktop Chromium/Firefox | HTTPS or localhost and notification permission | PWA push; browser behavior may stop after browser exit |
| Unsupported/older browser | Use ntfy | ntfy |

## Server setup

Generate one VAPID key pair and keep it stable. Changing it invalidates existing browser
subscriptions.

```bash
npx web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the BFF environment.
The subject must be a `mailto:` address or HTTPS URL. Restart the BFF, open Settings on
each device, enable PWA push, and save. Each device grants permission and registers its
own subscription. Disabling PWA push and saving removes the current device subscription
and globally stops the channel; it does not alter ntfy.

Subscriptions are stored in `.state/web-push-subscriptions.json` by default with file
mode `0600`. The public key may be returned to browsers. The private key and subscription
authentication keys are never returned by a read API or rendered in Settings. Registration
accepts at most 32 devices and only browser endpoints from the production Apple, Google,
Mozilla, and Microsoft push services; this prevents the BFF from becoming a general outbound
request proxy.

## Registered devices

Settings lists every registered device by push platform family (Apple, Google, Mozilla,
Microsoft) and registration date, and marks the row belonging to the device you are
reading on. Rows can be removed individually or all at once; a removed device
re-registers the next time it enables PWA push and saves.

A row labelled **Unlinked** was registered before the app tracked installations. It
cannot be matched to a device or replaced automatically, so if delivery is duplicated or
going nowhere, removing it is safe — any live device re-registers on its next save.

## Lifecycle and updates

The service worker does not intercept `fetch` and has no Cache Storage calls. The PWA is
not offline-capable, and live sessions, questions, permissions, and API responses always
come from the network. A newly installed worker waits until the app displays its update
notice. **Update** activates it and reloads; **Later** retains the current worker.

The app asks the browser to re-fetch `sw.js` whenever it returns to the foreground and
hourly while it stays open. Without that, an installed PWA resumed from memory never
performs the navigation the browser needs to notice a new worker, so the update notice
never appears and the device runs a stale worker indefinitely. Checking only downloads
and installs; activation still waits for your explicit **Update** tap.

Browsers retire push subscriptions on their own schedule. The worker listens for
`pushsubscriptionchange` and re-registers the device in place, so delivery recovers
without anyone re-saving Settings. This is the only network write the worker makes: one
POST of its own subscription to `/api/notifications/push-subscriptions`. If it fails it
warns to the console and the manual re-save still works.

## Troubleshooting

- PWA push unavailable: confirm HTTPS, browser support, and all three VAPID variables.
- iPhone permission unavailable: open the installed Home Screen app, not a Safari tab.
- Test button disabled: enable PWA push, save successfully, and confirm the device says
  it is subscribed.
- Delivery stops after changing VAPID keys: disable/save, enable/save, and grant a fresh
  subscription on every device.
- Provider returns 404 or 410: the BFF removes that expired subscription automatically.
- Two cards on iPhone for one event: iOS does not honour the Web Push `tag`, so
  notifications that are designed to replace one another stack instead. Pressing
  Stop used to be the common cause (it emitted both an abort and an idle); that
  pair is now collapsed server-side. Other stacking is a platform limitation.
- Delivery silently stops on one device while the server reports success: the subscription
  rotated. This now self-heals; if it persists, re-save Settings on that device and remove
  any leftover `Unlinked` row.
- PWA push fails but ntfy works: leave ntfy enabled while checking browser permission and
  subscription state; the channels do not disable one another.
- Every notification arrives twice on all devices: a second BFF is delivering from the
  same `.env`/`.state` — check for a stray `npm run dev` started with
  `NOTIFICATION_DELIVERY=on` (`lsof -nP -iTCP -sTCP:LISTEN | grep node`). Since audit
  correlation IDs now share a persisted key, the duplicate pair shows an identical
  `sessionCorrelation` milliseconds apart in `.state/logs/audit.jsonl`.
