---
title: "Permissions & access scope"
---

# Permissions & access scope

**Nextcloud gives an external app identity, not authorization.** That is worth
stating plainly, because it decides where the boundary actually lives:

- AppAPI's declarative **ApiScopes were removed in AppAPI 3.2.0**
  ([app_api#373](https://github.com/nextcloud/app_api)). An ExApp with a valid
  shared secret can act as any enabled user, for any API. There is no manifest
  block that narrows it and no install-time scope dialog.
- **App passwords** carry a single boolean filesystem flag — no per-folder or
  per-calendar scoping ([server#35262](https://github.com/nextcloud/server/issues/35262)).
- **OAuth2** is unscoped by Nextcloud's own admin manual: *"Nextcloud OAuth2
  implementation currently does not support scoped access… every token has full
  access to the complete account."*

So the connector does not claim to be limited by Nextcloud. It is limited by
four mechanisms Bee Flow implements and you can audit.

## 1. The route allow-list (what Nextcloud will even forward)

[`appinfo/info.xml`](https://github.com/Bee-Flow/connector/blob/main/appinfo/info.xml)
declares every path AppAPI may proxy and at which access level. AppAPI enforces
this *before* the connector sees a request:

| Route | Level | Why |
|---|---|---|
| `^/?api/.*`, `^/?auth/.*`, catch-all | `USER` | Requires a signed-in Nextcloud user; AppAPI forwards their uid. A `PUBLIC` catch-all would let anonymous traffic through. |
| `^/?heartbeat$`, static shell | `PUBLIC` | Lifecycle and assets; no user session exists. |
| `^/?init$`, `^/?enabled$`, `^/?setup/...` | `ADMIN` | Anything that could disrupt the whole organisation (rotate the tenant key, repoint the server, redeem a pairing code). |
| `^/?hooks/.*` | `PUBLIC` + brute-force protection | Delivered by a Nextcloud background job with no session; authenticated by a static header secret, so Nextcloud throttles repeated rejections. |
| `^/?nc/.*` | `PUBLIC` | The Bee Flow server calling back into Nextcloud; authenticated by HMAC (below), not by a session. |

## 2. Per-user impersonation (whose data a call can reach)

Every call the connector makes into Nextcloud carries
`AUTHORIZATION-APP-API: base64(<uid>:<APP_SECRET>)`. The uid half *is* the
impersonation: AppAPI validates the secret, confirms the user exists and is
enabled, and switches the request context to them. There is **no shared service
account** — a call made for you can only ever read what your own Nextcloud
account can read.

Two consequences worth knowing, both documented by Nextcloud: requests
authenticated this way **bypass CORS, two-factor authentication and rate
limiting**, and WebDAV/CalDAV accept the same headers (AppAPI registers a Sabre
auth backend), which is why no app password is needed for files or calendars.

*(An older version of this page described an `EX-APP-USER-ID` header and a
`<scopes>` block. Neither exists: the header is `AUTHORIZATION-APP-API`, and the
scopes block was removed from AppAPI.)*

## 3. Signed callbacks (`/nc/*`)

The Bee Flow server reaches Nextcloud only through the connector's `/nc/*`
route, signed per request with the org's tenant key:

```
message = <unix-ts>\n<REAL-METHOD>\n<decoded-path>\n<nc-uid>\n<sha256(body)>
header  = X-Beeflow-Sig: <unix-ts>.<hex-hmac-sha256>
```

The signature covers the body, so an observed signature cannot be replayed with
different content; it covers the real method, so a tunnelled WebDAV verb cannot
be swapped; and it is rejected outside a small clock-skew window. The connector
fails closed when no tenant key is present and rate-limits signature failures.
Repeated rejections are surfaced in `/setup/diagnostics` — under HaRP a run of
them can get the calling IP banned, so they are an operational signal, not just
an auth outcome.

## 4. The per-user access scope (what you actually shared)

This is the layer that replaces what Nextcloud does not provide. In
**Settings → Integrations → Nextcloud → "What Bee Flow may access"** each user
decides, per integration, one of:

- **Everything** — the default; nothing changes for existing users.
- **Only selected** — a specific set of folders, calendars, address books,
  boards, conversations, task lists, mail accounts, tables or forms.
- **Off** — the integration is not offered to the assistant at all.

Properties that make it auditable rather than decorative:

- **Enforced server-side, at one point.** Every Nextcloud tool call — from chat,
  automations, scheduled AI tasks, Cowork and Studio apps alike — passes through
  a single guard in the Bee Flow tool dispatcher before the call is made, and
  list/search results are filtered afterwards. The UI is a view of the setting,
  never the thing enforcing it.
- **Narrow-only.** The scope is resolved *after* the org's entitlements and the
  admin's integration toggles. It can subtract from them and never add: a user
  cannot re-grant themselves an integration an admin removed.
- **Fail-closed.** If the scope cannot be read, calls are denied rather than
  allowed. A tool that cannot be limited to a selection (an id-indirect lookup
  such as "read message 42") is refused while a selection is active, with an
  explicit reason, instead of quietly bypassing it.
- **Revocable in one action.** *Revoke all Nextcloud access* sets every
  integration to off. *Reset to default* returns to everything.
- **Audited.** Every change writes an audit event (`nc_scope:user`) with a
  per-integration diff of what changed.

## Org-level controls

In **Admin → Nextcloud integrations** an org admin can:

- set which Nextcloud integrations are enabled org-wide, and
- override per group — disabling specific integrations for a group's members
  (interns get no Talk, finance gets no Mail).

The per-group rule is **enable wins**: a user keeps access if at least one of
their groups still allows it. The org-wide list and the per-user scope compose
most-restrictive-first, so an integration is available only if the org allows it
*and* the user has not narrowed or disabled it.

## What the assistant can and cannot do

| Bee Flow can | Bee Flow cannot |
|--------------|------------------|
| Read a file you ask it to summarise, within the folders you shared | Reach a folder outside your selection — the call is refused, not silently emptied |
| Draft a reply to an email you point at | Read your entire inbox uninvited |
| Create a calendar event in a calendar you shared | Walk a calendar you did not share |
| Search on your behalf, scoped to your account | Access another user's data — there is no service account |
| Post in a conversation you specify | Spam every channel |

## How to revoke

| Level | Action | Effect |
|---|---|---|
| User | **Settings → Integrations → Nextcloud → Revoke all Nextcloud access** | Every Nextcloud integration off for you, immediately. Data already in Bee Flow stays. |
| Org admin | **Admin → Nextcloud integrations** | Removes an integration for the whole organisation, or for one group. |
| Nextcloud admin | **Apps → Disable Bee Flow** | Stops the connector; the bee icon disappears for everyone. Tenant data is **not** auto-deleted (use the Danger zone). |
| Nextcloud admin | Rotate the tenant key (**/setup**) | Invalidates every signed callback the Bee Flow server holds. |

## Audit trail

Nextcloud-side, every OCS/DAV call the connector makes is recorded in
`data/nextcloud.log` with the `app_api` source, carrying the impersonated uid:

```bash
tail -f data/nextcloud.log | grep '"app":"app_api"' | grep bee_flow
```

Bee Flow-side, access-scope changes and tool-level activity are in
[Admin → Audit & compliance](../admin/audit-and-compliance.md).
