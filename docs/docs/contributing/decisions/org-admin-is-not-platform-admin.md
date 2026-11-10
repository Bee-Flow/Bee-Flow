---
title: "0017: An organisation admin is not a platform admin"
description: Why instance-wide settings need a platform admin in every deployment mode, and why an organisation admin administers only the organisations where one strict check holds.
---

# 0017: An organisation admin is not a platform admin

**Status:** accepted, in effect. **Enforced by:** `server/auth/routes.contract.json` and
`server/routes.contract.test.js` (the instance-wide routes are recorded at class `platform`),
`server/auth/accessRegistry.drift.test.js` (no gate is tagged both rbac and platform),
`server/auth/requirePlatformAdmin.test.js`, `server/auth/admin/orgAdminGuards.strict.test.js`,
`server/auth/adminRoutes.crossTenant.test.js`, `server/auth/adminRoutes.selfDemote.test.js`,
`server/auth/permissions.characterisation.test.js` and the second caller of
`server/tenantIsolation.matrix.test.js`. **Code:** `server/auth/requirePlatformAdmin.js`,
`server/auth/permissionsOrgGates.js` (`_evalOrgAdmin`, `isOrgAdminForOrg`, `requireOrgAdmin`),
`server/auth/admin/orgAdminGuards.js`.

## Context

There are two administrator axes. A **platform admin** runs the installation: `users.role`
is `admin`, or the session carries the operator flag (the operator account from setup, see
0009, is one). An **organisation admin** runs one organisation: their `orgRole` is an admin
role in their own organisation, or they belong to a group of that organisation that carries
admin rights.

Two shortcuts blurred them. On a self-hosted install, the gate of instance-wide settings let
any holder of the matching organisation permission through, on the assumption that one
install is one customer. One server can hold many organisations, so an organisation admin
could change provider keys, model defaults, branding and other settings that apply to every
organisation. And there were two answers to "does this person administer organisation X":
a strict one (`_evalOrgAdmin`) used by the organisation-scoped config routes, and a looser
one in the user, organisation and access-grant routes that accepted an admin `orgRole` in
any organisation plus membership of any group of X.

## Decision

- **Instance-wide settings need a platform admin, in every deployment mode.**
  `requirePlatformAdmin` and `hasPlatformAdminAccess` answer `isSuperAdmin(req)` and nothing
  else; the gate is tagged on the `platform` axis, so the route contract records those routes
  as `platform` and a later weakening fails `routes.contract.test.js`. A permission such as
  `admin_ai_config`, `manage_users` or the `all` wildcard does not make anyone a platform admin.
- **One answer to "who administers organisation X".** `_evalOrgAdmin` decides: X is the
  person's own organisation and their `orgRole` is an admin role, or they belong to a group
  of X that carries the `all` or `admin` permission or the `admin` or `org_admin` role.
  Membership of an ordinary group of X is membership, not administration. The org-admin
  gates use it: `isOrgAdminForOrg`, `requireOrgAdmin` and `requirePrimaryOrgAdmin` in
  `permissions`, and `isOrgAdminForOrg`, `requireOrgAdmin`, `requireOrgAdminForUser` and
  `orgsAdministeredBy` in `auth/admin/orgAdminGuards.js`.
- **The anti-orphan count counts only guarded administrators.** `countOrgMembers` counts a
  person as an organisation's remaining administrator only when X is their own organisation
  and their `orgRole` is an admin role. Every way such a person stops administering X
  (demotion, a move, suspension, deletion, leaving the organisation) runs the guard. Leaving
  or editing an admin-carrying group runs none, so a member of such a group is not counted.
- Platform admins pass every org-admin gate, as before.

## Consequences

- A single-organisation self-hosted install must have a platform admin for its instance-wide
  settings. The operator account from setup is one; others are appointed by setting
  `users.role` to `admin`, which only a platform admin can do. The upgrade note in
  *Self-hosting → Upgrades* says so.
- An organisation admin who is also an ordinary member of a group of another organisation
  can no longer manage that organisation's users, settings or access grants, nor assign its
  groups. Someone whose only standing in an organisation is a group there that carries admin
  rights now administers it, whatever their own `orgRole`; the organisation-scoped config
  routes already treated them that way.
- The anti-orphan guard refuses a demotion that would leave an organisation with members but
  no administrator whose removal is itself guarded. A member of an admin-carrying group still
  passes the gate, but does not let the last org-admin `orgRole` of the organisation go.
- Who may *see* what (the list routes, monitoring, agents and knowledge bases across the
  organisations a person belongs to) is a separate question and is not changed by this record.
