---
title: Free vs paid features
---

# Free vs paid features

:::warning[Subject to change]

Tier limits and feature gates on this page are still being tuned
over the coming weeks. Treat the structure below as indicative — we'll
update this page as it settles.

:::

Bee Flow ships in three tiers. The **Community** tier is the free
self-hosted core and needs no licence key: chat with agents, knowledge bases,
skills, the no-code automation builder and scheduled agent runs, multi-user
with groups, the Nextcloud connector and every built-in integration, with no
caps on users, agents, messages or knowledge sources.

Paid tiers add capability on top of that core, not headroom.

## At a glance

| Tier         | Users  | Agents | Messages/mo | What it adds over Community |
|--------------|:------:|:------:|:-----------:|------------------------------|
| `community`  | unl.   | unl.   | unl.        | (the free self-hosted core) |
| `enterprise` | unl.   | unl.   | unl.        | + team collaboration (Projects, sharing, approvals), Studio-class modules (voice, webpages, meeting notes, notebooks, App Studio), advanced Privacy Shield modes, SSO beyond Nextcloud, the Compliance Hub, beta features |
| `full`       | unl.   | unl.   | unl.        | + White-label (logo, colours, domain), sub-licence issuance |

The full feature × tier matrix lives in [Licensing → Tiers](../licensing/tiers.md). Source of truth: [`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/server/license/tiers.js).

## What Community includes

- **Workflows**: the automation builder, scheduled agent runs, the Skills marketplace.
- **Knowledge**: knowledge bases (local, vector, hybrid, reranked).
- **Integrations**: every built-in integration and the Nextcloud connector, including signing in from the Nextcloud App Store app.
- **Privacy**: Privacy Shield with the **block** action on every tier.
- **Admin**: user and group management, org settings, the AI Config, Security, Integrations, Server licence and Languages tabs.

## What needs Enterprise

- Team workspaces (Projects), sharing automations across a team, Approvals.
- Voice chat, webpage creation, meeting notes, notebooks, App Studio.
- Privacy Shield **tokenize**, Web Search Guard and your own data types.
- SSO beyond Nextcloud (Google, Microsoft, SAML), the Compliance Hub, audit-log export and the paid admin tabs.
- Beta features in general.

**Full** is for partners shipping Bee Flow under their own brand or issuing
sub-licences to downstream customers.

## Where the limits fire

The Community tier sets every cap to "unlimited", so no limit currently
fires on a fresh install. The enforcement plumbing is still in place so
custom plans can opt back into capped seats / messages / KB sources:

| Limit | Where it's enforced | What happens at the cap |
|-------|---------------------|--------------------------|
| Users | User-create endpoint, NC sync job | New users are skipped; existing users stay active |
| Agents | Agent-create endpoint | UI shows "Tier limit reached — upgrade to add more" |
| Messages / mo | Chat endpoint, automations runner | Org-wide chat returns 402 with `tier_limit` until the next month |

A monthly counter resets on the first UTC day of each calendar month.
Counter state is in Postgres; nothing is sent off-machine.

## Feature flags (premium gates)

The server uses a `requireLicenseFeature(name)` middleware that returns 403
to any user/org without the feature. Community-tier features (`skills`,
`kb_unlimited`, `custom_themes`, etc.) pass through silently. The gates
that actually fire are the paid ones:

| Feature flag | Tier | What it unlocks |
|--------------|------|-----------------|
| `pii_tokenize` | Enterprise+ | Privacy Shield tokenize action (enforced on the server for the organisation) |
| `web_search_guard` | Enterprise+ | Web Search Guard and external tool-call PII blocking |
| `compliance_hub_gdpr` | Enterprise+ | `/api/compliance` (GDPR, AI Act, ISO 27001 checks) |
| `sso_saml` | Enterprise+ | SAML 2.0 identity-provider config |
| `white_label` | Full | Replace branding, custom theme assets |
| `license_issuance` | Full | Mint sub-licences for downstream tenants |

Some Enterprise flags (for example `guardrails_dlp` and `audit_log_export`) are
declared in `tiers.js` but not enforced by a route yet; the
[tier reference](../licensing/tiers.md#feature-flag-names) lists which is which.

## Legacy Pro keys

Bee Flow previously offered a paid **Pro** tier. It has been retired and its
features now ship in **Enterprise**. Existing licence keys carrying
`tier: "pro"` continue to validate and silently resolve to `enterprise`, so
paying customers keep access (and gain the compliance features) without
reactivating.

## Why fair-code?

The frontend and server are released under the **Sustainable Use Licence**.
You can use, modify and self-host them for free for your own organisation.
You cannot offer Bee Flow as a paid service to third parties without a
commercial agreement.

The Nextcloud connector is **AGPL-3.0-or-later** to comply with App Store
requirements.

[More on the licensing model →](../licensing/index.md)
