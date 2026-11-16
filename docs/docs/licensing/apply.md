---
title: Applying a licence key
---

# Applying a licence key

After purchase, you receive a JWT in your inbox. To apply it:

## Before you paste a key: the public key {#public-key}

A licence key is a signed JWT, and the server can only accept it when it has
Bee Flow's licence **public key** to check the signature against. A self-hosted
server does not ship with that key: set one of these in `.env` and restart.
The self-host Compose file (`docker-compose.from-registry.yml`, what
`./selfhost.sh` runs) passes all three through to the server; with another
Compose file, add them to the server's `environment:` list yourself.

| Variable | What it is |
|---|---|
| `LICENSE_PUBLIC_KEY` | The public key as inline PEM, with literal `\n` between the lines. |
| `LICENSE_PUBLIC_KEY_FILE` | A path to the PEM file inside the container, for example `/app/data/license-public-key.pem` (that path is in the `beeflow-data` volume, so it survives upgrades). |
| `LICENSE_JWKS_URL` | Bee Flow's key set (`https://license.beeflow.nl/v1/jwks.json`). It must be an `https://` URL. The server picks the key whose `kid` matches the licence key; a licence key without a `kid` is checked against the PEM above. |

Without any of them, pasting a key fails with `no_public_key_configured`. A
development checkout may carry a development key at
`server/license/bundled-public-key.pem`; a production server refuses that file
unless `LICENSE_ALLOW_BUNDLED_KEY=true`, so that a forgotten setting cannot
make it accept development-signed keys.

An admin blob (`beeflow-admin-v1.…`, see below) is not signed and needs no
public key.

## In the UI

1. Open Bee Flow as an organisation admin.
2. Go to **Admin dashboard → Workspace → Licence & usage**.
3. Paste the JWT into the **Licence key** field and click **Apply**.

The server verifies the signature against the public key configured above and updates the active tier immediately. Premium features become available without a restart.

![Applying a licence key](../img/screenshots/admin/license-apply/)

## Server-wide application

A super-admin can apply **one** licence that governs **every
organisation** on the server instead of activating the same key per-org.

1. Sign in as a super-admin.
2. Open **Admin dashboard → Whole server → Licence & features → Server licence**.
3. Paste the JWT (or `beeflow-admin-v1.…` admin blob) and confirm.

An admin blob (`beeflow-admin-v1.…`) carries no signature, so only a
super-admin can activate one. Pasted by anyone else, in
**Admin dashboard → Workspace → Licence & usage** for example, it is refused
with a `403` (`admin_blob_super_admin_only`).

While a server-wide licence is active:

- Every organisation and consumer on the install resolves to the
  server-wide tier — **per-organisation licences are ignored**.
- Per-organisation activation in **Admin dashboard → Workspace → Licence & usage**
  is replaced with a read-only banner ("Tier is managed server-wide").
- Deactivating the server-wide licence from the same admin panel
  restores per-organisation licences immediately (per-org rows are
  preserved in the database, not deleted).

**Restrictions:**

- Super-admin only — org admins receive `super_admin_required`.
- Community-tier licences are rejected (`community_server_license_pointless`)
  since Community is the default floor for every install.

A server-wide licence overrides **every** organisation's tier at once, so
on a genuinely multi-tenant install apply it deliberately.

API reference. The login hands out no token: the calls carry the session
cookie of a signed-in super-admin (see [Authentication](../api/auth.md)).

```bash
# Sign in once and keep the session cookie
curl -c cookies.txt -X POST https://beeflow.example.com/auth/admin-login \
  -H "Content-Type: application/json" \
  -d '{ "username": "admin@example.com", "password": "..." }'

# Apply
curl -b cookies.txt -X POST https://beeflow.example.com/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{ "token": "eyJhbG...", "scope": "server" }'

# Remove
curl -b cookies.txt -X DELETE 'https://beeflow.example.com/api/license/deactivate?scope=server'
```

## There is no environment variable for the key itself

A licence key is applied in the app (or through `POST /api/license/activate`
above) and stored in the database. No environment variable carries the key:
earlier versions of this page named `BEEFLOW_LICENSE_KEY`, which the server
has never read. The only licence settings in `.env` are the public key above
and the optional refresh settings in
[Connecting to the license server](./server-deploy.md).

## Verifying the active tier

`GET /api/license/status`, as a signed-in user, returns the tier the caller
resolves to:

```json
{
  "tier": "enterprise",
  "source": "license_key",
  "scope": "server",
  "license": {
    "id": "…",
    "tier": "enterprise",
    "issuer": "license.beeflow.nl",
    "issuedAt": "2026-05-09T00:00:00.000Z",
    "expiresAt": "2027-05-09T00:00:00.000Z",
    "billingInterval": "yearly",
    "lastRefreshAt": null,
    "refreshStatus": null,
    "revokedAt": null,
    "scope": "server",
    "metadata": {}
  },
  "subscription": null,
  "features": ["chat_basic", "automations", "voice_chat", "meeting_notes", "…"],
  "limits": {
    "max_users": -1,
    "max_agents": -1,
    "max_messages_per_month": -1,
    "max_kb_sources": -1
  },
  "serverOverride": true,
  "serverLicense": { "…": "…" }
}
```

`-1` means unlimited. `license.lastRefreshAt` is set when the server re-checks
the key with the licence server, which it does only when `LICENSE_REFRESH_URL`
is set.

## JWT structure

The licence is a standard JWT signed with Bee Flow's RSA private key
(`RS256`); a key with any other `alg` is refused. Header / claims:

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "…"
}
.
{
  "iss": "license.beeflow.nl",
  "sub": "org_abc",
  "license_id": "…",
  "tier": "enterprise",
  "iat": 1715212800,
  "exp": 1746748800
}
```

`iss`, `tier`, `license_id` and `exp` are required. A key for the `full` tier
must come from the issuer `license.beeflow.nl/internal`.

Verification logic lives in [`server/license/verify.js`](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/license/verify.js).

## Rotating

Paste a new key at any time — it overwrites the old one. Two situations:

- **Renewal** — same tier, new `exp`. Replace and you're done.
- **Upgrade** to a higher tier — premium features that were 403 immediately become reachable. Routes that were UI-hidden appear in the nav.

## Removing

Clear the field and click **Apply**. The org reverts to the Community tier. Premium features become unavailable but **all data is preserved**: what you built with them stays in the database, and the guardrail audit log keeps its existing rows.

Re-applying a valid key restores everything.

## Troubleshooting

Activation answers `400` with the reason in `code`:

| Code (starts with) | Cause | Fix |
|-------|-------|-----|
| `no_public_key_configured` | The server has no licence public key. | Set `LICENSE_PUBLIC_KEY`, `LICENSE_PUBLIC_KEY_FILE` or `LICENSE_JWKS_URL` ([above](#public-key)) and restart. |
| `invalid_signature` | The key was altered, or the server verifies against a different public key than the one that signed it. | Paste the key exactly as you received it; check the public key setting. |
| `token_expired` | `exp` is in the past. | Renew at [https://beeflow.nl/pricing](https://beeflow.nl/pricing) or contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl). |
| `unexpected_alg` | The key is not signed with `RS256`. | Use the key Bee Flow issued. |
| `untrusted_issuer` | The key's `iss` is not Bee Flow's licence server. | Use the key Bee Flow issued. |

After activation:

| What you see | Cause | Fix |
|-------|-------|-----|
| The tier falls back to Community and the licence shows as revoked | The licence server marked your key as revoked. | Contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl). |
| A monthly licence expires although `exp` is in the future | `LICENSE_REFRESH_URL` is set and has been unreachable for longer than the grace window (`LICENSE_GRACE_WINDOW_SECONDS`, 10 days by default). | Let the server reach the licence host, or leave `LICENSE_REFRESH_URL` unset. |

## Air-gapped deployments

The refresh check is opt-in: with `LICENSE_REFRESH_URL` unset, which is the
default, the server never contacts the licence server and the licence is valid
offline through `exp`. Give the server the public key as a PEM
(`LICENSE_PUBLIC_KEY` or `LICENSE_PUBLIC_KEY_FILE`), since a JWKS URL cannot be
reached. To rotate, ship a new JWT.
