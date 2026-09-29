---
title: Licensing
---

# Licensing

Bee Flow uses **fair-code** licensing. The frontend (`hive`) and server (`beeflow`) are released under the **Sustainable Use Licence** (SUL). The Nextcloud connector (`connector`) is **AGPL-3.0-or-later**.

> **In short**: you can self-host Bee Flow for free for your own organisation. You cannot offer Bee Flow as a paid service to third parties without a commercial agreement.

## Component licence matrix

| Repo | Licence | Why |
|------|---------|-----|
| `Bee-Flow/hive` (frontend) | Sustainable Use Licence | Allows free self-hosting; protects against pure SaaS resale. |
| `Bee-Flow/beeflow` (server) | Sustainable Use Licence | Same. |
| `Bee-Flow/connector` (NC ExApp) | AGPL-3.0-or-later | Required by the Nextcloud App Store. |
| `Bee-Flow/docs` (this site) | Documentation: CC-BY-4.0 · Code samples: MIT | Encourage reuse of docs. |

## How feature gating works

```
            ┌───────────────────────────┐
            │ Bee Flow licence-server   │  (PRIVATE — Bee Flow only)
            │ Mints signed JWT licenses │
            │ ECDSA P-256 private key   │
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
   │ Verifies JWT against bundled-public-key.pem           │
   │ requireLicenseFeature(name) middleware enforces gates │
   └───────────────────────────────────────────────────────┘
```

The verification code is part of the open-source server — read it in [`server/license/`](https://github.com/Bee-Flow/beeflow/tree/main/license). Three files:

- `verify.js` — JWT signature verification against the bundled public key.
- `tiers.js` — feature-flag mapping per tier (source of truth).
- `middleware.js` — `requireLicenseFeature(name)` Express middleware.

A licence is a JWT with claims like:

```
{
  "tenantId": "org_abc",
  "tier": "pro",
  "limits": { "users": 25, "agents": 20, "messages": 50000 },
  "features": ["automations","webpages","meeting_notes",...],
  "exp": 1759276800
}
```

The server validates the signature, ensures `exp` is in the future, then exposes the tier + features to every request through `req.license`.

## What stops at the gate vs what degrades

| At the gate | Degrades |
|-------------|----------|
| Premium routes return **403 Forbidden** with `error: "tier_limit"`. | Tier limits (users / agents / messages) — UI stays visible but new-create returns 402. |
| UI nav items disappear (`<RequireTier>`). | Existing automations keep running until the org explicitly stops them — no surprise downgrade mid-run. |
| Webhook automations stop firing on tier downgrade. | Audit log keeps recording — never silently disabled. |

## Refresh policy

Licences are **valid offline** for their `exp` window. Revocation checking is **opt-in**: with `LICENSE_REFRESH_URL` unset — the default — the server never contacts the licence server at all. Point it at `https://license.beeflow.nl/refresh` (or your own stub) to enable a periodic check, every 24h by default. Either way the licence stays valid until `exp`; the JWT signature and expiry are what count.

## AGPL isolation: connector ↔ server

The Nextcloud connector (`nextcloud-connector/`) is licensed under **AGPL-3.0-or-later**, while the rest of the platform (`server/`, `agent-hub/`, sidecars) is under the Sustainable Use License. The Nextcloud App Store requires AGPL for ExApps, so this split is deliberate.

The split is legally bounded because the connector and the server are two **separate programs** that communicate only over HTTP, authenticated with JWT tokens. There is no static or dynamic linking, no shared address space, no in-process FFI — nothing that would combine them into a single work for copyright purposes.

Concrete evidence in the code:

- The connector's outbound HTTP call site lives in [nextcloud-connector/src/server.js](https://github.com/Bee-Flow/connector/blob/main/src/server.js); it sets `X-Beeflow-Source: nextcloud-connector`.
- The server's inbound JWT verification is in [server/auth/connectorJwt.js](https://github.com/Bee-Flow/beeflow/blob/main/server/auth/connectorJwt.js).
- The unauthenticated handshake during first-time pairing is in [server/auth/connectorBootstrap.js](https://github.com/Bee-Flow/beeflow/blob/main/server/auth/connectorBootstrap.js).
- The middleware wiring in [server/index.js](https://github.com/Bee-Flow/beeflow/blob/main/server/index.js).

This matches the FSF's published interpretation of the GPL/AGPL family ("Mere aggregation" and "separate programs in pipes" — see [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)). AGPL §13 ("Remote Network Interaction") therefore covers the connector itself but does not propagate to the server.

If you fork the connector and modify it, AGPL §13 obliges you to make your modified connector source available to the connector's users — even if those users only interact with it over a network. That obligation does not extend to the Bee Flow server, which remains under its own license.

The full statement of this argument lives in [NOTICE.md](https://github.com/Bee-Flow/beeflow/blob/main/NOTICE.md) at the repo root.

## Pages

- [Tiers](tiers.md) — what you get at each level.
- [Applying a licence key](apply.md) — paste the JWT you received.
- [Fair-code FAQ](faq.md) — what you can and can't do.

## Buying a key

Pricing and signup live at [https://beeflow.nl/pricing](https://beeflow.nl/pricing). For volume / non-profit / education discounts, email [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl).
