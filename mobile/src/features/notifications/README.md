# Notifications on Android without Firebase

Bee Flow for Android ships **no Firebase**, no `google-services.json`, and no
FCM sender id. `app.config.ts` sets `enableBackgroundRemoteNotifications: false`
on the `expo-notifications` plugin for exactly that reason.

Notifications still work. They are **local notifications raised from polled
server state**: `background.ts` registers an `expo-background-task`
(WorkManager under the hood), the task asks the user's own Bee Flow server
`GET /api/notifications?unread=true`, works out which ids this device has not
announced yet, and posts a local notification for each.

## Why

Bee Flow is sold as a GDPR alternative to ChatGPT Teams and Copilot, and is
frequently installed on-premise by organisations that chose it precisely
because their data does not leave their building. Firebase Cloud Messaging
would undo a large part of that:

- **Every notification would transit Google.** FCM is a store-and-forward
  service. Even with an empty "data-only" payload used purely as a wake signal,
  Google learns that *this device*, belonging to *this installation*, has
  activity right now, and how often. For a customer whose threat model includes
  "our American cloud provider", that metadata channel is the objection, not
  the message body.
- **It needs a Google project per operator.** A self-hoster who downloads the
  APK from GitHub cannot use the Bee Flow sender id — the tokens would be
  minted against our project. Real push therefore means every operator
  registering a Firebase project, dropping a `google-services.json` into the
  build, and rebuilding the APK. That is not a checkbox; it is a fork of the
  release process.
- **It requires Google Play Services on the device.** A meaningful share of the
  audience — de-Googled Android, GrapheneOS/LineageOS without GApps, Huawei
  hardware, locked-down corporate MDM images — has no Play Services at all. On
  those devices an FCM-only app has *no* notifications. Polling works
  everywhere, on any Android 7+ device, with no account signed in.
- **It moves the licence boundary.** The license server is private; the mobile
  client is fair-code. Bundling a proprietary Google SDK into the published
  client is a licence conversation nobody wants to have for a feature that a
  15-minute poll delivers.

## What it costs

**Latency.** This is the whole trade-off, stated plainly:

- `POLL_INTERVAL_MINUTES` is 15, which is Android's floor for periodic
  WorkManager jobs. It is a **minimum, not a promise**.
- WorkManager batches wakeups across apps to save battery, so real delivery is
  typically 15–30 minutes and can be longer.
- In **Doze** (screen off, stationary, unplugged) periodic work is deferred to
  the maintenance windows the OS opens, which lengthen the longer the device
  stays idle — an overnight gap of a couple of hours is normal and correct.
- An **App Standby bucket** of `rare` or `restricted` (an app the user opens
  once a fortnight), or a manufacturer's aggressive battery manager (Xiaomi,
  OnePlus, Samsung's "deep sleeping apps"), can defer it much further or stop
  it entirely. `getPollingState()` reports `available: false` when the OS says
  background work is restricted, so the UI can explain this rather than
  silently doing nothing.

So: **a chat reply is not a real-time push and must never be presented as
one.** What polling is genuinely good for is what this server actually sends
notifications about — a routine that finished at 03:00, an approval waiting, a
support reply, an expired connector credential. None of those is worse for
arriving twenty minutes late.

The in-app badge is a separate, faster path: `components/NotificationBell.tsx` polls
`/api/notifications/unread-count` every 60 seconds while the app is in the
foreground, and React Query pauses that automatically when it is backgrounded.
So an open app is nearly live; a closed one is eventually consistent.

**Battery and data.** One small authenticated GET per wake, at most four times
an hour, only when the device is already awake for other work. The task returns
`Success` even when the request fails, so a server that is off overnight does
not push the app into WorkManager's exponential backoff.

## Privacy properties this buys

- The notification *content* never leaves the user's server: the text is
  fetched over the same authenticated session as the rest of the app and
  rendered by `Notifications.scheduleNotificationAsync` on-device.
- No push token exists, so there is nothing to leak, rotate, or subpoena, and
  no per-device identifier is registered anywhere.
- The channel is created with `lockscreenVisibility: PRIVATE`, so Android hides
  the body on a locked screen.
- The "already announced" ledger (`beeflow.notifications.announced.v1`) is a
  list of opaque uuids in AsyncStorage and is wiped by
  `unregisterNotificationPolling()`.

## If an operator does want real push

This is a supported path — it is just not the default. In rough order:

1. **Create a Firebase project** for the deployment and add an Android app with
   the package name from `app.config.ts` (`nl.beeflow.app`), or a rebranded one
   for a white-label build. Download `google-services.json`.
2. **Add it to the build.** Set `android.googleServicesFile` in
   `app.config.ts`, add `expo-notifications` back with
   `enableBackgroundRemoteNotifications: true`, re-run
   `npm run prebuild` and rebuild the APK. Note this makes the APK
   deployment-specific: it can no longer be the same binary everyone downloads.
3. **Register the device token.** Call `Notifications.getDevicePushTokenAsync()`
   after sign-in and POST it to a new server endpoint — there is none today;
   `server/routes/notifications.js` has no token table and
   `server/stores/notificationStore.js` has no device concept, so both need a
   `notification_devices (user_id, token, platform, created_at)` table and the
   usual per-user scoping the rest of that store already enforces.
4. **Send on write.** `notificationStore.createNotification()` is the single
   choke point every producer goes through (`core/aiTaskRunner.js`,
   `core/automationRunner/*`, `routes/support/threads.js`, …), so one hook
   there covers every notification in the product. Send a **data-only** message
   and let the app fetch the body over its own session, or the notification
   text itself passes through Google.
5. **Keep the poll as the fallback.** Leave `background.ts` registered: it is
   what still works on devices without Play Services, and the "already
   announced" ledger means a notification delivered by FCM first is not
   announced twice by the poll afterwards — the ids are the same rows.
6. **Tell the customer.** For an installation that chose this product for data
   residency, turning on FCM is a change to the data-flow diagram in their DPIA,
   not an app setting.

## Files

| File | What it is |
| --- | --- |
| `api/endpoints.ts` | The five REST calls. |
| `api/readers.ts` | Contract readers for the rows, the unread count and read-all's answer. |
| `api/keys.ts` | The query keys. `notificationKeys.unread` is shared with the header badge — do not rename it. |
| `model/types.ts` | The `notifications` table row and the category presentation table. |
| `model/route.ts` | Translating the server's **web** `link` column into a native route. |
| `model/format.ts` | Relative time, time buckets, markdown-stripped previews. |
| `model/sections.ts` | The inbox's today / this week / older sections. |
| `background.ts` | The WorkManager task, the announced-ids ledger, and registration. |
| `hooks/useUnreadCount.ts` | The 60s unread-count poll behind the bell. |
| `hooks/queries.ts`, `hooks/mutations.ts` | The inbox's list query and its three writes (mark read is optimistic). |
| `hooks/useNotificationInbox.ts` | The inbox screen's state. |
| `components/NotificationBell.tsx` | The header bell; `app/_layout.tsx` supplies it to every ScreenHeader. |
| `components/NotificationPlumbing.tsx` | Root-mounted: registers polling when signed in, routes warm and cold-start taps. |
| `screens/NotificationsScreen.tsx` | The inbox, rendered by `app/notifications.tsx`. |
| `index.ts` | The public surface: the screen, the bell, the plumbing, `useUnreadCount`, the link translation and the device preferences. |

`background.ts` defines its task at **module scope**, because WorkManager
launches the app headless and looks the task up by name. It must therefore be
imported somewhere on the app's entry path — `app/_layout.tsx` does, through
`NotificationPlumbing`, so the definition exists even when the user has never
opened the inbox.
