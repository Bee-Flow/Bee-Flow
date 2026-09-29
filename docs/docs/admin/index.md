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

## Pages

<div className="bf-grid">

-    [Users & groups](users-and-groups.md)

    User management, NC sync mode, manual invites, waitlist, signup settings.

-    [Nextcloud integrations](nc-integrations.md)

    Org-level integration toggles + per-group overrides ("enable wins").

-    [Organisation settings](organisation-settings.md)

    Branding, defaults, integrations, License & usage.

-    [Beta features](beta-features.md)

    Feature flags — enable upcoming features per-org.

-    [Audit & compliance](audit-and-compliance.md)

    Guardrail events, GDPR archive, audit log export (Enterprise+).

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

## Admin audit trail

Every admin action is logged in `admin_audit_events` (Enterprise+). The trail records: who, what, when, before/after JSON. Queryable through the same audit page as guardrail events.
