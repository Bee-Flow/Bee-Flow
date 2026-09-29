---
title: Free vs paid features
---

# Free vs paid features

:::warning[Subject to change]

Tier limits, pricing and feature gates on this page are still being tuned
over the coming weeks. Treat the structure below as indicative — we'll
update this page as it settles.

:::

Bee Flow ships in three tiers. The **Community** tier is fully functional
with no licence key — every product feature (chat, automations, voice,
meeting notes, vector knowledge bases, web crawl, skills, agent routines,
multi-user, the Nextcloud connector and every integration) is enabled out of
the box, with no caps on users, agents, messages or knowledge sources.

Paid tiers add compliance, branding, and resale capabilities — not headroom.

## At a glance

| Tier         | Users  | Agents | Messages/mo | What it adds over Community |
|--------------|:------:|:------:|:-----------:|------------------------------|
| `community`  | unl.   | unl.   | unl.        | (the full product) |
| `enterprise` | unl.   | unl.   | unl.        | + Compliance Hub (GDPR + AI Act), guardrail DLP, SAML SSO |
| `full`       | unl.   | unl.   | unl.        | + White-label (logo, colours, domain), sub-licence issuance |

The full feature × tier matrix lives in [Licensing → Tiers](../licensing/tiers.md). Source of truth: [`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/tiers.js).

## Why Community is enough for most teams

Community installs get the whole product:

- **Workflows** — Automations, agent routines, the Component Designer, the Skills marketplace.
- **Conversation** — Push-to-talk voice, voice call, meeting-notes transcription.
- **Knowledge** — Knowledge Bases and Webpage creation.
- **Integrations** — Every Nextcloud-bridge feature, all 30+ tool integrations, OAuth-write Nextcloud access.
- **Privacy** — Privacy Shield (Standard, Strict, Custom) is enabled on every tier.
- **Admin** — User & group management, beta-feature opt-in, org settings.

A team only needs **Enterprise** if it has a hard regulatory or
identity-management requirement (SAML SSO, GDPR/AI-Act compliance hub, DLP
rules). **Full** is for partners shipping Bee Flow under their own brand or
issuing sub-licences to downstream customers.

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
| `compliance_hub_gdpr` | Enterprise+ | `/api/compliance`, guardrail audit log export, DSR flows |
| `compliance_hub_aia` | Enterprise+ | AI Act compliance hub |
| `sso_saml` | Enterprise+ | SAML 2.0 identity-provider config |
| `guardrails_dlp` | Enterprise+ | DLP rule editor and enforcement |
| `white_label` | Full | Replace branding, custom theme assets |
| `license_issuance` | Full | Mint sub-licences for downstream tenants |

## Legacy Pro keys

Bee Flow previously offered a paid **Pro** tier. It has been retired — every
Pro feature now ships in Community. Existing licence keys carrying
`tier: "pro"` continue to validate and silently resolve to `enterprise`, so
paying customers retain access (and gain the compliance features) without
needing to reactivate.

## Why fair-code?

The frontend and server are released under the **Sustainable Use Licence**.
You can use, modify and self-host them for free for your own organisation.
You cannot offer Bee Flow as a paid service to third parties without a
commercial agreement.

The Nextcloud connector is **AGPL-3.0-or-later** to comply with App Store
requirements.

[More on the licensing model →](../licensing/index.md)
