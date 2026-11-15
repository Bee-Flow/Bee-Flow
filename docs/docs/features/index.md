---
title: Features
---

# Features

Bee Flow ships a layered feature set. Some are free at the Community tier; others are gated behind a licence key. See [Tiers](../getting-started/tiers.md) for the full matrix.

## By feature

<div className="bf-grid">

-    [Chat & agents](chat.md)

    **Community+** — Conversational UI on top of every integration. Agents are reusable, named personas with their own tool sets. 10 system starter agents seeded out of the box.

-    [Knowledge bases](knowledge.md)

    **Community+** — Drop documents in, ask questions across them. Local, vector, hybrid and reranked knowledge bases are all part of Community.

-    [Automations](automations.md)

    **Community+** (sharing with a team and approvals: **Enterprise+**) — Trigger-based workflows. When an email tagged urgent arrives, summarise and post in Talk. Cron / webhook / NC event / manual triggers.

-    [Privacy shield](privacy-shield.md)

    **Community+** — Detect and redact emails, phone numbers, IBANs, BSNs, credit-card numbers and 14 other categories before prompts reach the model.

-    [Voice](voice.md)

    **Enterprise+** — Full-duplex voice calls with the assistant. Voxtral STT/TTS, energy-VAD, barge-in.

</div>

## By use case

| I want to… | Start here |
|------------|------------|
| Summarise a long email or PDF | [Chat & agents](chat.md) |
| Ask questions across a folder of docs | [Knowledge bases](knowledge.md) |
| Auto-triage my inbox every 10 min | [Automations](automations.md) |
| Make sure customer data never leaves the tenant | [Privacy shield](privacy-shield.md) |
| Log + audit every AI prompt for compliance | [Audit & compliance](../admin/audit-and-compliance.md) |
| Talk to the assistant by voice | [Voice](voice.md) |
| Build a custom agent for support tickets | [Studio → Agent designer](../studio/agent-designer.md) |
| Embed Bee Flow chat into another product | [API → Authentication](../api/auth.md) |

## How tier gating works

Premium features are blocked at two layers:

1. **UI** — gated nav entries are hidden at lower tiers (`<RequireTier>` wrapper).
2. **API** — the `requireLicenseFeature()` middleware on the server returns 403 if the feature isn't allowed for the org's tier.

If you reach a 403, your tier doesn't include that feature. Upgrade or contact [tomkooy@beeflow.nl](mailto:tomkooy@beeflow.nl). Source of truth: [`server/license/tiers.js`](https://github.com/Bee-Flow/Bee-Flow/blob/main/server/license/tiers.js).
