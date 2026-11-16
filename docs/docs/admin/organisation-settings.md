---
title: Organisation settings
---

# Organisation settings

The organisation's settings are rows of the admin dashboard, in the block of your organisation (URL `/app/admin/organisation/<row>`; people, access and compliance have their own rows). They used to sit under Settings; the old addresses forward here.

| Group | Rows |
|-------|------|
| **Workspace** | Organisation info, Licence & usage, People, Projects, Learning Center, Usage & monitoring |
| **AI & agents** | Agents, Knowledge bases, Models, Conversations, Memory, Meeting notes |
| **Security & access** | Preferred sign-in method, Access, Privacy Shield, Encryption, MCP client access, Compliance |
| **Connections** | Integration status, MCP servers, Nextcloud, Microsoft 365, GitHub sync, Automations |

A row only shows when it applies to the organisation: Nextcloud for an organisation bound to a Nextcloud, Microsoft 365 when Microsoft is set up on the server, Meeting notes, Projects and Automations when the organisation has them. The sections below describe them.

## Overview

Path: **Admin dashboard → Workspace → Organisation info**. The org's basic info: name, logo, primary contact email, default language, default timezone.

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

Path: **Admin dashboard → Workspace → Licence & usage**, on Bee Flow Cloud. On a self-hosted server this row is not there: the licence is the whole server's, under **Admin dashboard → Whole server → Licence & features → Server licence**.

| Field | Notes |
|-------|-------|
| Active tier | Read-only — derived from the licence. |
| Licence key | Paste / clear here ([details](../licensing/apply.md)). |
| Tier limits | Users / agents / msgs per month. |
| Current usage | This calendar month. Resets at 00:00 UTC on the 1st. |
| Last verified | When the server last polled the licence-server. |
| Refresh now | Manual re-check button. |

How much AI your organisation uses, where it goes and who uses it is under
**Admin dashboard → Workspace → Usage & monitoring**; the Adoption row there is described in
[Usage & adoption](usage-and-adoption.md).

## Privacy

Path: **Admin dashboard → Security & access → Privacy Shield**. Org-level Privacy Shield settings (the same JSONB record described in [Privacy Shield](../features/privacy-shield.md)).

| Field | Notes |
|-------|-------|
| Master toggle | Turn the shield off entirely (not recommended). |
| Detection backend | Azure / Local / Both. |
| Confidence threshold | 0–1, default 0.7. |
| Custom regex categories | Org-defined patterns. |
| EU mode | Minimises logs, anonymises IPs. |
| Lock user override | Users can't tune their own privacy level. |

## Preferred sign-in method

Path: **Admin dashboard → Security & access → Preferred sign-in method**. How you would like the members of the organisation to sign in: a username and password, Google or Microsoft, out of the methods this server offers (a method it does not offer says why). It is a preference, not a lock: nothing reads it when someone signs in, the other sign-in methods of the server keep working, and you can change it at any time. An organisation bound to a Nextcloud signs in through its Nextcloud and has no choice to make here.

The same page holds who may join through single sign-on: the **Allowed domains** (self-hosted), the e-mail domains that link a newcomer to this organisation, and **Let people from your domains in straight away**, which lets someone from those domains join at once in the default groups instead of waiting as pending.

The sign-in providers themselves (the Google, Microsoft and Nextcloud apps) are set up once for the whole server, under **Admin dashboard → Whole server → Sign-in & SSO**.

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

## Voice (Enterprise+)

Voice chat has no provider picker of its own. Speech-to-text and text-to-speech run on
Voxtral with the Mistral API key from **Admin dashboard → Whole server → AI configuration → Providers**; an ElevenLabs key entered
there is the text-to-speech fallback. See [Voice](../features/voice.md#provider-routing).

## Integrations (other than NC)

**Admin dashboard → Security & access → Access → Grants** grants each integration your subscription includes to the whole organisation or to a group (grant-only: a user has an integration when All members or any of their groups has it). **Admin dashboard → Connections → Integration status** configures the integrations themselves; for an organisation bound to Nextcloud it holds the [Nextcloud integrations panel](nc-integrations.md), which works differently (org-wide switches with per-group exceptions).

## Memory

Path: **Admin dashboard → AI & agents → Memory**.

| Field | Notes |
|-------|-------|
| Memory enabled | Organisation-wide master switch, on by default. When off, nobody in the organisation gets memories injected into chats or automations, and nothing new is saved (including the memory tools and import). It beats each person's own memory switch; members see "turned off by your organisation". |
| Sensitive opt-in allowed | Off by default. When on, members may choose to let sensitive memories be kept. |
| Max per user | Upper limit of memories per person. Default 1000, between 50 and 10000. |

The panel also shows how many active memories exist and for how many people (counts only, never the content). **Clear all memories** deletes every memory of every user in the organisation after you confirm; it cannot be undone.

How long memories are kept is not set here: retention lives in the compliance settings.

## Images to AI in automations

**Admin dashboard → Connections → Automations**, the switch **Images to AI in automations**, next to reusing answers between runs. One switch, **off by default**, that only an admin of the organisation can change.

| Setting | What it does |
|---------|--------------|
| Off (default) | An AI step or a data extraction step in an automation gets the text read from an image (OCR), never the picture itself. |
| On | Such a step may show the picture itself to the AI model, when the step lists the image under **Images** and the conditions below hold. |

Switching it on asks for a confirmation, because the pictures then reach the AI model provider your organisation uses. Bee Flow keeps no copy: a run's output and log hold only a reference to the file in Nextcloud. Even with the switch on, a picture is never sent:

- when the [Privacy Shield](../features/privacy-shield.md) applies to the automation: the shield checks text for personal data and cannot check pixels, so the step uses the text read from the image;
- to a model that does not read images;
- in a dry run.

Each step that falls back to the text says so in its run output. Server operators set the per-step limits with `AUTOMATION_AI_IMAGES_MAX` and `AUTOMATION_AI_IMAGES_MAX_MB` ([environment variables](../self-hosting/env.md#ai-steps-and-automation-concurrency)). See [Automations → Images to AI](../features/automations.md#images-to-ai).

## Danger zone

| Action | Effect |
|--------|--------|
| Reset wizard | Re-runs the first-run wizard on next login. |
| Delete all conversations | Org-wide chat purge. Irreversible. |
| Delete organisation | Tombstones the org. 30-day grace period before hard delete. |
