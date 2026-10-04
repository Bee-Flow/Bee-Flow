# Fact sheet — Cowork (`/app/cowork`)

Audience: everyday users. Everything below was read from the code on branch
`claude/builder-redesign-fase-1-6sun0h` (2026-09-14). Exists: **yes** — a fully built,
shipping surface (page, API, scheduler, run history, notifications, mobile client).

Primary source files
- Frontend: `agent-hub/src/components/cowork/` (CoworkPage.jsx, CoworkComposer.jsx,
  CoworkOptionsBar.jsx, CoworkDetail.jsx, CoworkEditForm.jsx, CoworkRunHistory.jsx,
  CoworkStats.jsx, CoworkRow.jsx, CoworkWelcome.jsx, CoworkModeSwitch.jsx,
  coworkApi.js, coworkSchedule.js, coworkStatus.js, coworkFormat.js, useCoworkApps.js,
  useCoworkComposer.js)
- Routing: `agent-hub/src/authedApp/appRoutes.js`, `authedApp/useNavigateToPage.js`,
  `AgentHub.jsx`, sidebar row in `components/shell/Sidebar.jsx`
- Backend: `server/routes/cowork.js`, `server/stores/coworkStore.js`,
  `server/core/cowork/coworkRunner.js`, `coworkCompose.js`, `coworkShield.js`,
  `server/core/aiTaskRunner.js` (the shared execution engine),
  `server/migrations/cowork-2026-08.js`, `server/core/entitlements/coworkShieldFlag.js`
- Copy: `agent-hub/src/i18n/en-defaults.js` (namespace `cowork.*`, ~120 keys, NL
  translations seeded by `server/migrations/add-nl-cowork-translations.js`)

---

## 1. What the feature is for

Cowork is the "delegate it" half of Bee Flow, next to chat's "ask it" half. You write
**one plain-language brief** ("Every weekday at 08:00, give me a digest of what changed in
my inbox overnight"). Bee Flow's composer reads that sentence, derives a **title**, a
**runnable instruction** and a **schedule**, stores it as a *cowork item*, and a background
runner executes it **unattended** at the scheduled moment. The result lands in the
**notification bell** and in the item's own **run history**.

The product positioning, in its own words (the dotted card on the page,
key `cowork.list.explainer`):

> "Cowork is the short way: you write down what needs to happen, not how. If it has to take
> more steps, the same brief opens in the Builder."

Note: that sentence is copy only — there is **no button in the Cowork UI that hands a brief
to the Builder**. The reverse pointer does exist: Studio → Automations shows
*"Looking for your prompt tasks? They live under Cowork now →"* (`components/automation/index.jsx`).

Heritage: cowork replaced the old "prompt tasks" (`ai_tasks`). Those were migrated
(`server/migrations/prompt-tasks-to-cowork-2026-08.js`). Agent-linked *automations* stayed in
Studio → Automations. Cowork's new thing over prompt tasks is the **per-run history**.

---

## 2. How you get there

- Sidebar row **"Cowork"** (Handshake icon), directly under **"New Chat"**, with a badge =
  number of **active** schedules (`Sidebar.jsx`, counted from `GET /api/cowork`,
  `schedules.filter(s => s.isActive).length`).
- URL `/app/cowork`; deep link to one item `/app/cowork/:id`.
- Legacy URLs that still resolve here: `/app/work`, `/app/work/:id`, `/app/studio/cowork`,
  `/app/studio/cowork/:id` (`appRoutes.js`).
- Mobile-allowed page (`MOBILE_ALLOWED_PAGES` includes `cowork`); on a phone the list and the
  detail are one pane at a time, with an X button (aria-label *"Back to the list"*).
- Second entrance: the **Chat ⇄ Cowork switch** in the direct-chat header.
- Native Android app: `mobile/src/features/cowork/ComposeCowork.tsx` reads the same payload.

---

## 3. Every screen, with the real labels

### 3.1 Cowork page, left column (list, 320 px on desktop)
- Column heading: **`Cowork`** (hard-coded, not translated)
- Pill, only while something is in flight: **`{count} running`** (`cowork.list.running_count`)
- Icon button: aria-label **`Refresh`** (`cowork.list.refresh`)
- Primary button: **`New task`** (`cowork.list.new`) — it does *not* open a dialog; it clears
  the selection so the composer in the right pane comes back, and focuses the textarea.
- Rows (`CoworkRow.jsx`), two lines maximum:
  - line 1: the title (fallback **`Untitled cowork`**) + a coloured dot + the **status word**
  - line 2, grey: *when* · *how it's been going*, e.g. `Every weekday 08:00 · ran 42 times`,
    `Monday, Thursday 07:00 · last run 2d ago`, `Today at 14:30`
  - status words come from `components/shared/statusTokens.ts`: **Running**, **Paused**,
    **Failed**, **Finished**, **Waiting to start**, **Idle**, plus Cowork's own
    **`Needs sign-in`** (`cowork.status.needs_reauth`)
  - history half: `last run {when}` / `ran once` / `ran {count} times` (blank if never run)
- Loading text: **`Loading…`**
- Dotted explainer card at the bottom (always, full or empty list) — the sentence quoted in §1.

### 3.2 Right pane, nothing selected (welcome + composer)
- Handshake tile, heading **`What can Bee Flow take off your plate?`**
- Subheading **`Describe it once. It runs on its own — now, later, or every week.`**
- The composer (below)
- With an **empty list**, four starter buttons (clicking fills the box, never sends):
  1. `Every Monday at 09:00, summarise the AI news from the past week with source links.`
  2. `Every weekday morning, give me a digest of what changed in my inbox overnight.`
  3. `On the 1st of each month, draft a short progress report from my meeting notes.`
  4. `Every Friday, list the open items from this week that nobody has answered yet.`
- With a **non-empty list**, instead: *"Or pick something on the left to see when it runs and
  how every run went."*
- Page-level status strip shows, in order: load error, a flash, or the quota warning
  **`You've used all 10 cowork slots. Delete or finish one to add more.`**
- Flashes (4 s): **`Off it goes — the result lands in your notifications.`** (Run now),
  **`Scheduled.`**, **`Running — the result lands in your notifications.`** (Run now button).

### 3.3 The composer (`CoworkComposer.jsx`) — the same component in chat and on the page
- Textarea placeholder: **`Describe the work — Bee Flow runs it and reports back`**
  (aria-label `Cowork brief`, form aria-label `Cowork brief input`)
- Chip 1 **When** — label is `Now` or the resolved moment (`Today at 14:30`,
  `Tomorrow at 09:00`, `12 Sep at 09:00`) or `Pick a moment`
- Chip 2 **Repeat** — label `Once` … `Every year`
- Chip 3 **Run as agent** — only rendered when the user actually has pickable agents;
  label = agent name or `No agent`
- **Apps** picker (button title `Apps`); when the workspace app list cannot be read:
  **`App list unavailable — this run follows your workspace list`**
- Model **tier slider** (hidden in simple mode / on mobile)
- Send button: **`Run`** when *When = Now*, otherwise **`Schedule`**; while submitting
  **`Starting…`**. Enter sends, Shift+Enter is a newline, Cmd/Ctrl+Enter sends.

**When sheet** — title `When should this run?`, subtitle `Bee Flow delivers the result to your notifications.`
| Option | Resolves to |
|---|---|
| `Run now` (hint `Starts the moment you send it`) | now |
| `In an hour` | now + 60 min |
| `Tonight` (hint `18:00`) | today 18:00, or tomorrow 18:00 if already past |
| `Tomorrow morning` (hint `09:00`) | tomorrow 09:00 |
| `Next Monday` (hint `09:00`) | the *coming* Monday 09:00 (never today) |
| `Pick a moment…` | opens a date input (`Date`) and a time input (`Time`) |

**Repeat sheet** — title `How often?`, subtitle `Repeating work keeps running until you pause it.`
Options: `Once`, `Every hour`, `Every day`, `Every weekday`, `Every week`, `Every 2 weeks`,
`Every month`, `Every quarter`, `Every year`.

**Agent sheet** — title `Who does the work?`, subtitle
`An agent brings its own skills, knowledge and connected apps.`; first row `No agent`
(hint `Runs as a plain prompt`).

### 3.4 Detail pane header (`CoworkDetail.jsx`)
Agent-kind tile icon · title · status pill. While a run is open the pill reads
**`Running since 08:00:04`** (24-hour, from the open history row, not from `lastStatus`).
Buttons, left to right: **`Edit`**, **`Pause`** / **`Resume`**, a red trash button
(aria-label `Delete this cowork`), and the one filled button **`Run now`** (disabled while
`lastStatus === 'running'`).

### 3.5 "The assignment" card
Small caps heading **`THE ASSIGNMENT`**, then the brief verbatim (plain text, not Markdown),
then pills:
- cadence: `Every week 09:00`, `Every weekday 08:00`, or **`Runs once`**
- **`next Tomorrow at 09:00`** (only when the item is active and has a next run)
- the agent's name (only when linked)
- the **model tier** label: `Auto`, `Fast`, `Think`, `Deep Thinking`, `Write`, `Flow`, `Swarm`
- **`{count} app` / `{count} apps`** (only when the item carries its own app list)

Deliberately absent (documented in the file header): a knowledge-base pill, a datatable pill,
and a "Privacy shield on" pill — none of those are things a cowork item actually carries.

### 3.6 Figures (`CoworkStats.jsx`) — three cards
| Card | Value | Sub-line |
|---|---|---|
| **`Runs`** | `runCount` (lifetime) | `since 8 July` |
| **`Succeeded`** | `success` | `nothing went wrong` / `{n} run failed` / `{n} runs failed` / `older runs are no longer kept` |
| **`Average`** | `0m 48s` | `per run`, or `no run has finished yet` |

While loading every value is an em dash `—`. On failure: **`The figures for this work could not be loaded.`**
There is **no cost/token card** — the run path records no cost, and a fabricated euro amount
was refused on purpose (comment CW-12).

### 3.7 "What happened" — run history (`CoworkRunHistory.jsx`)
Card heading **`What happened`**. One table row per attempt, newest first:
dot · timestamp · duration · outcome line · chevron.
- timestamps: `Today 08:00`, `Yesterday 08:00`, `Tuesday 08:00`, `13 Aug 08:00`
  (with the year once it is not the current year)
- duration always `0m 48s` shape; blank when not measured
- outcome line, in this order: `Still running…` → first line of the error →
  `It failed without saying why` → **`Nothing to report`** → the first meaningful line of the
  result → `No output recorded`
- expanding a row shows **`Started by you`** or **`Started on schedule`**, then the result
  rendered as Markdown (images and live fences neutralised for safety), or the error in
  monospace, or one of: `This run failed without recording a reason.` /
  `This run finished and had nothing to report.` / `No output was recorded for this run.`
- empty: **`This hasn't run yet. The history fills in after the first run.`**
- more than one page: `Showing the {shown} most recent of {total} runs.`

### 3.8 Edit form (`CoworkEditForm.jsx`) — heading **`Edit cowork`**
Fields, in order: **`Name`** · **`What it does`** (hint: *"This is the instruction Bee Flow
runs, unattended, at the scheduled moment."*) · **`Next run`** (date) · **`At`** (time) ·
**`Repeat`** (select) · **`Only on`** (day buttons `Mo Tu We Th Fr Sa Su`, hint *"Leave all
off to use the repeat as-is."*, shown only when a repeat is chosen) · **`Apps it may use`**
(picker + `{count} of {total} enabled` + link **`Follow my workspace list`**) ·
**`Run as`** (select, first option `No agent`). Buttons **`Save`** / **`Saving…`** and
**`Cancel`**. Save is disabled until both Name and What it does are non-empty.
App hints: inherited → *"Following your workspace-wide list. Switch anything here and this
cowork keeps its own list from then on."*; own list → *"Only these apps are available to this
cowork when it runs, whatever you have switched on elsewhere."*

### 3.9 Delete dialog
Heading **`Delete this cowork?`**, body **`"{title}" stops running and its history is removed.
This can't be undone.`**, buttons **`Cancel`** / **`Delete`**.

### 3.10 Chat surface — the Chat ⇄ Cowork switch
Two tabs in the direct-chat header: **`Chat`** (title *"Answers you here, in the
conversation"*) and **`Cowork`** (title *"Runs on its own — now or on a schedule"*).
The switch disappears once the thread has its first message — you cannot convert a
conversation into a scheduled run halfway. In Cowork mode the welcome heading and starters
above the box change to the Cowork ones. On create, a toast:
`"<title>" scheduled — <schedule>. Change it under Cowork in the sidebar.`

### 3.11 Notification centre (`components/shell/NotificationCenter.jsx`)
Category **`Cowork`** (Handshake icon). A finished run arrives with the item's title and the
full result as the body; buttons **`Open result in chat`**, and when there is no text:
*"This ran, but produced no text to show. Open it to see the run."* + **`Open in Cowork`**.
Expanded modal title **`Cowork result`**. A failure arrives as an *urgent* notification
**`⚠️ Cowork failed: <title>`** with the message *"The scheduled cowork item "<title>" failed
to execute: <reason>"* and a link back to `/app/cowork/<id>`.

---

## 4. Concepts a learner must understand

- **Cowork item (schedule)** — one thing you handed over: a title, an instruction, a moment,
  optionally a repeat. Stored in `cowork_schedules`, one owner, **never shared** with
  colleagues. All API reads are scoped to the signed-in user.
- **Brief** — the sentence you type. It is *not* stored as-is: the composer rewrites it into
  the instruction the runner executes ("What it does"). The original sentence is the
  title's source.
- **Composer (the AI step)** — `POST /api/cowork/compose` sends the brief to a fast model
  which returns `{title, prompt, repeatInterval, daysOfWeek, timeOfDay, runOnce, agentId}`.
  Everything is whitelisted server-side; nothing the model invents reaches the database.
  It **creates nothing** — the client decides.
- **Touched chips win** — any chip you set yourself (When / Repeat / Run as) is never
  overruled by the composer. The AI only fills the blanks.
- **Run** — one execution attempt. Row in `cowork_runs` with status, trigger kind
  (`manual` vs `schedule`), start, finish, duration, result or error, and `producedOutput`.
- **`producedOutput` is three-valued** — `true` (something came out), `false` (succeeded with
  nothing to report), `null` (row predates the column; unknown, never read as false).
- **Model tier** — how much thinking the run is allowed. Remembered separately from chat
  (localStorage key `coworkTier`). A run linked to an agent uses the agent's own model, so
  the tier is forced to `auto` there.
- **Run as agent** — hands the brief to one of your agents, which brings its system prompt,
  skills, knowledge bases and connected apps; the result then also lands in that agent's chat
  thread.
- **Apps it may use** — a per-item allow-list. `null` = "no per-item restriction, follow my
  workspace-wide list" (the default). An **empty list is a real answer** ("this one may use
  nothing"). Unknown narrows: if the workspace list cannot be read, the screen claims nothing.
- **Needs sign-in** — a status of its own. An expired Google/Microsoft/Nextcloud token pauses
  every schedule that could touch that provider; reconnecting resumes them automatically.
- **Retention** — run *history rows* are deleted after 90 days; the schedule's lifetime
  `runCount` survives. That is why "42 Runs" can sit next to "3 Succeeded".

---

## 5. End-to-end workflows (exactly as a user clicks)

### W1 — Delegate something once, right now
1. Click **Cowork** in the sidebar.
2. Type the brief in the box, e.g. *"Zoek de drie grootste leveranciers in onze regio voor
   stalen kozijnen en zet ze in een tabel met contactgegevens."*
3. Leave the **When** chip on `Now` and the **Repeat** chip on `Once`.
4. Press **Run** (or Enter).
5. Flash: *"Off it goes — the result lands in your notifications."* The new item is selected
   automatically and shows status **Running** / `Running since 14:07:12`.
6. Wait. The list polls every 10 seconds while anything is in flight.
7. The bell shows a **Cowork** notification with the result; the detail pane's
   **What happened** table gains a row. Click the row to read the full output.

### W2 — Schedule a recurring digest
1. Cowork → type *"Elke werkdag om 07:30 een samenvatting van de nieuwe offerteaanvragen in
   mijn mailbox, met bedrag en deadline."*
2. Optional: click the **Apps** button and switch on only Gmail/Outlook.
3. Press **Schedule** — or leave everything to the composer, which reads "elke werkdag om
   07:30" and sets `Every weekday` + `07:30` itself. (If the chips are untouched, the AI's
   answer is used; if you set the chips, yours are.)
4. The new row appears with `Every weekday 07:30` and status **Waiting to start**.
5. Open the item to check the **next** pill (`next Tomorrow at 07:30`) and the assignment
   text the AI wrote.

### W3 — Correct what the AI inferred
1. Select the item in the left column.
2. Click **Edit**.
3. Fix **Name**, rewrite **What it does**, change **Next run** date, **At** time,
   **Repeat**, or tick days under **Only on**.
4. Click **Save**. (The form saves only on submit; a rejected save keeps your edits on screen.)

### W4 — Run, pause, resume, delete
1. Select the item.
2. **Run now** — fires immediately without disturbing the series (`manual` run; the next
   scheduled moment stays where it was). Disabled while a run is open;
   the API refuses with *"This cowork is already running"*.
3. **Pause** — stops future runs; the row reads **Paused**. **Resume** puts it back.
4. Trash icon → **Delete this cowork?** → **Delete**. The run history is deleted with it.

### W5 — Delegate from a chat you already started
1. Open **New Chat** (the switch only shows while the thread is still empty).
2. Flip the header switch from **Chat** to **Cowork**.
3. The heading and the placeholder change; set the chips if you want.
4. Send. A toast confirms: `"<title>" scheduled — Tomorrow at 09:00, every day. Change it
   under Cowork in the sidebar.`
5. (In an agent chat, flipping to Cowork pre-selects that agent as the one who does the work.)

### W6 — Diagnose a failure
1. The bell shows **⚠️ Cowork failed: <title>**; click it — a failure notification links to
   `/app/cowork/<id>`.
2. Read the top row in **What happened**: the outcome line is the first line of the error.
3. Expand the row for the full error text.
4. If the status word is **Needs sign-in**, reconnect the account in
   Settings → Integrations; the schedule un-pauses itself on the next tick.
5. Otherwise fix the brief under **Edit**, then **Run now** to test.

---

## 6. Defaults, limits and numbers

| Thing | Value | Where |
|---|---|---|
| Schedules per user | **10** (config `ai_tasks_max_per_user`, shared with automations) | `routes/cowork.js` `DEFAULT_MAX_SCHEDULES` |
| Over-quota error | `Maximum number of cowork schedules reached (10). Delete or pause one to create another.` | `routes/cowork.js` |
| Composer title max | **60** characters | `coworkCompose.js` `MAX_TITLE`, `titleFromBrief` |
| Composer instruction max | **4000** characters | `coworkCompose.js` `MAX_PROMPT` |
| Result stored, max | **50 000** characters, then `… (truncated)` | `aiTaskRunner.js` |
| Tool-call loop | max **20** iterations per run | `aiTaskRunner.js` `MAX_TOOL_ITERATIONS` |
| Scheduler tick | every **60 s**, first sweep **10 s** after boot | `coworkRunner.js` |
| Concurrency | **5** runs at a time, max **20** due schedules per tick | `coworkRunner.js`, `coworkStore.getDueSchedules` |
| Stale-run reaper | closes runs open longer than **30 min** | `coworkStore.reapStaleRuns` |
| History retention | **90 days** (`COWORK_RUN_RETENTION_DAYS`, 0 disables), swept hourly, 5 000 rows/batch, ≤20 batches (100 k) per pass | `coworkRunner.js` |
| Run-history page | default **25**, clamped **1–100**, `offset` ≥ 0 | `coworkStore.listRuns` |
| UI poll while running | every **10 s**; flash messages disappear after **4 s** | `CoworkPage.jsx` |
| Default model tier | server default **`fast`**; the page sends the remembered tier (default `auto`) | `routes/cowork.js`, `useModelTierSelection` |
| Composer model call | tier `fast`, `temperature: 0`, `maxTokens` ≤ **1500** | `coworkCompose.js` |
| Default timezone | browser zone, else `Europe/Amsterdam`; unknown IANA zones are rejected with 400 | `routes/cowork.js` |
| Default tools | `["agent_search"]`; `max_result_length` column default 50000 | `migrations/cowork-2026-08.js` |
| Valid repeats | `hourly, daily, weekdays, weekly, biweekly, monthly, quarterly, yearly` (or null) | both server and client |
| Valid weekdays | `sun mon tue wed thu fri sat` | both |
| Time format | `HH:MM`, 24-hour; anything else → 400 `timeOfDay must be in "HH:MM" format` | `routes/cowork.js` |

---

## 7. What happens on failure

- **Run errors** → schedule status `error` (word: **Failed**), the error text is stored on the
  run row and on `last_result`, and an *urgent* notification is raised. A **repeating** item
  still advances to its next occurrence (errors never block the series); a **one-off** is
  switched off so the minute tick cannot retry it forever.
- **Expired integration** → status `needs_reauth` (word: **Needs sign-in**). Every schedule of
  that user that could touch the broken provider is paused with that status, one notification
  is sent with a deep link into the OAuth flow, and the OAuth callback calls
  `resumeNeedsReauthForUser` to un-pause them.
- **Server restart / crash mid-run** → the open row is reaped after 30 minutes with the error
  *"This run was interrupted — the server stopped before it finished."* and the schedule is
  released so it runs again.
- **Tool loop exhausted** → the stored result is the Dutch marker
  `_(Deze cowork bereikte de limiet van 20 tool-aanroepen voordat een eindresultaat werd
  geproduceerd. Splits de prompt op of koppel een agent met grotere context.)_`
- **No text produced** → `_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat
  geproduceerd.)_`, recorded as `producedOutput = false` and shown as **Nothing to report**.
- **Composer unavailable** (model down, network) → silently falls back to *your own words*
  as a one-off; nothing is lost, but no schedule is inferred.
- **App list unreadable** → the composer shows *"App list unavailable — this run follows your
  workspace list"* and the edit form shows *"Your app list could not be loaded."* — the item is
  never given a list it could not verify.
- **Stats call fails** → only the three cards disappear; brief, buttons and history still render.
- **Unschedulable state** — `Pick a moment…` with empty date/time blocks Send and shows
  **`Pick a date and time first.`**
- Other API errors surface verbatim: `Title is required`, `Prompt is required`,
  `nextRunAt is required`, `This cowork is already running`, `Not found` (404),
  `Forbidden` (403 on someone else's item).

---

## 8. Permission and licence gates

- **Cowork itself is NOT licence-gated.** `server/index.js` mounts
  `app.use('/api/cowork', require('./routes/cowork'))` and the router's only gate is
  `router.use(requireAuth)`. No `requireLicenseFeature`, no `requirePermission`, no
  org-role entry in `server/config/orgRoles.json`. Any signed-in user, Community included,
  can create cowork items. The sidebar row is likewise ungated.
- **Ownership is the authorisation.** `loadOwned()` 404s on an unknown id and 403s
  (`Forbidden`) when `schedule.userId !== session.user.id`. There is no org-wide view.
- **Linking an agent** is gated by the beta/entitlement **`agent_routines`**
  (`userHasBetaFeature(userId, 'agent_routines')` in `routes/cowork.js`, both on create/update
  and on `/compose`). Lifecycle GA, licence feature `agent_routines`, which sits in the
  **Community** tier (`server/license/tiers.js`). Refusal: 403 *"Agent automations beta is not
  enabled for this account"*. The agent must also be owned by the caller — otherwise 403
  *"Agent not found or not owned by you"*. Frontend mirror: `useCoworkComposer` only offers the
  picker when `useEntitlements().can('agent_routines')`.
- **The "Run as" picker's data source is permission-gated.** `listCoworkAgents()` calls
  `GET /agents/all`, which is `requirePermission('manage_agents')`. In
  `server/config/orgRoles.json` that permission belongs to `org_admin`, `agent_admin` and
  `agent_editor` — **not** to `member`. A plain member therefore gets an empty list and the
  "Run as" field / agent chip simply does not render, even with the beta on.
- **Privacy shield on the non-agent run path** is a per-org opt-in stored in configStore under
  `org_cowork_shield_<orgId>`, default **OFF** and explicitly stamped off for existing orgs
  (`migrations/cowork-shield-flag-2026-09.js`). There is currently **no UI or route to switch it
  on**. When on, the brief and the run input go through the same PII passage as the agent
  runtime: masking rewrites the text, a PII block or a fail-closed guard outage fails the run
  visibly. `GET /api/privacy/shield-status` exposes `coworkEnabled` for the shield pill.
- Learning/verification note: the lesson check `cowork-first` in
  `agent-hub/src/components/onboarding/actionChecks.js` is already wired to `GET /api/cowork`
  and is **ungated** (no `gate:` entry), unlike the automations criterion.

---

## 9. How Cowork connects to the rest of the product

- **Notifications** — the only delivery channel for results (category `cowork`).
- **Chat** — the Chat ⇄ Cowork switch; "Open result in chat" continues a result as a
  conversation; an agent-linked cowork writes into that agent's thread.
- **Agents** — "Run as" hands the brief to an agent with its skills, KBs and integrations.
- **Integrations / Apps** — the run uses the user's connected apps; per-item allow-list narrows
  them; broken OAuth pauses schedules (`auth/automationAuth.js`).
- **Automations / Automations (Studio)** — agent automations stayed there; the Automations empty state
  says *"plain scheduled work lives under Cowork"* and a pointer button links across.
- **Model tiers** — `/ai/config/tiers-for-user`; tier is remembered per surface.
- **Usage & cost** — every run logs to `ai_usage_log` with `agent_type`/`source = 'cowork'`
  (the composer logs `source = 'cowork_compose'`), so scheduled work counts against org quota
  even though the Cowork UI shows no cost card.
- **Learning Center** — course `course-cowork` ("Cowork: Delegate Your Work", lessons
  `cowork-basics`, `cowork-briefs`, `cowork-hands-on`, badge 🤝 *Delegator*), plus the
  capstone criterion "A cowork item working for you".
- **Onboarding tour anchors** — `nav-cowork`, `cowork-composer`, `cowork-options`.
- **Mobile** — the Expo app reads the same `/api/cowork` payload (field names must not change).

---

## 10. Common mistakes

1. **Expecting a schedule while "When" says `Now`.** `Run now` + a repeat is fine — the first
   run fires immediately and the series starts at the *next* occurrence — but `Now` + `Once`
   runs exactly once and the item then switches itself off (which reads as **Finished**, not
   as a failure).
2. **Touching a chip and then expecting the AI to fix it.** A touched chip always wins; the
   composer only fills blanks.
3. **`Pick a moment…` left half-filled.** Send stays disabled until both date and time are set.
4. **Thinking colleagues can see it.** Cowork is strictly per-user; there is no sharing.
5. **Reading "Runs 42" against "Succeeded 3" as data loss.** Runs is the lifetime tally;
   succeeded/failed count only the history still kept (90 days). The Succeeded card says
   *"older runs are no longer kept"* in that case.
6. **Expecting a cost figure.** There is none, by design.
7. **Deleting to "clean up".** Delete removes the run history too, irreversibly. Pause is the
   reversible option.
8. **Switching one app off in the item's Apps picker** — that materialises a per-item list and
   from then on the item ignores workspace-wide changes. Use **Follow my workspace list** to
   go back.
9. **Assuming a failed one-off will retry.** It is deactivated; press **Run now** after fixing.
10. **Looking for a chat thread for a non-agent cowork.** There is none — the notification and
    the run history are where the output lives.
11. **Changing the time but not the repeat** (or vice versa): the row's "when" line is built
    from `repeatInterval` + `timeOfDay` + `daysOfWeek`, so a lone date change on a repeating
    item does not move the series.
12. **Briefs that ask a question.** The runner is told never to ask follow-up questions; a
    vague brief produces a vague unattended answer.
13. **Very long chains of work.** More than ~20 tool calls hits the cap; split the brief or
    attach an agent.

---

## 11. Three scenarios — Van Dijk Groep (Dutch SME)

**Procurement — "Leveranciersradar"**
Inkoper Bart opens Cowork and types: *"Elke werkdag om 07:30: vat de nieuwe mails van
leveranciers samen, groepeer per leverancier, en noem per bericht het ordernummer, het bedrag
en de uiterste reactiedatum."* He opens the **Apps** picker and enables only Outlook. The
composer sets `Every weekday` + `07:30`; he presses **Schedule**. The row shows
`Every weekday 07:30 · Waiting to start`. Next morning the bell holds the digest; after two
weeks the Figures card reads `Runs 10 · Succeeded 10 · Average 0m 52s`.

**HR — "Maandelijkse voortgangsrapportage"**
HR-adviseur Saskia types: *"Op de 1e van elke maand: schrijf een korte voortgangsrapportage
op basis van mijn vergadernotities van de afgelopen maand, met openstaande acties per
medewerker."* She sets **Repeat → Every month** herself and **When → Pick a moment…**
(1 October, 08:00). Because the brief involves personnel data she leaves **Run as** on
`No agent` and switches off every app except the notes source. She checks the assignment text
under **Edit** before the first run and shortens it.

**Sales — "Vrijdagse openstaande-offertes lijst"**
Accountmanager Daan starts in chat, flips the header switch to **Cowork**, and types:
*"Elke vrijdag om 16:00: welke offertes van deze week hebben nog geen antwoord gekregen? Geef
klant, bedrag en hoeveel dagen het stil is."* The toast confirms
*"Openstaande offertes — Friday at 16:00, every week."* Two weeks later a run fails with
**Needs sign-in** because his Google token expired; he reconnects under Settings →
Integrations and the schedule resumes itself on the next minute tick.

---

## 12. API — list/read endpoints a "did the learner do it?" check can call

All of these live in `server/routes/cowork.js` behind `router.use(requireAuth)` (session
cookie; 401 when anonymous) and are scoped to the signed-in user. No licence or permission
middleware. Base path `/api/cowork`.

| Method + path | Returns | Row fields (incl. owner) |
|---|---|---|
| `GET /api/cowork` | `{ schedules: [...], maxSchedules: 10 }` | `id`, **`userId` (owner)**, `title`, `prompt`, `repeatInterval`, `daysOfWeek`, `timeOfDay`, `nextRunAt`, `lastRunAt`, `lastResult`, `lastStatus`, `isActive`, `modelTier`, `toolsEnabled`, `enabledApps`, `maxResultLength`, `runCount`, `timezone`, `agentId`, `conversationId`, `createdAt`, plus `agentName`/`agentAvatar` (enriched) and `currentRunStartedAt` (ISO or null) |
| `GET /api/cowork/:id` | one schedule (same shape + `currentRunStartedAt`) | 404 `Not found`, 403 `Forbidden` for another user's item |
| `GET /api/cowork/:id/runs?limit=&offset=` | `{ runs: [...], total }` — newest first, limit default 25 / max 100 | `id`, `scheduleId`, **`userId` (owner)**, `status` (`running`\|`success`\|`error`\|`needs_reauth`), `triggerKind` (`manual`\|`schedule`), `startedAt`, `finishedAt`, `durationMs`, `result`, `error`, `producedOutput` (true/false/null) |
| `GET /api/cowork/:id/stats` | `{ total, success, failed, avgDurationMs, runCount, createdAt }` | `total/success/failed` = kept history; `runCount` = lifetime; `avgDurationMs` null until a run finished. No cost/token fields. |

Mutating endpoints (same auth, for reference): `POST /api/cowork` (body `title`, `prompt`,
`nextRunAt`, optional `repeatInterval`, `daysOfWeek`, `timeOfDay`, `timezone`, `modelTier`,
`agentId`, `enabledApps`, `startNow`), `PUT /api/cowork/:id`, `DELETE /api/cowork/:id`,
`POST /api/cowork/:id/toggle` → `{ success, isActive }`,
`POST /api/cowork/:id/run-now` → `{ success: true, message: 'Cowork started. The result
arrives in your notifications.' }`, `POST /api/cowork/compose` (body `brief`, `timezone`) →
the spec, creates nothing.

Related reads: `GET /agents/all` — the "Run as" list; **requires permission `manage_agents`**
(403 otherwise, which the UI treats as "no agents"). `GET /api/privacy/shield-status` —
carries `coworkEnabled`.

**Recommended verification recipe** (this is exactly what `actionChecks.js` already does for
the `cowork-first` lesson):
- *created*: `GET /api/cowork` → `schedules.length > 0`
- *ran at least once*: any schedule with `lastRunAt` set **or** `runCount > 0`
- *ran successfully*: `GET /api/cowork/:id/runs` → any run with `status === 'success'`
  (add `producedOutput === true` if the lesson requires real output)
- *is a repeat*: `repeatInterval !== null` **or** `daysOfWeek?.length > 0`
- *is delegated to an agent*: `agentId !== null`
