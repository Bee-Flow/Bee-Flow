---
title: Admin
---

# Admin

Org-admin operations live in the admin dashboard in the SPA. Its rail is the only navigation: the organisation's own pages (people, settings, grants, usage and compliance) in one block, and for a platform admin the pages of the whole server in a second block. A platform admin picks the organisation to work on at the top of the dashboard; an organisation admin always works on their own. This section is the reference for what each panel does.

URL inside Bee Flow: `/app/admin`. The former Settings addresses (`/app/settings/organisation/…`, `/app/org-settings/…`) forward to the matching admin page.

## Who is an admin

There are two admin levels, the same on Bee Flow Cloud and on a self-hosted server:

| Level | What they can do | How someone becomes one |
|-------|------------------|-------------------------|
| **Organisation admin** | Manage their organisation: its settings, users, groups, access and audit. | Their **Organisation Role** is Organisation Admin in their own organisation, set under [Users & groups](users-and-groups.md). Whoever signs up and creates an organisation becomes its organisation admin. A group of an organisation can also carry admin rights; its members administer that organisation. |
| **Platform admin** | Everything that applies to the whole server: AI configuration and provider keys, integrations, modules, appearance, languages, the server licence, and every organisation on it. | The operator account `admin`, created at first setup (the setup page, or `INIT_ADMIN_PASSWORD`), is one. A platform admin makes another account one under **Admin dashboard → Workspace → People**: edit (or add) the person and turn on **Platform administrator**. |

An organisation admin is never a platform admin, also not on a self-hosted server with a single
organisation, and administers only their own organisation (or one whose admin group they are in).
Being an ordinary member of a group of another organisation gives no admin rights there.

### Appointing a platform admin

Under **Admin dashboard → Workspace → People**, a platform admin edits the person and turns on
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

`/app/admin` opens the admin dashboard. The rail on the left is the only navigation: every
page is a row of it, and a page with parts of its own shows them as rows indented under it
while it is open. The rail has two blocks.

**Your organisation** (headed with the organisation's name), in four groups:

| Group | Rows |
|-------|------|
| **Workspace** | Organisation info, Licence & usage, People, Projects, Learning Center, Usage & monitoring |
| **AI & agents** | Agents, Knowledge bases, Models, Conversations, Memory, Meeting notes |
| **Security & access** | Preferred sign-in method, Access, Privacy Shield, Encryption, MCP client access, Compliance |
| **Connections** | Integration status, MCP servers, Nextcloud, Microsoft 365, GitHub sync, Automations |

**Whole server**, for a platform admin only:

| Group | Rows |
|-------|------|
| **AI & agents** | AI configuration (Providers, Models, Search & retrieval, Direct chat, Setup status), System agents |
| **Identity & access** | Organisations, Roles & permissions, Sign-in & SSO, Guardrail library |
| **Connections** | Platform services (Defaults for new organisations, Email, Transcription, Connected apps), MCP servers, Nextcloud instances |
| **Platform** | Licence & features (Server licence, Feature switches), Modules, Appearance (Look, Icon packs), Languages |
| **Operations** | Support inbox, Subscriptions |
| **Website** | Product website, Website analytics, Release notes |

You only see the rows you may open and that apply to the organisation: a row for something
the organisation does not have (no Nextcloud bound, no Microsoft set up on the server, a
feature outside its plan) is left out, several whole-server rows need an Enterprise
licence, and Subscriptions and the three Website rows exist on Bee Flow Cloud only. On a
self-hosted server **Licence & usage** is not an organisation row: the licence is the
whole server's, under **Licence & features**.

The row is in the URL, so every page can be bookmarked or linked:
`/app/admin/<row>/<part>`, for example `/app/admin/people`,
`/app/admin/organisation/conversations`, `/app/admin/ai-config/retrieval` or
`/app/admin/integrations/transcription`. Old addresses (`/app/admin/security/users`,
`/app/admin/organisation/meeting-templates`, `/app/settings/organisation/…`) still open the
page they moved to.

On a phone the dashboard is not available; the organisation's settings are in the app's own
Settings there.

In this documentation a path names the rail: **Admin dashboard → Connections → Nextcloud**
is the Nextcloud row in the Connections group of your organisation, and
**Admin dashboard → Whole server → Platform services → Transcription** is the Transcription
row under Platform services in the whole-server block.

## Pages

<div className="bf-grid">

-    [Users & groups](users-and-groups.md)

    User management, NC sync mode, manual invites, waitlist, signup settings.

-    [Nextcloud integrations](nc-integrations.md)

    Org-level integration toggles + per-group overrides ("enable wins").

-    [Organisation settings](organisation-settings.md)

    Branding, defaults, integrations, Licence & usage, the preferred sign-in method.

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
| Apply a licence key (self-hosted) | Admin dashboard → Whole server → Licence & features → Server licence ([details](../licensing/apply.md)) |
| Give a beta feature to one group | [Beta features](beta-features.md) |
| Export the last 30 days of guardrail events | [Audit & compliance](audit-and-compliance.md) |
| Set up single sign-on (Google or Microsoft) | Admin dashboard → Whole server → Sign-in & SSO (Enterprise+); the organisation's preference is [Preferred sign-in method](organisation-settings.md#preferred-sign-in-method) |
| Configure a custom domain (white-label) | [Organisation settings](organisation-settings.md) → Branding (Full tier) |
| Lock Studio so users can't create their own agents | [Organisation settings](organisation-settings.md) → Studio policy |
| See how many people use AI and where it goes | [Usage & adoption](usage-and-adoption.md) |
| Stop the AI from reading or answering support messages | [Support inbox: AI replies](#support-inbox-ai-replies) |

## Support inbox: AI replies

The company support inbox (**Admin dashboard → Whole server → Operations → Support inbox →
Settings → AI behaviour**) collects the messages from the website contact form and the
tickets people open in the app. **AI replies** decides what the AI does with them:

| Setting | What happens |
|---------|--------------|
| **Answer automatically** (default) | The support agent answers the customer, searching the knowledge bases it was given, and hands the ticket to staff when it is not confident. |
| **Draft for staff** | The agent writes a reply as an internal note that only staff see. Nothing is sent to the customer until a staff member replies. |
| **Off** | No message text goes to an AI model: no reply, no knowledge-base search, no automatic tags. The ticket goes straight to staff with the note "AI replies are off for this inbox", and staff are notified as usual. |

Only a platform admin can change it. The setting is for this company inbox only; a mailbox
inbox in the Support studio keeps its own reply mode. The **Test reply** preview on the Agent
page still asks the model, with the text you type there.

## Admin audit trail

Every admin action is logged in `admin_audit_events` (Enterprise+). The trail records: who, what, when, before/after JSON. Queryable through the same audit page as guardrail events.
