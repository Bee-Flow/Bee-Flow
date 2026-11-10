---
title: "0018: Teams meetings are imported per organiser by default; application permissions are opt-in per organisation"
description: Why Bee Flow reads Teams recordings and transcripts with each organiser's own delegated connection, why organisation-wide import with application permissions is off by default, takes its Microsoft tenant only from verified sources and re-checks coverage at use, and why the setup tests only read.
---

# 0018: Teams meetings are imported per organiser by default; application permissions are opt-in per organisation

**Status:** accepted, in effect. **Code:** `server/core/meetingNotes/teamsAutoImport.js`,
`teamsArtifacts.js`, `teamsCalendar.js`, `server/core/meetingNotes/teamsSetup/` (the tests),
`server/core/meetingNotes/teamsAppImport/` (`orgTenant.mts`, `coverage.mts`, `appToken.mts`,
`settings.mts`), `server/routes/teamsSetup.mts`. **Enforced by:** `teamsAppImport/coverage.test.js`
(every coverage rule; a member of another organisation, another tenant, a deactivated or moved
member is never covered), `teamsAppImport/appToken.test.js` (the token is asked for at the
organisation's own tenant, never `common`; a token for another tenant is refused; the session cannot
refresh), `teamsAppImport/orgTenant.test.js` (the tenant comes from the directory sync binding or a
single-organisation server only), `teamsAutoImport.test.js` (the delegated path is unchanged and
comes first; coverage is checked again when a job is claimed),
`teamsSetup/userDiagnostics.test.js` (the tests issue no write to Microsoft Graph),
`routes/teamsSetup.test.js` (another organisation's members, failures and settings never appear;
no token, secret, scope string, meeting title or e-mail address in any response) and
`server/routes.contract.test.js`.

## Context

Teams recordings and transcripts can be read through Microsoft Graph in two ways. With delegated
permissions Bee Flow acts as the signed-in organiser and Graph gives it that person's meetings
only. With application permissions Bee Flow acts as itself and can read the meetings of anyone the
tenant's administrators allow, without those people connecting. The second is easier for an
organisation to roll out and much wider: `Calendars.Read` as an application permission reads every
mailbox, and one wrong tenant would point an app token at another organisation's meetings on a shared
server.

## Decision

- **Delegated per organiser is the default.** A member connects Microsoft 365 and Bee Flow imports
  the meetings that member organises, with their token. Nothing changes for members who connect.
- **Application permissions are opt-in per organisation.** An organisation admin switches
  organisation-wide import on, chooses all members or selected members, and the change is audited.
  The platform administrator can switch it off for the whole server (`TEAMS_APP_IMPORT=0`). It is a
  second source of a token for the same poller, not a second pipeline, and it implies no automatic
  import: the organisation's and members' choices per meeting keep their meaning.
- **A delegated connection wins.** A member whose own connection carries the Teams permissions is
  imported with it; the app token is used only for covered members without one.
- **The tenant comes only from verified sources.** The directory sync binding a platform
  administrator set for the organisation, or the configured tenant ID on a server with exactly one
  organisation. An organisation admin cannot type a tenant. A tenant therefore maps to at most one
  organisation, and a server with several organisations and no binding does not offer the option.
- **Coverage is re-checked at use.** A member is covered only while every rule holds (switched on,
  same tenant as when it was switched on, active member of this organisation, a verified Microsoft
  identity in that tenant, selected, Meeting Notes access, credentials for the tenant), checked when
  meetings are found and again when a job is claimed. Members are identified by their verified
  Entra object ID, never by e-mail address.
- **The app token stays in memory.** It is cached per client ID and tenant, refused when its tenant
  claim differs, never stored, logged or returned, and the session built on it cannot refresh.
- **Setup tests only read.** The tests reuse the import's own Graph calls so they fail where an
  import would, never change a meeting (auto-record is a permission check, not a PATCH), discard a
  transcript's text at once, and return allow-listed result codes and parameters only. The member
  overview is built from stored state and asks Microsoft nothing.

## Consequences

- Organisations with several Microsoft tenants per Bee Flow organisation, or servers with several
  organisations and no directory sync binding, cannot use organisation-wide import until a
  per-organisation binding flow exists.
- Manual import and the Upcoming tab keep using the member's own connection; organisation-wide
  import covers automatic import only.
- Tenant-wide consent state (permission grants, app role assignments) is not read, because that
  needs directory permissions Bee Flow does not ask for. The tests infer it from what Microsoft
  answers.
- A new place that would use the app token has to go through the same coverage rule, or the
  coverage tests do not cover it.
