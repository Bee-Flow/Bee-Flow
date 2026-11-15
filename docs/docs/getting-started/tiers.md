---
title: Free vs paid features
---

# Free vs paid features

:::warning[Subject to change]

Tier limits, pricing and feature gates on this page are still being tuned
over the coming weeks. Treat the structure below as indicative — we'll
update this page as it settles.

:::

Bee Flow ships in three tiers. The **Community** tier needs no licence key
and is the free self-hosted core: chat with agents, knowledge bases, skills,
the automation builder and scheduled agent runs for personal use, multi-user
with groups, the Nextcloud connector and every built-in integration, with no
caps on users, agents, messages or knowledge sources.

Paid tiers add capabilities, not headroom: **Enterprise** adds working
together (sharing automations, approvals, projects), the Studio-class features
(voice, meeting notes, webpage creation, notebooks, App Studio), single
sign-on with Google or Microsoft, the advanced Privacy Shield modes and the
compliance hub. **Full** adds white-label branding and sub-licence issuance.

## At a glance

| Tier         | Users  | Agents | Messages/mo | What it adds |
|--------------|:------:|:------:|:-----------:|--------------|
| `community`  | unl.   | unl.   | unl.        | Chat, knowledge bases, skills, personal automations, multi-user, the Nextcloud connector, all built-in integrations |
| `enterprise` | unl.   | unl.   | unl.        | + Sharing automations, approvals, projects, voice, meeting notes, webpages, notebooks, App Studio, Google / Microsoft sign-in, compliance hub (GDPR + AI Act), guardrail DLP |
| `full`       | unl.   | unl.   | unl.        | + White-label (logo, colours, domain), sub-licence issuance |

The full feature × tier matrix lives in [Licensing → Tiers](../licensing/tiers.md). Source of truth: [`server/license/tiers.js`](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/license/tiers.js).

## What Community includes

- **Chat** — agents with their own prompts and tools.
- **Workflows** — the automation builder and scheduled agent runs, private to the person who makes them; the Skills marketplace.
- **Knowledge** — Knowledge Bases.
- **Integrations** — the Nextcloud connector (including signing in with Nextcloud) and all built-in integrations.
- **Privacy** — Privacy Shield blocks personal data on every tier.
- **Admin** — user and group management, organisation settings.

## What needs Enterprise

- **Working together** — sharing automations across a team, approvals, projects.
- **Studio-class features** — voice, meeting notes, webpage creation, notebooks, App Studio.
- **Identity** — sign-in with Google or Microsoft. (Signing in with Nextcloud is Community; there is no SAML sign-in.)
- **Privacy** — tokenizing personal data instead of blocking it, the web-search guard, your own data types.
- **Compliance** — the compliance hub, guardrail DLP rules, audit log export.
- **Beta features** — features in beta, the MCP server marketplace among them.

**Full** is for partners shipping Bee Flow under their own brand or
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
`kb_unlimited`, `automations`, etc.) pass through silently. The gates
that actually fire are the paid ones, for example:

| Feature flag | Tier | What it unlocks |
|--------------|------|-----------------|
| `voice_chat` | Enterprise+ | Voice chat |
| `meeting_notes` | Enterprise+ | Transcription and summaries of meetings |
| `webpages` | Enterprise+ | AI-built webpages |
| `approvals` | Enterprise+ | Browsing approvals; deciding one that is already pending is never blocked |
| `compliance_hub_gdpr` | Enterprise+ | `/api/compliance`, guardrail audit log export, DSR flows |
| `sso_saml` | Enterprise+ | Sign-in with Google or Microsoft. The flag's name is historical: there is no SAML sign-in |
| `guardrails_dlp` | Enterprise+ | DLP rule editor and enforcement |
| `white_label` | Full | Replace branding, custom theme assets |
| `license_issuance` | Full | Mint sub-licences for downstream tenants |

The complete list is in [Licensing → Tiers](../licensing/tiers.md#feature-flag-names).

## Legacy Pro keys

Bee Flow previously offered a paid **Pro** tier. It has been retired: its
features now ship in Enterprise, except the automation builder, skills and
unlimited knowledge bases, which are in Community. Existing licence keys carrying
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
