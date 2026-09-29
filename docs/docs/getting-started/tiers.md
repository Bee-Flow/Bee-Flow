---
title: Free vs paid features
---

# Free vs paid features

:::warning[Subject to change]

Pricing and the exact feature gates are still being tuned. This page follows
[`server/license/tiers.js`](https://github.com/Bee-Flow/beeflow/blob/main/license/tiers.js),
and we update it whenever that file changes.

:::

Bee Flow ships in three tiers of the same code. **Community** is free, needs no
licence key and has no cap on users, assistants, messages or knowledge sources.
**Enterprise** is a licence key that adds collaboration, compliance and the
specialist modules. **Full** adds white-label branding for partners.

Paid tiers add capability, not headroom: no tier has a smaller limit than
Community.

## At a glance

| Tier         | Users  | Assistants | Messages/mo | What it adds |
|--------------|:------:|:----------:|:-----------:|--------------|
| `community`  | unl.   | unl.       | unl.        | The free core, listed below |
| `enterprise` | unl.   | unl.       | unl.        | Collaboration, compliance, the Studio modules, Skills, meeting notes and the advanced Privacy Shield modes |
| `full`       | unl.   | unl.       | unl.        | White-label branding and sub-licence issuance |

The full feature matrix and the flag names are in
[Licensing → Tiers](../licensing/tiers.md).

## What Community includes

- **Chat and assistants.** Chat with a model or with an assistant you built,
  with its own instructions, knowledge and tools.
- **Knowledge bases** from files, pasted text and web pages. You refresh a
  source by hand.
- **Automations and agent routines** for your own use: the no-code builder,
  schedules, webhooks, forms and run history.
- **Data tables and web pages** for your own use.
- **All built-in integrations**: Google Workspace, Microsoft 365, Nextcloud,
  AI generation and the third-party connectors.
- **Multiple users and groups**, with no user cap.
- **The Nextcloud connector**, including signing in to Bee Flow with
  Nextcloud.
- **The Learning Center.**
- **Privacy Shield detection** that finds personal data before a prompt
  reaches a model and blocks it.

## What Enterprise adds

- **Privacy Shield:** placeholders instead of real values (the model sees
  `[email_1]`, you see the real address), the web search guard, your own data
  types, and the Guard and Tokenize steps in automations.
- **Compliance Center:** GDPR, the AI Act, ISO 27001, DORA, NIS2 and more,
  including the compliance checks on automations.
- **Collaboration:** approval steps in automations, sharing automations and
  routines, sharing web pages and data tables, and Projects (team workspaces).
- **Studio:** Apps, Documents, Playbooks and Solutions.
- **Data and knowledge:** retention windows on data tables, a data table as a
  knowledge source, and refreshing web pages and other sources on a schedule.
- **Skills, meeting notes, voice chat, notebooks and the support inbox.**
- **The MCP server marketplace**, where MCP servers are added.
- **Administration:** advanced usage monitoring and analytics, encryption at
  rest, Google and Microsoft single sign-on, audit log export, custom themes
  and the paid admin tabs.
- **The other beta features**, such as swarm agents and the Component
  Designer.

**Full** adds white-label branding (logo, colours, domain) and sub-licence
issuance for partners who ship Bee Flow under their own brand.

## When a licence lapses

A lapse or a move to a lower plan only refuses **new** creation or widening.
Existing data and shares keep working, and removing access is always
possible:

- Skills already attached to an assistant keep working, and you can still
  delete a skill.
- A retention window on a data table keeps being honoured.
- Approvals that are already waiting can still be decided, so the paused runs
  behind them finish.
- Web pages and tables that are already shared stay shared. You can unshare
  them, but not share them further.

## Where the limits fire

The Community tier sets every cap to "unlimited", so no limit fires on a fresh
install. The enforcement plumbing is still in place so custom plans can opt
back into capped seats, messages or knowledge sources:

| Limit | Where it's enforced | What happens at the cap |
|-------|---------------------|--------------------------|
| Users | User-create endpoint, NC sync job | New users are skipped; existing users stay active |
| Agents | Agent-create endpoint | The UI shows "Tier limit reached" |
| Messages / mo | Chat endpoint, automations runner | Org-wide chat returns 402 with `tier_limit` until the next month |

A monthly counter resets on the first UTC day of each calendar month. Counter
state is in Postgres; nothing is sent off-machine.

## Legacy Pro keys

Bee Flow previously offered a paid **Pro** tier. It has been retired and its
features now ship in **Enterprise**. Existing licence keys carrying
`tier: "pro"` continue to validate and resolve to `enterprise`, so paying
customers keep what they had and gain the rest of Enterprise without
reactivating.

## Why fair-code?

The frontend and server are released under the **Sustainable Use Licence**.
You can use, modify and self-host them for free for your own organisation.
You cannot offer Bee Flow as a paid service to third parties without a
commercial agreement.

The Nextcloud connector is **AGPL-3.0-or-later** to comply with App Store
requirements.

[More on the licensing model →](../licensing/index.md)
