---
title: Authentication
---

# Authentication

Bee Flow authenticates a browser client with a **server-side session cookie**, and a connector
client with a **bearer JWT**. These are different mechanisms — the password login does not issue a
token.

- Browser / SPA: a `connect.sid` cookie (name overridable via `COOKIE_NAME`), backed by an
  `express-session` store. The password login establishes it; there is nothing to pass by hand.
- Nextcloud connector: an `Authorization: Bearer <jwt>` header **plus** the marker header
  `X-Beeflow-Source: nextcloud-connector`. Without the marker the JWT is ignored.

## Ways to obtain credentials

| Method | When to use | Lifetime |
|--------|-------------|----------|
| Username / password | Self-hosted standalone, no NC | session cookie, 30 days (configurable) |
| Nextcloud session | Embedded in Nextcloud (connector flow) | JWT, 300 s by default, re-minted per request |
| OAuth / OIDC (Google, Microsoft Entra, Nextcloud) | Standalone with SSO | session cookie, 30 days (configurable) |

:::note
There is no user-facing API-key scheme. An earlier version of this page documented `bfk_` keys and
an **Organisation → API keys** panel; neither exists in the product. For scripted access, use the
connector JWT flow below. (`apiKeyAuth` in the codebase guards only the internal search sidecar.)
:::

## Username / password

The field is **`username`**, not `email`. It accepts a user id, or an email address when the value
contains an `@`.

```http
POST /auth/admin-login
Content-Type: application/json

{ "username": "alice@example.com", "password": "..." }
```

Response — note there is **no token**; the session cookie on the response is the credential:

```json
{
  "success": true,
  "user": {
    "id": "u_abc",
    "email": "alice@example.com",
    "displayName": "Alice",
    "role": "admin"
  }
}
```

Subsequent requests carry the cookie:

```http
GET /api/agents
Cookie: connect.sid=s%3A...
```

If the account has two-factor authentication enabled, this route answers
`{ "mfaRequired": true, "mfaMethods": ["totp"] }` instead and the login completes at
`POST /auth/mfa/verify-login` with `{ "code": "123456" }` (an authenticator or a recovery code).

When the account has a security key (a YubiKey or another FIDO2 key), `mfaMethods` contains
`"security_key"`: `["totp", "security_key"]` for an account with both, `["security_key"]` for one
that uses keys only. Recovery codes always work at `/auth/mfa/verify-login` and are not listed.
The login can complete with the key in two WebAuthn steps:

1. `POST /auth/mfa/security-key/options` with `{}` returns `{ "options": … }`, the
   `PublicKeyCredentialRequestOptionsJSON` for `navigator.credentials.get()`. It answers
   `409 no_security_key_here` when none of the account's keys was registered for this host.
2. `POST /auth/mfa/security-key/verify-login` with `{ "response": … }`, the credential JSON the
   browser returned, completes the login exactly as a correct code does.

Both steps need the `Origin` header of an address listed in `CORS_ORIGIN`, over HTTPS (or
`http://localhost`). Wrong codes and refused keys share one budget of five attempts per password
login. A security key is a second factor on its own: keys are added and removed in
Settings → Security, and the first key on an account without two-factor authentication turns it
on and issues recovery codes, as enabling an authenticator app does. While two-factor
authentication is on, adding a key or an app, new recovery codes and turning it off all ask for
proof of a factor the account already has (a code, a recovery code, or a tap of an existing key),
and the account's last remaining factor cannot be removed on its own.

The relying-party ID a key is bound to is the host of the page, widened to `CLIENT_PUBLIC_HOST`
when the page is on a subdomain of it, so one key serves both `example.com` and
`www.example.com`. Set `WEBAUTHN_RP_ID` to choose that parent explicitly. Changing it later makes
existing keys unusable (their holders fall back to their other factors or recovery codes).

The first admin password is set during the install wizard via `POST /auth/setup`. After that, additional users sign up through `POST /auth/signup` (if signup is enabled) or are invited by an admin.

## Nextcloud session

When Bee Flow is embedded inside Nextcloud, the [connector](../connector/index.md) authenticates the user's NC session. There's no explicit login from the SPA.

There is **no handshake endpoint**. Earlier versions of this page drew one at
`GET /auth/nc-handshake`; no such route exists. The connector mints the token
itself and presents it on every request:

```
┌────────┐   AppAPI signed call      ┌──────────┐  Authorization: Bearer <jwt>   ┌────────┐
│ NC SPA │ ───────────────────────▶  │ Connector│ ─────────────────────────────▶ │ Server │
│        │                           │  signs   │  X-Beeflow-Source:             │        │
└────────┘                           │  HS256   │    nextcloud-connector         └────────┘
                                     └──────────┘
```

The connector signs a short-lived HS256 JWT with the customer's tenant key
(`connector_tenant_key_<organizationId>`, held encrypted in the config store)
and sends it as `Authorization: Bearer <jwt>` with an
`X-Beeflow-Source: nextcloud-connector` marker. The server side is
`server/auth/connectorJwt.js`: it resolves the tenant by trying keys until one
verifies, then populates the request session so downstream handlers see no
difference from a cookie session. An email that is not provisioned is refused
with 403 — the connector path never auto-creates users.

The JWT carries `tenantId`, `ncUid`, `roles`, `exp`. TTL is `BEEFLOW_JWT_TTL_SECONDS` (default 300 s — short on purpose). Because the token travels on every request, there is nothing to refresh.

## Scripted / server-to-server access

There is no API-key panel. A script authenticates the same way the Nextcloud connector does: sign a
short-lived HS256 JWT with the org's tenant key and send it with the marker header.

```http
GET /api/agents
Authorization: Bearer <jwt signed with the org tenant key>
X-Beeflow-Source: nextcloud-connector
```

The JWT must carry `email` (the account it acts as) and is signed with `issuer:
"nextcloud-connector"` and `audience: "beeflow.nl"`. The tenant key is a **bearer credential for the
whole organisation** — anything holding it can act as any provisioned account in that org, so treat
it like a private key and keep it out of shell history and version control.

## OAuth (social login)

Configure Google, Microsoft Entra or Nextcloud OAuth in **Settings → Organisation → SSO**
(client id, client secret, and the tenant id for Entra). The login screen shows a button per
configured provider. GitHub is not a login provider — it is an ISO-evidence connector.

The routes are provider-parameterised; there is no per-provider path:

```http
GET /auth/login/google       → 302 to the provider
                             → callback GET /auth/callback/google
                             → establishes the session and redirects to /app
```

So the redirect URI to register with the identity provider is
`https://your-host/auth/callback/<provider>`.

The first user to log in via OAuth becomes a regular user in the org indicated by the email domain (or in a fallback "default" org if no domain match).

## SAML — not implemented {#saml-not-implemented}

:::warning[There is no SAML support in Bee Flow]

Earlier versions of this page described an ACS URL, an SP entity ID and a
metadata-XML paste flow. **None of those endpoints exist**, and no version of
Bee Flow has ever served them. If you planned an identity integration on the
strength of that section, or wrote it into an access-control policy, treat SAML
as unavailable and use one of the OIDC providers below.

The name `sso_saml` does appear in the product — it is the identifier of the
**licence capability** that gates enterprise SSO. It gates the Microsoft Entra
and Google providers; it does not indicate a SAML implementation.

:::

Enterprise SSO today is OpenID Connect / OAuth 2.0:

| Provider | Protocol | Licence |
|----------|----------|---------|
| Microsoft Entra ID | OIDC | Enterprise (`sso_saml` capability) |
| Google Workspace | OIDC | Enterprise (`sso_saml` capability) |
| Nextcloud | OAuth 2.0 | Community — exempt from the capability gate |

Configure them in **Settings → Organisation → SSO**: a client id and client
secret per provider, plus the tenant id for Entra. Bee Flow's redirect URI is
`https://your-host/auth/callback/<provider>`.

## Token lifetime

| Token type | Lifetime | Renewal |
|------------|----------|---------|
| Browser session | 30 days from sign-in, `SESSION_MAX_AGE_DAYS` | none by default — see below |
| Connector JWT | `BEEFLOW_JWT_TTL_SECONDS` (default 300 s) | minted per request by the connector; nothing to renew |
| API key | until revoked | manual rotation |
| OAuth / OIDC browser session | the same — it is the same session | the same |

### Session lifetime, corrected

Earlier versions of this page said "14 days, sliding, refreshed on every
successful API call". That was wrong on all three counts, and if you wrote it
into an access-control policy it is worth re-reading now:

- It is a **server-side session** with a cookie, not a JWT.
- The default is **30 days**, not 14.
- It does **not** slide by default. The window runs from sign-in: signing in on
  the 1st means signing in again on the 31st however much you used it in
  between, and a session untouched since the 1st is still valid on the 30th.

Both are now settings, so an organisation can match the product to its own
policy rather than the other way round:

| Variable | Default | Effect |
|----------|---------|--------|
| `SESSION_MAX_AGE_DAYS` | `30` | Session lifetime in days. Fractions are allowed (`0.5` = 12 hours). Capped at 365. An unparseable or non-positive value falls back to 30 and logs a warning — it never becomes "no expiry". |
| `SESSION_ROLLING` | `false` | `true` restarts the clock on each request, turning the lifetime into an **inactivity** timeout. This is what most written access-control policies actually describe. Only the exact string `true` enables it; anything else is refused with a warning rather than guessed. |

The defaults are deliberately unchanged from what installations have always run.
Shortening the window signs people out sooner, which is a trade for whoever runs
the installation to make.

## Header / cookie precedence

If both are present, **`Authorization` header wins**. This lets a browser session coexist with API-key calls from the same origin.

## Logout

```http
POST /auth/logout
```

Clears the cookie + records the JWT in a server-side denylist for its remaining lifetime. API keys are not affected — revoke them in the UI.

## Inspecting your token

```http
GET /auth/user
Authorization: Bearer <jwt>
```

Returns the user record + the resolved tier features:

```json
{
  "id": "u_abc",
  "email": "alice@example.com",
  "displayName": "Alice",
  "role": "admin",
  "organizationId": "org_xyz",
  "tier": "pro",
  "features": ["automations", "voice", "..."],
  "limits": { "users": 25, "agents": 20, "messages": 50000 }
}
```

## Common errors

| Status | `error` | Meaning |
|--------|---------|---------|
| 401 | `missing_token` | No session cookie, and no `Authorization` + `X-Beeflow-Source` pair. |
| 401 | `invalid_token` | JWT signature mismatch or revoked. |
| 401 | `expired_token` | `exp` in the past. Re-login or refresh. |
| 403 | `forbidden` | Auth ok, role insufficient. |
| 403 | `license_feature_required` | Tier doesn't include the feature. |
