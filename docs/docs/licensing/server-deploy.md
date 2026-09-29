---
title: Connecting to the License Server
description: The settings a Bee Flow server uses to talk to Bee Flow's licence server.
---

# Connecting to the license server

Licence keys are signed JWTs minted by Bee Flow's license server: a separate,
private service that Bee Flow B.V. runs at `license.beeflow.nl`. Its source is
not part of this repository and customers never run it. The Bee Flow server in
this repository only **verifies** keys, and, when configured, asks the license
server to issue, refresh or revoke them over HTTPS.

This page covers that product side: the environment variables on the Bee Flow
server that point at the license server. A self-hosted install needs none of
them to activate a key; the bundled public key is enough (see
[Applying a licence key](./apply.md)).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `LICENSE_PUBLIC_KEY` / `LICENSE_PUBLIC_KEY_FILE` | `server/license/bundled-public-key.pem` | The public key licence JWTs are verified against: an inline PEM, or a path to one. Override only to verify keys from a different issuer. |
| `LICENSE_JWKS_URL` | _(empty)_ | A JWKS endpoint (`/v1/jwks.json` on the license server). Verification picks the key whose `kid` matches the JWT, which is what makes key rotation possible without a release. Unset, the public key above is used alone. |
| `LICENSE_REFRESH_URL` | _(empty, refresh is opt-in)_ | Where keys are re-checked for revocation, periodically. Unset means no pings at all; the JWT signature and `exp` stay authoritative either way. |
| `LICENSE_ISSUE_URL` | `https://license.beeflow.nl/v1/issue` | Where the Stripe webhook asks for a key after a paid checkout. Only used by an install that sells subscriptions itself (Bee Flow's cloud). |
| `LICENSE_ISSUE_API_KEY` | _(empty)_ | The shared secret for `LICENSE_ISSUE_URL`; it must match an API key configured on the license server. |
| `BEEFLOW_HUB_URL` | `https://hub.beeflow.nl` | The module hub behind **Admin → Modules → Marketplace**. HTTPS is required in production. |

A server that issues keys itself, as Bee Flow's cloud does, sets:

```env
LICENSE_PUBLIC_KEY_FILE=/srv/beeflow/server/license/bundled-public-key.pem
LICENSE_JWKS_URL=https://license.beeflow.nl/v1/jwks.json
LICENSE_ISSUE_URL=https://license.beeflow.nl/v1/issue
LICENSE_ISSUE_API_KEY=<the API key configured on the license server>
LICENSE_REFRESH_URL=https://license.beeflow.nl/v1/refresh
```

Restart the server after a change. Without `LICENSE_ISSUE_URL` reachable, a
paid checkout still records the subscription and the tier still resolves
through the subscription fallback; the customer only lacks a portable licence
key until one is issued.

## Checking the connection

1. `curl -fsS https://license.beeflow.nl/v1/health` returns `{"ok":true}`.
2. After a test checkout (a test card, then a refund), a `license_keys` row
   exists in the Bee Flow database and `GET /api/license/status` returns
   `source: 'license_key'`.
3. With `LICENSE_REFRESH_URL` set, a key revoked on the license server reports
   tier `community` after the next refresh tick.
