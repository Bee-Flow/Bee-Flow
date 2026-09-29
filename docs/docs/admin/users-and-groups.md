---
title: "Users & groups"
---

# Users & groups

Path: **Admin → Users & groups**.

## User management panel

A list of all users in the org, with columns: avatar, name, email, role, groups, last seen, source (NC / signup / SSO / manual invite).

![Users & groups panel](../img/screenshots/admin/users-and-groups/)

### Actions per user

| Action | Effect |
|--------|--------|
| Promote / demote | Toggle org-admin role. |
| Disable | Mark inactive — user can't log in but data is preserved. |
| Delete | Soft-delete (30-day recovery), then hard-delete. |
| Resend invite | If user hasn't accepted yet. |
| Reset password | Sends a reset link (if SMTP configured). |
| Impersonate | (System admin only) Log in as the user — a banner shows the impersonation. |
| Export their data | GDPR Subject Access — generates a ZIP archive. |

## Groups

Groups are the unit of permission (NC integrations, agent visibility, automation triggers).

| Action | Effect |
|--------|--------|
| Create group | Bee Flow-native group, separate from any NC group. |
| Sync from NC | Mirror an NC group; members + name stay in sync via webhooks. |
| Add / remove members | Manual add/remove for native groups; read-only for NC-synced. |
| Delete group | Removes the group + revokes its permissions. Members keep access via other groups. |

NC-synced groups are recognisable by a small Nextcloud icon next to the name and are not editable here — manage them in NC.

## NC sync mode

Determines which NC users get a Bee Flow account.

| Mode | Behaviour |
|------|-----------|
| **All users** | Every NC user is mirrored. New NC users auto-mirror within seconds (event webhook) or up to 6 h (backstop). |
| **Specific groups** | Only members of selected NC groups. Users dropped from those groups are deactivated, not deleted. |
| **Manual** | No auto-mirror. Admin invites by hand. |

Change the mode any time. The next backstop run reconciles the org membership to match.

## Backstop sync

A 6-hourly cron job (`server/jobs/ncSyncBackstop.js`) re-runs NC user/group sync to catch anything the webhooks missed (e.g. NC was unreachable when an event fired). Skips if webhook activity has been seen in the last 30 minutes.

## Manual invites

For non-NC users (or in `manual` sync mode):

1. Click **Invite user**.
2. Enter email + role + initial groups.
3. The user receives an invite link (valid for 14 days).
4. They set a password (or sign in via OAuth / SAML if configured) on first visit.

The link is single-use; resend if it expires.

## Signup settings

In **Admin → Signup settings**:

| Setting | Effect |
|---------|--------|
| Public signup | Allow anyone with the URL to sign up. |
| Domain allowlist | Restrict to specific email domains (e.g. `@bee-flow.nl`). |
| Waitlist | New signups go to a queue for admin approval. |
| Default role | What new users get (regular / admin). |
| Default groups | Auto-add new users to these groups. |
| Captcha | Cloudflare Turnstile or hCaptcha (configure separately). |

## Waitlist

If waitlist is on:

1. New signups get a "Thanks — you're on the waitlist" page.
2. Admin sees them under **Admin → Waitlist** with email + signup time + source.
3. Admin clicks **Approve** to materialise the user, or **Reject** to discard.

## Tier limits

Adding users beyond the tier cap is blocked at the API. UI shows "Tier limit reached — upgrade to add more". For NC sync that hits the cap, new NC users are skipped (logged) until you upgrade.

## Bulk operations

| Action | How |
|--------|-----|
| Bulk import | CSV with `email,displayName,groups` columns. |
| Bulk export | Download CSV of current users. |
| Bulk role change | Multi-select then **Promote / Demote**. |

## Privacy

User profile fields are stored in Postgres. Email + display name are visible to other users in pickers (e.g. agent sharing); group membership is visible to other admins. Phone numbers and physical addresses are not stored.

## Right to erasure (GDPR)

Click **Delete user** + tick **Hard delete + purge audit references**. This:

- Removes the user record.
- Anonymises their conversations (replaces user_id with a salted hash).
- Removes them from group memberships.
- Records the deletion in the GDPR archive (Enterprise+).

Hard delete is irreversible — there's a confirmation modal.
