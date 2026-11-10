---
title: Admin
---

# Admin

Org-admin operations live under **Settings → Organisation** in the SPA. This section is the reference for what each panel does.

URL inside Bee Flow: `/app/admin` and `/app/org-settings`.

## Who is an admin

There are two admin levels, the same on Bee Flow Cloud and on a self-hosted server:

| Level | What they can do | How someone becomes one |
|-------|------------------|-------------------------|
| **Organisation admin** | Manage their organisation: its settings, users, groups, access and audit. | Their **Organisation Role** is Organisation Admin in their own organisation, set under [Users & groups](users-and-groups.md). Whoever signs up and creates an organisation becomes its organisation admin. A group of an organisation can also carry admin rights; its members administer that organisation. |
| **Platform admin** | Everything that applies to the whole server: AI configuration and provider keys, integrations, modules, appearance, languages, the server licence, and every organisation on it. | The operator account `admin`, created at first setup (the setup page, or `INIT_ADMIN_PASSWORD`), is one. A platform admin makes another account one under **Admin → Security → Users**: edit (or add) the person and turn on **Platform administrator**. |

An organisation admin is never a platform admin, also not on a self-hosted server with a single
organisation, and administers only their own organisation (or one whose admin group they are in).
Being an ordinary member of a group of another organisation gives no admin rights there.

### Appointing a platform admin

Under **Admin → Security → Users**, a platform admin edits the person and turns on
**Platform administrator**, in the section **Whole server** of the form, below the organisation
role. The form asks for confirmation and names the person; the change applies when you save.
Only a platform admin sees this switch: an organisation admin cannot set or clear the platform
role, also not for a member of their own organisation (the server refuses it). Nor does an
organisation admin manage the account of a platform admin who is a member of their
organisation: its password, two-factor reset, status, avatar and deletion are for a platform
admin, and the user list offers an organisation admin no actions on that row.

In the user list a platform admin carries a **Platform admin** marker, next to their
organisation role. The organisation role belongs to the organisation the list shows them under.

Turning the switch off withdraws the role. Turning it off for yourself asks first, because it
ends your own access to the settings of the whole server. The operator account `admin` always
stays a platform admin, and the server keeps the last active platform admin: it refuses to take
the role away from, suspend or delete that account, and the panel shows why.

The same through the API: `PUT /auth/users/<id>` with `{"role": "admin"}` (or `{"role": "user"}`
to withdraw it), as a platform admin.

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
| Turn off Nextcloud Mail for one Nextcloud group | [NC integrations](nc-integrations.md) |
| Apply a licence key | [Organisation settings](organisation-settings.md) → Licence & usage |
| Give a beta feature to one group | [Beta features](beta-features.md) |
| Export the last 30 days of guardrail events | [Audit & compliance](audit-and-compliance.md) |
| Set up SAML SSO | [Organisation settings](organisation-settings.md) → SSO (Enterprise+) |
| Configure a custom domain (white-label) | [Organisation settings](organisation-settings.md) → Branding (Full tier) |
| Lock Studio so users can't create their own agents | [Organisation settings](organisation-settings.md) → Studio policy |
| See how many people use AI and where it goes | [Usage & adoption](usage-and-adoption.md) |

## Admin audit trail

Every admin action is logged in `admin_audit_events` (Enterprise+). The trail records: who, what, when, before/after JSON. Queryable through the same audit page as guardrail events.
