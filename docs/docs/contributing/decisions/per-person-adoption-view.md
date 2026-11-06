---
title: "0015: Per-person adoption view: pseudonymous by default, audited reveal, no navigation tracking"
description: Why the Adoption report lists people under a stable pseudonym, writes an access-audit row before it shows a name and refuses to show one when it cannot, keeps the top users of a Studio item pseudonymous for good, and measures adoption only from records that already exist.
---

# 0015: Per-person adoption view: pseudonymous by default, audited reveal, no navigation tracking

**Status:** accepted, in effect. **Code:** `server/routes/usageAdoption.js` (the
`/api/usage/adoption/*` routes, the reveal and its audit row),
`server/core/privacy/pseudonym.js` (the per-organisation pseudonym),
`server/stores/adoption/` (the read model), `server/shared/usageAreas.js` (the area
vocabulary). **Enforced by:** the compliance check `GDPR-Art35-per-user-shield-view`
(`server/compliance/checks/gdpr/art35-per-user-shield-view.js` and its test) and the
audit assertion in `server/routes/usageAdoption.authz.test.js`.

## Context

An organisation admin could not see how Bee Flow is adopted: how many people use AI,
where the spend goes, what was built in Studio and who uses it. The Adoption report in
Usage & Monitoring answers that, and one part of the answer is a table with one row
per member: their status, their AI use, the areas they use and what they built.

A table like that is a facility suitable for monitoring named staff (in the
Netherlands WOR art. 27(1)(l), and a DPIA under GDPR Art. 35). The Overview tab
already ranks named people by consumption for org admins and Monitoring holders, and
none of the usage routes writes an access-audit row. The compliance check
`GDPR-Art35-per-user-shield-view` listed what a per-person view should have before it
can pass: a DPIA, works-council scope, a notice naming the endpoints, a start date,
pseudonymous by default, an audited name reveal and a retention bound. None of those
existed.

The report also needs a usage figure per Studio kind. For agents, automations, forms,
apps and skills a domain row already exists (a conversation, a run, a submission, an
action run, an activation). For data tables, knowledge bases, documents, playbooks and
internal webpages nothing records a use, and the cheap fix would be to start recording
opens and views. The telemetry contract (`docs/docs/reference/telemetry.md`) forbids
recording screen names, navigation or route paths.

## Decision

1. **Pseudonymous by default.** Every per-person row of the Adoption report carries a
   pseudonym, not a name: an HMAC-SHA256 of the user id under an organisation-scoped
   secret, shown as `Member · K7Q2`. It is stable inside one organisation, so a person
   can be followed over periods without being named, and different across
   organisations. No avatar is sent.
2. **An audited, fail-closed reveal.** Names come back only with `?reveal=true`. Before
   the answer is built, the route awaits `recordReveal` in
   `server/stores/adoption/audit.js`: a direct insert of a
   `usage_adoption_people_revealed` row into `access_audit_log` (target type
   `organization`, the organisation and the actor) that throws when the write fails.
   It does not go through `userStore.logAccessAudit`, because that function swallows
   errors and so cannot fail closed. The payload is an allow-list of the view's
   parameters (`startDate`, `endDate`, `group`, `limit`): no names, no figures. If the
   row cannot be written, the route answers `503 audit_unavailable` and shows nothing,
   as `dsr.subject_viewed` does. The client keeps no revealed answer once the names are
   hidden, so every "Reveal names" is a new request and a new row.
3. **Who uses an item stays pseudonymous.** The top users of a Studio item are always
   pseudonyms, also after a reveal. Owners are shown by name: who built something is
   organisational metadata, who uses it and how much is behaviour.
4. **Aggregate first.** Groups with fewer than 5 members are merged into one row. The
   weekly chart uses ISO weeks and marks the current one as incomplete. Health
   categories never appear next to a person; the report carries no Privacy Shield
   categories at all.
5. **No navigation tracking.** Usage per Studio kind comes only from records that
   already exist. A kind without one shows "no signal". Webpages count only the view
   counter of a public share link. The report adds no event, column or table that
   records an open, a view or a visit.
6. **The check stays a warning.** `GDPR-Art35-per-user-shield-view` lists the Adoption
   endpoints (`adoption.people`, `adoption.studio.items.top_people`) next to the
   Privacy Shield views and the consumption views (`usage.users`, `usage.by_user`,
   `usage.recent`), and its evidence records `adoption_pseudonymous_default`,
   `adoption_reveal_audited` and `adoption_reveal_audit_action`. The prefix scopes
   those flags to the Adoption endpoints: the other listed views still show names.
   It keeps `warn` while the DPIA, works-council and notice gate does not exist in
   the product.
7. **Test traffic is not adoption.** Test chats in the agent editor and skill tests
   (the `agent_test_*` and `skill_test*` ledger sources) are left out of every
   adoption read: they show that a maker checked their work, not that anyone used it.

## Alternatives considered

- **Named by default, as the Overview does.** Simplest, and consistent with the tab
  next to it. Rejected: it extends an unaudited per-person view to a table of every
  member, which is the larger of the two, and makes the Overview's gap the norm.
- **No per-person view at all.** The safest choice. Rejected: an admin who wants to help
  people get started needs to find who has not, and the group view cannot answer that
  for small teams. A pseudonymous row answers "how many and what kind" without a name;
  a reveal is a deliberate, recorded act.
- **A full works-council opt-in gate first**, modelled on chat signals (DPIA, works
  council, notice, start date, retention, objections, a resolver that pauses the view).
  The right end state. Rejected for now: it is a feature of its own, and holding the
  whole report back for it would leave the Overview's named, unaudited ranking as the
  only per-person view. The check names the gap until it is built.

## Consequences

- A reveal is visible to the DPO in the access audit log. An admin who reveals names for
  every visit leaves a trail of every visit.
- A broken audit store makes the people table unusable with names. That is intended.
- Kinds without a usage record say "no signal" in the product. Adding a usage figure for
  one of them needs a domain record that already serves another purpose, or a new
  decision record that supersedes point 5.
- The pseudonym hides a name, not a person: a small organisation can often tell who is
  behind a row. The pseudonym is a safeguard against casual identification, not
  anonymisation, and the GDPR applies in full.
- The compliance check keeps warning in every Enterprise organisation until the opt-in
  gate exists.

## The check that enforces it

- `server/compliance/checks/gdpr/art35-per-user-shield-view.test.js` pins the endpoint
  list with the Adoption endpoints, the evidence allow-list (`adoption_pseudonymous_default: true`,
  `adoption_reveal_audited: true`, `adoption_reveal_audit_action: 'usage_adoption_people_revealed'`, no
  user and no count), and the `warn` status while `opt_in_gate` is false.
- `server/routes/usageAdoption.authz.test.js` asserts that `?reveal=true` writes the
  `usage_adoption_people_revealed` row before any name is answered, that a failing audit
  store answers `503 audit_unavailable` without names, and that the default answer and
  the top users of an item carry pseudonyms only.
