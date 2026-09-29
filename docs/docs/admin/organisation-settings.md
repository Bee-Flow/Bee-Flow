---
title: Organisation settings
---

# Organisation settings

Path: **Settings → Organisation** (URL `/app/org-settings`).

A grab-bag of org-wide configuration. Sub-pages within:

## Overview

The org's basic info: name, logo, primary contact email, default language, default timezone.

![Organisation settings overview](../img/screenshots/admin/organisation-settings/)

## Branding (Full tier)

White-label settings:

| Field | Notes |
|-------|-------|
| Org name | Replaces "Bee Flow" in titles. |
| Logo | Replaces the bee mark. SVG / PNG up to 1 MB. |
| Primary colour | Hex. Replaces amber as the accent. |
| Secondary colour | Hex. |
| Custom domain | E.g. `ai.example.com`. DNS CNAME to `beeflow.nl`. |
| Custom email sender | `From: noreply@example.com` for invites / notifications. |

White-label is gated by the `white_label` feature flag — Full tier only.

## Defaults

What new agents / KBs / users inherit:

| Default | Purpose |
|---------|---------|
| Default model | What new agents use unless overridden. |
| Default Privacy Shield level | What new agents inherit. |
| Default integrations enabled | Mirrors the [NC integrations](nc-integrations.md) panel. |
| Default starter prompts language | English / Dutch / German / etc. |

## Studio policy

Org-wide rules for what users can do in Studio:

| Rule | Notes |
|------|-------|
| Allow user agent creation | Off → users can use existing agents but not create new ones. |
| Mandate templates | New agents must start from a template. |
| Require admin approval for publish | Public-marketplace submissions need admin sign-off. |
| Lock per-user integration overrides | Users can't re-enable disabled tools. |

## Licence & usage

Path: **Org settings → Licence & usage**.

| Field | Notes |
|-------|-------|
| Active tier | Read-only — derived from the licence. |
| Licence key | Paste / clear here ([details](../licensing/apply.md)). |
| Tier limits | Users / agents / msgs per month. |
| Current usage | This calendar month. Resets at 00:00 UTC on the 1st. |
| Last verified | When the server last polled the licence-server. |
| Refresh now | Manual re-check button. |

## Privacy

Org-level Privacy Shield settings (the same JSONB record described in [Privacy Shield](../features/privacy-shield.md)).

| Field | Notes |
|-------|-------|
| Master toggle | Turn the shield off entirely (not recommended). |
| Detection backend | Azure / Local / Both. |
| Confidence threshold | 0–1, default 0.7. |
| Custom regex categories | Org-defined patterns. |
| EU mode | Minimises logs, anonymises IPs. |
| Lock user override | Users can't tune their own privacy level. |

## SSO (Enterprise+)

| Provider | Setup |
|----------|-------|
| ~~SAML 2.0~~ | **Not implemented.** There is no ACS URL, no SP metadata and no metadata-XML paste flow — see [API → Authentication](../api/auth.md#saml-not-implemented). The licence capability is named `sso_saml`, which is what this row was describing; it gates the OIDC providers above. |
| OIDC | Set issuer + client ID + secret. |

When SSO is enabled, the username/password form is hidden by default. Set `ALLOW_PASSWORD_LOGIN=true` to keep it as break-glass.

## Audit (Enterprise+)

| Field | Notes |
|-------|-------|
| Retention days | How long to keep `guardrail_events`. Default 90. |
| SIEM webhook | URL + shared secret for real-time event push. |
| Email alerts | Email address(es) for high-severity violations. |

See [Audit & compliance](audit-and-compliance.md) for the data model.

## Voice (Pro+)

| Field | Notes |
|-------|-------|
| STT provider | Voxtral / Deepgram / Mistral / Whisper local. |
| TTS provider | Voxtral / ElevenLabs. |
| Default voice | Picker from your provider's voices. |
| Allow voice calls | Master toggle. |

## Integrations (other than NC)

A panel listing every integration the server is configured for (env vars set), with org-level toggles + per-group overrides — same model as the [NC integrations panel](nc-integrations.md).

## Memory

| Field | Notes |
|-------|-------|
| User memory enabled | Master toggle for the Memory Extractor system agent. |
| Org memory | Shared memory facts visible to all agents (e.g. "We refer to Q1 as 'the launch quarter'."). |
| Retention | Forever / 12 months / 6 months. |

## Danger zone

| Action | Effect |
|--------|--------|
| Reset wizard | Re-runs the first-run wizard on next login. |
| Delete all conversations | Org-wide chat purge. Irreversible. |
| Delete organisation | Tombstones the org. 30-day grace period before hard delete. |
