# Bee Flow — Frontend (`agent-hub`)

The React + Vite single-page application that fronts every Bee Flow deployment:
the SaaS at [beeflow.nl](https://beeflow.nl), self-hosted installs, and
the embedded Nextcloud ExApp shipped via the
[Bee Flow Nextcloud connector](../nextcloud-connector/README.md).

> **License**: Sustainable Use Licence (fair-code). You can use, modify and
> self-host this software for free. You cannot offer it to third parties as a
> paid service without a commercial agreement. See [LICENSE.md](./LICENSE.md).

## Status

This SPA is shipped publicly so that:

1. Nextcloud App Store reviewers can audit the source of the embedded app.
2. Self-hosters can build it themselves and verify what runs in the iframe.
3. Bug reports + community PRs are easier when the code is open.

The companion Bee Flow server lives in [`../server`](../server/README.md) in
this monorepo. The SPA is purely a client — it talks to the server via
REST + SSE; nothing of the SaaS-only logic ships in this directory.

## What this is — and isn't

- ✅ React 19 + Vite 7 SPA, code-split with vendor chunks
- ✅ All UI for chat, agents, knowledge bases, integrations, admin panels
- ✅ i18n via [`./src/i18n`](./src/i18n)
- ✅ Builds to a fully-static `dist/` that any web server can serve
- ❌ Not a Bee Flow server — this is the client only
- ❌ Not a Nextcloud app on its own — the connector packages it for the App Store

## Quick start (development)

```bash
git clone https://github.com/Bee-Flow/Bee-Flow.git
cd Bee-Flow
cp .env.example .env       # ports + VITE_* vars live at the repo root
cd agent-hub
npm install
npm run dev
```

Vite reads its env files from the repo root (`envDir: '..'` in
[vite.config.js](./vite.config.js)), so configure the root `.env`, not one
inside `agent-hub/`. The dev server starts on the port set by `CLIENT_PORT`
(`.env.example` sets 5176; the built-in fallback is 5175) and proxies `/api`,
`/auth`, `/agents`, etc. to the backend on `SERVER_PORT` (default 3001) —
leave `VITE_API_URL` empty in dev so requests stay same-origin.

To run the backend and frontend together, use `npm run dev:all` at the repo
root.

## Build

```bash
npm run build              # → dist/
npm run preview            # serve dist/ on http://localhost:4173
```

The bundle is fully static. Drop `dist/` behind any reverse proxy (Nginx,
Caddy, Cloudflare Pages) and point the API requests at your Bee Flow server.

## Environment variables

Set in the repo-root `.env` (see the root `.env.example`):

| Variable       | Default | Purpose                                                            |
|----------------|---------|--------------------------------------------------------------------|
| `VITE_API_URL` | empty   | Base URL of the Bee Flow server. Empty = same-origin (dev proxy)   |
| `CLIENT_PORT`  | `5175`  | Dev-server port (`.env.example` sets 5176); `strictPort` — no drift |
| `SERVER_PORT`  | `3001`  | Backend port the dev proxy targets                                 |

## Project layout

```
src/
├── App.jsx                    Root + auth-gating render-tree
├── AuthedApp.jsx              Session hydration (/auth/user, /auth/my-permissions)
├── AgentHub.jsx               Main app shell
├── pages/                     Top-level routes (Settings, Studio, …)
├── components/
│   ├── chat/                  Conversation UI + tool-result rendering
│   ├── admin/                 Org-admin panels (NC sync, integrations, …)
│   └── …
├── i18n/                      Translation defaults (en-defaults.js)
└── utils/                     API helpers (authFetch), scoped storage, …
```

Tests are colocated with their source (vitest): `npm run test:run`, plus
`npm run typecheck` and `npm run lint`.

## Contributing

We welcome bug reports, feature requests, and PRs.

- Open an issue first for non-trivial changes — saves rework.
- Run `npm run lint` and `npm run build` before pushing.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## Security

Found a vulnerability? Please disclose responsibly via **tomkooy@beeflow.nl**.
See [SECURITY.md](./SECURITY.md).

## Trademarks

"Bee Flow" and the bee logo are trademarks of Bee Flow B.V. The Sustainable
Use Licence does not grant trademark rights — please don't ship a fork under
the Bee Flow name.

## Questions

- Commercial / hosted SaaS: **tomkooy@beeflow.nl**
