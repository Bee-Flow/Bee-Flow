# Fact sheet — Approvals & Runs (Studio), audience: builder

Status: **the area exists and is fully built** (not a stub). Two separate Studio sections,
two separate APIs, two separate permission models. Verified against the code on
branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.

Key source files:

- Frontend Approvals: `agent-hub/src/components/admin/Studio/Approvals/` —
  `ApprovalsStudio.jsx`, `ApprovalDetail.jsx`, `ApprovalDecisionControls.jsx`,
  `approvalDisplay.js`, `useApprovals.js`
- Frontend Runs: `agent-hub/src/components/admin/Studio/Runs/` — `RunsStudio.jsx`,
  `NowRunningStrip.jsx`, `nowRunning.js`
- Frontend Executions (shared engine of the runs list): `agent-hub/src/components/admin/Studio/Executions/` —
  `ExecutionsPanel.jsx`, `ExecutionsTable.jsx`, `ExecutionsFilterBar.jsx`, `ExecutionView.jsx`,
  `ExecutionBar.jsx`, `RunStepTimeline.jsx`, `useExecutions.js`, `useRunStream.js`,
  `runLanguage.js`, `runScope.js`
- API client: `agent-hub/src/hooks/useAutomationApi.js`
- Backend routes: `server/routes/automation/approvals.js`, `server/routes/automation/runs.js`,
  `server/routes/automation/webhooksAndRunOps.js`, `server/routes/studio/counts.js`
- Backend logic: `server/automation/approvalService.js`, `server/automation/approvalStages.js`,
  `server/automation/approvalNotify.js`, `server/automation/approvalDelivery.js`,
  `server/core/automationRunner/approvalLifecycle.js`,
  `server/core/automationRunner/scheduler/reapers.js`, `server/core/automationRunner/shared.js`
- Stores: `server/stores/automationStore/approvals.js`, `server/stores/automationStore/runs.js`,
  `server/stores/automationStore/rowMappers.js`
- Gates: `server/license/tiers.js`, `server/license/featureMap.js`, `server/modules/catalog.js`,
  `server/auth/permissions.js`, `server/config/orgRoles.json`
- Builder-side authoring of the approval step: `agent-hub/src/components/automation/Builder/flow/settings/approvalEditors.jsx`,
  `.../approvalStages.jsx`, `agent-hub/src/components/automation/Builder/approvals/ApprovalActionBar.jsx`

---

## 1. What the feature is for

A routine (automation) can **pause and ask a person**. The step type is `approval`
("Ask someone to approve" in the builder palette). When the run reaches it, the run row
goes to status `awaiting_approval`, a durable **approval row** is written, the people who
must decide get a bell (and optionally an e-mail / Nextcloud Talk card), and the run sits
there until somebody approves or rejects — or the deadline passes.

**Approvals** (Studio → Approvals) is where a *person* decides. It is deliberately outside
the flow builder: the decider is usually not the builder and must never need the canvas to
say yes. It is also the durable record of every decision ever made (who asked, who decided,
when, why).

**Runs & log** (Studio → Runs & log) is where a *builder* watches: every time a routine
fired, what started it, what it did, what broke, and step-by-step replay on a read-only
canvas. It is the only Studio section that is about the past — you cannot create a run.

The two connect: a run waiting on a decision appears in Runs with the status
"Waiting for approval", and the approval detail carries an **"Open the run"** link (owner only).

---

## 2. Screens, with their real labels

### 2.1 Studio → Approvals (`/app/studio/approvals`)

Reached from the **left sidebar row "Approvals"** (its own top-level row — deliberately NOT
in the Studio flyout: `hiddenFromNav: true` in `studioApps.jsx`), from the notification bell,
and from e-mail deep links. The sidebar row carries a **numeric badge = pending approvals
"waiting on me"**, polled every 30 s from `/approvals/facets?scope=mine`, and paused while
the tab is hidden.

Registry entry (`studioApps.jsx`): `labelFallback: 'Approvals'`,
`descFallback: 'Requests waiting on a person, and every past decision'`, icon `ShieldCheck`.

List screen:

| Element | Real string |
|---|---|
| Page title | `Approvals` |
| Scope toggle (org admins only) | `My approvals` / `Organisation` |
| Refresh icon button | aria-label `Refresh` |
| Search box | placeholder `Search by question or routine…` (debounced 300 ms) |
| Status tabs (with counts appended as ` · N`) | `Waiting`, `Approved`, `Declined`, `Expired`, `Closed` |
| Empty state on the Waiting tab | `Nothing is waiting for a decision.` |
| Empty state on other tabs | `Nothing here yet.` |
| Loading | `Loading…` |
| Pagination | `Show more` |
| Row marker when it is yours to decide | `You` (uppercase, amber) |
| Row meta line | `<routine title> · <when> · decide before <deadline> · by <decider>` |
| Mobile-only escape hatch | `← Bee Flow` |

Row status words (from `approvalDisplay.js` `approvalStatusChip`), drawn as a coloured dot
plus the word: `Waiting` (amber), `Approved` (emerald), `Declined` (red), `Expired`
(orange), `Closed` (grey).

### 2.2 Approval detail (`/app/studio/approvals/<id>`)

| Element | Real string |
|---|---|
| Back link | `All approvals` |
| Eyebrow | the routine's title, or `Automation` |
| Heading | the rendered question (`prompt`), or `Approval requested` |
| Who-decides line | `Owner decides` / `Assigned` / `Assigned to a group` / `Panel of {n}` / `Chain of {n} stages` |
| Deadline line (pending) | `Decide before <date>` or `No deadline` |
| Deadline line (decided) | `Requested <date>` |
| Run link (owner only) | `Open the run` |
| Attachments section | `Documents` (each row: label/filename + size, downloads) |
| Panel section | `Approval panel · <rule>` where rule is `First to respond decides` / `At least {n} of {m} must approve` / `Everyone must approve` |
| Panel progress | `{n}/{m} approved`, or `Panel approved — final sign-off pending` |
| Final-sign-off note | `A final sign-off follows once the panel approves.`, badge `final` |
| Stage section | `Approval chain`, `Stage {n} of {m}` |
| Stage states | `Decided` / `Waiting on this stage` / `Skipped — its condition was not met, so the chain went straight past it` / `Never reached — the chain stopped before this stage` / `Not started yet` |
| Stage tally | `{n} of {m} approved`, `declined here` |
| Decision box (see 2.3) | — |
| When you may not decide | `Waiting for the assigned approver to decide.` / `Waiting for the assigned group to decide.` / `Waiting for the other approvers to vote.` / `Waiting for the final sign-off.` / `Waiting for {name} — stage {n} of {m}.` |
| Withdraw (owner / org admin, pending only) | `Withdraw this request` — confirm dialog: `Withdraw this approval request? Whoever was asked will be told, and a paused run is closed.` |
| History section | `History` — one line per audit event |

History (audit) lines: `Approval requested` / `Approval recorded` (backfill), `Approved — "reason"`,
`Rejected — "reason"`, `Stage passed`, `Expired — nobody decided before the deadline`,
`Escalated — the fallback approver can now decide too`, `App updated`, `App update failed`,
`Withdrawn — "reason"`, `Closed — the run was no longer waiting`.

Decided summary: verb (`Approved` / `Rejected` / `Expired` / `Closed`) + `by <name>` +
timestamp, the quoted reason, and the answers as `key: value`.

### 2.3 The decision controls (`ApprovalDecisionControls.jsx`)

The **same component** is mounted in three places — the Approvals detail, the builder's
inline `ApprovalActionBar` on a paused node, and the full-screen run view — so the rules
cannot fork.

- Optional extra question fields (from the snapshot): types `text`, `textarea`, `number`,
  `date`, `email`, `select` (`— choose —` as the blank option), `checkbox`. `download` and
  `notebook` field types are filtered out. Required fields carry a red `*`.
- Reason box: placeholder `Why? Required when you reject.`, aria-label `Reason for your decision`.
- Buttons: **`Approve`** (green) and **`Reject`** (red outline). Reject stays disabled until
  a reason is typed; the hint beside it reads `Add a reason to reject.`
- Client-side required-field check message: `<field> is required.`

Toasts after deciding: `Approved — the run is continuing.`, `Rejected — the run has stopped.`,
`Your vote is in — waiting for the other approvers.`, `The panel approved — waiting for the
final sign-off.`, `This stage is done — it has moved on to {name} (stage {n} of {m}).`,
`Request withdrawn.` Failures: `The deadline for this approval has passed and the run was
closed.` (410), `Someone else already decided this approval.` (409),
`This approval was already decided.` (409).

### 2.4 Studio → Runs & log (`/app/studio/runs`)

Registry entry: `labelFallback: 'Runs & log'`, `descFallback: 'Every time a routine fired,
and what happened'`, icon `History`, category `bundle` (last row on the rail). The rail
count next to it is **runs in the last 24 hours, my scope only**.

Header:

| Element | Real string |
|---|---|
| Title | `Runs & log` |
| Intro | `Every time a routine fired: what started it, what it did, and what went wrong. Opening a run shows it step by step.` |
| Scope switch (group aria-label `Whose runs`) | `My runs` / `Organisation` |
| Org-scope caveat | `The organisation's runs do not update by themselves — refresh to see new ones. Only the person who started a run can open it.` |
| Scope refusal banner | the server's own sentence + a `Show my runs` link |

**"Now running" strip** (`NowRunningStrip.jsx`), one line per routine, fixed 24-hour window
that does NOT follow the table's range chip:

| Element | Real string |
|---|---|
| Heading | `Now running` + right-aligned `last 24 hours` |
| Line phrases | `failed — {reason}` / `failed` / `{count} waiting for a person` / `{count} running now` / `done · {count} runs` |
| Nameless routine | `A routine without a name` |
| Empty | `Nothing has run in the last 24 hours.` |
| Unreadable (read failed) | `Could not read what is running — this is not “nothing is running”.` |
| Server without the rollup | `This server did not report per-routine activity, so this strip has nothing to show. The runs below are unaffected.` |
| Overflow | `and {count} more routines` |

Strip limit: **6 lines** (`NOW_RUNNING_LIMIT`), sorted by urgency `error → waiting → running → done`.
Error lines show the error **class**, never the free-text message (that can quote a customer).

### 2.5 The runs table and its filter bar

Filter bar (`ExecutionsFilterBar.jsx`):

- Status chips with counts: `All`, `Success`, `Failures`, `Running`, `Awaiting`, `Stopped`
- Jump box: placeholder `Paste a run link or id`
- Trigger select: `Any trigger` + the trigger kinds present
- Mode select: `Live runs` (default), `Tests only`, `Live runs and tests` — hidden on the Step surface
- Automation picker (global view only): `All automations`
- Date range segmented control: `24h` (default), `7d`, `30d`, `All`
- Refresh button with a liveness dot: `Live — new runs appear on their own` / `Checking every 5 seconds` / `Paused while this tab is in the background`
- Standing line: `Showing: <parts>` + `Show everything`, and `Counts cover the last 30 days.` when the range is All

Table header — **exactly 7 columns**: `Outcome`, `What ran`, `What happened`, `Started`,
`Took`, `Started by`, (actions).

Outcome words (`statusTokens.ts`): `Finished`, `Failed`, `Running`, `Waiting to start`,
`Paused`, `Stopped`, `Waiting for approval`, `Waiting for a form`.

"What happened" sentences (`runLanguage.js`):
`Failed — <reason>`, `Rejected — <why>`, `Rejected — someone turned this down`,
`Finished`, `Finished — <summary>`, `Finished — N problems handled automatically`,
`Still running…`, `Waiting for someone to approve it`, `Waiting for a form to be filled in`,
`Stopped before it finished`.

"Started by" labels: `On a schedule`, `Started by hand`, `Test run`,
`Someone filled in the form`, `An app event`, `Asked from chat`,
`A webhook — another system called this`.

Row badges: `Step` for reusable-Step runs, a dry-run badge for tests.

Row ⋯ menu (only on rows you own): `Run it again` (error only), `Stop it` (running/queued),
`Approve` (awaiting), `Reject` (run-level confirm only), `Review & decide` (step-level
approval), `Open this run`, `Copy a link to this run`, `Open in editor`, `Copy run id`.
Action failure inline: `Couldn't do that: <message>`.

Empty states: `No runs in this time range.` + `Older runs are still here — widen the time
range to see them.` + `Show all time`; `No runs yet. Run the routine to see what happened
here, step by step.`; for a Step: `No runs yet. Test this Step or call it from an automation
to see its runs.` Load failure: `We couldn't load the runs.` + `Try again`.

### 2.6 One run, full screen (`?run=<id>&step=<stepId>` on `/app/studio/runs`)

Top bar (`ExecutionBar.jsx`): back button `Runs`, the run's name
(`Run of 12 Aug 2026, 14:03 · test` — never a hex id), status badge, `took <duration>`,
relative start, trigger, `· via <entry point>`, a version chip `v<N>`
(title `This run used saved version N.`), a lineage chip
`This was a retry of an earlier run`, `N problems handled automatically`, the expiry chip,
and the error class in parentheses.

Buttons: `Run it again` (title `Uses the routine as it is now`), `Stop it`, `Approve` /
`Reject` for a run-level confirm, `Copy link`, `Open in editor`.
Action failure: `<action> failed: <message>`.

Left rail: the step timeline, header `Steps`. Each row: step label, status word,
`· took <duration>`, `· attempt N of N`, its error. A marker line after the failing step:
`This is where it stopped. Nothing ran after this point.` Empty: `No steps recorded for this run.`

Right: the read-only canvas replay (`RunExecutionView`), `Loading the run…` /
`Definition unavailable for this run.`

If the run is `awaiting_approval`, a panel appears between the bar and the canvas with the
question and the full decision controls (heading `Waiting for your approval`, hint
`Approve and the run continues from the next step. Reject and the run stops here.`).

Load failure: `We couldn't load this run.` + `Try again` + `Back to Runs`.

---

## 3. Concepts a learner must understand

- **Run** — one execution of one routine. Row in `automation_runs`. Has a status, a start,
  a duration, a trigger kind, a mode (live or test) and the version of the routine that ran.
- **Journey / leg** — a routine that pauses (approval or form) resumes in a **child run**.
  The list shows one row per journey; the status shown is the *newest leg's*. `journeyRunId`
  is the leg that Stop/Approve must actually act on. `rootRunId` groups the legs.
- **Retry vs continuation** — both carry `parentRunId`. A real retry starts a new journey
  (`rootRunId === id`) and is the only one labelled "This was a retry of an earlier run".
- **Dry run / test run** — `mode: 'dry_run'`. A reusable Step's runs are *all* dry runs,
  which is why the mode filter is hidden there.
- **Trigger kind vs entry point** — the kind is how it fired (schedule, form, webhook…);
  the entry point (`rootStepId` → `rootTriggerLabel`) is *which* trigger node a
  multi-trigger routine came in through.
- **Approval** — the durable question. Row in `automation_approvals`. Statuses:
  `pending`, `approved`, `rejected`, `expired`, `cancelled`.
- **Snapshot** — everything the approver sees (`prompt`, `detailsMd`, `fields`,
  `attachments`) is frozen at pause time. The detail never re-derives from the live run:
  you judge what the run showed then, and the record still means that years later.
- **Assignee** — one person or one group. Empty = the owner decides.
- **Panel** — up to **10 seats**, each a person or a group (a group seat is filled by its
  first voting member). Resolved by a **decision rule**: `Everyone must approve` (`all`,
  the default — one reject declines immediately), `First to respond decides` (`first`),
  `At least N approvals` (`quorum`).
- **Final sign-off** — an optional second stage after the panel; only then does the run continue.
- **Stages (approval chain)** — 1..5 ordered stages, each with its own approvers, rule and
  name, and optionally a condition (`when`). A stage whose condition was false is kept on
  the record as `Skipped` but is not counted in "stage n of m". Stages and the legacy
  assignee/panel/final/escalation fields are a **mode switch**, never combined
  (`approval.stages_conflict` validation error).
- **Vote** — on a panel or a stage, a decision is evidence, not a verdict; the approval row
  only flips when the rule resolves. One vote per seat and one per person (two partial-unique
  indexes); a race loses with 409.
- **Escalation** — after `escalateAfterHours`, a fallback person/group *also* gains the right
  to decide. The original approver keeps theirs. The `escalated_at` stamp IS the grant.
- **Reminder** — a nudge at `remindAfterHours`. A clock that would fire after the deadline
  is silently dropped.
- **Withdraw** — the requester's "never mind". Narrower than decide: owner or org admin only.
- **Run scope (`mine` vs `org`)** — *whose* runs. Different question from the surface scope
  (`global` / `automation` / `step`), which is *which* runs.
- **Facets** — cheap server-side counts that drive the status chips, the sidebar badge and
  the "Now running" strip. They are a claim about the whole window, not about the page.
- **awaiting_confirm** — a *run-level* first-run gate (legacy; the column now defaults to
  FALSE). Approve promotes the routine to live; Reject closes just this run and leaves the
  gate on. It is NOT the same thing as an approval step and uses a different endpoint.

---

## 4. End-to-end workflows

### W1 — Decide an approval that is waiting on you

1. The bell (or the sidebar badge on **Approvals**) shows a number. Click **Approvals** in
   the left sidebar, or open the notification, which deep-links to
   `/app/studio/approvals/<id>`.
2. The list opens on the **Waiting** tab. Your rows carry the amber **You** marker.
3. Click the row.
4. Read the question (the heading), the **details** below it, and open anything under
   **Documents**.
5. Answer any extra questions shown above the reason box; required ones carry a `*`.
6. Type a line in **Why? Required when you reject.** — optional for approve, mandatory for reject.
7. Click **Approve** (or **Reject**).
8. A toast confirms: `Approved — the run is continuing.` The row leaves the Waiting tab and
   appears under **Approved**; the **History** section gains a line.

### W2 — Chase an approval you asked for, then withdraw it

1. Studio → **Approvals**, **Waiting** tab.
2. Type part of the question or the routine name in **Search by question or routine…**.
3. Open the row. The line under the heading says who is being asked
   (`Assigned` / `Assigned to a group` / `Panel of 3` / `Chain of 2 stages`) and
   **Decide before <date>**.
4. If you own it, **Open the run** jumps to the paused run.
5. Decide it is moot: click **Withdraw this request** and confirm the dialog.
6. The approval becomes **Closed**, whoever was asked is notified, and the paused run is closed.

### W3 — Find and fix a failed run

1. Studio → **Runs & log**. It always opens on **My runs**.
2. Glance at the **Now running** strip: red lines first, with `failed — <reason class>`.
3. In the table, click the **Failures** chip; widen the range to `7d` if nothing is in `24h`.
4. Click the row. The top bar shows the status, duration, trigger and `v<N>`; a red band
   under it carries the run's error text.
5. In the **Steps** rail, find the red row and the line
   `This is where it stopped. Nothing ran after this point.` Click it — the canvas selects
   the same node and the URL gains `&step=<id>`.
6. Fix the routine: **Open in editor**.
7. Come back and press **Run it again** (title: `Uses the routine as it is now`). The new
   run **opens immediately** — you are not dumped back on the list to hunt for it. Its bar
   shows `This was a retry of an earlier run`.

### W4 — Watch a live run and stop it

1. Studio → **Runs & log**. The refresh button's dot is green: `Live — new runs appear on their own`.
2. A new row appears on its own with a pulsing dot and `Still running…`.
3. Open it. Step data is polled every 1.5 s and streamed over SSE; the canvas tints as steps complete.
4. Click **Stop it**. The run is flagged; the runner honours it at the next "between steps"
   check, so the latency is one step long.
5. The row settles on `Stopped` / `Stopped before it finished`.

### W5 — Add an approval step to a routine (the builder side)

1. Studio → **Automations**, open the routine, add a step of type **Ask someone to approve**.
2. Section **What to approve**:
   - **Question for the approver** — a template field, e.g.
     `Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?`
   - **More information** — markdown, e.g. `**Client:** {{trigger.output.client}}`
   - **Documents to show** — a `{{steps.doc.output.fileId}}` plus an optional shown name
   - **Questions for the approver** — extra fields the decision must carry
3. Section **Deadline**:
   - **Who decides** — `Me (the owner)` or a colleague/group; or **+ More approvers** to
     turn it into a panel (**Approvers**, up to 10 seats), with a **Decision rule** and,
     for quorum, an **Approvals needed** `N of M` picker
   - **Final sign-off** — optional last word
   - **Use approval stages** — switch to a chain of named rounds
   - **Decide within** — `4 hours` / `1 day` / `3 days` / `7 days` (default) / `14 days` /
     `30 days` / `No deadline`
   - **Remind after** — `No reminder` (default) or 1h/4h/1d/2d/3d/7d
   - **Escalate to** — a fallback person/group, with its own delay (defaults to 24h when
     you pick a target)
4. Save, activate, and fire the routine. The run stops at `awaiting_approval`; the approval
   appears in the decider's Approvals inbox and in your Runs list as
   `Waiting for someone to approve it`.

### W6 — Read the whole organisation's log (org admin)

1. Studio → **Runs & log** → click **Organisation**.
2. The strip and the table reload from the org endpoints. A grey caveat appears:
   `The organisation's runs do not update by themselves — refresh to see new ones. Only the
   person who started a run can open it.`
3. Rows that are not yours are **not clickable** and carry no ⋯ menu — every per-run route is
   owner-scoped and would 403.
4. If you lack `manage_automations` (or belong to no organisation), a red banner shows the
   server's sentence plus **Show my runs**. The list is **never** silently narrowed to your own.

---

## 5. Defaults and limits (numbers)

| Thing | Value | Where |
|---|---|---|
| Approval deadline default | **7 days** (`APPROVAL_DEFAULT_TTL_MS`); `AUTOMATION_APPROVAL_TTL_MS=0` disables | `core/automationRunner/shared.js` |
| Approval deadline ceiling | **30 days / 720 h** (`APPROVAL_MAX_TTL_MS`); per-step values are clamped | same |
| Deadline choices in the UI | 4 h, 1 day, 3 days, **7 days (default shown)**, 14 days, 30 days, No deadline | `approvalEditors.jsx` |
| Reminder / escalation choices | 1 h, 4 h, 1 day, 2 days, 3 days, 7 days (opt-in; escalation defaults to 24 h once a target is picked) | same |
| Reminder/escalation clock cap | 720 h, and any clock that would land after the deadline is dropped | `approvalLifecycle.js approvalClocks` |
| Panel seats | **max 10** in the editor | `approvalEditors.jsx` |
| Stages in a chain | 1..5 | `approvalStages.js` |
| Group notification fan-out | **25 members** (`GROUP_NOTIFY_CAP`), stable user-id order | `approvalLifecycle.js` |
| Approvals page size | default **50**, server clamp **1..100** | `stores/automationStore/approvals.js` |
| Approvals list poll | facets every **30 s**; the list refetches only when the pending count moves | `useApprovals.js` |
| Approvals search debounce | **300 ms** | `ApprovalsStudio.jsx` |
| Sidebar badge poll | **30 s**, skipped while the tab is hidden | `Sidebar.jsx` |
| Runs page size | **50** per page, cursor paginated, server clamp 1..100 | `useExecutions.js`, `stores/automationStore/runs.js` |
| Runs range chips | `24h` (default) / `7d` / `30d` / `All` | `useExecutions.js RANGE_HOURS` |
| Facet range clamp | **720 h (30 days)** — the "All" chip labels this honestly | `routes/automation/runs.js` |
| Default runs mode filter | `live` (tests hidden), except on the Step surface | `useExecutions.js` |
| "Now running" strip | fixed **24 h**, max **6** lines | `nowRunning.js` |
| Run step poll while running | every **1.5 s**; step fetches debounced to one per **750 ms** | `ExecutionView.jsx` |
| SSE heartbeat | **25 s**; polling fallback every 5 s | `runs.js`, `ExecutionsFilterBar.jsx` |
| Reaper tick | every **60 s** (expiry, reminders, escalations, orphan cleanup) | `scheduler/ticks.js` |
| Run history retention | **90 days** (`AUTOMATION_RUN_RETENTION_DAYS`, 0 = off); 5 000 rows per batch, 20 batches per hourly pass | `jobs/runRetention.js` |
| Run hard timeout | **5 min** default, per-routine override capped at **60 min** | `core/automationRunner/shared.js` |
| Retry / run synchronous wait | **60 s**, then a `202 accepted, pending` | `webhooksAndRunOps.js` |
| Approval resume wait | **60 s** guard before answering | `approvalService.js` |
| Stuck-run reaper | floor 6 min + 1 min buffer, **5 attempts** then `error` | `shared.js` |

---

## 6. What happens on failure

- **Nobody decides before the deadline** → the reaper flips the approval to `expired`,
  fails the run with `errorClass: ApprovalExpired` (`Approval expired — no decision was made
  before the deadline.`), writes an `expired` audit line, and sends **urgent** bells to the
  owner *and* everyone who was asked. No Talk card is posted (a 👍 that decides nothing
  would only invite someone to try). If someone submits a decision after the deadline, the
  API answers **410** and flips the row in the same request — the list then agrees with the
  refusal.
- **Two people decide at once** → the decision write is conditional on `status='pending'`;
  exactly one wins, the loser gets **409** `This approval was already <status>.` and the run
  is never resumed twice. Same guard on votes (two unique indexes) and on stage advance.
- **The run moved on** (cancelled, deleted, decided before the table existed) → the approval
  is closed as `cancelled` with reason `The run is no longer waiting for this approval.` and
  the caller gets **409**.
- **Reject with no reason** → **400** `A reason is required to reject.` — but *only* from
  the Approvals surface (`source: 'studio'`). The legacy owner-only endpoint
  `POST /runs/:runId/approve-step` (`source: 'builder'`) still accepts reason-less rejects,
  deliberately, so already-loaded browser tabs do not break.
- **Missing required answer** → **400** `Some answers need attention.` with per-field errors;
  the client checks first so you rarely see it.
- **You are not allowed to decide** → **403** `You cannot decide this approval.`
  Not allowed to *see* it → **404** `Approval not found` (uniform with "missing", so an id is
  never an oracle for another org).
- **Approval row fails to write at pause time** → best-effort by contract: the run's own
  `awaiting_*` columns stay authoritative, and the list path lazily **backfills** up to 25
  of your own paused runs on every "my approvals" load.
- **Run crashes / pod dies** → the stuck-run reaper resets the row so the next tick re-claims
  it; after 5 attempts it is left in `error` and the owner is notified
  (`⚠️ Automation failed: <title>`).
- **Facets fail to load** → the "Now running" strip renders `Could not read what is running
  — this is not “nothing is running”.` It never draws an empty strip over a failed read, and
  the previous scope's numbers are cleared rather than left standing.
- **Org scope refused** → a red banner with the server's own sentence plus **Show my runs**.
  It does **not** silently fall back.
- **Run list load fails** → `We couldn't load the runs.` + **Try again**.
- **Retry takes longer than 60 s** → `202 { accepted, pending, message: "Retry is still in
  progress. Check the run history shortly." }`; the view shows `Started — it's running now`.
- **Attachment bytes already reaped** → 404 (a live row with no bytes is a normal race).

---

## 7. Permission and licence gates

### Approvals

- **Licence:** `approvals` is an **Enterprise** capability (`server/license/tiers.js`).
  Enforced **per route**, never as a `router.use`, because `/api/automation` itself is
  Community and Express is first-match.
- **Module:** `approvals` is a platform module (`modules/catalog.js`, `defaultImported: true`,
  capability `approvals`). `requireModule('approvals')` rides the same three routes so an
  un-imported module 404s rather than 403s.
- **Gated (browsing only):** `GET /approvals`, `GET /approvals/facets`, `GET /approvals/directory`.
- **Deliberately UNGATED — "the drain exemption":** `GET /approvals/:id`,
  `POST /approvals/:id/decide`, `POST /approvals/:id/withdraw`,
  `GET /approvals/:id/files/:fileId`, and the legacy `POST /runs/:runId/approve-step`.
  A pending approval holds a paused run; a lapsed licence must never freeze it forever.
- **Frontend mirror:** `ApprovalsStudio` wraps itself in `<RequireTier feature="approvals">`
  **unless** an `initialApprovalId` is present — a deep link to one approval renders ungated.
  `RequireTier` **fails open** on a degraded entitlements resolver; the server stays authoritative.
- **Scope `org`:** requires an **org-admin role** (`org_admin` or the legacy `admin`, or the
  `org_admin` marker permission). Resolved from the users table, not the session. Refusal is
  **403**, never a narrowing.
- **Who may decide** (`approvalService.canDecide`): staged row → only the *current* stage's
  seats; panel row → only seat holders (owner and org admin can watch and withdraw but not
  vote — "an 'everyone must approve' the owner can bypass is theatre"); otherwise owner ∨
  assignee ∨ member of the assigned group ∨ (after the stamp) the escalation target ∨ org admin.
- **Who may view** (`canView`): anyone who may decide, plus `requestedBy`, plus — for panels
  and chains — the owner, the org admin, every seat and the final approver, for the whole life
  of the row.
- **Who may withdraw:** owner or org admin only.

### Runs

- **Licence/module:** the same gate as Automations — `/api/automation` is mounted behind
  `requireModule('automation')` + `requireLicenseFeature('automations')`. The **builder is
  free (Community)**; approvals are the paid collaboration layer on top.
- **Registry gate:** `hasLicenseFeature('automations') && canUse('automations')`,
  `gateCapability: 'automations'`, `lockOn: 'disable'`.
- **Per-run routes are owner-scoped, full stop.** `GET /runs/:id`, `/runs/:id/steps`,
  retry, cancel, approve, approve-step all 403 anyone but `run.userId` — **including an org
  admin**. That is why the org-scope table shows rows it will not open.
- **Org run log:** `GET /_runs/org` and `GET /_runs/org/facets` require the
  **`manage_automations`** permission, resolved via `hasPermission(userId, …)` against the
  user's real groups and roles — never `req.session.user.orgRole`. In
  `server/config/orgRoles.json`, **only the `org_admin` role grants `manage_automations`**
  (not `dpo`, `isms_auditor`, `agent_admin`, `agent_editor`, `member`). Its description:
  *"Org: see every routine's runs in the organisation's run log (Studio → Runs & log). Does
  not grant access to the routines themselves — those stay private to their owner."*
  An account with **no organisation** is refused too (403).
- **Three client-side rules** (`runScope.js`, all unit-tested): unknown scope narrows to
  `mine`; only the global surface may use `org`; a row is openable only when the server
  stamped `mine === true` (not "not false", not "truthy").
- **Live stream:** `/_runs/stream` drops every event whose `userId` is not the subscriber's,
  so streaming is turned **off** in the org scope rather than half-working.
- **Org row shape is an explicit allow-list** (`rowToOrgRunRow`) — no `triggerPayload`, no
  `userId`, no runner plumbing. `summary` and `error` ARE included, by decision, because an
  admin who can see that something broke but not what broke cannot act.

---

## 8. List/read API endpoints for a "did the learner do it?" check

All are under `/api/automation` (mounted behind `requireAuth` +
`requireModule('automation')` + `requireLicenseFeature('automations')`). Auth is the normal
session (cookie or `X-Session-Token` via `authFetch`).

| Method | Path | Auth / gate | JSON returned |
|---|---|---|---|
| GET | `/api/automation/approvals?scope=mine\|org&status=&q=&cursor=&limit=&appId=&automationId=` | session; **licence `approvals` + module**; `scope=org` needs an org-admin role | `{ approvals: [...], nextCursor, scope }`. Each row: `id`, `organizationId`, `projectId`, `projectTitle`, `automationId`, `automationTitle`, `runId`, `rootRunId`, `stepId`, `source` (`run`\|`app`), `requestedBy`, `studioAppId`, `actionId`, `context`, `onDecided`, `remindAt`, `reminderSentAt`, `escalateAt`, `escalatedAt`, `escalateToUserId`, `escalateToGroupId`, **`ownerId`**, `assigneeUserId`, `assigneeGroupId`, `approvers`, `approvalRule`, `quorumCount`, `stages`, `stageParticipants`, `stageEnteredAt`, `stage`, `finalApproverUserId`, `finalApproverGroupId`, `status`, `prompt`, `detailsMd`, `fields`, `attachments`, `answers`, `decidedBy`, `decidedByName`, `decisionReason`, `decidedAt`, `expiresAt`, `createdAt`, `updatedAt` |
| GET | `/api/automation/approvals/facets?scope=mine\|org` | same gate | `{ facets: { status: { pending, approved, rejected, expired, cancelled } }, scope }` — the cheapest "did they decide it?" probe |
| GET | `/api/automation/approvals/:id` | session; **ungated** (drain exemption); 404 unless `canView` | `{ approval: {...as above, incl. ownerId}, audit: [{ id, ts, decision, source, comment, ... }], runLink, votes?, progress?, canDecide, canWithdraw }` |
| GET | `/api/automation/approvals/directory` | session; **licence `approvals`** | `{ members: [{ id, name }], groups: [{ id, name }] }` |
| GET | `/api/automation/approvals/:id/files/:fileId` | session; ungated; must be in this approval's snapshot | the file bytes (`Content-Disposition: attachment`) |
| GET | `/api/automation/_runs/recent?limit=&cursor=&status=&trigger=&mode=&automationId=&kind=&since=&until=` | session; **always the caller's own runs** | `{ runs: [...], nextCursor }`. Each row: `id`, `automationId`, `automationTitle`, `automationKind`, `automationIcon`, `automationTriggerType`, `version`, **`userId`** (owner), `triggerKind`, `triggerPayload`, `rootStepId`, `rootTriggerLabel`, `mode`, `status`, `startedAt`, `finishedAt`, `durationMs`, `error`, `errorClass`, `summary`, `handledErrorCount`, `parentRunId`, `rootRunId`, `journeyRunId`, `submittedByUserId`, `awaitingStepId`, `awaitingStepExpiresAt`, `cancelRequested` |
| GET | `/api/automation/_runs/facets?range=<hours,max 720>&automationId=&kind=&mode=` | session; own runs | `{ facets: { status:{…}, triggerKind:{…}, errorClass:{…}, automations:[{ automationId, title, kind, total, status, lastRunAt, lastErrorAt, lastErrorClass }], automationsTotal }, rangeHours }` |
| GET | `/api/automation/_runs/active` | session; own runs | `{ active: [{ runId, automationId, status, startedAt }] }` |
| GET | `/api/automation/:id/runs?…` | session; **403 unless you own the automation** | `{ runs, nextCursor }` — same row shape as `_runs/recent`, fixed to one routine (or one reusable Step) |
| GET | `/api/automation/runs/:id` | session; **403 unless `run.userId === you`** | `{ run: { …full row, plus journey overrides: journeyRunId, status, finishedAt, summary, error, errorClass, handledErrorCount, awaitingStepId, awaitingStepExpiresAt, durationMs } }` |
| GET | `/api/automation/runs/:id/steps` | session; owner only | `{ steps: [{ runId, stepId, parentStepId, stepType, attempts, status, startedAt, finishedAt, input, output, error, errorClass, branchIndex, piiSummary }], definition, version }` — the whole journey, and the definition **as it was** at run time |
| GET | `/api/automation/_runs/org?…` | session; **`manage_automations`** + must be in an org | `{ runs, nextCursor, scope:'org' }`. Allow-listed row: `id`, `journeyRunId`, `automationId`, `automationTitle`, `automationKind`, `automationIcon`, `automationTriggerType`, `rootStepId`, `rootTriggerLabel`, `triggerKind`, `mode`, `status`, `startedAt`, `finishedAt`, `durationMs`, `summary`, `error`, `errorClass`, `handledErrorCount`, **`mine`** (boolean — ownership, not identity; no `userId`) |
| GET | `/api/automation/_runs/org/facets?range=…` | same permission, re-checked | `{ facets, rangeHours, scope:'org' }` |
| GET | `/api/automation/_runs/stream?automationId=` | session; SSE, events filtered to the caller's own `userId` | `run.started`, `run.finished`, `run.failed`, `step.started`, `step.finished`, `step.heartbeat` |
| GET | `/api/studio/counts` | session; per-key gates, omits keys you may not see | `{ counts: { runs, automations, … }, makers }` — `counts.runs` is **your** runs in the last 24 h |

Write endpoints (for completeness, not for verification):
`POST /approvals/:id/decide` `{decision, reason, answers}`,
`POST /approvals/:id/withdraw` `{reason}`,
`POST /runs/:runId/approve-step` `{decision, reason, answers}` (owner only),
`POST /runs/:runId/cancel`, `POST /:id/runs/:runId/retry`, `POST /runs/:id/approve` `{decision, reason}`.

**Best verification probes:**
- "Did they decide an approval?" → `GET /approvals?scope=mine&status=approved` and look for
  a row whose `decidedBy` is the learner's user id (or `GET /approvals/facets?scope=mine`
  and watch `status.approved` move).
- "Did they run a routine?" → `GET /_runs/recent?limit=5&mode=both` and check `startedAt`
  and `automationId`; ownership is implicit (the route is user-scoped) but `userId` is on the row.
- "Did they retry a failed run?" → `GET /_runs/recent?status=success` and look for a row with
  `parentRunId != null && rootRunId === id`.

---

## 9. How it connects to other features

- **Routines / Automations builder** — the `approval` step type is authored there; the
  builder's own history tab mounts the *same* `ExecutionsPanel` with `scope='automation'`,
  and a paused node in the canvas shows the same decision controls inline (`ApprovalActionBar`).
  `Open in editor` and `Open the run` are the two doors between them.
- **App Studio** — an app action can mint an approval (`source: 'app'`, `studioAppId`,
  `actionId`). Such a row has **no run**: the decision itself is the outcome, delivered via
  the `on_decided` hook and the `approval.decided` trigger event. The app runtime has its own
  `AppApprovalList` component that reuses the same status chips. App-sourced attachments live
  in the app's ledger and are unlocked by the approval snapshot, not by app membership.
- **Solutions / Projects** — an approval is stamped with `projectId`/`projectTitle` at INSERT
  and never cleared, so the record still reads after the project or the routine is deleted.
- **Notifications** — bells via `notificationStore`; the sidebar badge reads the facets.
  Category `heads_up` for a request, `urgent` for an expiry (`⏰ Approval expired: <title>`).
- **Nextcloud Talk / Nextcloud notifications** — `approvalDelivery.js` can post an approval
  **card** into a configured Talk conversation (config key `nc_approvals_talk_room_<orgId>`)
  where a 👍 reaction counts as a vote; reactions are *polled* on Nextcloud 24–30 because
  reaction webhooks only arrive with NC 31 / Talk 21. Every attempt is logged in
  `automation_approval_deliveries`.
- **E-mail** — the approval-pause path addresses the **owner** once; there is no magic-link
  approve flow, so an assignee decides in the app.
- **Forms** — a form pause behaves like an approval pause at the run level: the same journey
  mechanics (`rootRunId`, child legs), the same "one row per journey" rule in the table, the
  status `Waiting for a form`.
- **Datatables / generated documents** — attachments on an approval are documents the run's
  own journey produced; their expiry is pushed out to the approval deadline so a file cannot
  die before the decision window closes.
- **Compliance / audit** — `automation_approval_audit` is the durable "who asked, who decided,
  when, why" trail, kept independently of the run.
- **Studio → Attention list, Studio Home, the rail counts** — all read the same facets.
- **Mobile** — `?view=runs&run=<id>` is contract: the Android client recognises a run link
  and opens its own runs screen.

---

## 10. Common mistakes

1. **Assuming Approvals is free.** Browsing the inbox is Enterprise (`approvals`). On
   Community the section shows the upgrade panel — but a *deep link to one approval* still
   works, on purpose.
2. **Assuming an org admin can open a colleague's run.** They can *see* the row in the
   organisation scope and they can read `summary`/`error`, but every per-run route is
   owner-scoped: the row is not clickable and has no ⋯ menu.
3. **Expecting the organisation log to update live.** It does not. The SSE stream only
   carries your own events, so streaming stands down in the org scope; refresh manually.
4. **Looking for old runs in the default window.** The table opens on **24h** and on
   **Live runs**. A test run or a run from last week is hidden until you widen the range or
   switch the mode select.
5. **Reading the chip counts as "all time".** The server clamps facet counting to 720 h; with
   the `All` chip the bar admits `Counts cover the last 30 days.`
6. **Trying to reject without a reason.** The Reject button is disabled until you type one,
   and the server enforces it from the Approvals surface.
7. **Confusing the owner with the decider.** Whoever decides, the resumed run continues under
   the **owner's** identity, credentials and quotas. The decider is recorded
   (`decidedBy`, the audit event, `steps.<id>.output.by`) — never impersonated.
8. **Expecting the owner to be able to override a panel.** With a panel or a chain the owner
   can watch and withdraw but cannot vote a seat they do not hold.
9. **Mixing stages with the simple fields.** Stages supersede assignee / panel / final
   sign-off / escalation; saving both is a validation error (`approval.stages_conflict`).
   Turning stages on clears the legacy fields and vice versa (and the middle stages have
   nowhere to go on the way back).
10. **Setting a reminder later than the deadline.** It is silently dropped — a reminder about
    an already-expired approval is worse than silence.
11. **Assigning someone outside the organisation.** The assignee/escalation target is
    re-validated against the owner's org at pause time; an outsider falls back to
    *owner-only* with a warning in the log, so nobody is ever asked.
12. **Assuming "no deadline" is safe.** It is a real, supported choice (`0`), but a routine
    that waits forever holds a paused run forever. The default is 7 days for a reason.
13. **Acting on the journey head instead of the live leg.** In the UI this is handled
    (`journeyRunId`); if you script against the API, address the leg that is actually
    `awaiting_approval`.
14. **Thinking "Runs & log" is the audit log.** It is automation runs only — not the
    compliance audit trail, not agent conversations, not app action history, not KB ingestion.
15. **Expecting a run to live forever.** Terminal runs older than **90 days** are deleted
    (in-flight and paused runs are never touched).
16. **Confusing `Approve` on an `awaiting_confirm` run with an approval step.** That is the
    run-level first-run gate: Approve promotes the routine to live, Reject closes only this
    run and leaves the gate on. Different endpoint, no reason, no questions.
17. **Not noticing `Rejected` is not `Failed`.** A rejection carries `errorClass:
    ApprovalRejected` and gets its own warm-toned sentence, so it does not teach people to
    ignore the error column.

---

## 11. Three scenarios for Van Dijk Groep (Dutch SME)

### S1 — Procurement: purchase orders over €5 000

*Situation.* Van Dijk Groep's site managers order materials by e-mail. Finance wants anything
above €5 000 signed off before the order leaves the building.

*Build.* A routine triggered by a form ("Bestelaanvraag"). Step 1 extracts the supplier,
the line items and the total. A **Route** step splits on `total > 5000`. On the expensive
branch, an **Ask someone to approve** step:

- **Question for the approver:** `Bestelling van €{{steps.extract.output.total}} bij {{trigger.output.leverancier}} goedkeuren?`
- **More information:** the line items as a markdown table.
- **Documents to show:** the generated PO PDF from the previous step.
- **Questions for the approver:** a required text field `Kostenplaats` and a required
  `Inkoopordernummer`.
- **Who decides:** the group *Finance*; **Decide within** `3 days`; **Remind after** `1 day`;
  **Escalate to** the CFO after `2 days`.

*Use.* A Finance colleague gets a bell, opens **Approvals**, sees the amber **You** marker,
reads the PDF, fills in `Kostenplaats` and the PO number, and clicks **Approve**. The run
continues and sends the order. Under €5 000 nothing pauses.

*Teachable moment.* Because the answers are part of the decision, the PO number lands in
`steps.<id>.output.answers` and the next step can put it on the order — "approve, and the PO
number is 4471" is one act, not two.

### S2 — HR: new-hire onboarding with a two-round chain

*Situation.* A new field engineer starts. HR wants the line manager to confirm the kit list,
then the director to sign off the budget.

*Build.* A routine triggered by a row in the *Nieuwe medewerkers* datatable. An approval step
switched to **Use approval stages**:

- Stage 1 `Teamleider` — approvers: the *Uitvoerders* group, rule `First to respond decides`.
- Stage 2 `Directie` — approver: the director, rule `Everyone must approve`,
  with a condition so it is skipped when the total kit cost is under €1 500.
- **Decide within** `7 days`, **Remind after** `2 days`.

*Use.* The team lead decides first; the toast reads `This stage is done — it has moved on to
Directie (stage 2 of 2).` The director then sees the same request with the chain drawn out.
On a cheap kit list, stage 2 shows as `Skipped — its condition was not met, so the chain went
straight past it` — the record still says who *would* have been asked.

*Teachable moment.* HR data is personal data. The approval carries the name in its own
snapshot (that is fine, it stays inside Bee Flow), but a routine that also files a ticket in
an external system must send only a reference — see the CLAUDE.md rule.

### S3 — Sales: a weekly quote routine that started failing

*Situation.* Every Monday 07:00 a routine builds the quote pipeline report from the CRM and
mails it to the sales lead. This Monday nobody got it.

*Use.* The account manager opens Studio → **Runs & log**. The **Now running** strip's top
line is red: `Kwartaalrapport verkoop — failed — a connection is no longer signed in`.
She clicks the **Failures** chip, opens the run, and the top bar says
`Failed`, `took 4s`, `On a schedule`, `v12`, `(a connection is no longer signed in)`.
The **Steps** rail stops at *CRM ophalen* with
`This is where it stopped. Nothing ran after this point.`

She clicks **Open in editor**, reconnects the CRM, returns to the run and presses
**Run it again**. The retry opens straight away; its bar carries
`This was a retry of an earlier run`, and a minute later the row reads
`Finished — 14 offertes verwerkt`.

*Teachable moment for the org admin.* Switching to **Organisation** shows that three other
people's routines failed with the same class this morning — one expired connection, not three
bugs. The rows are not clickable, which is the point: he can see *that* they broke, the owners
can see *what* broke.
