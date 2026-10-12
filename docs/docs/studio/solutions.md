---
title: Solutions
---

# Solutions

A Solution is the **builder's view of a project**: the automations, apps and webpages that
work together, how they are wired, and the Blueprint you package them into. It is not a
new kind of object — the same project's *collaboration* side (chats, members, memory)
stays on `/app/projects`, which is where people who **use** a Solution live. Studio is
for whoever **builds** one, which is why the section sits next to Automations, Apps and
Webpages.

URL: `/app/studio/solutions` · one Solution opens at `/app/studio/solutions/:id`.

**Tier:** Enterprise. The section is gated on `projects`, the same entitlement the
server puts in front of `/api/projects`. On Community the row stays visible in the
Studio rail, **disabled with an upgrade hint** — the row is how an organisation learns
Solutions exist. Packaging on top of that is a *second* Enterprise key,
`blueprint_packaging`, enforced on each export/publish route (not router-level:
those routes share a mount with unrelated project routes).

## The overview

Three tabs, plus two create paths.

| Tab | What it lists |
|---|---|
| **From us** | Solutions built here |
| **Installed** | Solutions that came from a Blueprint (badged with a count, but only once the read succeeded) |
| **Catalogue** | Blueprints available to install |

- **New Solution** asks for a name.
- **Install a Blueprint** reads one from a file — the Catalogue tab covers the gallery
  half.

The overview is fed by one request that answers `null` for anything it could not read,
so the screen can tell *"none"* from *"could not find out"*. **A failed read is never
drawn as an empty workspace**: an empty state is only reachable after the read
succeeded, and a partial read says so.

## One Solution

Six tabs:

| Tab | What it holds |
|---|---|
| **Content** | Everything the Solution bundles, grouped, with dependency pills |
| **Check** | The completeness checks, badged with how many findings and whether any of them block |
| **Versions** | The release history — one immutable row per publication |
| **Installs** | Where this Solution's Blueprint has been installed |
| **Flow** | The wiring, and what this Solution depends on outside itself |
| **Overview** | Counts, live runs and recent activity |

The header carries the Solution's name (renameable by its owner or an editor), an audience capsule,
a Blueprint-version chip (`Blueprint v2`), and three actions: **Publish** (primary), **Export**, and
**Open in Projects**.

### The publish gate

**Publish** is shut unless the checks came back and explicitly said nothing blocks.
"Not loaded yet", a server error and a network failure all leave the button disabled
with *"Not while there are things to fix — or while the checks could not be run."* —
an unknown result narrows, it never opens the gate.

Publishing is also owner-only: exporting reads every entity in the Solution, including
other members' apps and automations, so the route is owner-only on top of the licence gate.

### The version chip

The chip says `Blueprint v2`, not "Solution v2", because a Blueprint version is what
the number counts. Versions are numbered per publisher, so when two owners have both exported the
same Solution there is no single answer and **no chip is shown at all**. Nothing is
shown before the first Blueprint either — an invented "v1.0" would be a release nobody
made.

### Updates

When a newer version of the Blueprint a Solution came from exists, a banner appears
above every tab (it is about the Solution, not about whichever tab happens to be open).
Only the owner gets the button to apply it — the same role the route requires. The
"a new version exists" event is a **poke, never the answer**: it carries no version
number and no Blueprint id, and the screen re-reads its own scoped data before it
claims anything.

Install counts and update notices cover **this installation only**. Blueprints are
scoped to the organisation and there is no cross-instance channel.

## Stages and deployments

A Solution can run in three places: **Dev**, where you build it; **UAT**, where you try it
with real connections; and **Production** (PRD), where the work runs for real. Dev is the
Solution you already have. UAT and Production are **copies of it that live in the same
organisation** (two more projects, named *Solution (UAT)* and *Solution (Production)*),
and the only way something gets into them is a **deployment** of a **release**.

**Tier:** Enterprise. The stage routes need `blueprint_packaging` on top of `projects`;
turning on the Production approval gate also needs `approvals`. What keeps a stage that
already runs operable is deliberately *not* licensed: see [When the licence lapses](#when-the-licence-lapses).

### Releases and deployments

- A **release** is an immutable, numbered snapshot of Dev's working copies, cut by the
  Solution owner (*Release 7*). Cutting runs the same checks as publishing and a few more
  that only matter for stages; anything that blocks is listed and nothing is cut. A release
  is **not** a Blueprint version: it never leaves the instance, and the release download and
  the Blueprint installer refuse it.
- A **deployment** brings one stage to one release. You always see the **plan** first:
  which parts will be created, replaced, revived or retired; what changes in each table
  (columns that are added, renamed or *retired*, never dropped); reference rows and
  knowledge that are copied; slots that still need a binding and variables that still need a
  value; the go-live checks of every automation that will run; what drifted in the stage since
  the last deploy; and the acknowledgements you have to give. The plan has a hash. If
  anything changes between the plan and the deploy, you get *the plan changed* and review
  it again instead of deploying something you did not read.
- **One at a time per stage.** A deployment prepares everything aside, then switches every
  live pointer in **one database transaction**, so a stage never runs a mix of two releases.
  A failure before the switch is compensated and the stage stays as it was. The side
  effects after the switch (webhook and form addresses, trigger subscriptions, the page
  files, search caches) are repeated until they succeed; if one cannot, the deployment ends
  as *succeeded with warnings* and **Retry** runs them again.
- **Production only takes a release that succeeded in UAT.** A **rollback** goes back to a
  release that already succeeded in Production. A **redeploy** applies the release the stage
  already runs again, which is how a changed binding or steering value goes live.
- **Release and deploy** cuts a release, plans it and deploys it to UAT in one step when
  nothing blocks; otherwise it shows the plan.
- Deployments are repeat-safe: the same request key answers the same deployment.

### Locking

Everything inside a stage is **managed**: it changes in Dev and arrives by deployment. The
editor shows a *Managed by a Solution stage* banner with links to open the part in Dev and
to the stage settings, and a write answers `409 managed_part`. A stage deliberately keeps a
short list of things that need no deploy: switching an automation, app, page or agent on or
off, who it reaches (audience and groups), pausing the stage, non-steering variable values
and the stage's own settings. A part that was never deployed has nothing to switch on
(`managed_part_not_deployed`). Test, dry and partial runs of a managed automation execute the
**live** copy.

Tables are the exception to "everything is copied": rows of a stage table are the stage's
own data and are never carried. The one exception is a **reference table** (a table marked
as holding reference data, such as a tax-rate list), whose rows travel with the release
and are written by the deployment only.

### Who may do what

| Role | May |
|---|---|
| **Solution owner** | Create and remove stages, cut releases, plan and deploy, set bindings and **steering** variables, change the approval gate. The owner is also each stage's *run-as* user |
| **Stage editor** | Switch parts and the stage on and off, change audience, enter **non-steering** variable values, pause and resume |
| **Stage viewer** | Look at the stage, its history and its runs |
| **Dev editor / viewer** | Work in Dev. A Dev role grants **nothing** in a stage, and a stage role grants nothing in Dev |
| **Organisation admin** | Pause, resume, detach or remove any stage of the organisation, so that an offboarding never deadlocks a stage. Audited, and the Solution owner is notified |

A person who holds a role in a stage but not in Dev gets their own entry point on the
Solutions overview (*Stages you operate*), and sees only their stage's history.

UAT and Production **run with the Solution owner's connected accounts**, because a part
owned by someone else cannot be run by automations of the owner. That is why only the owner
deploys, and why a stage owner's account cannot be deleted or moved out of the organisation
while a stage runs as them: an organisation admin detaches or removes the stages first.

### Bindings and variables

A release leaves *holes* that every stage fills for itself, because a connection or an
approver in UAT is not the one in Production:

- **Connections** for request steps, chosen from connections the run-as user may use, with
  the **allowed hosts** they may call (required in Production). The host list is written
  into the step, and a request to any other host is refused at run time.
- **Approver seats** of approval steps and app approval actions, and notification
  recipients.
- **Tables, knowledge bases and templates** that are not part of the Solution, a page's
  **address** (UAT defaults to `<slug>-uat`; addresses are unique across the instance) and
  the source of a mirrored table.

A binding can only name something that is not part of another stage or of Dev. Changing a
binding after a deploy is a **redeploy**, because the value is written into a locked
definition; in Production with the gate on it needs approval, because bindings decide whose
credentials are used and who approves.

**Variables** are named values a Solution declares in Dev (text, number, yes/no, URL, email
or a choice) and every stage fills in. Automations read them as `vars.<name>`; a declared name
wins over an automation's own value with the same name, so the release cut refuses that
shadowing. A name that looks like a secret is refused: *store it in a connection*. A
variable is **steering** when it is a URL or email, when it is used in a place that decides
where data or mail goes (a request URL or header, a recipient, a callback address), or when
the author marks it. A steering value is **owner only**, is kept as a draft and goes live
only through a redeploy, so a stage editor cannot point a live run at another host.

### Production approval

Production can require a **second person's approval**. With the gate on, every deployment
to Production waits as an approval request (type *deployment*) in the approvers' inbox: a
deploy, a redeploy, a removal, and a rollback if the stage says rollbacks need approval.
See [Approvals](approvals.md#deployment-requests). The approval chain must have an
approver who is not the owner (otherwise the gate could never open), and the requester can
never decide their own request. When the decision arrives the plan is computed again; if it
no longer matches what was approved, the deployment fails with *the plan changed after it
was approved* and nothing happens.

The gate protects itself. **Turning it on** is a plain setting. **Turning it off, or changing
its approvers or the rollback switch while it is on, is itself a deployment** of kind
*settings* that passes the same approval, so the owner cannot seat themselves as approver or
switch the gate off alone.

### Privacy

- Promotion carries **definitions only**. Runs, outputs, approval records, app rows, page
  data, table rows (except reference rows), builder sessions, knowledge sources, grants and
  members are never carried, and test outputs pinned in an automation are stripped.
- **Reference rows may not contain personal data at all.** The release is refused rather
  than asking for an acknowledgement. Reference rows and the document listing of a
  knowledge base are stored next to the release, not in it, are removed with it, and never
  leave the instance.
- **Knowledge content** is opt-in per knowledge base. Documents are copied from the stage
  below (Dev to UAT, UAT to Production) without being embedded again. A document flagged
  for personal data, or not yet scanned, needs a **per-document acknowledgement** that
  records who gave it and when; it is repeated in the Production plan and on the approval.
- A Production table with a personal column and **no lawful basis** adds an acknowledgement
  to the Production plan. Stage tables keep their lawful basis and retention, so they show
  up in the Art. 30 register.
- Deployment rows and steps hold ids, versions, counts and hashes. Never content.
- Promotion is one way. There is no "pull Production into Dev".
- **UAT sends real mail** through the run-as user's connections; the settings page says so.

### Recovery

An organisation admin can **pause** (every automation of the stage off, remembering which were
on), **resume** (exactly that set back on), **detach** or **remove** a stage. *Detach* is
the escape hatch: the stage stops being a stage, its parts become ordinary unmanaged parts
and it is an ordinary Solution again (its deployment history stays). *Remove* is a
deployment: it switches the automations off, deletes the parts and then the stage itself. The
tables and knowledge bases **stay with their data** (owned by the run-as user, no longer part
of any stage) unless you choose **delete data** and acknowledge it, which deletes them too.
Parts that are already deleted stay deleted if a removal stops half way; removing the stage
again finishes the job.

### When the licence lapses

A lapse must never strand production. These stay available without any licence, on
`/api/solution-stages`: reading a stage, switching parts on and off, pause and resume,
non-steering variable values and detach. What a lapse refuses is new work: releases, plans,
deployments, bindings, steering values, audience changes, the approval gate and removing
a stage with its data. Approvals that are already pending can still be decided.

### Limits (v1)

- **Same organisation only.** UAT and Production are never in another organisation.
- **No gallery publish of a pipeline release.** To share a Solution outside the instance
  you still export a Blueprint from Dev.
- **No extra files** beside the page and its assets: a release carries what the parts are,
  not loose project files.
- **App data models are additive.** A deployment can add tables and columns to an app's own
  data; a change that would drop or retype something is blocked in the plan.
- **Retired columns are kept.** A column the release no longer has stops being used, is never
  dropped by a deployment and can come back; purging comes later.
- **Old gallery installs** (a Solution installed from a Blueprint before stages existed) keep
  working as before and have no stages until you create them.
- Only the **Solution owner deploys**. Delegating the run-as account to someone else comes
  later.

## Where to next

- [Studio → Apps](apps.md), [Studio → Webpages](webpages.md) — two of the things a
  Solution bundles.
- [Studio → Approvals](approvals.md) — the Production gate arrives there as a request.
- [Features → Automations](../features/automations.md) — the third.
