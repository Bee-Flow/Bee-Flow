# Bee Flow for the desktop

The native client for **Linux, macOS and Windows**, with a bridge to the
Nextcloud desktop app that is already syncing your files.

Electron + TypeScript, built from this monorepo, shipped as a `.deb`, `.rpm`,
`.pacman`, an AppImage, a tarball, a universal `.dmg`, and a Windows
installer.

---

## What it is, and what it deliberately is not

**It is not a bundled copy of the web app.** The main window loads the SPA from
*your* Bee Flow server, exactly as a browser tab would.

That is the central decision in this package, and it is the opposite of what
most Electron clients do. The reason is what Bee Flow is: every customer runs
their own server and upgrades it on their own schedule, so a bundled `agent-hub`
build would have to stay compatible with every version in the field. You would
get a compatibility matrix, a version-negotiation layer, and a class of bug
where the client shows a button the server has never heard of. Loading the
server's own bundle makes that class of bug impossible — UI and API always ship
together.

So what is this package *for*? Everything a browser tab cannot do:

| | |
|---|---|
| **Lives in the tray / menu bar** | Close the window and Bee Flow keeps running: notifications arrive, the shortcut works, watched folders keep watching. |
| **Quick ask** | One global shortcut, one field, straight into a conversation — without finding the app first. |
| **Native notifications** | Attributed to Bee Flow, survive the window being closed, and carry a `beeflow://` link that opens the right conversation. |
| **Deep links** | `beeflow://chat/…` from an e-mail, a Talk message or a Nextcloud notification opens the workspace at the right place. |
| **OS credential storage** | Sealed by Keychain, DPAPI or libsecret — or, where none is available, **not written down at all**. |
| **The Nextcloud bridge** | The next section. |

**It is also not a phone app.** That is `mobile/`, which renders native views
and has its own information architecture, because a phone is a different shape
of problem. A desktop is the shape `agent-hub` was designed for, so the desktop
client shows it.

---

## The Nextcloud bridge

The Nextcloud desktop client has already done the hard part: it knows which
folders sync where, it has the account, and it keeps the files on disk. This
client reads that, and the result is that **a file you attach is referenced,
not copied**.

Drag a contract out of `~/Nextcloud/Contracten` into a conversation. Without the
bridge, the browser uploads the bytes, the server stores a second copy, and from
that moment the copy diverges from the file you keep editing in Nextcloud. With
the bridge, what reaches the server is
`https://cloud.example.com/remote.php/dav/files/tom/Contracten/huur.pdf`, and the
server reads the original through the Nextcloud integration it already has
(`server/integrations/nextcloudFiles/`), with your own app password.

What the bridge does, and what each part needs:

| Feature | Needs |
|---|---|
| Which accounts and folders exist; local path → WebDAV URL; "Open in Nextcloud" | the Nextcloud client **installed** |
| Live sync state ("still uploading", "excluded", "error"); the client's own share dialog; permanent links | the Nextcloud client **running** |
| An app password stored on your Bee Flow server, so it can read those files | one sign-in, in your real browser |
| Watched folders that keep a knowledge base current | a folder and a knowledge base ID |

### How it finds Nextcloud

Two channels, and the important one needs nothing running:

1. **The configuration file** (`nextcloud.cfg`). This is where accounts and sync
   folders come from. Bee Flow looks in the places the client is actually
   installed — the distro package's `~/.config/Nextcloud/`, the **Flatpak**'s
   `~/.var/app/com.nextcloud.desktopclient.nextcloud/`, the **Snap**'s
   `~/snap/…`, `~/Library/Preferences/` on macOS and `%APPDATA%` on Windows. An
   integration that only checked `~/.config` would report "Nextcloud not
   installed" on a Fedora machine that is syncing perfectly well.

2. **The local socket** the Nextcloud client exposes for its file-manager
   extensions. This is what Nautilus, Dolphin and Finder use, and it is where
   live sync state and the share dialog come from.

   Its location is derived from Qt's runtime directory plus the application
   name, so it moves between packaging formats and has changed across releases.
   Bee Flow probes an ordered list of candidates, rejects one that accepts a
   connection and then says nothing (a stale socket file, a leftover named
   pipe), and takes the first that answers a `VERSION` handshake. **If none
   does, nothing breaks** — the two features above turn off and the rest of the
   bridge carries on. Settings → Nextcloud → Advanced takes an explicit path
   when your installation puts it somewhere new.

### Signing in to Nextcloud

Settings → Nextcloud → *Link a Nextcloud account* runs **Login Flow v2**: the
same handshake the Nextcloud desktop client itself uses. Your real browser
opens, where your existing session, your SSO and your second factor already
work; approve it there, and Nextcloud issues an **app password** — scoped to
this app and revocable on its own from your Nextcloud security settings.

Bee Flow never renders a Nextcloud login form, so there is nothing to phish, and
the password is never logged (`src/main/logging.ts` redacts it even if a future
error message tries).

### Save to Nextcloud

The simplest possible version, and deliberately so: writing a file into a synced
folder. No upload, no API call, no second copy — Nextcloud does what it already
does. Writes are bounded to the sync folders, never overwrite (`nota.md` becomes
`nota (2).md`), and a proposed name is reduced to a name (`../../.ssh/authorized_keys`
saves as `authorized_keys`).

### Watched folders

A folder whose contents keep a knowledge base current: drop a contract in, and
it is offered to Bee Flow as soon as it lands — by WebDAV reference when the
folder is inside Nextcloud.

Most of the work is deciding what *not* to react to. A sync folder is full of
things that are not documents: the client's journal (`._sync_*.db`), the partial
download in flight (`*.nextclouddownload`, `*.~a1b2c3`), the **virtual-files
placeholder** standing in for a file that is not on this machine
(`jaarverslag.pdf.nextcloud` — zero bytes, and ingesting it would file an empty
document under a real document's name), LibreOffice's lock file, Office's `~$`
file, `.DS_Store`. All of it is filtered, and the filter has tests.

---

## Security

The main window is pointed at a remote origin, so every way out of it is a
decision rather than a default.

- **Hardened renderers.** `contextIsolation`, `sandbox`, no `nodeIntegration`,
  no `<webview>` — for every window, from one shared function, so a second
  window cannot be created with looser settings.
- **A navigation allow-list, on every renderer.** Applied from
  `web-contents-created`, so popups `window.open` creates get it too, and to
  server redirects (`will-redirect`) as well as page navigations. The server's
  own origin — and its single sign-on origin, when it has one — loads
  in-window; an identity provider only as a redirect hop in a sign-in, never
  because a page navigated there; everything else http(s) opens in the system
  browser; `javascript:`, `data:`, `blob:` and `file:` are blocked outright,
  except the app's own shell pages (files directly in the shell directory
  resolved at startup).
- **A narrow preload.** `window.beeflow` is built by hand from a fixed list of
  channels. There is no generic `invoke(channel, …)` passthrough, no `require`,
  no filesystem helper. It is bundled (`scripts/build-preload.mjs`) because a
  sandboxed preload may `require` nothing but `electron`, and the build fails if
  anything else appears — a relative require once left every page without the
  bridge.
- **Three classes of caller.** The preload runs in every page, so the bridge
  existing is not a permission; the sender's URL is (`senderTrust`). The
  server's page may resolve a dropped file, read sync state, open the share
  dialog, save into the sync folder and raise a notification, and sees
  settings without the user's other servers or local paths. Only a page *this
  app shipped* may change which server the client points at, probe addresses,
  rewrite settings or relaunch. Anything else — an identity provider's page, a
  popup — gets nothing. A server page asking to repoint the client at another
  server is either a bug or an attack.
- **Deep links propose; they never act.** Any `beeflow://` link that would
  change servers, start a Nextcloud sign-in or show a local file comes back
  flagged and produces a dialog naming exactly what is about to happen. A file
  is only ever revealed in its folder, and only in a sync folder or Downloads —
  never opened, because opening would run an executable a link named.
  Honouring `beeflow://server?url=…` directly would be a one-click account
  takeover dressed up as a convenience feature.
- **Credentials or nothing.** If the OS keyring is unavailable — a Linux box
  with no Secret Service running, or a desktop Chromium does not recognise,
  where `safeStorage` picks its hardcoded-key `basic_text` backend — the app
  keeps the credential in memory for the session, says so, and asks again next
  time. What it does write is written atomically, mode 0600.
- **Only what the product uses.** The microphone, camera, notifications and
  screen capture are granted to the configured server's pages; a server reached
  over plain http from another machine is asked per permission. Geolocation,
  MIDI, HID, serial, USB and Bluetooth are refused to everyone.
- **Plain http, honestly.** Accepted — a LAN server before its certificate is
  the most common first run — with "not encrypted" in the window title. A
  private IP address gets Chromium's secure-context exception for that origin
  alone (after a restart), so encrypted sign-in works there; a LAN *name* never
  does, because the current network decides what it resolves to.
- **No telemetry.** The client identifies itself to *your* server with
  `X-Beeflow-Client: desktop`, on requests to that origin only — never to an
  identity provider during sign-in, which has no business knowing what you run
  Bee Flow in. Nothing else is reported anywhere.

---

## Building

```bash
cd desktop
npm install
npm run dev        # build + launch
```

```bash
npm run verify     # typecheck + lint + tests — what CI gates on
npm test           # node --test over the TypeScript sources directly
npm run e2e        # the real app, end to end (Playwright; needs a display — xvfb-run on Linux)
npm run dist:linux # or dist:mac / dist:win — installers into release/
```

There is **no application bundler and no unit-test framework** in this package.
Node 22 strips TypeScript types itself, so `node --test` runs the sources with
no toolchain in between; `tsc` emits the main process; the four local pages are
HTML, CSS and ES modules that a browser loads directly. The one exception is the
preload, which esbuild bundles into a single file because the sandbox allows it
no other shape.

`npm run e2e` launches the app with Playwright against a fake Bee Flow server
(`e2e/fakeServer.ts`) and drives the connect flow: an address typed without
`http://`, a redirect, the API port, an address the server refuses, a server
down at launch, single sign-on, plain http on a LAN. By default it runs this
checkout's `dist/` (`npm run build` first); `BEEFLOW_E2E_APP` points it at a
packaged build instead. Each launch gets its own profile
(`BEEFLOW_USER_DATA_DIR`).

`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` gives you the TypeScript
definitions without the ~150 MB runtime — which is what CI's check job does.

### In CI

| Workflow | Trigger | Result |
|---|---|---|
| `desktop-checks.yml` | PR touching `desktop/**` | lint, typecheck, tests, a build, ~2 minutes |
| `desktop-release.yml` | PR touching `desktop/**` | Linux installers by default, each installed and launched (below); all three platforms when the PR changes packaging (`electron-builder.yml`, the manifests, `build/`, `resources/`, `.nvmrc`, the workflow) or carries the `desktop-full` label |
| `desktop-release.yml` | push to `main` | a **dev release**: the rolling `desktop-dev` prerelease, replaced in place |
| `desktop-release.yml` | Run workflow → `channel=dev` | the same, on demand, from any branch |
| `desktop-release.yml` | Run workflow → `channel=prod` (main only) | a **production release**, tagged and kept (published as a draft to review first) |

**The two channels are separated all the way down**, not just by a label. A dev
build is packaged with `-c.publish.channel=beta`, so electron-builder writes
`beta.yml` rather than `latest.yml`; an app on Settings → Updates → Beta reads
the first, an app on Stable reads the second, and neither ever sees the other's
builds.

Dev is **one rolling release** rather than one per merge — three platforms is
~400 MB, and a release per commit would be both unusable and a storage problem.
The `desktop-dev` tag always points at the newest build; production tags are
immutable.

**Every package is launched before it is released.** The `launch` job installs
each format the way a user would — the `.deb` with the kernel restricting user
namespaces as Ubuntu 24.04 does, the AppImage, the tarball's launcher, the
`.rpm` in Fedora and the pacman package in Arch, the NSIS installer, zip and
portable build, the `.dmg` on an Apple silicon and an Intel Mac — and runs the e2e suite
(or `scripts/smoke-launch.sh`, which reads the app's own log) against it. The
release job waits for all of it. arm64 packages are launched when a runner label
is set in `DESKTOP_LINUX_ARM64_RUNNER` / `DESKTOP_WINDOWS_ARM64_RUNNER`; every
run's summary says which packages were built but not launched.

Signing is optional for a dev build: with no certificate secrets a contributor
still gets working installers — macOS ones signed ad hoc, which Apple silicon
requires, and marked as unable to update themselves. A **production** release refuses to
publish an unsigned macOS build, because an unsigned `.dmg` on a modern Mac is
not something to hand a customer.

---

## How it updates itself — and when it does not

| Installed as | Updates come from |
|---|---|
| AppImage, Windows installer, `.dmg` | Bee Flow, in-app |
| `.deb`, `.rpm`, `.pacman` | your package manager — `apt upgrade` and friends |
| Flatpak | `flatpak update` |
| Snap | `snap refresh` |
| Windows portable | you, when you want a newer one |

The app works out which of these it is and says so on the settings page rather
than greying out a button with no explanation. An in-app updater on a
package-manager install produces a download that fails at the last step, or a
binary the package manager now disagrees with — so it does not try.

`BEEFLOW_UPDATE_FEED_URL` points updates at your own static host instead of
GitHub, which is an ordinary requirement in the kind of organisation that
self-hosts this product.

---

## Layout

```
src/
  main/            the Electron main process
    config/        settings + OS-keyring-sealed credentials
    server/        server URL normalisation, the reachability probe (on Chromium's network stack), error wording
    linux/         AppImage desktop integration
    security/      the navigation, window-open and permission policies
    nextcloud/     the bridge: config parsing, socket, path mapping, login flow, watchers
    windows/       window creation, window state, the quick-ask window
    ipc/           the handlers, and the line between trusted and server-supplied callers
  preload/         the contextBridge surface — the whole renderer↔main boundary
  shell/           the local pages: welcome, settings, unreachable, quick-ask
  shared/          types and the IPC contract, used by both sides
```

Tests live next to the source they cover (`x.ts` ↔ `x.test.ts`), the same
convention as the rest of the monorepo.

Nothing in `src/main` imports `electron` at module load except the files that
are pure wiring — `index.ts`, `app.ts`, `tray.ts`, `menu.ts`, the window
modules. Everything with a decision in it takes what it needs as an injected
dependency, which is why the Nextcloud bridge, the security policies and the
whole settings layer are tested in plain Node with no display, no X server and
no Electron binary.
