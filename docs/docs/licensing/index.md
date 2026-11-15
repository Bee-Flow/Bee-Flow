---
title: Licensing
---

# Licensing

Bee Flow uses **fair-code** licensing. The server (`server/`), the frontend (`agent-hub/`) and the clients are released under the **Sustainable Use Licence** (SUL). The Nextcloud connector (`nextcloud-connector/`) is **AGPL-3.0-or-later**. Everything lives in one repository, [`Bee-Flow/Bee-Flow`](https://github.com/Bee-Flow/Bee-Flow).

> **In short**: you can self-host Bee Flow for free for your own organisation. You cannot offer Bee Flow as a paid service to third parties without a commercial agreement.

## Component licence matrix

The authoritative table is [`LICENSE.md`](https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md) in the repository root; this is a summary.

| Directory | Licence | Why |
|------|---------|-----|
| `server/`, `agent-hub/` (server and frontend) | Sustainable Use Licence | Allows free self-hosting; protects against pure SaaS resale. |
| `desktop/`, `mobile/`, `components/`, `guard-service/`, `classify-service/` | Sustainable Use Licence | Same. |
| `nextcloud-connector/` (NC ExApp, mirrored to `Bee-Flow/connector`) | AGPL-3.0-or-later | Required by the Nextcloud App Store. |
| `docs/` (this site) | Documentation: CC-BY-4.0 · Code samples: MIT | Encourage reuse of docs. |

## How feature gating works

```
            ┌───────────────────────────┐
            │ Bee Flow licence-server   │  (PRIVATE — Bee Flow only)
            │ Mints signed JWT licenses │
            │ RSA private key (RS256)   │
            └─────────────┬─────────────┘
                          │ signs
                          ▼
        ┌─────────────────────────────────┐
        │ JWT (delivered by mail/dash)    │
        └─────────────────┬───────────────┘
                          │ admin pastes
                          ▼
   ┌───────────────────────────────────────────────────────┐
   │ Bee Flow server (PUBLIC, fair-code)                   │
   │ Verifies JWT against Bee Flow's public key            │
   │ requireLicenseFeature(name) middleware enforces gates │
   └───────────────────────────────────────────────────────┘
```

The verification code is part of the source-available server — read it in [`server/license/`](https://github.com/Bee-Flow/Bee-Flow/tree/main/server/license). Three files:

- `verify.js` — JWT signature verification (`RS256`) against the public key the operator configures: `LICENSE_PUBLIC_KEY`, `LICENSE_PUBLIC_KEY_FILE` or `LICENSE_JWKS_URL`. A self-hosted server does not ship with that key; see [Applying a licence key](apply.md#public-key).
- `tiers.js` — feature-flag mapping per tier (source of truth).
- `middleware.js` — `requireLicenseFeature(name)` Express middleware.

A licence is a JWT with claims like:

```
{
  "iss": "license.beeflow.nl",
  "sub": "org_abc",
  "license_id": "…",
  "tier": "enterprise",
  "exp": 1759276800
}
```

The server validates the signature, ensures `exp` is in the future, and resolves the tier and its features from [`tiers.js`](tiers.md) for every request.

## What stops at the gate vs what degrades

| At the gate | Degrades |
|-------------|----------|
| Premium routes return **403 Forbidden** with `error: "feature_locked"`, the feature's name and the tier it needs. | Tier limits (users / agents / messages) — UI stays visible but new-create returns 402. |
| UI nav items disappear (`<RequireTier>`). | Existing automations keep running until the org explicitly stops them — no surprise downgrade mid-run. |
| Webhook automations stop firing on tier downgrade. | Audit log keeps recording — never silently disabled. |

## Refresh policy

Licences are **valid offline** for their `exp` window. Revocation checking is **opt-in**: with `LICENSE_REFRESH_URL` unset — the default — the server never contacts the licence server at all. Point it at `https://license.beeflow.nl/v1/refresh` (or your own stub) to enable a periodic check of monthly licences, every 24h by default; yearly and lifetime licences are not pinged. With the check off, the licence stays valid until `exp`: the JWT signature and expiry are what count. With it on, a monthly licence the server cannot re-confirm for longer than the grace window (`LICENSE_GRACE_WINDOW_SECONDS`, 10 days by default) expires, and a revoked one falls back to Community at once.

## AGPL isolation: connector ↔ server

The Nextcloud connector (`nextcloud-connector/`) is licensed under **AGPL-3.0-or-later**, while the rest of the platform (`server/`, `agent-hub/`, sidecars) is under the Sustainable Use License. The Nextcloud App Store requires AGPL for ExApps, so this split is deliberate.

The split is legally bounded because the connector and the server are two **separate programs** that communicate only over HTTP, authenticated with JWT tokens. There is no static or dynamic linking, no shared address space, no in-process FFI — nothing that would combine them into a single work for copyright purposes.

Concrete evidence in the code:

- The connector's outbound HTTP call site lives in [nextcloud-connector/src/server.js](https://github.com/Bee-Flow/connector/blob/main/src/server.js); it sets `X-Beeflow-Source: nextcloud-connector`.
- The server's inbound JWT verification is in [server/auth/connectorJwt.js](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/auth/connectorJwt.js).
- The unauthenticated handshake during first-time pairing is in [server/auth/connectorBootstrap.js](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/auth/connectorBootstrap.js).
- The middleware wiring in [server/index.js](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/index.js).

This matches the FSF's published interpretation of the GPL/AGPL family ("Mere aggregation" and "separate programs in pipes" — see [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)). AGPL §13 ("Remote Network Interaction") therefore covers the connector itself but does not propagate to the server.

If you fork the connector and modify it, AGPL §13 obliges you to make your modified connector source available to the connector's users — even if those users only interact with it over a network. That obligation does not extend to the Bee Flow server, which remains under its own license.

The full statement of this argument lives in [NOTICE.md](https://github.com/Bee-Flow/Bee-Flow/blob/main/NOTICE.md) at the repo root.

## Pages

- [Tiers](tiers.md) — what you get at each level.
- [Applying a licence key](apply.md) — paste the JWT you received.
- [Fair-code FAQ](faq.md) — what you can and can't do.

## Buying a key

Pricing and signup live at [https://beeflow.nl/pricing](https://beeflow.nl/pricing). For volume / non-profit / education discounts, email [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl).
