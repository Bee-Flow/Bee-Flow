---
title: Nextcloud integrations
---

# Nextcloud integrations

Path: **Admin → Nextcloud integrations**.

This panel controls which of the 11 Nextcloud integrations are available, at three levels: org-wide default, per-group override, and ultimately what each user sees.

![NC integrations panel](../img/screenshots/admin/nc-integrations-org/)

## Three-layer model

```
┌───────────────────────────────────┐
│ 1. Org default                    │  Tick boxes — what's on for the whole org
├───────────────────────────────────┤
│ 2. Per-group disable list         │  Specific groups can DISABLE org-on tools
├───────────────────────────────────┤
│ 3. Resolved per user              │  User sees a tool if AT LEAST ONE of
│                                   │  their groups still allows it
└───────────────────────────────────┘
```

The rule for layer 3 is **enable wins** — if a user is in two groups, one disabling Mail and one allowing Mail, the user gets Mail. Disabling for everyone means disabling in *every* group the user belongs to.

## Tab 1 — Org default

A grid of the 11 integrations with on/off toggles:

| Integration | Default |
|-------------|:-------:|
| Files & WebDAV | ✅ |
| Mail | ✅ |
| Calendar | ✅ |
| Contacts | ✅ |
| Deck | ✅ |
| Talk | ✅ |
| Notes | ✅ |
| Tasks | ✅ |
| Activity | ✅ |
| Notifications | ✅ |
| User Status | ✅ |

Saving here sets the org's `enabledIntegrations` array. This becomes the **default** for users unless overridden by their groups.

## Tab 2 — Per-group overrides

A table with one row per group (NC-synced + Bee Flow-native). For each group, a multi-select of integrations to **disable** for its members.

Examples:

| Group | Disabled integrations |
|-------|------------------------|
| `interns` | Talk, Mail |
| `finance` | (none) |
| `engineering` | (none — they get everything) |

The UI shows a count of affected users next to each group, so you can see the blast radius before saving.

## Walkthrough — disable Mail for interns

1. Go to **Admin → NC integrations → Per-group**.
2. Find the `interns` group row.
3. In the multi-select, add **Mail**.
4. Save.

Effect: every `interns` member loses access to `nextcloud_mail_*` tools — even if they're also in another group. Wait — that's wrong. **Enable wins**. If an intern is *also* in `engineering`, and engineering doesn't disable Mail, they keep it. To truly remove Mail, disable it everywhere they're a member.

In practice, design groups so users belong to exactly one "feature tier" group. The intuitive behaviour ("they're an intern, they shouldn't have Mail") works when interns are *only* in `interns` — and you separately decide whether to also disable Mail in any group they happen to also be in.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| User belongs to no groups | Org default applies. |
| Org has integration disabled | All groups inherit; per-group overrides become moot for that integration. |
| User loses all groups | Org default applies. |
| Group is deleted | Its disable list disappears; users may regain access. |

## Per-tool exceptions

If you need finer granularity than per-integration (e.g. "Sales can read Mail but not draft / send"), do it at the **agent level**: build an agent with `nextcloud_mail_search` + `nextcloud_mail_read` enabled but not `nextcloud_mail_compose` / `_send`. Then share that agent with the Sales group.

## Lock per-user override

By default, individual users can re-enable disabled integrations at the user level (**Settings → Account → Integrations**). To prevent this, toggle **Lock user-level overrides** in the Org default tab. Useful for compliance.

## Source of truth

The settings live in Postgres on the org row (`enabledIntegrations` array) and on each group row (`disabled_integrations` array). The runtime resolution happens in `server/core/integrationTools.js` at every chat turn — no server restart needed.

## Related

- [Connector → Permissions & scopes](../connector/permissions.md) — what each scope grants.
- [Integrations → catalog](../integrations/index.md) — full list of available integrations.
- [Integrations → Nextcloud Files](../integrations/nextcloud.md) — and the 10 sibling pages.
