---
title: Applying a licence key
---

# Applying a licence key

After purchase, you receive a JWT in your inbox. To apply it:

## In the UI

1. Open Bee Flow as an organisation admin.
2. Go to **Settings → Organisation → Licence & usage**.
3. Paste the JWT into the **Licence key** field and click **Apply**.

The server verifies the signature against the Bee Flow licence server's public key (configured with `LICENSE_PUBLIC_KEY` or `LICENSE_PUBLIC_KEY_FILE`, or fetched from the key set at `LICENSE_JWKS_URL`) and updates the active tier immediately. Paid features become available without a restart.

![Applying a licence key](../img/screenshots/admin/license-apply/)

## Server-wide application

A super-admin can apply **one** licence that governs **every
organisation** on the server instead of activating the same key per-org.

1. Sign in as a super-admin.
2. Open **Admin → Server licence**.
3. Paste the JWT (or `beeflow-admin-v1.…` admin blob) and confirm.

While a server-wide licence is active:

- Every organisation and consumer on the install resolves to the
  server-wide tier — **per-organisation licences are ignored**.
- Per-organisation activation in **Settings → Organisation → Licence**
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

API reference:

```bash
# Apply
curl -X POST https://beeflow.example.com/api/license/activate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <super_admin_jwt>" \
  -d '{ "token": "eyJhbG...", "scope": "server" }'

# Remove
curl -X DELETE 'https://beeflow.example.com/api/license/deactivate?scope=server' \
  -H "Authorization: Bearer <super_admin_jwt>"
```

## Via env var (self-hosted)

Set `BEEFLOW_LICENSE_KEY` and restart the server. Useful for IaC / GitOps deploys where you don't want to paste keys through a UI.

```bash
echo 'BEEFLOW_LICENSE_KEY=eyJhbG...' >> .env
docker compose up -d beeflow-server
```

The env var takes precedence over a key applied via UI, so removing it falls back to whatever was last entered in the UI (or Community tier if neither is set).

## Verifying the active tier

```bash
curl https://beeflow.example.com/api/license/status \
  -H "Authorization: Bearer <admin_jwt>"
```

Returns:

```json
{
  "tier": "enterprise",
  "expiresAt": "2027-05-09T00:00:00Z",
  "features": [
    "automations",
    "webpages",
    "meeting_notes",
    "skills",
    "voice_chat"
  ],
  "limits": {
    "max_users": -1,
    "max_agents": -1,
    "max_messages_per_month": -1,
    "max_kb_sources": -1
  },
  "tenantId": "org_abc",
  "issuedAt": "2026-05-09T00:00:00Z",
  "lastVerifiedAt": "2026-05-09T12:34:56Z"
}
```

`lastVerifiedAt` is updated when the server polls the licence-server for revocation (`LICENSE_REFRESH_URL`, default every 24 h).

## JWT structure

The licence is a standard JWT signed with the Bee Flow ECDSA P-256 private key. Header / claims:

```json
{
  "alg": "ES256",
  "typ": "JWT"
}
.
{
  "iss": "license.beeflow.nl",
  "sub": "org_abc",
  "tenantId": "org_abc",
  "tier": "pro",
  "limits": { "users": 25, "agents": 20, "messages": 50000 },
  "features": ["automations", "..."],
  "iat": 1715212800,
  "exp": 1746748800
}
```

Verification logic lives in [`server/license/verify.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/verify.js).

## Rotating

Paste a new key at any time — it overwrites the old one. Two situations:

- **Renewal** — same tier, new `exp`. Replace and you're done.
- **Upgrade** (Community → Enterprise): paid features that answered 403 become reachable immediately, and routes that were hidden appear in the nav.

## Removing

Clear the field and click **Apply**. The org reverts to the Community tier. Paid features become unavailable but **all data is preserved**: automations keep running (they are Community), skills already attached to assistants keep working, shares that already exist stay in place, and the guardrail audit log keeps its existing rows. What the Community tier refuses is new use of a paid feature, such as adding a skill, an approval step or a share. See [Tiers → When a licence lapses](tiers.md#when-a-licence-lapses).

Re-applying a valid key restores everything.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid signature` | Key was tampered with, or you pasted a key for a different deployment. | Verify the key matches what you received. |
| `License expired` | `exp` is in the past. | Renew at [https://beeflow.nl/pricing](https://beeflow.nl/pricing) or contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl). |
| `Public key not found` | `BEEFLOW_LICENSE_PUBLIC_KEY_PATH` set incorrectly. | Unset, or point at `license/bundled-public-key.pem`. |
| `Tier limit exceeded` (after applying) | The new tier is **lower** than what you had — usage already exceeds the new limits. | Either upgrade, or trim usage (delete agents, archive automations) until under the limit. |
| `License revoked` | The licence-server marked your key as revoked. | Contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl). |
| `Refresh failed (network)` | `LICENSE_REFRESH_URL` unreachable. | Non-fatal — the key stays valid until `exp`. Whitelist the licence host. |

## Air-gapped deployments

For air-gapped self-hosters:

```bash
# Disable the periodic refresh check
echo 'LICENSE_REFRESH_URL=' >> .env

# Or: serve a stub from your own host
# echo 'LICENSE_REFRESH_URL=https://my-licence-stub.internal/refresh' >> .env
```

The licence is valid offline through `exp`. To rotate, ship a new JWT.
