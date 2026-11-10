---
title: Beta features
---

# Beta features

Path: **Admin → Access → Grants**, the **Beta features** group of the scope you pick on the left (All members or one group). What your organisation may have at all is under **Admin → Access → Ceiling**. Server-wide on/off switches (Notebooks, Projects, Ask AI and the like) are a separate list under **Admin → Integrations → Features**; they are not beta features.

Beta features are capabilities that ship behind their own switch: some are still marked *beta*, others are generally available (*ga*) but stay separately grantable. They are granted the same way as every other capability: a user has a beta feature when it is granted to **All members** or to **any group they belong to**, and only within the ceiling. There is no per-group "disable".

![Beta features panel](../img/screenshots/admin/beta-features/)

## Available flags

| Flag | Name in the matrix | What it enables | Lifecycle |
|------|--------------------|-----------------|:---------:|
| `meeting_notes` | Meeting Notes | Audio transcription, meeting summaries and action items | ga |
| `advanced_analytics` | Advanced Analytics | Extended analytics dashboards and reporting | ga |
| `custom_themes` | Custom Themes | Organisation-level custom branding and themes | beta |
| `skills` | Skills | Reusable instruction packs for consistent AI task execution | ga |
| `flow` | Flow Model Tier | The multi-stage "Flow" chat tier; needs Skills | beta |
| `voice_chat` | Voice Chat (Beta) | Realtime voice conversation (Mistral Voxtral); needs a Mistral API key | beta |
| `swarm` | Swarm Agents | Multi-agent swarms such as Deep Research | beta |
| `webpages` | Webpages | AI-built web apps with live preview and publishing | ga |
| `automations` | Automations | The conversational no-code automation builder | ga |
| `agent_routines` | Agent schedules | Recurring tasks that run through a specific agent | ga |
| `support_inbox` | Customer Support Inbox (Beta) | A support desk in the Studio: mailboxes, tickets, AI replies | beta |
| `app_studio` | App Studio | Internal apps built in the Studio | ga |
| `learning_center` | Learning Center | Bee Flow Academy: courses, badges, certificates | ga |
| `learning_custom_content` | Academy Custom Courses (Beta) | Org admins author their own Academy courses; needs the Learning Center | beta |
| `compliance_hub_gdpr` | Compliance Hub | The GDPR / AI Act / ISO 27001 compliance centre | ga |
| `ai_integration_builder` | AI Integration Builder | Org admins build custom integrations with an AI builder agent | beta |

The list comes from `server/core/entitlements/betaFeatures.js`. A module imported under **Admin → Modules** can add a beta of its own; it appears in the matrix while the module is installed.

## How a beta reaches a user

Three layers, the same in both deployment modes; only the source of the ceiling differs.

| Layer | Bee Flow Cloud | Self-hosted |
|-------|----------------|-------------|
| **Ceiling** | The organisation's subscription plan: its **Included beta features** (Admin → Subscriptions → Plans). | The server licence tier: Enterprise and up allows every beta; below that only the *ga* betas whose licence feature the Community tier includes. |
| **Organisation access** | A super-admin can narrow, per organisation, what it may use within the ceiling (Admin → Access → Ceiling → **Organisation access**). By default an organisation may use everything the ceiling allows. | Same. |
| **Grants** | Every beta inside the organisation's access is on for all members: the beta rows are read-only and the matrix says "Beta features follow your subscription". | Every beta inside the organisation's access is on for All members until an admin switches it off there. A group can still be granted a beta that All members does not have. |

Anything outside the organisation's access shows with a lock in the matrix and cannot be granted. A super-admin gets everything inside the ceiling, without grants.

**Meeting Notes is the exception** in both modes: All members is a real toggle for it, and a group can hold it while All members does not. Use that to roll Meeting Notes out to one team first.

## How to grant a beta

1. Go to **Admin → Access → Grants** (a super-admin picks the organisation at the top).
2. Pick **All members** or a group on the left.
3. Turn on the beta's toggle. It saves by itself ("Saved" appears next to the heading).

No restart is needed. The server checks the beta on every request it gates and the organisation's cached entitlements are dropped when a grant changes.

On cloud you change which betas an organisation gets by changing its plan, or the plan's **Included beta features** (Admin → Access → Ceiling, **Edit plan**; editing a plan changes the ceiling for every organisation on it).

## Server-wide switches

**Admin → Integrations → Features** (super-admin) holds the operator switches for Notebooks, Projects, Ask AI, Export, Open in Notebook and the Notebooks menu. They apply to everyone on the server, are stored in the server's configuration (not in environment variables), and take effect on the next page load. On a self-hosted server the same switches are also shown under **Admin → Access → Ceiling**. Notebooks and Projects are also rows under **Features** in the Grants matrix: the grant decides who has them, and switching them off here turns them off for everyone regardless of grants.

## Reporting issues

When a beta feature misbehaves:

1. Reproduce and capture the server logs (`docker logs` of the server container).
2. File at [https://github.com/Bee-Flow/beeflow/issues](https://github.com/Bee-Flow/beeflow/issues) with the feature flag in the title.
