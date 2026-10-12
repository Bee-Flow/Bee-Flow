# Fact sheet — Organisation: Users, Groups & Access (audience: org admin)

Area id: `org-users-access` · Status: **exists, fully built** (not a stub)
Verified against the working tree on branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.

Primary code:
- Frontend: `agent-hub/src/components/admin/org/OrgUsersPanel.jsx` (~2 500 lines, the real screen),
  `agent-hub/src/pages/settings/OrganisationSection.jsx`, `agent-hub/src/pages/AdvancedSettings.jsx`
  (the settings shell + nav), `agent-hub/src/config/orgRoles.js` (role catalogue shown in the UI),
  `agent-hub/src/components/admin/shared/UserFilterBar.jsx`, `agent-hub/src/hooks/useUserFilters.js`,
  `agent-hub/src/components/admin/org/GroupAccessMatrix.jsx`,
  `agent-hub/src/components/admin/org/orgInfo/OrgAuthSection.jsx`,
  `agent-hub/src/components/integrations/azure/SSOSection.jsx`,
  `agent-hub/src/components/admin/security/SecurityHub.jsx` + `admin/org/UserManagement.jsx` (second surface).
- Backend: `server/auth/admin/userRoutes.js`, `groupRoleRoutes.js`, `invitationRoutes.js`,
  `orgRoutes.js`, `featureAccessRoutes.js`, `orgAdminGuards.js`, `leaveOrgRoutes.js`;
  `server/auth/permissions.js`; `server/config/orgRoles.json`; `server/auth/ssoUserResolver.js`;
  `server/auth/accountProvisioning.js`; `server/routes/orgAzureConfig.js`;
  `server/stores/invitationStore.js`, `server/stores/user/{users,groups,subscriptions}.js`.

---

## 1. What the feature is for

Bee Flow is multi-tenant: every account belongs to an **organisation** (or to none, which is what a
"consumer" account is). *Users & Groups* is the screen where the organisation's own administrator —
not Bee Flow staff — decides three separate things:

1. **Who is in the organisation** — invite people, approve or reject people who signed in via SSO,
   remove people.
2. **What each person may do inside the product** — by giving them an *organisation role*
   (`org_admin`, `dpo`, `isms_auditor`, `agent_admin`, `agent_editor`, `member`), which the server
   expands into a permission set via `server/config/orgRoles.json`.
3. **Which teams exist** — *groups*, which carry members, can grant a role to everyone in them, can
   restrict which AI model tiers their members may use, and are the unit that integrations and beta
   features are granted to (Settings → Organisation → Integrations → *Access*).

Everything on this screen is scoped to the caller's own tenant on the server. `GET /auth/users` and
`GET /auth/groups` filter by the caller's resolved org ids, and the panel deliberately does *not*
re-derive that set client-side (comment at `OrgUsersPanel.jsx:448-455`).

Two deliberate boundaries a learner must accept:
- **Moving a user between organisations is not possible from here.** It is a platform-operator
  action (super admin only). An org admin who tries gets `403 cross_org_move_denied`.
- **The platform role (`users.role`, i.e. super admin) cannot be changed from here** —
  `403 role_change_denied` / `403 Cannot assign super admin role`.

---

## 2. Screens, with real UI strings

### 2.1 Getting there

Sidebar/settings path: **Settings → Organisation → Users & Groups**.
URL: `/app/settings/organisation/users` (segment table: `SETTINGS_ORG_ID_TO_URL.org_users = 'users'`
in `agent-hub/src/authedApp/settingsRoutes.js`).

The **Organisation** group in the settings nav (`settings.organisation`) contains, in order:
*License & Usage* (`settings.license_usage`), *Sign-in Method* (`settings.signin_method`),
*Privacy Shield*, *Encryption*, *AI Context*, *Integration Cache*, *Organisation info*,
*Usage & Monitoring* (`settings.usage_monitoring`), *Compliance*, **Users & Groups**
(`settings.users_groups` = `"Users & Groups"`), *Academy*, *Integrations*, *GitHub Sync*,
*Nextcloud Sync*, *Meeting Templates*, and on self-hosted *Azure Configuration*
(`settings.azure_config` = `"Azure Configuration"`).

The whole Organisation accordion is **hidden on phones** (only `org_compliance` is let through).

### 2.2 Users & Groups — tab bar

Rendered by `OrgUsersPanel.jsx:527-531`. Each tab shows a **count badge**.

| Tab label | Shown when | Badge counts |
|---|---|---|
| **Users** | always | org members (system rows dropped) |
| **Groups** | always | groups in the caller's org(s) |
| **Roles** | always | *server* roles whose id is `org_admin`/`agent_admin`/`agent_editor` — see Pitfalls |
| **Nextcloud Sync** | only when the org is bound to a Nextcloud instance (`user.ncOrg.instanceId`) | — |

Clicking a tab pushes `/app/org-settings/users/<list|groups|roles|customTiers|sync>` into the address
bar (`useUrlTab`, basePath `/app/org-settings/users`, alias `users → list`). `customTiers` has no tab
button — it is reachable only by URL and renders `OrgCustomTiersPanel`.

### 2.3 Users tab

Top of the tab, above the card:
- **Org health banner** (`OrgHealthBanner`, only for Nextcloud-connector orgs / blocked orgs):
  *"AI chat is not available for your organisation yet — a configuration step is still needed."* /
  *"{count} user(s) are waiting for approval and cannot use AI yet."* +
  *"Approve them in the member list below to unlock access."* + button **Show pending**.
- **Auto-approve card** — only rendered when the org's sign-in method is *not* `password`:
  title **"Auto-approve users from trusted domains"**, body *"When enabled, users with a matching
  email domain are added automatically with default permissions. When disabled, they are added as
  pending and require admin approval."*, with a toggle.

Card header:
- Title **"Organisation Members"**, subtitle *"Manage roles and group assignments for users in your
  organisation"*.
- Button **"Invite User"** (paper-plane icon).

Invite form (expands under the header):
- Field label **EMAIL ADDRESS**, placeholder `colleague@example.com`.
- Field label **ROLE**, a `<select>` with `User` plus every entry of `ORG_ROLES`:
  *Organisation Admin, Data Protection Officer, ISMS Internal Auditor, Agent Admin, Agent Editor, Member*.
- Button **Send**.
- Success line: *"Invitation sent to &lt;email&gt;"*; if mail delivery failed:
  *"Invitation created but email delivery failed. Share the link manually:"* + link **Copy invite link**.
- Seat-cap failure adds a link **"View plans & upgrade"** → `/app/settings/organisation/license`.

Filter bar (`UserFilterBar`): search box placeholder **"Search by name or email…"**; selects
**All roles** / **All groups** / **Any status** (options **Active**, **Pending**); right-aligned
count **"{count} of {total}"** and a **Clear** button when any filter is set.

Member row: avatar, display name, role chip (`RoleBadge`, coloured, e.g. purple *Organisation Admin*),
email, group chips, and on ≥ md screens an AI-cost column — the amount plus the caption
**"cost · 30d"**, tooltip *"{calls} requests · {cost} (last 30 days)"*.

Row actions:
- Active member: a pencil (title **"Change role"**) that swaps in the role `<select>`; a person-plus
  button (title **"Assign groups"**) that opens a popover headed **Groups** with
  *"{count} selected"*, a search box **"Search groups…"** (only when the org has more than 5 groups),
  a checkbox row per group with its member count, and a footer button **"Create New Group"**.
  Empty state inside the popover: *"No groups in this organisation yet."*; no search hit:
  *"No groups match your search."*
- Pending member: chip **Pending** (clock icon) and two buttons, **Approve** (green) and **Reject** (red).

Empty states:
- No members at all: **"No users yet"** / *"Users will appear here once they are assigned to your
  organisation. Add users via the admin panel or invite them by sharing a signup link."* + button
  **Manage Groups**.
- Filters exclude everyone: *"No users match the current filters."*

**Pending Invitations** block (only when at least one invite has `status === 'pending'`), heading
**PENDING INVITATIONS**; each row: the email, chip **Invited**, the role chip when the role is not
`user`, sub-line *"Invited by &lt;name&gt; · Expires &lt;date&gt;"*, and an ✕ button
(title **"Revoke invitation"**).

### 2.4 Groups tab

- Dashed full-width button **"Create New Group"**. Expanded form: text input placeholder
  **"Group name"**, input **"Description (optional)"**, an organisation `<select>` (only when the
  caller can see more than one org), buttons **Cancel** and **Create** (**"Creating..."** while saving).
- Empty state: **"No groups yet"** / *"Groups let you organise users and control which agents they
  can access. Create a group to get started."*
- Group card: name, chip **System** for `admins`/`users`, chip **🪟 Azure AD** for
  `source === 'azure'` (plus *"Last synced: …"* and the word **Managed** instead of a delete button),
  description or *"No description"*, and **"N member/members"**. Pencil title
  **"Edit group settings"**, bin title **"Delete group"**.
- Expanded group → **GROUP SETTINGS**:
  - **Description** (click text to edit; placeholder *"Add a description..."*, empty shows
    *"Click to add description..."*).
  - **Group Role** `<select>`, first option **"User (default)"**, then the six `ORG_ROLES`.
    When set, the hint **"All members inherit this role"** appears.
  - **Allowed tiers** — pills **⚡ Fast**, **🧠 Thinking**, **✍️ Writer**, **✨ Deep Thinking**
    plus any custom tiers. Unrestricted hint: *"No restriction set — members can use every tier.
    Click a pill to restrict access to only selected tiers."* Restricted hint:
    *"N tiers permitted. Members of other groups may still see additional tiers through those
    groups."* + link **Clear restrictions**.
  - Button **"Add member"** → search box **"Search users to add…"** (max 20 candidates listed);
    if nobody is left: *"Everyone is already a member"*; **Close** to collapse.
  - **MEMBERS (n)** list with per-row ✕ (title **"Remove from group"**); empty:
    *"No members in this group"*.

### 2.5 Roles tab

Header **"Organisation Roles"**, subtitle *"These roles define what members can do within your
organisation. Assign roles in the Users tab."* It is a **read-only catalogue** — there is no create /
edit / delete here. Each row: role name, its id as a coloured chip, *"N user/users"*, the description,
and permission chips; expanding shows a **PERMISSIONS** list with a one-line explanation per item.

### 2.6 Sign-in Method (Settings → Organisation → Sign-in Method)

Heading **"Sign-in Method"**, subtitle *"Choose how users will sign into your organisation"*.
Three cards: **Username & Password** (*"Users sign in with a username and password."*),
**Sign in with Google** (*"Users sign in using their Google account."*),
**Sign in with Microsoft** (*"Users sign in using their Microsoft account."*).
Warning: **"Choose carefully:"** *"Once saved, this cannot be changed. Each user's data is protected
with a unique key that is tied to how they sign in. Switching later would make existing conversations
unreadable."* Once chosen, the card shows a lock chip **Active**, the banner
**"Sign-in method is locked"** appears, **and the nav row disappears entirely** (`AdvancedSettings.jsx`
drops `auth` when `orgAuthLocked`). Self-hosted installs additionally get **Allowed Domains**
(*"Email domains that are allowed to join this organisation via SSO…"*).

### 2.7 Azure Configuration → Microsoft SSO (self-hosted only)

Sub-tabs: **Azure OpenAI**, **Chat Model Tiers**, **Document Processing**, **Microsoft SSO**
(*"Azure AD credentials & user approval"*).
The SSO section — **"Microsoft / Azure AD SSO"** — carries
**Application (Client) ID**, **Client Secret**, **Directory (Tenant) ID**, a toggle
**"Auto-approve new SSO users"** (*"Automatically approve users who sign in via Microsoft SSO with a
matching email domain, without requiring admin approval."*), and **Azure AD Group Sync**
(*"Automatically sync groups and users assigned to your Azure AD enterprise app to BeeFlow."*) with
a **Sync Now** button, *Last synced* / *Never synced*, and **Sync Settings**:
**Auto-activate synced users**, **Destructive sync**, **Automatic periodic sync** with
**Sync every** 1 / 3 / 6 / 12 / 24 / 48 hours or Weekly. Required Azure application permissions are
listed on-screen: `GroupMember.Read.All`, `User.Read.All`, `Application.Read.All`.

### 2.8 Second surface — Admin → Security → Users

`/app/admin/security/users` (`SecurityHub` → `UserManagement.jsx`). Sections for a non-super-admin:
**Users**, **Groups**, and **My Organization**. It has the modals Users & Groups lacks:
**"Add new user"** / **"Edit user"**, **"Reset two-factor authentication?"**,
**"Delete this user?"** (*"The account is removed and cannot be restored."*),
**"Delete this group?"** (*"Members keep their accounts but lose whatever this group granted them."*).
An `org_admin` reaches it because `orgRoles.json` grants them `admin_security`.

---

## 3. Concepts a learner must understand

- **Organisation (tenant)** — the container every account belongs to. `users.organizationId`. An
  account with no organisation is a consumer account; that null is the only discriminator.
- **Organisation role (`users.orgRole`)** — what the person may do *inside their tenant*. Six values,
  defined server-side in `server/config/orgRoles.json` and mirrored for display in
  `agent-hub/src/config/orgRoles.js`. This is the field the role dropdown writes.
- **Platform role (`users.role`)** — `admin` = Bee Flow platform operator (super admin), `user` =
  everyone else. Completely separate axis; an org admin can neither read nor write it.
- **Permission** — an atomic capability id such as `manage_users`, `admin_security`,
  `admin_compliance`, `use_datatables`. The catalogue lives in `SYSTEM_PERMISSIONS`
  (`server/auth/permissions.js:108+`) and is served by `GET /auth/permissions`.
- **Group** — a named set of users inside one organisation. A group can additionally carry
  `permissions`, `roles`, an `orgRole` (fan-out: every member also acts as that role),
  `allowedAgentTypes`, `allowedTiers` and `granted_capabilities`. Group id = the slugified name.
- **Effective permissions** — the union of: the user's own `orgRole` → permissions, every group's
  `roles` → permissions, every group's `permissions`, every group's `orgRole` → permissions, plus
  `page_chat`. If the union contains `all` it short-circuits to `['all']`
  (`getUserPermissions`, `permissions.js:545-680`). Cached; mutations invalidate the cache.
- **Status** — `active` (or absent, for rows predating the column) vs `pending` vs anything else.
  Only active accounts can sign in, and only active members count as an organisation's administrator.
- **Capability / entitlement** — the *feature* layer, separate from permissions: what the
  subscription allows (the "ceiling"), what the org has switched on, and what each group is granted.
  Edited in Settings → Organisation → Integrations → **Access** (`GroupAccessMatrix`).
- **Seat** — one active user in the org. The plan's `max_users` caps it; `-1` means unlimited.
- **Auto-approve** — per-organisation flag (`organizations.autoApproveSSO`). Off ⇒ SSO newcomers land
  as `pending` with no groups and must be approved on this screen.
- **Anti-orphan rule** — an organisation that still has other active members must keep at least one
  active `org_admin`. Enforced on demote, move, suspend, delete and *leave org*.

---

## 4. End-to-end workflows (exact clicks)

### W1 — Invite a colleague and give them a role
1. Sidebar → **Settings**.
2. Expand **Organisation** → click **Users & Groups**.
3. Stay on the **Users** tab → click **Invite User**.
4. Type the address in **EMAIL ADDRESS**.
5. Pick the role in **ROLE** (leave `User` for an ordinary member).
6. Click **Send**. Expect *"Invitation sent to …"*; the person now appears under
   **PENDING INVITATIONS** with chip **Invited** and an expiry date (7 days out).
7. If the line instead says *"Invitation created but email delivery failed…"*, click
   **Copy invite link** and send it yourself.
8. After they sign up, the row moves into the member list; adjust the role with the pencil if needed.

### W2 — Approve someone who signed in with Google/Microsoft
1. Settings → Organisation → **Users & Groups** → **Users**.
2. (Optional) set the status filter to **Pending**, or click **Show pending** in the banner.
3. Find the row with the amber **Pending** chip.
4. Click **Approve** — the account becomes `active` with role `user`. Or click **Reject**, confirm
   *"Reject and remove this user? They can sign up again later."* (browser confirm), and the account
   is deleted.
5. To stop approving one by one, switch on **Auto-approve users from trusted domains** at the top of
   the tab (only visible for Google/Microsoft orgs).

### W3 — Create a team group and staff it
1. Users & Groups → tab **Groups**.
2. Click **Create New Group**.
3. Fill **Group name** (e.g. `Inkoop`) and **Description (optional)**.
4. Click **Create**. The card appears with `0 members`.
5. Click the card to expand it.
6. Click **Add member**, type a name in **Search users to add…**, click the person (the ✛ adds them).
   Repeat; click **Close**.
7. Optional: set **Group Role** if everyone in this team should also hold an org role.
8. Optional: click tier pills under **Allowed tiers** to restrict which models the team may use;
   **Clear restrictions** puts it back to "no restriction".

### W4 — Promote a colleague to Organisation Admin, then step down yourself
1. Users tab → find the colleague → click the **pencil** on their row.
2. Choose **Organisation Admin** in the dropdown. The list refreshes and the purple chip appears.
3. Now find your own row → pencil → choose **Member**.
4. A dialog appears: **"Give up your admin rights?"** / *"This removes your own administrator rights
   over this organisation. Another administrator would have to give them back."* with
   **Yes, step down** / **Cancel**.
5. Click **Yes, step down**. (Doing step 3 *before* step 1 in a one-admin org is refused — see §6.)

### W5 — Give a team an integration (access, not membership)
1. Settings → Organisation → **Integrations**.
2. Tab **Access** → the panel **Integration access**
   (*"Give an integration to your whole organisation or to a specific group. These are the
   integrations your subscription includes."*).
3. Left column: pick **All members** (blue) or a group (green). Groups with no entries show
   *"No groups yet. Create groups under **Users & Groups** to grant capabilities per team."*
4. Flip the toggle on the integration card. Saving is immediate. A padlock means the capability is
   outside the organisation's ceiling (plan/licence), not something you can grant.
5. Rule to teach: *a user gets a capability if it is granted to All members **or** to any group they
   belong to* — grants stack, they never subtract.

### W6 — Connect Azure AD and sync groups (self-hosted)
1. Settings → Organisation → **Azure Configuration** → **Microsoft SSO**.
2. Paste **Application (Client) ID**, **Client Secret**, **Directory (Tenant) ID** from
   *Azure Portal → App registrations*; save.
3. Grant `GroupMember.Read.All`, `User.Read.All`, `Application.Read.All` with admin consent in Azure.
4. Back in Bee Flow, click **Sync Now** → *"Sync completed: N group(s), M new user(s)"*.
5. Decide the three **Sync Settings** toggles: **Auto-activate synced users**, **Destructive sync**
   (removes groups/memberships that disappear in Azure — warning shown), **Automatic periodic sync**
   with **Sync every …**.
6. Synced groups now appear on the **Groups** tab with the **🪟 Azure AD** chip and the word
   **Managed** — they have no delete button.

---

## 5. Defaults, limits, numbers

| Thing | Value | Where |
|---|---|---|
| Invitation lifetime | **7 days** | `invitationStore.createInvitation` |
| Invites per inviter | **20 per rolling hour** (429) | `invitationRoutes.js:20` |
| Invites per organisation | **200 per 24 h** (429, in-memory, per node) | `ORG_INVITE_DAILY_CAP` |
| Same-email cooldown | **1 hour** (429) | `EMAIL_INVITE_COOLDOWN_MS` |
| Invite default role | `user` | invite form + `POST /auth/invitations` |
| Seat cap | plan `max_users`; `-1` = unlimited. Pending invites count toward it | `invitationRoutes.js:100-128` |
| Licence tier limits | community / enterprise / full all set `max_users: -1` | `server/license/tiers.js` |
| Password minimum | **8** chars; **12** for admin/org-admin accounts; max **256**; blocked if breached, repetitive, sequential, or contains the username/e-mail | `server/auth/passwordPolicy.js` |
| Password hashing | bcrypt, **10** rounds | `userRoutes.js` |
| Avatar upload | **2 MB**, PNG/JPG/SVG/WEBP/GIF | `userRoutes.js:719` |
| Group id | slug of the name: lower-case, non-alphanumerics → `-`, trimmed | `groupRoleRoutes.js:184` |
| System groups | `admins`, `users` — cannot be deleted | `groupRoleRoutes.js:373` |
| Group search box | appears at **> 5** groups (assign popover) / **> 6** (access matrix) | `OrgUsersPanel.jsx`, `GroupAccessMatrix.jsx` |
| "Add member" candidate list | first **20** matches | `OrgUsersPanel.jsx` |
| Per-user cost column | last **30 days** (`/api/usage/by-user?days=30`) | `OrgUsersPanel.jsx:197` |
| Model tiers | `fast`, `thinking`, `writer`, `pro` ("Deep Thinking"); empty `allowedTiers` = unrestricted | `OrgUsersPanel.jsx:1170` |
| Azure periodic sync intervals | 1, 3, 6, 12, 24, 48 hours, or Weekly (168) | `SSOSection.jsx` |
| Org id slug cap | 48 characters | `accountProvisioning.slugifyOrgId` |
| Self-serve founder | first user of a new org gets `orgRole: 'org_admin'`, status `active` | `accountProvisioning.createOrgPlacement` |
| Invited joiner | status `active`, org default groups applied, role from the invitation | `joinOrgPlacement` |
| Self-signup joiner | `active` + default groups **only if** `org.allowSignup`; otherwise `pending`, no groups | `joinOrgPlacement` |
| New SSO user, auto-approve **on** | `orgRole: 'user'`, `active`, org default groups | `ssoUserResolver.planNewSSOUserPlacement` |
| New SSO user, auto-approve **off** | `orgRole: ''`, **`pending`**, no groups | same |

---

## 6. What happens on failure

| Situation | HTTP | `code` | What the admin sees |
|---|---|---|---|
| Change would leave the org with no admin | 409 | `last_org_admin` | Red banner: *"That change would leave this organisation without an administrator. Give another active member the Organisation Admin role first — nobody could manage users afterwards, and only direct database access could undo it."* |
| You demote yourself | 409 | `confirm_self_demotion` | Confirm dialog **"Give up your admin rights?"**; on confirm the request is resent with `confirmSelfDemotion: true` |
| Org admin tries to move a user to another org | 403 | `cross_org_move_denied` | *"Cannot move users between organisations"* |
| Org admin tries to change a platform role | 403 | `role_change_denied` / *"Cannot assign super admin role"* | — |
| Assigning a group from another tenant | 403 | `cross_org_group_denied` | *"You can only assign groups in your organisation: …"* |
| Unknown field in the update body | 400 | `unknown_fields` | *"Unsupported field(s): …"* |
| Unknown role id | 400 | `unknown_role` | *"Unknown role: …"* |
| Seat cap reached on invite | 403 | `seat_cap_exceeded` | *"Your plan has reached its user limit (N active + M pending invite(s) of X). Upgrade your plan to add more users."* + link **View plans & upgrade** |
| Seat cap reached on direct create | 403 | `seat_cap_exceeded` | atomic re-check inside the transaction (`createUserWithSeatCheck`) |
| Inviting someone already in the org | 409 | — | *"A user with this email is already in your organisation"* |
| Invite flood | 429 | — | *"Organisation invitation cap reached (200 per 24h). Try again later."* / *"This email was recently invited. Wait an hour before re-inviting."* |
| Granting a permission you don't hold | 403 | — | *"Cannot assign permissions you don't have: …"* |
| Attaching a role that grants more than you hold | 403 | — | *"Cannot assign roles that grant permissions you don't have: …"* |
| `roles`/`permissions` sent as a string or `null` | 400 | — | *"roles must be an array (use [] to clear it, not null)"* |
| Deleting `admins` / `users` group | 400 | — | *"Cannot delete system groups"* |
| Leaving the org as the only admin | 409 | `last_org_admin` | *"You are the only organization admin. Promote another member before leaving."* |
| Non-admin opens the screen by URL | 403 from the API; the nav row is not rendered at all | — | `AdvancedSettings.jsx:344` |

There is also a **post-write repair**: two admins demoting each other concurrently both pass the
pre-check, so `repairIfOrphaned` re-checks after the write and rolls the row back, then returns the
same 409 (`orgAdminGuards.js:137-163`).

Password reset by an admin (no `oldPassword`) is **destructive** in the zero-knowledge sense: it calls
`adminResetUser`, and the user's previously encrypted data needs their recovery key.

---

## 7. Permission and licence gates

### 7.1 Client-side (what renders)
- `usePermissionCheck(user, perm)` / `checkPermission` — `agent-hub/src/hooks/usePermissionCheck.ts`.
  `user.isAdmin` or a `permissions` array containing `'all'` always wins. (There is **no** `useCan`
  hook in this repo; `useCan(...)` in `AdvancedSettings.jsx` comes from the licensing context and
  answers *entitlement*, not permission.)
- Nav row **Users & Groups** is shown when
  `canManageUsers = perms.includes('all') || perms.includes('manage_users') || user.orgRole === 'admin' || user.orgRole === 'org_admin'`
  (`AdvancedSettings.jsx:246, 344`).
- The rest of the Organisation group needs
  `canSeeOrg = perms.includes('all') || perms.includes('org_admin') || orgRole admin/org_admin`.
  A pure **DPO** sees *only* Compliance.
- `USER_MANAGEMENT_ROLES = ['org_admin']` in `agent-hub/src/config/orgRoles.js`.

### 7.2 Server-side
- `requireAuth` — authenticated session.
- `requireAdmin` — `manage_users` or `all` (`permissions.js:758`). Used by `GET /auth/roles` and
  `GET /auth/permissions`.
- `requireSuperAdmin` — `users.role === 'admin'`. Used by org create/delete and all role CRUD.
- `requireOrgAdmin(param)` — org-admin of the org named in that path param (`orgAdminGuards.js`).
- `requireOrgAdminForUser` — resolves the *target user's* org, then requires org-admin over it, and
  additionally blocks `role`, `organizationId` and cross-org `groups` changes.
- Inline permission checks on the list endpoints accept any of
  `all` / `manage_users` / `admin_security` / `org_admin`.
- `server/config/orgRoles.json` is the authority for role → permissions:
  - `org_admin` → `org_admin, manage_users, manage_agents, manage_skills, manage_knowledge,
    manage_apps, manage_components, manage_automations, page_settings, use_notebooks,
    modify_n8n_workflows, support_inbox, admin_agents, admin_agents_chat, admin_agents_system,
    admin_agents_pipeline, admin_components, admin_ai_config, admin_security, admin_monitoring,
    admin_compliance, admin_subscriptions, use_datatables, manage_datatables`
  - `dpo` → `dpo, page_settings, admin_compliance, admin_monitoring`
  - `isms_auditor` → `isms_auditor, page_settings, admin_compliance, admin_monitoring`
  - `agent_admin` → `agent_admin, manage_agents, manage_skills, manage_knowledge, manage_apps,
    use_notebooks, admin_agents, admin_agents_chat, admin_agents_pipeline, use_datatables,
    manage_datatables`
  - `agent_editor` → `agent_editor, manage_agents, manage_skills, manage_knowledge, manage_apps,
    use_notebooks, admin_agents, admin_agents_chat, use_datatables`
  - `member` → `use_notebooks, use_datatables`

### 7.3 Licence
**User & group management itself is NOT licence-gated** — there is no `requireLicenseFeature(...)`
anywhere on `/auth/users`, `/auth/groups`, `/auth/roles` or `/auth/invitations`, and every tier in
`license/tiers.js` sets `max_users: -1`. What *is* gated:
- Seat caps come from the **subscription plan** (`subscription_plans.max_users`,
  overridable per org on `organization_subscriptions`), not the licence tier.
- The neighbouring nav rows are gated: **Compliance** needs `admin_compliance` **and** the compliance
  entitlement; **Academy** needs the `learning_center` entitlement; the Usage sub-reports
  Safety/Integrations/Azure need `advanced_usage_monitoring` (enterprise+).
- Grants in the access matrix are clamped twice: to `cap.groupTogglable` and to the org's
  ceiling (`orgAvailable`) — an org admin can never grant beyond the subscription.

---

## 8. How it connects to other features

- **Sign-in Method / SSO** — decides whether new people arrive as `pending`; the auto-approve toggle
  on the Users tab is only meaningful for Google/Microsoft orgs. Changing the sign-in method after
  the fact is impossible (encryption keys are derived from it).
- **Licence & Usage** — seat cap, upgrade link from a failed invite, per-user 30-day cost column.
- **Integrations → Access** and **Beta features** — granted per *group* or to *All members*
  (`GroupAccessMatrix` → `PUT /auth/groups/:id/access`, `PUT /auth/me/org-access`).
- **AI model tiers** — a group's **Allowed tiers** restricts which tiers its members may pick;
  custom tiers come from `/ai/config/custom-tiers-list` and the `customTiers` sub-screen.
- **Compliance Center** — the `dpo` and `isms_auditor` roles exist purely to open Compliance and
  Usage & Monitoring without full admin.
- **Datatables / Studio apps / automations** — `use_datatables` vs `manage_datatables` come straight
  from the org role, so "who may create a table" is decided here.
- **Nextcloud-bound orgs** — identity is delegated to Nextcloud: the Sign-in Method row disappears
  and an extra **Nextcloud Sync** tab appears inside Users & Groups.
- **Azure AD** — group sync creates Bee Flow groups marked `source: 'azure'`.
- **Audit** — every mutation writes an `access_audit` row: `user.create`, `user.update`,
  `user.delete`, `group.create`, `group.delete`, `group.member.add`, `group.member.remove`,
  `group.access.update`, `org.access.update`, `invitation.create`, `invitation.revoke`.

---

## 9. Common mistakes

1. **Confusing the role dropdown with the platform role.** The dropdown writes `orgRole`. Nothing on
   this screen can make someone a Bee Flow super admin.
2. **Assuming the Roles tab is editable.** It is a read-only catalogue. Creating or editing a role
   is super-admin-only (`POST/PUT/DELETE /auth/roles` → `requireSuperAdmin`) and roles are *global*,
   not per-tenant.
3. **The Roles tab badge does not match the six rows listed.** The badge counts server-side roles
   whose id is `org_admin`/`agent_admin`/`agent_editor`, while the list renders the six client-side
   `ORG_ROLES`. Do not teach the badge as "number of roles".
4. **Demoting yourself first.** In a one-admin org with other members, the 409 `last_org_admin`
   fires. Promote someone else first.
5. **Expecting "Reject" to be reversible.** Reject = `DELETE /auth/users/:id`. The account is gone
   (the person may sign up again).
6. **Expecting an admin password reset to be harmless.** Without the old password it re-keys the
   account destructively; encrypted content needs the user's recovery key.
7. **Thinking group `allowedTiers` subtracts.** It restricts only *that* group; another group can
   still widen the same person's tiers. Empty = unrestricted, not "nothing allowed".
8. **Thinking the access matrix grants membership.** Access grants (integrations/features) and group
   membership are two different actions on the same object.
9. **Editing an Azure-synced group.** It carries the **Managed** marker, cannot be deleted from the
   UI, and destructive sync will undo manual membership changes.
10. **Forgetting the invite caps.** Bulk-onboarding 30 people in one sitting hits the 20/hour inviter
    limit; the per-email cooldown also blocks a quick "resend".
11. **Losing the invitation link when mail fails.** The link is shown only once, in the green/red
    result line — click **Copy invite link** immediately.
12. **Assuming the address bar stays on `/app/settings/organisation/users`.** Clicking a sub-tab
    rewrites it to `/app/org-settings/users/<section>` (the legacy Organisation Settings page). Both
    render the same panel, so do not write a lesson step that says "the URL stays the same".
13. **Sending the whole user row back.** The panel PUTs only the fields it changes; an unknown key
    returns 400 `unknown_fields`.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

**A. Procurement — a supplier-quote team with restricted models.**
Van Dijk Groep's inkoop team (Sanne, Joost, Bilal) processes supplier quotations. The office manager
opens Settings → Organisation → Users & Groups → **Groups**, clicks **Create New Group**, names it
`Inkoop`, description *"Offertes en leveranciersdossiers"*, and clicks **Create**. She expands the
card, clicks **Add member**, and adds all three. Because quote comparison is cheap bulk work she
clicks the **⚡ Fast** pill under **Allowed tiers** so the team cannot burn budget on Deep Thinking;
the hint changes to *"1 tier permitted…"*. Finally she goes to Organisation → Integrations →
**Access**, selects **Inkoop** in the left column, and switches on the Nextcloud integration so the
group reaches the supplier folder. Nobody's role changes — they stay **Member**, which already carries
`use_datatables`.

**B. HR — onboarding a new payroll administrator, and a DPO.**
A new HR colleague, Marieke, starts on the 1st. On the Users tab the HR lead clicks **Invite User**,
types `marieke@vandijkgroep.nl`, leaves **ROLE** on `User`, and clicks **Send**. The row appears under
**PENDING INVITATIONS** with *"Expires 21-09-2026"*. Marieke's mail is quarantined, so the HR lead
re-opens the form — the second attempt returns *"This email was recently invited. Wait an hour before
re-inviting."*, so she instead revokes nothing and waits, then uses **Copy invite link** on a fresh
invite an hour later. Separately, Van Dijk Groep appoints their office manager as Data Protection
Officer: the org admin clicks the pencil on her row and picks **Data Protection Officer**. She now
sees only **Compliance** and **Usage & Monitoring** under Organisation — no user management — which is
exactly the separation the AVG/GDPR role is meant to have.

**C. Sales — a departing account manager and the anti-orphan guard.**
Account manager Ruben leaves. He is the second `org_admin` (the first is the director). The director
opens Users & Groups, clicks the pencil on Ruben's row and sets him to **Member**, then deletes the
account from Admin → Security → Users (**"Delete this user?" / "The account is removed and cannot be
restored."**). Later the director tries to hand the tenant to the new commercial manager but sets
*himself* to **Member** first — Bee Flow answers with *"That change would leave this organisation
without an administrator…"*. He promotes the new manager to **Organisation Admin** first, then
re-tries his own change and confirms **"Yes, step down"**. Meanwhile the Sales group keeps its
**Allowed tiers** and its CRM integration grant, so the new manager inherits a working set-up rather
than a blank slate.

---

## 11. List / read endpoints a "did the learner do it?" check can call

All of these are on the `/auth` mount (`server/index.js:548 → app.use('/auth', authRouter)`), so the
full path from the SPA is `${API_BASE}/auth/...`. All require an authenticated session cookie
(`authFetch`); the org-scoped ones additionally require one of
`all` / `manage_users` / `admin_security` / `org_admin`.

| Method | Path | Auth | Row / payload |
|---|---|---|---|
| GET | `/auth/users` | session + (`all`\|`manage_users`\|`admin_security`\|`org_admin`); rows filtered to the caller's org(s), self always included | Array. Each row: `id`, `username`, `displayName`, `firstName`, `lastName`, `email`, `phone`, `avatarType`, **`role`** (platform), **`orgRole`** (org role), `groups` (array of group ids), **`organizationId`** (the tenant "owner" field), `status` (`active`/`pending`/…), `ssoEncryptionSetup`, `passwordResetRequired`, `dekUnwrapFailures`, `dekLockoutUntil`, `kdfMode`, `createdAt`, `activeIconPackId`, `azureUserId`, `nc_uid`, `provider`, `auto_provisioned`, `mfa_enabled`/`mfaEnabled`, `last_seen_at`/`lastSeenAt`. Envelope-key material and the avatar blob are deliberately **not** included. A synthetic `{id:'admin', isSystem:true}` row is prepended for super admins only. |
| GET | `/auth/groups` | same permission set; filtered to the caller's org(s) | Array. Each row: `id`, **`organizationId`**, `name`, `description`, `permissions[]`, `roles[]`, `userCount`, `allowedAgentTypes[]`, `allowedTiers[]`, `disabled_integrations[]`, `granted_capabilities[]`, plus `orgRole`, and for Azure-synced groups `source: 'azure'` and `lastSyncedAt`. |
| GET | `/auth/roles` | `requireAdmin` (`manage_users` or `all`) | Array of `{ id, name, description, permissions[] }`. Global, not org-scoped. |
| GET | `/auth/permissions` | `requireAdmin` | Static catalogue: `{ id, name, description, group }` (groups: `super`, `pages`, `admin`, `actions`, …). |
| GET | `/auth/organizations` | same permission set; filtered to the caller's org(s) | Array of organisation rows: `id`, `name`, `description`, `tagline`, `address`, `email`, `phone`, `website`, `kvk`, `vat`, `logo`, `footerText`, `defaultGroups[]`, `allowSignup`, **`authMethod`**, **`autoApproveSSO`**, `allowedDomains[]`, `enabledIntegrations`, `registrationSource`. |
| GET | `/auth/organizations/:id` | `requireOrgAdmin('id')` | One organisation row (same shape). |
| GET | `/auth/invitations` | session + org-admin of the caller's own org | Array: `id`, `email`, `role`, `status` (`pending`/`accepted`/`revoked`), `invited_by`, **`inviterName`** (enriched display name of the issuer), `created_at`, `expires_at`. |
| GET | `/auth/my-permissions` | any session | `{ permissions[], groups[], organizations[], allowedAgentTypes[], betaFeatures[], canUseFeature{} }` — the caller's own effective permission snapshot. Best endpoint for "does this learner now hold `manage_users`?". |
| GET | `/auth/user` | any session | The caller's own profile + session flags. |
| GET | `/auth/me/group-access` | session + org-admin-like | `{ orgId, mode, capabilities[], ceiling[], everyone[], groups[{ id, name, granted[] }], betaGoverned }` — the access matrix state. |
| GET | `/auth/organizations/:orgId/group-access` | `requireOrgAdmin('orgId')` | Same shape for a named org. |
| GET | `/api/org-azure-config/:orgId` | session + strict org-admin of that org | Azure/SSO configuration, with secrets returned only as `has…` booleans. |
| GET | `/api/org-azure-config/:orgId/sync-groups/status` | session + strict org-admin | `{ status, settings }` — last Azure sync result and the three sync toggles + interval. |
| GET | `/api/usage/by-user?days=30` | session (usage router) | Per-user `{ calls, cost }` used by the cost column. |

Mutating counterparts (for completeness, not for verification checks):
`POST /auth/users`, `PUT /auth/users/:id`, `DELETE /auth/users/:id`, `POST /auth/users/:id/mfa/reset`,
`POST|DELETE /auth/users/:id/avatar`, `POST /auth/groups`, `PUT /auth/groups/:id`,
`POST /auth/groups/:id/members`, `DELETE /auth/groups/:id/members/:userId`, `DELETE /auth/groups/:id`,
`PUT /auth/groups/:id/access`, `PUT /auth/me/org-access`, `POST /auth/invitations`,
`DELETE /auth/invitations/:id`, `PUT /auth/organizations/:id` (auto-approve lives here),
`POST /auth/users/me/leave-org`, `POST /api/org-azure-config/:orgId/sync-groups`.
