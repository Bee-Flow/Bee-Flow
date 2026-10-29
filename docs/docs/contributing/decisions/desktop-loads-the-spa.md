---
title: "0006: The desktop client loads the SPA from the server"
description: Why the Electron client ships no copy of the frontend, and why trust between its renderer and main process is decided by the sender's URL rather than by a flag.
---

# 0006: The desktop client loads the SPA from the server

**Status:** accepted, in effect. **Code:** `desktop/src/main/`, `desktop/src/preload/index.ts`,
`desktop/src/main/ipc/handlers.ts` (`requireShell`, `requireTrusted`).

## Context

A customer runs their own Bee Flow server at their own version. A desktop client with a
bundled frontend would drift from the API it talks to with every release of either side,
and would need its own release for every UI change.

## Decision

The main window loads the SPA from the server itself. The client adds only what a browser
tab cannot: tray, global shortcut, OS notifications, `beeflow://` deep links and the
Nextcloud bridge. The preload is the whole renderer/main boundary: a fixed list of channels
in `shared/ipc.ts`, no generic `invoke(channel, ...)`, `sandbox: true`, and a build that
fails on any `require` other than `electron`. Every IPC handler starts by checking the
sender's URL; a flag from the renderer never grants trust. The server probe goes through
Chromium's network stack so it agrees with the window on proxy, certificates and HSTS.

## Consequences

- The UI can never be newer or older than the API a customer runs.
- A page from an untrusted origin cannot reach a privileged channel by claiming to be the
  shell.
- Everything with a decision in it lives in a module with injected dependencies and tests
  next to it; only the entry files import `electron` at module level.
