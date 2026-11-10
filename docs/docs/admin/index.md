---
title: Admin
---

# Admin

Org-admin operations live under **Settings → Organisation** in the SPA. This section is the reference for what each panel does.

URL inside Bee Flow: `/app/admin` and `/app/org-settings`.

## Who is an admin

There are two admin levels:

| Level | What they can do |
|-------|------------------|
| **Org admin** | Manage org settings, users, groups, integrations, license, audit. Default for the first user. |
| **System admin** (self-hosted only) | All of the above + cross-org tasks: install packages, manage feature flags globally. Set via `BEEFLOW_SYSTEM_ADMINS` env var. |

The first user to register on a fresh install becomes an org admin automatically. Promote / demote others under [Users & groups](users-and-groups.md).

## The admin dashboard

`/app/admin` opens the global admin dashboard. It has three columns:

1. **The rail** on the left, with the tabs in five groups:

   | Group | Tabs |
   |-------|------|
   | **AI & agents** | Agents, AI Config |
   | **Security & access** | Security, Access, Compliance |
   | **Platform** | Integrations, Modules, Appearance, Languages |
   | **Operations** | Monitoring, Support, Subscriptions, Server licence |
   | **Website** | Product Website, Website Analytics, Release Notes |

   You only see the tabs you may open: most are for super-admins, several need an
   Enterprise licence, and Subscriptions and the three Website tabs exist on Bee Flow
   Cloud only. On a self-hosted Community install a super-admin sees AI Config,
   Security, Access, Integrations, Modules, Languages and Server licence.
2. **The section list** of the open tab (for example AI Config → API Keys, Chat Models,
   Embeddings, Direct Chat, Web Search Inference, Limits & Self-host).
3. **The section itself.**

The tab and the section are in the URL, so every screen can be bookmarked or linked:
`/app/admin/<tab>/<section>`, for example `/app/admin/ai-config/embeddings`,
`/app/admin/integrations/transcription`, `/app/admin/security/sso` or
`/app/admin/subscriptions/promos`. A third part opens one item or tab: a provider under
API Keys (`/app/admin/ai-config/providers/<provider>`) or a tab under Security → Users
`/app/admin/security/users/roles`. Website Analytics keeps its section in a query
parameter instead: `/app/admin/website-analytics?section=pages`.

On a phone the rail folds into a menu under the tab's name at the top, and the section
list becomes a row of tabs you can scroll sideways.

Sections that hold a list of things with settings per item show the list on the left
and the selected item on the right: Integrations → Transcription (the engines),
Security → SSO (Nextcloud, Google, Microsoft) and AI Config → API Keys (the providers).

In this documentation a path such as **Admin → Integrations → Transcription** means:
the Integrations tab in the rail, then the Transcription section.

## Pages

<div className="bf-grid">

-    [Users & groups](users-and-groups.md)

    User management, NC sync mode, manual invites, waitlist, signup settings.

-    [Nextcloud integrations](nc-integrations.md)

    Org-level integration toggles + per-group overrides ("enable wins").

-    [Organisation settings](organisation-settings.md)

    Branding, defaults, integrations, License & usage.

-    [Usage & adoption](usage-and-adoption.md)

    The Adoption report: who uses AI, where it goes, what was built in Studio (Enterprise).

-    [Beta features](beta-features.md)

    Feature flags — enable upcoming features per-org.

-    [Audit & compliance](audit-and-compliance.md)

    Guardrail events, GDPR archive, audit log export (Enterprise+).

-    [Chat signals](chat-signals.md)

    Optional counts that show whether the Privacy Shield works in chat (off by default).

</div>

## Quick reference

| Task | Where |
|------|-------|
| Invite a user | [Users & groups](users-and-groups.md) |
| Disable Mail integration for the Sales group | [NC integrations](nc-integrations.md) |
| Apply a licence key | [Organisation settings](organisation-settings.md) → Licence & usage |
| Turn on the Notebooks beta | [Beta features](beta-features.md) |
| Export the last 30 days of guardrail events | [Audit & compliance](audit-and-compliance.md) |
| Set up SAML SSO | [Organisation settings](organisation-settings.md) → SSO (Enterprise+) |
| Configure a custom domain (white-label) | [Organisation settings](organisation-settings.md) → Branding (Full tier) |
| Lock Studio so users can't create their own agents | [Organisation settings](organisation-settings.md) → Studio policy |
| See how many people use AI and where it goes | [Usage & adoption](usage-and-adoption.md) |

## Admin audit trail

Every admin action is logged in `admin_audit_events` (Enterprise+). The trail records: who, what, when, before/after JSON. Queryable through the same audit page as guardrail events.
