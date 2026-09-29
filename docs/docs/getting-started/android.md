---
title: Android app
---

# Android app

Bee Flow has a **native Android client**. It is not the web app in a wrapper — there is no WebView
anywhere in it; every screen renders native Android views, laid out for a phone rather than a
desktop:

| Tab | What lives there |
|-----|------------------|
| **Chat** | Conversations, agents, model tiers, attachments, project scoping |
| **Record** | Capture a meeting in the room, transcribe it, get meeting notes |
| **Library** | Notebooks, knowledge bases, documents, templates |
| **Cowork** | Automations and their runs, tasks, reminders, projects, Studio apps |
| **More** | Settings, organisation, integrations, admin, usage, support |

Where a phone is honestly the wrong tool, the app says so instead of shipping a cramped imitation:
you can trigger an automation, follow a run live and edit simple parameters, but building a node
graph stays on the desktop. The app also registers in Android's share sheet, so you can share text,
images, audio or a PDF from any other app straight into a chat or a knowledge base, and a meeting
recording keeps running when the screen locks.

**Android only.** There is no iOS app, and none is planned.

## It connects to *your* server

The same APK serves a SaaS user on beeflow.nl, a company on its own domain, and someone running
`./selfhost.sh` on a laptop. On first launch the app asks which Bee Flow server to connect to,
checks `/api/health` before remembering it, and lets you change it later under
**Settings → Server**.

Plain `http://` is allowed — a self-hosted server on a LAN often has no certificate — but the app
warns about any non-HTTPS host and asks for explicit confirmation when it is not a private
address.

## Privacy properties

- **No Firebase, no Google Play Services.** The app installs and works on a device without Google
  services. Notifications are scheduled locally from polled server state — a bounded polling delay
  instead of instant push, and no notification metadata passing through Google.
- **Nothing is backed up.** Android's auto-backup is disabled for this app: the session token and
  encryption key material never land in a cloud backup.
- A sign-in lasts as long as it does in a browser (thirty days), then you sign in again.

## Install the APK

The app is distributed as a **direct APK download** — there is no Play Store listing and no iOS
App Store presence today.

1. Open the [GitHub Releases page](https://github.com/Bee-Flow/Bee-Flow/releases) on your
   phone. Android releases have tags starting with `android-` and are cut on their own cadence,
   separately from server releases. (If no `android-…` release with an `.apk` is listed yet,
   build the APK yourself — see below.)
2. Download the `.apk` asset and open it. Allow installation from your browser or file manager
   when Android asks. One APK covers all supported devices; the `.aab` asset is for Play Store
   publishing only and cannot be installed directly.
3. On first launch, enter your server's URL (for example `https://ai.example.com`, or the address
   your self-hosted [web UI](../self-hosting/docker-compose.md#easy-install) runs on).

Requires Android 7.0 or newer.

## Updating

There is **no auto-update**. To update, download the newer `.apk` from the Releases page and
install it over the existing app — your sign-in and settings are kept, because release builds are
signed with the same key. (A debug-signed development build cannot be installed over a release
build, or the other way around; Android will refuse the signature change.)

An older APK keeps working against an upgraded server — it just lacks the newest screens — so
updating the app and [upgrading the server](../self-hosting/upgrades.md) don't have to happen in
lockstep.

## Build your own APK

Self-hosters can build the app from source — for example to bake in their own server URL as the
default:

```bash
cd mobile
npm ci
npm run prebuild                        # generates android/ from app.config.ts
cd android && ./gradlew assembleRelease # APK in app/build/outputs/apk/release/
```

You need JDK 17 and an Android SDK with platform 36. Set `BEEFLOW_DEFAULT_SERVER_URL` when
building to pre-fill your server's address (users can still change it in the app); leave it unset
and the app asks on first launch.

On a fork, the `.github/workflows/android-release.yml` workflow does the same in CI: every pull
request touching `mobile/` produces an installable dev APK as a build artifact. That APK is signed
with the debug key, so it is for trying the app, not for distributing it; to sign a release build
with your own key, build locally with the Gradle properties described in
[`mobile/README.md`](https://github.com/Bee-Flow/Bee-Flow/blob/main/mobile/README.md).
