# Bee Flow for Android

The native mobile client for Bee Flow. React Native, built from this monorepo,
shipped as an APK.

This is **not** the web app in a wrapper. There is no WebView anywhere in this
package — every screen renders native Android views. The web SPA in
`agent-hub/` is desktop-shaped (a sidebar with thirty-odd destinations, a
node-graph automation builder, dense admin tables) and putting that on a
six-inch screen would be worse than nothing.

---

## What it covers, and what it deliberately does not

The whole product is reachable from the app. The **information architecture is
different**, because how often you reach for something on a phone is not how
important it is on a desktop:

| Tab | What lives there |
|---|---|
| **Chat** | Conversations, agents, model tiers, attachments, projects scoping |
| **Record** | Capture a meeting in the room where it happens, transcribe, get notes |
| **Library** | Notebooks, knowledge bases, documents, templates |
| **Automate** | Automations and their runs, tasks, reminders, projects, Studio apps |
| **More** | The complete sitemap — settings, org, integrations, admin, usage, support |

Notifications are a bell with an unread count in every header rather than a
tab: you glance at them from where you already are.

**Where a phone is honestly the wrong tool, the app says so** instead of
shipping a cramped imitation. The automation *flow editor* is the clearest
case: you can trigger a run, follow it live, read every step with its timings
and errors, toggle a schedule and edit simple parameters — but building a node
graph belongs on a desktop, and the UI says that in one line rather than
offering a canvas you cannot use.

---

## Building an APK

### In CI (the normal path)

Two workflows:

- **the `mobile` job in `.github/workflows/ci.yml`** — lint, typecheck, tests and a dry
  `expo prebuild` on every PR touching `mobile/`. Runs in about three minutes.
- **`.github/workflows/android-release.yml`** — the actual APK.

| Trigger | Result |
|---|---|
| push to `main` (with `mobile/**` changed) | dev APK as a build artifact |
| Run workflow → `channel=dev` | the same, on demand, from any branch |
| Run workflow → `channel=prod` (main only) | AAB + build provenance + a GitHub Release (`android-…`) |

**No signing key in this repository.** Every build here is signed by Gradle
with the debug key. A dev APK installs fine for trying a change, and a
contributor on a fork gets exactly the same, but it is never for distribution.
A `channel=prod` run publishes the AAB as a GitHub Release. Bee Flow's release
pipeline then checks it (commit on main, provenance attestation), signs it
with the upload key and releases it on Google Play. The APK for direct
download is the universal APK Google Play generates from that bundle, so a
direct install and a Play install update each other.

`versionCode` is the number of minutes since 2026-01-01 UTC at build time, not
the run number. It must never repeat, even when this code moves to another
repository. See the header of `android-release.yml`.

A self-hoster who wants a release build signed with their own key can do that
locally: `plugins/withBeeFlowAndroid.js` reads the Gradle properties
`BEEFLOW_UPLOAD_STORE_FILE`, `BEEFLOW_UPLOAD_STORE_PASSWORD`,
`BEEFLOW_UPLOAD_KEY_ALIAS` and `BEEFLOW_UPLOAD_KEY_PASSWORD` when they are set.

The `server_url` workflow input bakes a default server into the build. Leave it
blank and the app asks on first launch, which is the right default for a
self-hosted product.

### Locally

```bash
cd mobile
npm ci
npm run prebuild          # generates android/ from app.config.ts
npm run android           # or: cd android && ./gradlew assembleRelease
```

Needs JDK 17 and an Android SDK with platform 36. `android/` is **not**
committed — `expo prebuild` regenerates it from `app.config.ts` and
`plugins/withBeeFlowAndroid.js` every time, so the manifest has exactly one
source. If you find yourself editing a file under `android/`, edit the plugin
instead; your change will be thrown away otherwise.

---

## Connecting to a server

The same binary serves a SaaS customer on beeflow.nl, a company on its own
domain, and someone running `./selfhost.sh` on a laptop. So the server URL is
first-class state: asked for on first run, validated against `/api/health`
before it is remembered, and changeable in Settings → Server.

`http://` is permitted — a self-hosted Bee Flow on a LAN often has no
certificate, and refusing cleartext outright would make the app useless to
exactly the people it is built for. It is not silent about it: the app warns on
any non-HTTPS host and requires an explicit confirmation for one that is not on
a private network.

---

## Decisions worth knowing about

### No Firebase, no Google Play Services

Notifications are scheduled **locally** from polled server state. There is no
FCM sender id in this app.

The trade-off is real and deliberate: you get a bounded polling delay instead of
instant push, and in exchange the APK works on a device with no Google Play
Services, installs from a direct download, and no notification metadata passes
through Google's infrastructure on its way to you. For a GDPR-first,
self-hostable product that is the right side of the trade. See
`src/features/notifications/README.md` for how an operator who wants true push
would add it.

### Nothing is backed up

`allowBackup="false"` plus `data_extraction_rules` that exclude everything.
This app holds a session token and, while unlocked, an unwrapped data
encryption key; Android's default auto-backup would copy both into the user's
Google Drive, which is precisely the failure this product exists to prevent.

### A sign-in lasts as long as it does in a browser

Thirty days, then you sign in again — the same window `connect.sid` gives the
web app, and for password and OPAQUE accounts it is literally that cookie, held
in Android's own jar and flushed to disk on arrival.

Single sign-on cannot use a cookie. RFC 8252 puts the OAuth round trip in a
Custom Tab with its own cookie store, so the app authenticates with a bridge
token instead — and that bridge was built for a popup handing a session to an
iframe already open on screen, so it expired after an hour. On a phone that is
not a TTL, it is a sign-out over lunch. `GET /api/session-token` now grants a
native client the same thirty days and answers with `expiresIn`, so the app
reads the lifetime rather than assuming one, and trades the pickup token in for
a long-lived one the moment sign-in completes.

**Losing the network is not losing your session.** A failure to reach the
server on a cold start used to resolve to the login screen — the one screen a
user with no signal cannot complete — for a session that was still perfectly
valid. Only the server actually answering about the session (a 4xx) signs
anyone out now; a timeout, a 5xx, a tunnel or a deploy gets the "can't reach
your server" screen, which retries by itself and keeps everything.

### The encryption key still does not persist

The DEK lives in memory and dies with the process. What that does *not* mean is
that a cold start asks for your password — it does not, and this file used to
say otherwise. The server holds the key for the session (encrypted to it under
the OPAQUE session key at sign-in, exactly as the web client does it), so a
surviving session can read your data without the phone holding anything.

What the phone's copy buys is the app lock: "Unlock with biometrics" puts the
DEK in the Android hardware Keystore behind a fingerprint, invalidated by the OS
if you enrol a new one. That is a local gate on this device, not a cryptographic
necessity, and Settings says so rather than calling it "remember me".

### OPAQUE is reimplemented, in TypeScript

Password accounts authenticate with OPAQUE and nothing else — the server
refuses a migrated account on the legacy path. The web client uses
`@serenity-kit/opaque`, which is WASM, and Hermes has no WebAssembly; the only
React Native binding was last published in 2023 and does not build against RN
0.86.

So `src/crypto/opaque/` is a pure-TypeScript OPAQUE client on `@noble/curves`
and `@noble/hashes`. It is verified by **interop tests, not self-consistency**:
our client registers and the reference library's client logs in against the
record; the reference registers and ours recovers the same `exportKey` and gets
its KE3 accepted by the reference server. If a dependency bump on either side
changes a constant, `npm test` fails before a user does.

### Streaming

`expo/fetch`, not React Native's `fetch` — RN's cannot stream a response body,
and chat is a stream. On Android `expo/fetch` is OkHttp wired to the same
`ForwardingCookieHandler` as RN's own client, so one cookie jar serves both and
the session survives whichever path a request takes.

Tokens are batched on a 50 ms interval rather than one `setState` per token.
Per-token updates peg the JS thread at exactly the moment the user is most
likely to be typing.

---

## Layout

```
app/                     expo-router routes; the file tree is the nav graph
  (onboarding)/          server, login, MFA, encryption, locked
  (tabs)/                the five tabs
  chat/[id].tsx          the conversation screen
src/
  api/                   client, SSE reader, server-URL config
  auth/                  the sign-in state machine and the key vault
  crypto/                envelope encryption + the OPAQUE client
  features/<domain>/     api.ts, types.ts, hooks and components per domain
  theme/                 tokens ported from agent-hub/src/index.css
  ui/                    the component kit — use it, don't reinvent it
plugins/                 the Expo config plugin (manifest, signing, hardening)
scripts/generate-icons.mjs
```

Tests sit next to their source (`x.ts` ↔ `x.test.ts`), matching the rest of the
monorepo — no central `__tests__` tree.

## Design tokens

`src/core/theme/tokens.ts` is a one-for-one port of `agent-hub/src/index.css` —
all eight themes, the same hex values. Duplicated rather than derived, because
nothing can share a CSS custom property with a React Native `StyleSheet`.
**`index.css` is the source of truth**; when a value changes there it must
change here, and `tokens.test.ts` pins the ones that matter so drift shows up
as a failing test rather than as a screenshot nobody compares.
