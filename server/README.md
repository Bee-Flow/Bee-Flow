# Bee Flow — Server

The Node.js 22 + Express backend of the [Bee Flow monorepo](../README.md).
Powers chat, agents, knowledge bases, integrations (Nextcloud, Google,
Microsoft, …), the automation engine, and the license gate.

> **License**: Sustainable Use Licence (fair-code). You can self-host this
> for free for your own organisation. You cannot offer Bee Flow as a paid
> service to third parties without a commercial agreement. See
> [LICENSE.md](./LICENSE.md).

## Quick start (development)

```bash
git clone https://github.com/Bee-Flow/Bee-Flow.git
cd Bee-Flow/server
cp .env.example .env       # set SESSION_SECRET, DATABASE_URL, WEBPAGE_PREVIEW_TOKEN_SECRET
npm install
npm start                  # API on http://localhost:3001 (SERVER_PORT)
```

The server refuses to boot without the required variables — every one of them
is documented inline in [.env.example](./.env.example). It creates and
migrates its own tables on boot; `npm run db:migrate` runs the migrations
explicitly.

To run the frontend alongside it, use `npm run dev:all` at the repo root
(starts this server plus the [agent-hub](../agent-hub/README.md) SPA). For the
full containerised stack, see the root [README](../README.md) and
`docker-compose.from-registry.yml`.

## Required services

- **PostgreSQL with the `pgvector` extension** — primary store
  (the compose stack uses `pgvector/pgvector:pg15`)
- **Redis** — optional; sessions fall back to Postgres when `REDIS_URL` is unset
- **At least one model provider key** — Anthropic, OpenAI, Google, Mistral,
  Azure OpenAI, or Scaleway (adapters in [`core/providers/`](./core/providers/))

## Tests

Tests are colocated with their source (`x.js` ↔ `x.test.js`), not in a
central `tests/` directory:

```bash
cd server
node --test                        # full suite
node --test path/to/file.test.js   # one file
```

## License tiers

Tiers are hierarchical — `community` → `enterprise` → `full` — and each tier
inherits everything below it. `license/tiers.js` is the single source of truth.

| Tier         | Who | Adds |
|--------------|-----|------|
| `community`  | Every install, no key required | Chat + agents, knowledge bases (vector/hybrid/reranked), multi-user with groups, all built-in integrations, Nextcloud connector incl. OAuth login, skills, automation builder + scheduled agent runs, learning center |
| `enterprise` | Paid self-hosted tier | Automation sharing + approvals, voice chat, webpages, meeting notes, notebooks, projects, App Studio, MCP server marketplace, advanced Privacy Shield modes (PII tokenize, web-search guard), compliance hub, SAML/Google/Microsoft SSO, audit log export, custom themes, swarm agents, advanced analytics, content encryption at rest |
| `full`       | Internal/operator tier | White-label branding, license issuance |

The legacy `pro` tier is still accepted on input and resolves to `enterprise`
(see `LEGACY_TIER_ALIAS` in [`license/tiers.js`](./license/tiers.js)).

## How licensing works

License keys are signed JWTs minted by Bee Flow's private license server.
This server verifies them in [`license/verify.js`](./license/verify.js)
against a public key (`license/bundled-public-key.pem`, provided at
build/deploy time — not committed) or a JWKS endpoint (`LICENSE_JWKS_URL`).
Premium routes are gated with `requireFeature(...)` from
[`license/middleware.js`](./license/middleware.js). Without a key, every
install runs at the free `community` tier.

## Layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full map — the layering
(API → features → core/platform), what may depend on what, and how it is
enforced. The short version:

```
core/              # What Bee Flow is: LLM orchestration + provider adapters
  llm/             #   model resolution, costs, token budgets, compaction
  providers/       #   one adapter per provider (claude, openai, google, …)
  entitlements/    #   beta-feature + capability gating (see its README.md)
  integrations/    #   integration tool registry
routes/            # HTTP surface — mounting and gating, no business logic
auth/              # Sessions, OAuth, admin + login routes
license/           # JWT verification, tier definitions, gating middleware
automation/        # Workflow engine
integrations/      # Nextcloud, Google, Microsoft, … connectors
jobs/  workers/    # Background processing
stores/            # Postgres-backed data layer
services/          # Cross-cutting domain services
```

## Docker image

CI builds and pushes `ghcr.io/bee-flow/server` (see
`.github/workflows/build-push-ghcr.yml` at the repo root). Locally:
`./scripts/build-images.sh build dev server` from the repo root.

## Contributing

See the repo-level [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup and
the commands a pull request is validated with.

## Security

Disclose vulnerabilities responsibly via **tomkooy@beeflow.nl** — do not open
a public issue. See [SECURITY.md](../SECURITY.md).

## Trademarks

"Bee Flow" and the bee logo are trademarks of Bee Flow B.V. Forks are welcome
under fair-code; please don't ship a fork under the Bee Flow name.

## Questions

- Commercial: **tomkooy@beeflow.nl**
