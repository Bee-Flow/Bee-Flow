---
title: "Users & groups"
---

# Users & groups

Two places manage people:

- **Admin → Security → Users** on the admin dashboard. A full admin gets the tabs Users, Organizations, Nextcloud, Groups, Roles and Permissions, across every organisation on the server. Anyone else who can open Admin → Security gets Users, Groups and, when they belong to an organisation, My Organization. Adding, editing and deleting needs the Manage Users or Privacy Shield permission.
- The same screen for an org admin, scoped to their own organisation, with the tabs Users, Groups and Roles. Invitations and approvals live here.

What a user or group may *use* (features, beta features, integrations) is not set on these screens: that is **Admin → Access → Grants**, see [Beta features](beta-features.md). The Nextcloud integrations have their own panel, see [Nextcloud integrations](nc-integrations.md).

## User management panel

The **Users** tab of Admin → Security → Users is the People directory: everyone you may see, grouped **By organisation**, **By group** or **Flat**, with a search and filters. Each row shows the name, the organisation role, `@username` and the email address. A person in more than one organisation is listed under each.

![Users & groups panel](../img/screenshots/admin/users-and-groups/)

### Actions per user

| Action | Effect |
|--------|--------|
| Add user | Creates an account. Username, display name and password are required; first and last name, email, phone, avatar, groups and (for a platform operator) the organisation and its organisation role are optional. Only a platform operator can give a platform role other than `user`. |
| Edit | The same fields; leave the password blank to keep it. An org admin sees the organisation but cannot move someone to another one. On a self-hosted server: a monthly AI budget. Taking away your own admin rights asks for confirmation first. |
| Reset 2FA | After a confirmation, the user's authenticator and recovery codes stop working; they enrol again at their next sign-in. |
| Delete | After a confirmation, erases the account and its data. It cannot be restored. |

Deleting or demoting the last org admin of an organisation that still has other members is refused, so an organisation is never left without an administrator. The built-in system account cannot be deleted.

### The other tabs

| Tab | What it offers |
|-----|----------------|
| **Organizations** | Add, edit and delete organisations; remove an organisation's Nextcloud association. |
| **Nextcloud** | Every organisation connected to a Nextcloud instance: its Nextcloud URL, instance ID and when it was connected, with **Health** (the connector health page) and **Remove Nextcloud association**. Removing it revokes that connector's tenant key so it can no longer authenticate; the organisation itself is kept. |
| **Groups** | Add, edit and delete groups (name, organisation or none for a global group, description, permissions, assigned roles, allowed agent types, and on a self-hosted server an AI budget per member per month). |
| **Roles** | Role templates with their permissions: add, edit, delete. |
| **Permissions** | The list of permissions roles and groups can carry (read-only). |
| **My Organization** | Your own organisation's details and logo. |

## Organisation admins: Admin → Security → Users

| Tab | What it offers |
|-----|----------------|
| **Users** | The organisation's members. Per member: change the organisation role, assign groups, see this month's AI cost, and on a self-hosted server set a monthly AI budget. A member waiting for approval has **Approve** and **Reject** (reject removes the account; they can sign up again). |
| **Groups** | Create and delete groups, add and remove members, and per group: description, a role all members inherit, allowed tiers and, on a self-hosted server, an AI budget per member. |
| **Roles** | What each organisation role may do (Organisation Admin, Data Protection Officer, ISMS Internal Auditor, Agent Admin, Agent Editor, Member). Open a role to see its permissions; an org admin can switch the ones the organisation decides (such as Notebooks, the Studio sections, Approvals and Forms) on or off for that role. The rest of what a role is stays fixed by the install. |

When the organisation signs in through Google or Microsoft, the Users tab also has **Auto-approve users from trusted domains**: on, matching users are added straight away; off, they are added as pending and wait for approval.

Which users match: a Microsoft account by the organisation's verified tenant. A Google account only when it is created, by an e-mail domain that is the organisation's: a domain on a self-hosted server's allowed-domain list, or the domain of the organisation's contact e-mail once an organisation admin signs in with a verified address on that domain (or a platform admin set the contact e-mail). An account that already exists without an organisation is not added by its domain on a later sign-in: invite it. A domain that two organisations use adds nobody, and a public mail domain (such as gmail.com) never matches. The contact e-mail cannot be set to a domain another organisation already uses.

### Invitations

1. On the **Users** tab, click **Invite User**.
2. Enter the email address and a role, and click **Send**.
3. The invitee receives an email with a link, valid for 7 days. If the email could not be sent, the screen shows the link to copy and share yourself.
4. On first visit they create their account through the link.

Pending invitations are listed with who invited them and when they expire, each with **Revoke invitation**. Inviting the same address again replaces the earlier invitation. An address that already has an account in your organisation cannot be invited, and the same address can be invited again only after an hour.

## Groups

Groups are how access is handed out:

- capabilities granted to a group in **Admin → Access → Grants** (a user gets everything granted to All members plus everything granted to any of their groups);
- per-group exceptions for the [Nextcloud integrations](nc-integrations.md);
- agents shared with a group;
- the permissions, roles, allowed agent types and budgets set on the group itself.

A group comes from one of three places: made in Bee Flow, mirrored from Nextcloud by the [Nextcloud sync](#nextcloud-sync), or synced from Azure AD. Azure groups are marked **Managed** under Admin → Security → Users and are changed by syncing, not by hand.

## Nextcloud sync

Path: **Admin → Organisation → Nextcloud Sync**, for organisations bound to a Nextcloud instance (and for super-admins). It decides which Nextcloud users get a Bee Flow account.

| Mode | Behaviour |
|------|-----------|
| **Mirror everything** (default) | Every Nextcloud user gets a Bee Flow account. |
| **Selective groups** | Only members of the Nextcloud groups ticked under **Groups to mirror**. |
| **Manual only** | Nothing is created automatically, and the periodic sync and **Sync now** are off. |

**Excluded groups**: members of these Nextcloud groups are never mirrored, in any mode. **New user default status**: *Active immediately* or *Pending*, in which case an admin approves each new account.

What a sync does:

- Creates an account for each admitted Nextcloud user that has an email address (a user without one is skipped), and keeps email and display name up to date with Nextcloud.
- Deactivates, never deletes, an account whose Nextcloud user was deleted or is no longer admitted by the mode or the excluded groups. History is kept; the account is reactivated when the user is admitted again.
- Mirrors each Nextcloud group (except Nextcloud's own `admin` group) as a Bee Flow group. A group removed or renamed in Nextcloud is not removed here.
- Sets each user's memberships of the mirrored groups to what Nextcloud lists. The sync owns only those mirrored groups: any other group a user is in (one made in Bee Flow, for instance) is kept as it is. A membership of a mirrored group that you added by hand in Bee Flow is Nextcloud's to decide, and goes at the next sync if Nextcloud does not list it.

User and group changes arrive as events from Nextcloud through the connector (see the [connector documentation](../connector/permissions.md)). Behind that runs a full sync every 6 hours, which skips an organisation that synced in the last 30 minutes and backs off for 24 hours after a failed sync (7 days when the connector app was removed or its key no longer matches). **Sync now** runs a full sync at once and is never held back by that backoff.

## Signup settings

On Bee Flow Cloud, a super-admin controls who can sign up under **Admin → Subscriptions → Access**:

| Setting | Effect |
|---------|--------|
| Organization signups | Allow users to register and create new organisations. |
| Consumer signups | Allow personal (non-organisation) accounts. |
| Only allow signups via the Nextcloud connector | Block every public web signup; accounts come from Nextcloud or from an invitation. |
| Waitlist mode | New registrations need approval. Invited users bypass the waitlist. |
| Require email verification | New password signups confirm their address before they can log in. |
| Require MFA for password accounts | Password accounts must set up two-factor authentication. |
| Allowed login methods | Username & password, Google SSO, Microsoft SSO. |
| Geo restrictions | An allowlist or blocklist of countries, based on IP geolocation. |

The `ALLOW_SIGNUPS=false` environment variable overrides these toggles and hides the **Create Account** button. It defaults to false on self-hosted installs. Email invitations work either way.

## Waitlist

If waitlist mode is on, new registrations appear in the **Waitlist queue** under Admin → Subscriptions → Access, with their signup date. **Approve** lets them in, **Reject** turns them away.

## Seat limits

An invitation is refused when the organisation's active users plus its pending, unexpired invitations already reach the seat cap (the plan's user limit on cloud, and a licence seat cap where one applies, whichever is lower). Creating an account is checked against the same cap. The Nextcloud sync skips new users once the cap is reached and logs it.

## Privacy

A user record holds the username, display name, first and last name, email, an optional phone number, avatar, platform role, organisation and organisation role, and groups. Invitations store a hash of the invite token, not the token itself.

## Right to erasure (GDPR)

**Delete** on a user (Admin → Security → Users) is the erasure: after the confirmation it removes the account and the user's data in one go, and it cannot be undone. Datatables the user had shared pass to the org admin of the organisation whose account is oldest, rather than being deleted, because they are the organisation's records. If a step fails, the account stays and the delete can simply be repeated.

An account mirrored from Nextcloud whose Nextcloud user is deleted is only deactivated by the sync; erase it here.
