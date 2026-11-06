---
title: "Usage & adoption"
description: "The Adoption report in Usage & Monitoring: how many people use AI, where the AI goes, what your organisation built in Studio and who uses it, per group and per person. Who can see it, how the numbers are made, and the privacy rules it keeps."
---

# Usage & adoption

:::caution[Not legal advice]

This page describes what Bee Flow does. It is not legal advice. A per-person view of AI
use can be a facility for monitoring staff. Your organisation decides whether and how
you use it, carries out the DPIA, gets works-council consent where it applies, and
tells people in your staff notice. Check with your data protection officer (DPO) before
you rely on the per-person part.

:::

The **Adoption** report answers four questions about your organisation:

- how many people use AI, and how many do not yet;
- where the AI goes: chat, agents, automations, apps, forms and the rest;
- what your organisation built in Studio, who built it, and how much it is used;
- how adoption differs per group and per person.

Path: **Settings → Organisation → Usage & Monitoring → Adoption**
(`/app/settings/organisation/usage/adoption`). It is a report tab next to Overview,
Feedback and Terminations.

## Who can see it

- **Org admins** and anyone whose role holds the **Monitoring** permission
  (`admin_monitoring`). The built-in roles **Data Protection Officer** and **ISMS
  Internal Auditor** hold it.
- Members without that permission get no Adoption tab, and the API answers `403`.
  There is no "my own adoption" view: this is an organisation report.
- It needs an **Enterprise** licence (the `advanced_usage_monitoring` capability, see
  [Licence tiers](../licensing/tiers.md)). On Community the tab does not appear.
- A person without an organisation (a consumer account) gets `403`.

The organisation always comes from your session. A query parameter cannot point the
report at another organisation, and the group filter can only narrow it.

## What the report shows

The report follows the period selected at the top of Usage & Monitoring: a number of
days counted back from today, or a custom date range. The headline compares with the
period of the same length just before it.

### The headline

- **Members**: everyone in the organisation, directly or through a group. System
  accounts, the platform operator and people still pending are left out.
- **AI-active**: members who made at least one AI call in the period, and the
  **adoption rate** (AI-active members out of all members).
- **Signed in only**: members who signed in during the period but made no AI call.
- **Dormant**: members who have not signed in for more than 30 days.
- **Never signed in**: members created in the last 30 days who have not signed in yet.
- **Makers**: members who own at least one Studio item (an agent, automation, app,
  form, table, knowledge base and so on), and how many became a maker in the period.
- **Seats**: the seats in use, and the maximum when your licence sets one.
- **Spend**: the AI cost in the period, the number of people behind it, and the cost
  per AI-active member.

"Signed in only", "Dormant" and "Never signed in" need a period counted back from today.
For a custom date range they show "—": Bee Flow keeps only each person's last sign-in,
which cannot be placed inside a window in the past.

### Where the AI goes

Every AI call is assigned to one **area**: agents, chat, automations, forms, apps,
Cowork, meeting notes, knowledge, documents, projects, webpages, skills, data tables,
media, system and other. The list shows per area the cost, the number of people, and
the number of distinct objects (agents, apps, automations) behind it. Open an area to
see the sources it is made of. **Other** lists the sources Bee Flow does not assign to
an area by their raw name, so nothing is hidden.

Below the list, a weekly chart stacks the areas per ISO week (Monday to Sunday). The
current week is still growing and is shown faded. The area list above it holds the same
numbers as a table.

### Studio adoption

One row per Studio kind: agents, automations, forms, apps, data tables, knowledge
bases, skills, webpages, documents, meeting notes, playbooks, solutions and Cowork. Per
kind: how many there are, how many are published or shared, how many makers, how many
are new in the period, how much they were used and by how many people, and the AI cost
of the matching area.

How much a kind is used is counted from what Bee Flow already records for it:

| Kind | Counted as |
|------|------------|
| Agents | conversations |
| Automations | runs |
| Forms | submissions |
| Apps | action runs |
| Skills | activations |
| Webpages | views of public share links only |
| Meeting notes | recordings |
| Solutions | project activities |
| Cowork | Cowork runs |
| Data tables, knowledge bases, documents, playbooks | **no signal** |

**"No signal" is deliberate.** Bee Flow does not record who opens a table, a knowledge
base, a document or a playbook, and the Adoption report does not start doing so (see
[What the report does not track](#what-the-report-does-not-track)). For these kinds
the row shows the inventory and the AI cost, and says "no signal" where usage would be.
Internal webpage visits are not counted for the same reason; only the view counter of a
public share link is.

Open a row to see the items of that kind: the owner, who can see it (organisation,
group, private or public), when it was created and last used, how many people used it,
how often, and its AI cost. The panel also lists the items that are published or
shared but went unused in the period, and the **top users** of the kind. The top users
are **always pseudonymous**, also after you reveal names in the people table.

Owners are shown by name. Who built something is organisational information; who uses
it, and how much, is behaviour, and that part stays pseudonymous.

### Groups

One row per group (from Entra ID, Nextcloud or Bee Flow itself): members, AI-active
members, adoption rate, makers, cost and the area where most of the group's AI goes.
Groups with **fewer than 5 members** are merged into one row, **Other groups**, so that
a figure cannot point at one or two people. When the merged row itself holds fewer than 5 people, it shows only how many people it covers; its figures stay withheld until it does.

Use the group filter above the report to narrow every section to the members of one
group.

### People

One row per member: status (AI-active, signed in only, dormant, never signed in), the
last sign-in, the AI cost, the areas used, what the person built, and the date of
their first AI use. Search, sort and a **Not yet active** filter help you find the
people who might need help getting started.

**Names are hidden by default.** Each person shows as a stable pseudonym such as
`Member · K7Q2`: the same person gets the same pseudonym every time in your
organisation, and a different one in another organisation. Avatars are not shown.

**Reveal names** shows names and avatars for the rest of your session. Before any name
is shown, Bee Flow writes an entry to the access audit log with the action
`usage_adoption_people_revealed`: who revealed, when, for which organisation, and the
period, group filter and page size of the view. The entry holds no names and no
figures. If the entry cannot be written, no names are shown and the report says the
audit log is unavailable. Review these entries under **Compliance → ISO → Sign-in &
access log** (see [Audit & compliance](audit-and-compliance.md)). **Hide names** returns
to pseudonyms and discards the names in your browser, so revealing them again writes a
new entry.

## How the numbers are made

- **One row per AI call.** Every model call in Bee Flow writes one row to the AI usage
  log, with the model, the tokens, the cost and the source. The report reads that log
  for your organisation only. Tool-call rows are left out, so a call is not counted
  twice.
- **A call counts for the person who caused it.** For an app action, an automation run
  or a question to a webpage, the call is billed to the owner of the app, automation or
  page, but it is counted for the person who pressed the button, started or submitted
  the run, or asked the page (the `actor_user_id` column, see
  [Telemetry](../reference/telemetry.md)). A run therefore counts for the person who
  started it.
- **Guests and visitors** (public links, embedded agents, guest accounts) are not
  members. Their calls count toward an area's cost but never toward a person.
- **Test chats and skill tests** are left out: a chat in an agent's test tab, or a
  skill test, shows that a maker checked their work, not that someone used it.
- **Cost on Bee Flow cloud** is shown with your plan's markup, the same basis as the
  Overview tab, and without call or token counts. A self-hosted installation shows the
  raw cost and the call counts.
- Figures are cached for up to a minute.

## Privacy

- **Aggregate first.** The headline, areas, Studio kinds and groups are organisation or
  group totals. Small groups are merged.
- **Pseudonymous by default.** Per-person rows show pseudonyms until someone with access
  reveals names, and every reveal is recorded as `usage_adoption_people_revealed` in the
  access audit log. The top users of a Studio kind are never revealed.
- **The Quality tab works the same way.** The person behind a rating (Feedback) or an
  early stop (Terminations) is the same pseudonym as in the people table, so a label can
  be matched across tabs. Its **Reveal names** is recorded as
  `usage_quality_people_revealed`, one row per list shown; when the audit log cannot
  record it, no names are shown.
- **No special categories per person.** The report holds no Privacy Shield categories at
  all. Health data (GDPR Art. 9) never appears next to a person anywhere in Usage &
  Monitoring; it appears only as organisation-wide totals.
- **Your obligations.** A per-person view of AI use is suitable for monitoring staff
  (in the Netherlands: WOR art. 27(1)(l)). Before you use the people table, cover it in
  a DPIA, get works-council consent where it applies, and name it in your staff notice.
  The compliance check **Per-person monitoring views, including the Adoption report,
  are assessed** (GDPR Art. 35) reminds you of this and keeps warning in this release,
  because Bee Flow does not yet hold that opt-in gate for you. The same preconditions,
  and how Bee Flow handles them for chat signals, are on the
  [Chat signals](chat-signals.md#preconditions) page.

## Export

**Export CSV** downloads the report's tables for the selected period and group: areas,
Studio kinds, groups and people. The people table contains names only when you have
revealed them; otherwise it contains the pseudonyms. The file is built in your browser
from what the report shows. Once downloaded, it is your organisation's responsibility:
store it as you would the report itself.

## What the report does not track

The Adoption report adds **no navigation or view tracking**. Bee Flow does not record
which screens people open, which apps, webpages, documents or meeting notes they view,
or how long they stay (see
[Product measurement](../reference/telemetry.md#product-measurement-what-we-may-and-may-not-collect)).
Everything in the report comes from records that already exist: the AI usage log, the
Studio items themselves, and the runs, submissions, conversations and activations they
already keep.

## What is not metered yet

- **Usage of data tables, knowledge bases, documents and playbooks**: "no signal", by
  design (see above).
- **Internal webpage visits**: only public share link views are counted.
- **AI calls that write no usage row.** A few smaller AI features may not yet write a
  row to the AI usage log. Their cost is missing from every total, the Overview
  included, until they do.
- **Calls made before this release** for an app, automation or webpage carry no
  `actor_user_id`, so they count for the owner rather than the person who used it.

## Where to next

- [Chat signals](chat-signals.md): the opt-in model, with DPIA, works-council and notice
  preconditions, that Bee Flow uses for counting Privacy Shield outcomes in chat.
- [Audit & compliance](audit-and-compliance.md): the access audit log and the
  compliance checks.
- [Telemetry](../reference/telemetry.md): what the AI usage log may and may not record.
- [Licence tiers](../licensing/tiers.md): which tier includes the Adoption report.
