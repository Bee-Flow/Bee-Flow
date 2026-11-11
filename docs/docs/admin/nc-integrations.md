---
title: Nextcloud integrations
---

# Nextcloud integrations

Path: **Admin → Organisation → Integrations → Integration settings**, the **Nextcloud integrations** panel. Org admins see it when their organisation is bound to a Nextcloud instance; for any other organisation the panel is not shown.

This panel decides which of the 14 Nextcloud integrations your organisation's agents may use, with exceptions per Nextcloud group. It is separate from **Admin → Access → Grants**: the Nextcloud integrations are not rows in that matrix, and every member is entitled to them unless this panel says otherwise.

![NC integrations panel](../img/screenshots/admin/nc-integrations-org/)

## Three-layer model

```
┌───────────────────────────────────┐
│ 1. Org-wide                       │  Ticked = on for the whole org
├───────────────────────────────────┤
│ 2. Per-group exceptions           │  A Nextcloud group can DISABLE an
│                                   │  org-wide-on integration
├───────────────────────────────────┤
│ 3. Resolved per user              │  User keeps a tool if AT LEAST ONE of
│                                   │  their groups still allows it
└───────────────────────────────────┘
```

The rule for layer 3 is **enable wins**: if a user is in two groups, one disabling Mail and one not, the user keeps Mail. A user loses an integration through layer 2 only when *every* group they belong to disables it.

## Org-wide

A grid of the 14 integrations, each with a checkbox, and a **Save** button:

| Integration | Default |
|-------------|:-------:|
| Files & WebDAV | ✅ |
| Calendar | ✅ |
| Contacts | ✅ |
| Deck | ✅ |
| Mail | ✅ |
| Notifications | ✅ |
| Talk | ✅ |
| Tasks | ✅ |
| Notes | ✅ |
| Activity | ✅ |
| Tables | ✅ |
| Forms | ✅ |
| Teams | ✅ |
| User Status | ✅ |

An organisation that never saved this panel has no restriction, so everything shows as on. Once you save, the choice is recorded per integration, so unticking all of them really means "all off". When an integration is off org-wide, the server refuses calls to its tools for everyone in the organisation, in chats, automations and apps alike.

## Per-group exceptions

One row per **Nextcloud group** of the organisation (the groups the Nextcloud sync mirrors; groups made in Bee Flow are not listed here), with the number of members next to it and a count of disabled integrations. Open a row and tick **Disable Mail**, **Disable Talk** and so on for that group. An integration that is off org-wide cannot be ticked here ("Enable org-wide first"). Each tick is saved immediately.

![NC integrations per group](../img/screenshots/admin/nc-integrations-per-group/)

If no group is listed yet, the Nextcloud sync has not mirrored any groups; it runs every 6 hours, or use **Sync now** under **Admin → Organisation → Nextcloud Sync** (see [Users & groups](users-and-groups.md#nextcloud-sync)).

## Walkthrough: turn off Mail for interns

1. Go to **Admin → Organisation → Integrations → Integration settings**.
2. Under **Per-group exceptions**, open the `interns` row.
3. Tick **Disable Mail**.

Effect: an intern whose only group is `interns` can no longer use Mail. An intern who is *also* in `engineering`, where Mail is not disabled, keeps it: **enable wins**. To take Mail away from everyone in a set of groups, disable it in each of them, or switch it off org-wide.

In practice, design groups so users belong to exactly one "feature tier" group, and the behaviour you expect ("they're an intern, they shouldn't have Mail") follows.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| User belongs to no groups | Only the org-wide setting applies. |
| Integration is off org-wide | Off for everyone; the group exceptions for it cannot be set. |
| A user's groups disable nothing | Only the org-wide setting applies. |
| Group is deleted | Its disable list no longer counts; its former members may regain access. |

## What users can narrow themselves

Each user can narrow, never widen, what Bee Flow may touch in their own Nextcloud: on the Nextcloud row of their own **Settings → Integrations** page, per integration *all*, *selected* (specific folders, calendars, address books, boards or conversations, where the integration supports it) or *off*, plus **Revoke all Nextcloud access**. The server combines the organisation's choice and the user's choice and the most restrictive wins. There is no setting that lets a user turn on an integration this panel switched off.

## Source of truth

- The org-wide choice is stored in the configuration store under `org_nc_scope_<orgId>`, one mode per integration (`server/core/integrations/ncScope.js`). The panel also keeps the Nextcloud part of the organisation's `enabledIntegrations` column up to date for older surfaces, but that column is not what is enforced.
- The per-group exceptions are the `disabled_integrations` column on each group row.
- Enforcement happens on the server at every tool call: the org-wide and per-user scope in `server/core/integrations/ncScopeGuard.js`, the per-group exceptions in `server/core/integrations/runtimeAppGate.js`. No restart is needed.

## Related

- [Connector → Permissions & scopes](../connector/permissions.md): what each scope grants.
- [Integrations → catalog](../integrations/index.md): full list of available integrations.
- [Integrations → Nextcloud Files](../integrations/nextcloud.md): and the sibling pages.
- [Beta features](beta-features.md): how the **Admin → Access → Grants** matrix hands out every other integration and feature.
