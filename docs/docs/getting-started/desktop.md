---
title: Desktop app
---

# Desktop app

Bee Flow has a **desktop client for Linux, macOS and Windows**. It connects to *your* Bee Flow
server, lives in the tray or the menu bar, and bridges the workspace to the Nextcloud desktop app
that is already syncing your files.

## What it adds over a browser tab

The window shows the same workspace your browser does — deliberately, because that is what keeps
the interface and your server's API from ever drifting apart. What the desktop client adds is
everything a tab cannot do:

| | |
|---|---|
| **Stays running** | Close the window and Bee Flow keeps going in the tray: notifications still arrive, the shortcut still works, watched folders keep watching. |
| **Quick ask** | One global shortcut (Ctrl+Shift+Space, ⌘⇧Space on a Mac), one field, straight into a conversation — without finding the app first. |
| **Real notifications** | From Bee Flow rather than from your browser, and clicking one opens the conversation it came from. |
| **`beeflow://` links** | A link in an e-mail, a Talk message or a Nextcloud notification opens the workspace at the right place. |
| **The Nextcloud bridge** | Files you attach are *referenced*, not copied — see below. |

## Install

Desktop builds are published on the repository's
[Releases page](https://github.com/Bee-Flow/Bee-Flow/releases), with tags starting with
`desktop-`. That page needs access to the repository; public downloads (and in-app updates for
everyone) come from Bee Flow's own download server once it is set up.

There are two channels. **Stable** is what you want: tagged releases that do not
change once published. **`desktop-dev`** is a rolling prerelease rebuilt from
every merge — useful for trying something before it ships, and not something to
put on a machine you depend on. Switch an installed copy between them under
**Settings → Updates → Channel**; an app on Stable never sees a dev build.

### Linux

Take the package your distribution understands, so updates arrive with the rest of your system:

| Distribution | File | Install |
|---|---|---|
| Debian, Ubuntu, Mint, Pop!\_OS | `.deb` | `sudo apt install ./Bee-Flow-*.deb` |
| Fedora, RHEL, openSUSE | `.rpm` | `sudo dnf install ./Bee-Flow-*.rpm` |
| Arch, Manjaro, EndeavourOS | `.pacman` | `sudo pacman -U ./Bee-Flow-*.pacman` |
| Anything else | `.AppImage` | `chmod +x Bee-Flow-*.AppImage && ./Bee-Flow-*.AppImage` |
| Packaging it yourself | `.tar.gz` | unpack anywhere, then run `./beeflow.sh` |

Every format is built for x64 and arm64, except the pacman package (x64 only). CI installs and
starts each one before a release is published.

The AppImage updates itself; the three packages are updated by your package manager, and the app
says so rather than offering an in-app update it cannot carry out.

:::note Credential storage on Linux
Bee Flow seals stored credentials with your desktop's keyring (GNOME Keyring, KWallet — anything
providing the Secret Service API). On a machine with **no** keyring running, it keeps them in
memory for the session and asks again next time, instead of writing them to `~/.config` in
effectively plain text. That includes desktops Chromium does not recognise (i3, sway, a bare X
session): there it falls back to a key built into Chromium itself, which Bee Flow does not count as
a keyring. Start a keyring, or launch Bee Flow with `--password-store=gnome-libsecret`, and it is
used. **Settings → About** shows which case you are in.
:::

:::note Chromium's sandbox on Linux
Pages run in Chromium's sandbox, so a compromised page cannot reach the rest of the computer. On
kernels that restrict unprivileged user namespaces — Ubuntu 23.10 and later — the sandbox needs
help from the installer: the `.deb` installs an AppArmor profile for it, the `.rpm` and pacman
packages likewise. The **AppImage** and the **tarball** cannot, so on those systems they start
with the sandbox off and **Settings → About** says so. Install a package to turn it on, or for the
tarball run once: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.
:::

### macOS

One `.dmg`, a universal binary for both Apple silicon and Intel. Drag Bee Flow to Applications.

On macOS 15 and later, the first connection to a server on your local network asks for the
**Local Network** permission. If it was refused, Bee Flow says the Mac cannot reach the server;
allow it under **System Settings → Privacy & Security → Local Network**.

Builds from the `desktop-dev` channel are not signed with an Apple Developer ID: macOS calls them
"from an unidentified developer" the first time (open them from Finder with right-click → Open),
and they cannot update themselves — download the next one when you want it.

### Windows

The installer (`.exe`) needs no administrator rights and installs for the current user; choose
"more info → run anyway" if SmartScreen asks and the build is not signed. The **portable** build
runs from a folder and installs nothing — handy on a managed machine.

## It connects to *your* server

The first screen asks for your server's address, checks it before remembering it, and lets you
change it later under **Settings → Server**. The same installer serves a SaaS user on beeflow.nl,
a company on its own domain, and someone running `./selfhost.sh` on a laptop. Nothing is sent
anywhere until you name a server.

### Which address

**The one you open Bee Flow at in a browser.** On a standard self-hosted install that is the
web app's port, **5176** — for example `192.168.1.40:5176`, or `bee.example.com` behind your own
reverse proxy. The server's API port (3001) answers too, but serves no web app; Bee Flow
recognises it and says which port to use instead.

Typed without `http://` or `https://`, the address is tried over https first. If the port turns
out to speak plain http:

- on **this computer** (`localhost`) and on a **private IP address** (`192.168.…`, `10.…`,
  `172.16–31.…`, Tailscale's `100.64–127.…`), Bee Flow uses http and carries on;
- for a **name** — `nas.local`, `bee.lan`, `homeserver` — it asks you to type `http://` yourself.
  Whoever runs the network you are on decides what those names point to; on café Wi-Fi,
  `nas.local` can be anyone.

A server reached over plain http from another machine works, and the window title says
**not encrypted**. On a private IP address, Bee Flow also asks for one restart so that encrypted
sign-in (and PIN unlock) work there: browsers only allow the cryptography they need on https or
`localhost`, and the restart lets Bee Flow make that one exception for that one address.
For anything beyond trying it out, put the server behind https.

### The server has to accept that address

A Bee Flow server only accepts sign-ins from the addresses listed in its **`CLIENT_PUBLIC_HOST`**
(or `CORS_ORIGIN`) setting. The default is `localhost:5176`, which works on the server machine
itself and nowhere else. If you connect to it as `192.168.1.40:5176`, Bee Flow notices before you
try to sign in and names the setting: add that address, restart the server, and connect again.

### Single sign-on

Google, Microsoft and Nextcloud sign-in run inside the app when the server's
`SERVER_PUBLIC_HOST` is an address this computer can reach — Bee Flow learns it from the server and
lets the sign-in pass through it. Google may still refuse to sign in inside an app window rather
than a browser; password sign-in is unaffected.

### When it cannot connect

If the server cannot be reached, Bee Flow says which of the plausible causes it is — a name that
does not resolve, nothing listening on that port, a certificate that expired or that this computer
does not trust (with how to trust it on your system), a proxy that failed, or something that
answered but is not Bee Flow — and retries in the background until the server is back.

If your server **moves** — it starts redirecting to another address — Bee Flow follows by itself
only when that cannot lower the bar: the same machine (another port, or http becoming https), or
one https address to another. For anything else, most importantly https to http, it shows the new
address and lets you choose it, rather than switching silently.

For anything else, the log is under **Help → Show Logs** (or **Settings → About → Show logs**):
`~/.config/Bee Flow/logs/` on Linux, `~/Library/Logs/Bee Flow/` on macOS,
`%APPDATA%\Bee Flow\logs\` on Windows. It records every connection check and why it failed, and
contains no passwords or tokens.

## The Nextcloud bridge

If you use the [Nextcloud desktop client](https://nextcloud.com/install/#install-clients), Bee Flow
finds it and uses what it already knows.

**Attach a file without copying it.** Drag a contract out of your Nextcloud folder into a
conversation. Instead of uploading the bytes and storing a second copy that immediately starts
diverging from the one you keep editing, Bee Flow hands your server the file's WebDAV path — and
the server reads the original with your own app password.

Alongside that:

- **Sync state.** Bee Flow can tell you a file has not finished uploading yet, rather than handing
  the server a path that is not there.
- **Sharing.** "Share" opens the Nextcloud client's own dialog, so your instance's sharing policy —
  expiry dates, required passwords, whether public links are allowed at all — still applies.
- **Open in Nextcloud** for any attached file, and **Save to Nextcloud**, which writes into a synced
  folder and lets Nextcloud do the rest.
- **Watched folders.** Point one at a knowledge base and anything you drop in it is offered to Bee
  Flow as soon as it lands. The client's own bookkeeping — journals, partial downloads,
  online-only placeholders, lock files — is filtered out.

### Linking your Nextcloud account

**Settings → Nextcloud → Link a Nextcloud account** uses Nextcloud's Login Flow v2 — the same
handshake its own desktop client uses. Your real browser opens, where your session, your SSO and
your second factor already work; you approve it there, and Nextcloud issues an **app password**
scoped to Bee Flow, which you can revoke on its own under **Nextcloud → Settings → Security**.

Bee Flow never shows you a Nextcloud login form, and the password is never written to its log.

### If Bee Flow does not find it

Settings → Nextcloud shows what it found and what it did not. Two states that look alike and are
not:

- **"Desktop client not found"** — no configuration file. Bee Flow looks where the client actually
  installs, including the Flatpak and Snap locations on Linux. If yours lives somewhere else, set
  the path under **Advanced**.
- **"Client not running"** — the configuration was read, so folders, accounts and WebDAV paths all
  work. What is missing is live sync state and the share dialog, which need the client running.
  If it *is* running and Bee Flow still says this, its local socket is somewhere unexpected; set it
  under **Advanced**.

## What it sends, and to whom

- The client identifies itself to your server as `desktop` (an `X-Beeflow-Client` header), on
  requests to that server only — never to Google or Microsoft during a single sign-on. A server
  that predates this client records it as `unknown` until it is updated. See the
  [telemetry contract](../reference/telemetry.md).
- There is no analytics, no crash reporting and no usage reporting of any kind.
- Links to anywhere other than your server open in your normal browser rather than inside the app.
- A `beeflow://` link can ask Bee Flow to open a conversation. Anything with a consequence —
  connecting to a different server, signing in to a Nextcloud, showing a local file — asks you
  first, by name. A link can only ever *show* a file in its folder, and only in your Nextcloud
  folders or Downloads; it never opens or runs one.

## Building it yourself

```bash
cd desktop
npm install
npm run dist:linux   # or dist:mac / dist:win
```

Installers land in `desktop/release/`. Full details, including the security model, are in
[`desktop/README.md`](https://github.com/Bee-Flow/Bee-Flow/blob/main/desktop/README.md).
