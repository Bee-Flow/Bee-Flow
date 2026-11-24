# Fact sheet — Cowork (`/app/cowork`)

Audience: everyday users. Everything below was read from the code on branch
`claude/cowork-v2-v3-redesign-w076uh` (2026-11-24), after the Cowork redesign ("round 2": one
column, a task as a page, the four questions What · When · Uses · Sends to). Exists: **yes** — a
shipping surface (home page, task page, API, scheduler, fixed steps, notifications, mobile client).

Labels are quoted exactly as the English dictionary has them, with the key; the Dutch is in
`server/i18n/defaults/nl/<namespace>.json` under the same key.

Primary source files
- Frontend: `agent-hub/src/components/cowork/` — `CoworkPage.tsx` (header, pages), `CoworkHome.tsx`
  (the home column), `CoworkHomeComposer.tsx` (the box), `CoworkConfirmCard.tsx` +
  `CoworkConfirmRows.tsx` + `coworkConfirmModel.ts` (the confirmation card), `useTaskSetup.ts`
  (set-up and test), `CoworkNeedCard.tsx` + `CoworkNeedKinds.tsx` + `CoworkNeedFix.tsx` +
  `CoworkNeedSetup.tsx` (Needs you cards), `coworkTaskStatus.ts` (the status words),
  `task/CoworkTaskView.tsx` (the task page) with `task/CoworkTaskHeader.tsx`,
  `task/CoworkTaskSettings.tsx`, `task/TaskSetWhat|When|Uses|SendsTo|Keeps|Target.tsx`,
  `task/CoworkTaskTested.tsx`, `task/CoworkTaskSteps.tsx`, `task/CoworkTaskPeople.tsx`,
  `task/CoworkTaskHistory.tsx`; `panels/` (Cowork preferences, Admin rules, Teamwork, Templates).
  The chat's Cowork mode still uses the older `CoworkComposer.tsx` + `CoworkOptionsBar.tsx`.
- Backend: `server/routes/cowork.js` (+ `cowork*Routes.js` beside it), `server/stores/coworkStore.js`,
  `server/stores/coworkSetup.mts`, `server/usecases/coworkSetup.mts`, `server/core/cowork/taskSetup.mts`
  (the hold), `server/core/cowork/coworkRunner.js`, `server/core/cowork/coworkCompose.js`,
  `server/core/cowork/plan/planIndependence.mts`, `server/core/cowork/planTrust.mts`,
  `server/core/aiTaskRunner.js`, `server/core/cowork/promptTaskLoop.js`, `server/core/cowork/runShared.mts`.
- Copy: `server/i18n/defaults/en/cowork_home.js`, `cowork_task.js`, `cowork_pages.js`,
  `cowork_panels.js`, `cowork_trail.js` (and the older `cowork.js` for the chat composer).
- User guide: `docs/docs/features/cowork.md`.

---

## 1. What the feature is for

Cowork does recurring work for you while you do something else: "every weekday at 07:30, read the
supplier mail and tell me which orders are late". The thing it makes is a **task** (one word,
everywhere: "Your tasks", "Delete this task", "Untitled task" — `cowork_home.untitled`).

You write one sentence. Cowork answers with a card of four lines it understood — **What, When,
Uses, Sends to** — that you can change before anything exists. **Set up and test** then makes the
task, sets up **fixed steps** for it and tests them once without sending anything. The task does
not run for real until you approve those steps. After that it runs on its own, as you, with your
connected apps.

Organising principle (design brief, `CoworkTaskSettings.tsx` header): everything about ONE task is
inside that task under the same four questions; everything about YOU is under **Cowork
preferences**; everything about EVERYONE is under **Admin rules**.

---

## 2. How you get there

- Sidebar row **Cowork** (`sidebar.cowork`), Handshake icon, directly under **New Chat**, anchor
  `[data-tour="nav-cowork"]` (`components/shell/sidebar/NavRow.tsx`, key `cowork` in
  `sidebarNav.tsx`). Its badge counts the tasks that are switched on (`isActive`), not the paused ones
  (`api/queries/shellSidebar.ts`).
- URL `/app/cowork`; one task `/app/cowork/:id`. Old URLs `/app/work`, `/app/studio/cowork` still land
  here (`authedApp/appRoutes.test.ts`). Cowork is allowed on a phone (`MOBILE_ALLOWED_PAGES`).
- A second entrance still exists: the **Chat ⇄ Cowork switch** in the header of an empty chat
  (`CoworkModeToggle.tsx`; it disappears once the thread has a message, and in incognito). In chat's
  Cowork mode the OLD composer is used: the chips When / Repeat / (agent) and the Apps picker, a
  **Run** / **Schedule** button, and the task is created straight away with a toast
  `"<title>" scheduled — <schedule>. Change it under Cowork in the sidebar.`
  (`AgentHub/useComposerMode.ts`). There is no confirmation card and no set-up of fixed steps on
  that path.
- A chat suggestion can hand a sentence to the home: "You ask this every {day}. Let it run as a
  task?" with **Make it a task** (`cowork_panels.chip.*`, only when the person switched on "Suggest a
  task when I repeat a question").

---

## 3. The home (`CoworkPage.tsx`, `CoworkHome.tsx`)

One column, top to bottom:

- Header: **Cowork**, then for an organisation administrator a link **Admin rules**
  (`cowork_pages.name.org`, shown when `administersOrg(user)`), and a gear button with the label
  **Cowork preferences** (`cowork_pages.name.settings`).
- Heading **What should be done for you?** (`cowork_home.ask`), a box with the placeholder
  *Every Monday at 09:00, summarise last week’s meetings and send it to me*
  (`cowork_home.brief_placeholder`), a link **Start from a template** (`cowork_home.from_template`)
  and the button **Show what I understood** (`cowork_home.show_understood`; **Reading…** while it
  reads). Enter = the button, Shift+Enter = new line. Anchor (added in this round):
  `[data-tour="cowork-composer"]` on that form.
- At the task limit the box says *You have {count} tasks, the most you can have. Delete one to add
  another.* (`cowork_home.at_limit`).
- Notices from the organisation: AI budget from 80 %, read-only mode (`cowork_home.notice.*`).
- **Needs you · {count}** (`cowork_home.needs.heading`): one card per thing that waits for you, at
  most three, the rest behind **Show {count} more**. Not shown when nothing waits.
- **Your tasks** (`cowork_home.tasks.heading`): one row per task (name, status word, when, next run,
  target). Empty: *No tasks yet. Write one sentence above to start.*
- **Shared with you** (`cowork_home.shared.heading`), only when a colleague shared a task with you.
- **Teamwork**: one row that is always there (*Let your tasks work together with colleagues’ tasks* /
  *You work together in {names}*) — `cowork_pages.home.*`.

A task, Teamwork, Templates, Cowork preferences and Admin rules open as pages in the same column,
with **← Tasks** (`cowork_pages.back`) to go back; browser Back works. There is no side panel.

---

## 4. The confirmation card (`CoworkConfirmCard.tsx`, `CoworkConfirmRows.tsx`, `coworkConfirmModel.ts`)

**Show what I understood** sends the sentence to `POST /api/cowork/compose`, which **creates
nothing** (`routes/cowork.js`). The card is headed **This is what I understood**
(`cowork_home.confirm.heading`) and has four rows, each changeable before anything exists:

| Row | What it shows | How you change it |
|---|---|---|
| **What** | the task's NAME (an editable text field), worked out of the sentence (≤ 60 characters, `coworkCompose.js` `MAX_TITLE`) | type in the field |
| **When** | the day words + **at** + a time field: *Every Monday at 09:00*, *Weekdays…*, *Once, today*, *Once, tomorrow*, *Right away*, *When a new e-mail arrives* | **Change** opens **Which day?**: *Just once, today*, *Every day*, weekdays, *Every Monday* … *Every Sunday*; the time field changes the time |
| **Uses** | chips of the apps your sentence NAMES (matched on the app's name or id, 3+ letters, `appsNamedIn`); none named: *Cowork picks the apps it needs while it sets up the steps. You see them before anything runs.*; all removed: *No apps. The AI only writes.* | × on a chip; **Add an app** |
| **Sends to** | **Me** plus every e-mail address written in the sentence, as chips ("send it to me and sam@…" shows both); nobody: *Nobody. The result stays in the task.* | × on a chip, **Add me**, an address field with **Add** (*That is not an e-mail address.*) |

- When the sentence does not say when, the card asks **Which day?** and says *Your sentence does not
  say when. Pick a day and it is ready to start.*; the start button stays off until a day is picked.
- Vague times are read as fixed hours: morning 08:00, midday 12:00, afternoon 14:00, evening 18:00,
  night 21:00 (`coworkCompose.js` prompt).
- When someone other than you is under Sends to, a checkbox **Show me each message first**
  (`cowork_home.confirm.show_first`) appears, ticked by default, with *Nothing goes to someone else
  before you have seen it, under Needs you.* Unticked it says *Cowork still shows you each message at
  first. After 10 runs you let through, you can choose “Don’t ask” in the task.* — unticking is NOT a
  stronger setting: the server only acts on `askFirst: true` (`usecases/coworkSetup.mts`), and a
  task's default level is already "Show me each message first" (`DEFAULT_INDEPENDENCE =
  'asks_before_sending'`, `planIndependence.mts`).
- Editing the sentence while the card is open does not throw it away: *Reading your sentence again…*,
  and the rows follow the new sentence EXCEPT the ones you changed by hand (`ConfirmChoices`).
  Emptying the box closes the card. **Cancel** closes it.
- Under the rows: *Cowork sets up the steps and tests them once. Nothing is sent during the test,
  and it runs for real only after you approve the steps.* (`cowork_home.confirm.after_set_up`).
- Buttons: **Set up and test** (`cowork_home.confirm.set_up`) and **Cancel**; **Starting…** while it
  creates. In an organisation whose licence has no automations (`useMayHaveSteps` →
  `can('automations')`), the button reads **Start** and the card says *Your organisation has no
  fixed steps, so the AI works this task out on every run.* (`after_start_ai`).
- The agent is not on the card. A sentence that names one of your agents can still link it (the
  composer only links an agent the sentence names, `coworkCompose.js`).

---

## 5. Set up and test, and the first approval

- After **Set up and test** the home shows the task's name with three ticking lines: **Setting up
  the steps** · **Testing once, nothing is sent** · **Ready for your check** (`cowork_home.setup.*`,
  `CoworkHomeComposer.tsx`, `useTaskSetup.ts`). The task's status meanwhile is **Testing**.
- Then a card under **Needs you**: *The steps are ready and tested. Check them once.* /
  *It does not run for real until you approve them.* with **Open and approve**
  (`cowork_home.need.check`, `check_sub`, `open_approve`).
- On the task page the same card offers **Approve** and **Test, sends nothing**. Above the steps,
  only while they wait for their first approval: **This is what you would have received** —
  *From the test, on your real data. It would have gone to {who}. Nothing was sent.* — with the
  test's actual output and **Change something** (opens the What row) (`CoworkTaskTested.tsx`,
  `cowork_task.tested.*`).
- **Approve** → *Approved. It runs by itself from now on.* (`cowork_home.done.approved`), with Undo
  where the server allows it. Approving does NOT start a run (`POST /:id/plan/approve`).
- **The hold** (`core/cowork/taskSetup.mts` `heldForSetup`): a task whose set-up is `wanted` or
  `failed` and that has no approved plan does not run. A repeating one has its moment moved on
  without running; a one-off is left out of the due query; **Run for real now** is refused with 409
  *This task waits for you: approve its steps first, or let the AI work it out every run.*
  (`routes/cowork.js`). The hold only covers tasks created through the confirmation card (they carry
  a set-up); a task made from the chat's Cowork mode, or an older one, has no set-up and runs as it
  always did (`stores/coworkSetup.mts`: `NULL` = "runs as it always did").
- **When set-up does not work** the task keeps waiting, never quietly switching to the AI: a card
  *Cowork could not set up the steps.* with a cause (*Your workspace has no AI model for this yet…*,
  *It took too long…*, *Cowork could not turn the sentence into steps. Try again, or say it step by
  step.*, *The AI budget for this month is used up.*, *It was not finished: the page was closed…*),
  *Until you choose, this task does not run.*, and the choice **Try setting up again** or **Let the AI
  work it out every run** (with **Undo**) (`cowork_home.setup_card.*`, `CoworkNeedSetup.tsx`).

---

## 6. The task page (`task/CoworkTaskView.tsx`)

One column, top to bottom:

1. **← Tasks**, the status pill, the name, and **Run for real now** · **Pause** (**Resume** when
   paused) · **Share** (`cowork_task.action.*`, `more.share`). A button that is off says why under it:
   *It cannot run for real yet: its steps wait for your approval.* / *…test it once first.* /
   *…something needs you first. See below.* / *It starts when a new e-mail arrives, so it cannot be
   started by hand.* / *It is running or being tested right now…* (`cowork_task.held.*`).
2. What needs you (the same cards as on the home), OR what it is doing now (*Running now*, *Testing
   it. Nothing is changed or sent.*), OR its latest result: **Done · {when}**, **Failed · {when}**,
   **Nothing to do · {when}**, with **Next: {when}** (`cowork_task.result.*`). A fix Cowork made by
   itself shows as *Fixed by itself on {date}: {what}.* with **Undo**.
3. **Settings** (`cowork_task.set.heading`): four rows that always show their value, each with
   **Change**, opening in place, one at a time. There is no Edit screen.
   - **What** — **Name**, the sentence (**What should be done?**), and **Target to track**
     (`cowork_task.target.heading`: one sentence such as *Every supplier mail answered within two
     working days*; Cowork drafts a check that only reads and counts; you **Approve the check**).
   - **When** — **It starts**: *On a schedule*, *When a new e-mail arrives*, *After another task
     finishes*, *When a table gets a new row*, *When a new file lands in a folder*, *When another system
     calls it (webhook)* (`TaskSetWhen.tsx` `KINDS`); on a schedule: **How often** (*Once*, *Every
     hour*, *Every day*, *Weekdays*, *On chosen days*, *Every two weeks*, *Every month*, *Every quarter*,
     *Every year*), days, time. Pause is in the header, not here.
   - **Uses** — **Apps it may use** (chips you switch on/off), **How it works** (`cowork_task.edit.how`):
     **The AI works it out every run** · **An agent of yours does it** (then **Which agent**) ·
     **Fixed steps**; then **What it remembers** (with **Clear what it remembers**) and **Spending
     limit** (*Monthly limit in euros*, empty = *No limit*; at the limit the task pauses and tells you).
   - **Sends to** — **Who receives it** (read-only here: *To send it to someone else, say so in the
     sentence under What.* — `cowork_task.sends.change_hint`), the one **Ask me** choice, and **Per
     person** trust.
   - Saving: a name or a time is saved at once; a change to the sentence, the apps or "how it works"
     of a task with fixed steps is **Save and test** (*Cowork rebuilds the steps and tests them once.
     Nothing is sent. You approve the changed steps before it runs again.*); switching a fixed-steps
     task to the AI or an agent warns *Saving takes its fixed steps off…* (`cowork_task.set.*`,
     `coworkTaskSettingsModel.ts` `saveEffect`).
4. **This is what you would have received** (only before the first approval), then **Steps**
   (`cowork_task.steps.*`): *Fixed steps, the same on every run, top to bottom.*, each step with what it
   does (**Reads**, **Changes**, **Sends**/**Sends to {who}**, **AI writes or decides**, **Asks you**),
   in-between steps folded (**Show {count} in-between steps**), and **Test, sends nothing** and
   **Compare with last month** (runs today's steps on what earlier runs read; touches no app). For the
   AI or an agent: *The AI works out the steps on every run. This is what it did last time.*
5. **People** (`cowork_task.people.*`): **Share** (a colleague in your organisation: **Can see**, or
   **Can answer** — also handles what it asks under Needs you; only one can answer; nobody else can
   edit), **Send each result to a colleague's task**, **Save as template / Export as file**, **Give this
   task away** (the colleague gets a paused copy and approves its steps first; it leaves your list).
6. **History** (`cowork_task.history.*`): **Runs**, **Changes** (with **Restore these steps** for an
   earlier approved version), **Proof of each run** (signed receipts; **Export receipts**), and at the
   very bottom **Delete this task** → *Delete '{title}'? It stops for good, with its runs. This cannot
   be undone.* → **Delete task**.

---

## 7. "Ask me" — one choice (`task/TaskSetSendsTo.tsx`, `planIndependence.mts`, `planTrust.mts`)

| Label | Level | What it does |
|---|---|---|
| **Ask me before every change or message** | `asks_everything` | nothing it changes or sends goes ahead until you approve it, under Needs you |
| **Show me each message first** | `asks_before_sending` (the default) | changes inside its own reach (a table, a draft) on its own; a message to someone else waits for **Send** / **Don’t send** |
| **Don't ask** | `on_its_own` | runs as approved; offered only after **10** runs of this version you let through without stopping one (`ON_ITS_OWN_AFTER`), and only when the organisation's ceiling allows |

- The choice only applies to **fixed steps**. For the AI or an agent the row says *This applies to
  fixed steps. Here the AI or your agent does the task and tells you afterwards what it did.*; before
  approval *This starts to apply once you approved its steps…*; for a task that only sends to you
  *It sends only to you, so there is no message to someone else to show you first.*
- **Per person**: after you let the same step's message to the same address through **5** times
  (`TRUST_AFTER`) that address can be set to **Send without asking**; stopping a message puts it back
  to asking.
- A result for you yourself is never asked about (`deliver` steps, `planIndependence.mts`).

---

## 8. Statuses (`coworkTaskStatus.ts`, `cowork_home.status.*`)

One word per task, the same on the home row, the task header and the runs:
**Done · Failed · Needs you · Scheduled · Running · Testing · Paused · Nothing to do**.

- **Testing** — setting up or trying its steps. **Running** — a run is on the go.
- **Failed** — a card says something is wrong, a sign-in ran out, or the last run failed. Every failed
  task has a card under Needs you, so home and task agree.
- **Paused** — switched off by you. **Needs you** — a card asks something (approve the steps, choose
  after a failed set-up, a message to send, a review), or the task waits for its steps.
- **Nothing to do** — the last run checked and found nothing to do (a success, not a failure).
- **Done** — the last run went well. **Scheduled** — has not run yet and waits for its start.

---

## 9. When something goes wrong (`CoworkNeedFix.tsx`, `CoworkNeedKinds.tsx`)

A failure is always a card under **Needs you**, on the home and on the task, in plain words that name
the step and the cause, with one primary action and a way out. The raw text is only under **Technical
details** (`cowork_task.technical`). A failed run also raises a notification titled
*Cowork failed* that links to the task (`runShared.mts`).

| Card says | Primary action |
|---|---|
| *The steps are in the wrong order, so it cannot run.* (*Cowork can fix the order of the steps. What the task may read and send stays the same.*) | **Fix it for me** |
| *‘{step}’ could not read what it needs from ‘{source}’.* / *‘{step}’ did not work in the last run.* / *The test of the steps did not pass.* | **See what is wrong** (way out: **Let the AI work it out every run** or **Run it again**) |
| *The sign-in of {app} ran out.* — *Sign in again, then run it again.* | **Sign in again** (opens Settings → Connections) |
| *An app needs you to sign in again.* — *The task paused itself, so nothing is lost. Sign in, then turn it back on.* | **Sign in again**, **Turn it back on** |
| *{app} is no longer allowed for this task.* — *Allow it again under Uses…* | **See what is wrong** |
| *The last run took too long and was stopped.* | **Run it again** |
| *The last run failed.* — *Open the task to see what happened.* | **See what is wrong** |
| *Cowork could not set up the steps.* | **Try setting up again** / **Let the AI work it out every run** |

- Reconnecting an account under Settings → Connections also resumes every task the expired sign-in had
  paused (`coworkStore.resumeNeedsReauthForUser`, called from `auth/oauth/shared.js` and the Microsoft
  365 callback).
- What Cowork can repair without widening what the task may do, it repairs, tests and reports with
  **Undo** (organisation switch **Automatic fixes**, `cowork_panels.org.auto_fix`).

---

## 10. Where the result lands

- On the task: its latest result at the top, and **History → Runs**.
- In your notifications, category **Cowork** (`runShared.mts` `NOTIFICATION`), for every run mode;
  **Open result in chat** continues it as a conversation.
- With an agent: also in that agent's chat thread, one thread the task keeps using
  (`agentScheduleRun.js`).
- What it sends by e-mail goes to who is under Sends to; *What it sends without a send step reaches its
  owner alone* (user guide, Privacy).

---

## 11. Who does the work — Settings → Uses → How it works

- **The AI works it out every run** — *It reads your sentence and works out the steps on every run.
  Most flexible, a bit slower.* Runs through `promptTaskLoop.js`: at most **20** tool calls per run
  (`MAX_TOOL_ITERATIONS`), told *Do NOT ask follow-up questions — this runs unattended.*
  (`aiTaskRunner.js`).
- **An agent of yours does it** — *One of your own agents runs it, with its own instructions and
  apps.* The agent brings its instructions, skills, knowledge bases and connected apps; it runs on its
  own model; the result also lands in its chat thread; with the agent's **Memory** on, each run is told
  what earlier runs already covered (`agentScheduleRun.js`, `memoryEnabled`).
  - The option is only listed when there are agents to pick: the list is `GET /agents/all`, which needs
    the permission `manage_agents` (Organisation Admin, Agent Admin, Agent Editor; not Member —
    `server/config/orgRoles.json`).
  - Server refusals (`routes/cowork.js` `resolveAgentId`): *Running Cowork items as an agent is not
    enabled for this account* (feature `agent_routines` off) and *Agent not found or not available to
    you*. An agent may be your own, or a published agent of your organisation that you may chat with
    (`coworkAgentAccess.mts`), checked again at every run.
- **Fixed steps** — *The same steps every run, with AI only where something must be written or judged.
  Fastest and cheapest.* Only offered when the organisation has automations.
- Switching from fixed steps to the AI or an agent takes the steps off (the task then no longer waits
  for approval: `detachPlan` sets the set-up to `ai`, `stores/coworkSetup.pg.test.js`).

**Apps it may use** (`TaskSetUses.tsx`): with no list of its own a task *uses the apps that are on for
you*; switching one chip off or on gives it *its own list* (*It only uses the apps that are on here.*);
all off reads **No apps** on the row. There is no button on the task page to go back to "no list of its
own". The organisation's **Apps tasks may use without asking** applies to every run, AI, agent or
steps (`runApps.mts`).

---

## 12. Your preferences and the organisation's rules

- **Cowork preferences** (gear): **E-mail me each morning what needs me**; **Suggest a task when I
  repeat a question** (off unless you turn it on; keeps only which apps a chat used and on which weekday,
  forgets after 8 weeks) — `cowork_panels.settings.*`.
- **Admin rules** (administrators): **Read-only mode** (*Tasks read and write drafts, but change and
  send nothing.*), the ceiling on "Ask me", **Apps tasks may use without asking**, **Monthly AI budget**
  (notice from 80 %, new runs refused at 100 %), **Automatic fixes**, **Allow “Suggest a task when I
  repeat a question”**, **Proof of each run** (audit of every receipt) — `cowork_panels.org.*`.

---

## 13. Numbers

| Thing | Value | Where |
|---|---|---|
| Tasks per person | **10** (config `ai_tasks_max_per_user`); paused ones count | `routes/cowork.js` `DEFAULT_MAX_SCHEDULES`, `getScheduleCount` |
| Name | ≤ **60** characters from the composer | `coworkCompose.js` |
| Addresses under Sends to | ≤ **20** | `taskSetup.mts` `MAX_RECIPIENTS` |
| "Don't ask" offered after | **10** runs let through | `planIndependence.mts` |
| Per-person "Send without asking" after | **5** let-throughs | `planTrust.mts` |
| Tool calls per AI run | **20** | `promptTaskLoop.js` |
| Set-up counted as abandoned after | **4** minutes | `taskSetup.mts` `SETUP_GRACE_MS` |

---

## 14. Permission and licence gates

- `/api/cowork` is mounted with `requireTraining('cowork')` (an organisation may require the Cowork
  course before creating tasks; reads stay open) and `requireAuth`; no licence gate on the router
  (`server/index.js`, `routes/cowork.js`). Ownership is the authorisation for a task's own routes.
- Fixed steps need the licence feature `automations` (client: `can('automations')`).
- Running as an agent: feature `agent_routines` plus access to the agent (§11).
- Admin rules: organisation administrators (`administersOrg`).

---

## 15. API a learning check can read

All behind `requireAuth`, scoped to the signed-in user. `GET /api/cowork` →
`{ schedules: [...], maxSchedules }`; each row has `id`, **`userId` (owner)**, `title`, `prompt`,
`isActive`, `repeatInterval`, `daysOfWeek`, `timeOfDay`, `nextRunAt`, `lastRunAt`, `lastStatus`,
`runCount`, `agentId`, `enabledApps`, `planId`, `setup`, `currentRunStartedAt`.

- `lastRunAt` and `runCount` move only on a run for real (`coworkStore.markCompleted` / `markError`).
  The test of the steps (`POST /:id/plan/try`) and approving do NOT count.
- `cowork-first` (`agent-hub/src/components/onboarding/actionChecks.ts`): *created* =
  `schedules.length > 0`; *ran* = any row with `lastRunAt` or `runCount > 0`. After the redesign a
  learner satisfies *ran* by approving the steps and pressing **Run for real now** (or by **Start** +
  **Run for real now** where the organisation has no fixed steps).
- `cowork-apps-scoped` (generated): only "a task of your own exists" is checkable; `enabledApps` is in
  the row but the generic `expect` kinds cannot test it per row.

---

## 16. Common mistakes

1. Expecting the task to run before its steps are approved. It waits, and its status is **Needs you**.
2. Writing "send it to purchasing": only e-mail addresses written in the sentence reach **Sends to**.
3. Expecting **Uses** to fill itself: only apps the sentence names are pre-selected.
4. Unticking **Show me each message first** to make it send on its own: it still shows each message
   until "Don't ask" opens after 10 runs.
5. Looking for an Edit button: everything is under **Settings** on the task page.
6. Trying to change recipients on the task page: say it in the sentence under **What**.
7. Reading **Nothing to do** as a failure.
8. Switching to an agent and expecting "Ask me" to keep holding messages: it applies to fixed steps only.
9. Deleting to "clean up": **Delete this task** removes its runs for good; **Pause** is reversible.
