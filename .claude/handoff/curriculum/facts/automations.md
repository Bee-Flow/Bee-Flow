# Fact sheet — Automations (Studio → Automations)

Audience: **builder** (someone who designs and ships automations for their team).
Everything below was read from the repo the repo root on 2026-09-14
(branch `claude/builder-redesign-fase-1-6sun0h`). UI strings are quoted verbatim from
the source; where a string is served through i18n the key is given so an author can
verify it.

**Exists: yes — this is one of the largest, most mature areas of the product.**
~29k lines of frontend under `agent-hub/src/components/automation/`, a full
route family under `server/routes/automation/`, and a DAG execution engine under
`server/core/automationRunner/`.

---

## 1. What the feature is for

A **automation** (internally "automation") is a saved, typed **DAG** of steps that runs on
its own. It starts from exactly one primary **trigger** (optionally plus extra entry
points), walks its steps, and records everything it did as a **run**.

Three things distinguish it from a chat prompt:

1. It **runs unattended** — on a clock, on an inbound event, on a form submission.
2. It has **state and an audit trail** — every run and every step is stored with its
   input, output, error and duration; egress (what left the platform) is logged
   unconditionally for source `automation`.
3. It can **pause for a person** — approval steps and form pages suspend the run and
   resume it days later as a continuation of the same journey.

Naming note for lesson copy: the product calls the Studio section **"Automations"**
(`studio.tab.automations`), the URL slug is `/app/studio/automations`, and the objects
inside it are called **automations** in almost all newer UI copy (`automations.*` i18n
namespace, "Design the automation on the canvas"). Both words are correct; "automation" is
the current house style, "automation" is the section name and the API name.

---

## 2. Where it lives, screen by screen (real labels)

### 2.1 Getting there

- Left sidebar → **"Studio"** (`studio.sidebar_link`), then the section
  **"Automations"** — subtitle **"Multi-step automations that run for you"**
  (`studio.tab.automations` / `studio.tab.automations_desc`), icon `ListChecks`.
- URL: `/app/studio/automations` (legacy slugs `routines` and `ai-tasks` still parse).
  One automation: `/app/studio/automations/<id>`; a reusable Step:
  `/app/studio/automations/steps/<id>[/<flowletKey>]`.
- Sibling sections that belong to the same mount and the same licence gate:
  **"Datatables"** ("Rows your automations keep between runs"), **"Forms"**,
  **"Approvals"**, and **"Runs & log"** ("Every time an automation fired, and what
  happened", `runs.title` / `runs.tab_desc`).

### 2.2 Start screen (no automation selected) — `AutomationsStudio/AutomationsLauncher.jsx`

A four-tab launcher; the chosen tab is remembered per user (`scopedStorage` key
`automationsStartTab`, default `overview`). Since 2026-09-28 (owner) there is no
**Build with AI** tab or start-screen button and no **Steps** tab: the sidebar's
**+** is a split button (the main part = **"New automation"**; the chevron beside
it offers **"New automation"** / **"New building block"**, hint "A reusable step
you can drop into any automation"), and describing an automation in plain language
happens in the builder's assistant beside the canvas (see W2). Reusable Steps are
listed as **"Building blocks"**, a collapsible group in the same sidebar list,
below the automations and folders.

| Tab | Content |
|---|---|
| **All automations** | The library overview of your automations (list, cards or board), with its own empty state and create button. |
| **Find repeating work** | Header "Find repeating work" with a **"Last 90 days"** chip. Four source tiles, each with a switch: **Mail** (Gmail, Outlook, Nextcloud Mail; eyebrow "Source · Live"), **Calendar & meetings** (Teams and Google Meet imports, Talk recordings; "Source · History"), **Files** (Nextcloud, OneDrive, Google Drive; "Source · Live") and **Bee Flow activity** (your own chat tool calls and knowledge uploads; "Source · History"). A tile with nothing connected is dashed and reads **"Nothing connected yet"** with a **Connect** link. A **"Focus"** chip opens the optional field ("Optional: a focus, like invoices or support tickets"). Button **"Scan my recent work"**; disabled with **"Switch on at least one source to scan."** when every tile is off. The scan is drawn as a small flow: **Read your work** → **Find templates** ("Names and numbers masked") → **Spot repeats** → **Name patterns** ("The AI sees patterns only"), with a **Stop** chip and a **Details** log per app. Each result is a pattern card: eyebrow like "Pattern · Weekly · Mon 09–10", evidence pills ("12× in 90 days", "12 of 13 weeks", "≈1–2 h/month (estimated)", the apps), a weekday strip, a "Looks like" template line with placeholders, a trigger → steps preview, **"Why this ranks here"**, and the actions **"Build this"** (opens the builder and sends it), **"Adjust first"** (pre-fills only), **"Not now"** (hidden 30 days) and **"Not repetitive"** (four reasons), with **Undo** for a few seconds. Footnote: **"No message text was sent to the AI, only patterns."** Empty states: **"Nothing to scan yet"** / "Connect an app first. Bee can only look at apps you have connected."; **"Not enough history yet"**; **"No repeating work spotted"**, with **"Suggest ideas instead"**. Results are per person, never shared with colleagues. Rate-limited: "You have scanned a lot in a short time. You can scan again in {seconds}s." |
| **Templates** | Gallery of server-side templates (see §5). |
| **Runs** | The executions panel, same data as Studio → Runs & log. |

Older list surface (`automation/ListView.jsx`) still carries the empty state
**"No automations yet"** with "Schedule recurring AI workflows — like a weekly news digest
or daily lead report. Results land in your notifications when they're ready." and the
button **"Create your first task"**.

Left rail of the section: automations grouped in **folders** (org-wide labels) —
"Folder name" placeholder, tooltips "Rename this folder", "Remove this folder — the
automations in it stay", drop hints "Drop here to take it out of its folder." and
"Empty — drag an automation here.", plus a **"Move to folder"** menu.

### 2.3 The builder — header (`Builder/BuilderHeader.jsx`)

Back button title **"Back to Automations"**; a browse button **"Browse automations"**
(**"Browse Steps"** in Step mode).

**View switcher** (`VIEWS`, ids are persisted so don't rename them in copy):

| Label | id | Description shown |
|---|---|---|
| **Editor** | `build` | "Design the automation on the canvas" |
| **Settings** | `settings` | "Name, sharing and behaviour" |
| **Runs** | `history` | "What happened each time this automation ran" |
| **Versions** | `versions` | "Earlier versions you can open or make live" |

Other header controls: **Undo** ("Undo your last canvas change (⌘Z) — this is not a
saved version") / **Redo** (⌘⇧Z); **Diagnose** ("Probe the trigger pipeline
(subscription, credentials, Gmail, filter)"); an activation toggle reading **"Pause"**
or **"Activate"**.

**Run split-button** (`header/TestRunMenu.tsx`): the visible half is **"Test"** (a
dry-run) with the tooltip "Test the working copy: no real actions, a safe preview".
The chevron ("More ways to run") opens:
- **"Dry-run (preview)"** — "No real actions, a safe preview"
- **"Run live"** — "Executes every step for real"
- a **"Start from"** group listing the primary trigger plus every additional trigger
  (only on multi-trigger automations).

In building-block mode the header shows, instead of the run controls, the audience
menu, **"In chat"** ("Make this Step callable as a tool in direct and agent chat") and **"Publish"** ("Publish — automations and
chats using this Step pick up the change").

### 2.4 The canvas — empty state (`flow/DiagramEmptyState.jsx`)

Title **"What does this automation start with?"** (`automations.canvas.empty_title`),
subtitle **"Every automation has exactly one trigger. Pick one, or let the assistant
write the automation."** Then a 3-column grid of all seven triggers, short names:
**Manual · Form · Schedule · Webhook · App event · Agent call · Studio App**.
Below: **"Or describe the automation:"** with the italic example
*"annual report via a form → analysis per bank → memorandum"*.

While the AI is building: a pulsing line **"Building · 0:04 · <caption>"**, default
caption "Choosing a trigger…".

### 2.5 The canvas — add-step ribbon (`flow/AddStepRibbon.jsx`, `flow/stepPalette.js`)

Tabs across the ribbon: **AI**, **Logic**, **People**, **Data & documents**,
**Nextcloud apps** (only when the org has a Nextcloud app), **Other apps**, **My
building blocks** (`flow/ribbon/ribbonCategories.ts`). Drag hint on every item:
"Click to add, or drag it onto the canvas." Search field placeholder **"Add a
step…"**. The ribbon holds no triggers (its search skips them too); an extra trigger
is added from a node's **+** ("Add next step") or a connection's **+** ("Insert a
step here"), which open the **"Add a step here"** panel (search "Search steps…")
with a **Trigger** group on top.

Groups (`buildStepGroups`): **Trigger**, **AI**, **Action** (per-app categories),
**Flow** (sections **Flow control**, **People & waiting**, **Data & lists**,
**Integrations**), **Flowlets**, **Steps**.

### 2.6 Canvas south bar and node menu

South bar hint: **"Drag to select · Space or middle-drag to pan · Tab jumps to the next
step"**; selection readouts "1 step selected" / "{n} steps selected"; a legend toggle
**"What the marks on the canvas mean"** → **Legend** with entries such as "a branch
label — the run follows labels only" and "a line carrying personal data".
Live-run banner: **"Live run"** / **"Run failed at"** + **"Go to step"**, and
**"Open the form"** when a run waits on a form page.

Right-click a node (`flow/NodeContextMenu.jsx`): **Expand flowlet / Collapse flowlet**,
**Disable / Enable**, **Duplicate** ("Triggers cannot be duplicated"),
**Disconnect** ("Take this step out of the flow — it stays on the canvas and its
neighbours reconnect"), **Delete** ("The primary trigger cannot be removed", shortcut
`Del`).

### 2.7 Node inspector (`NodeDetailView.jsx`, `flow/settings/*`)

Two density modes: **Simple** / **All options** ("How much of this step to show",
"Show all options ({count})" / "Show fewer options"). Value modes per field:
**Text** vs **Formula** — "Plain text — type a value. Use `{{ }}` to insert data from a
previous step." / "Expression — compute the value, e.g. `steps.s1.output.total > 100`".
Helpers: **"Insert data from a previous step"**, **"Fields of {step}"**,
**"What can I write here?"**, **"Syntax help"**, **"Changes save automatically."**,
**"Undo changes"**. Validation strip: **"Fix this before the automation can run:"** and
**"Worth checking:"**.

### 2.8 Settings view (`Builder/SettingsTab.jsx`)

Rows: **Title**; **Description** ("Optional. Shown to admins reviewing this
automation."); **Notifications** with three switches — **On success**
(preview `🤖 <title> — run summary`), **On error** (`⚠️ Automation failed: <title>`),
**On approval** (`🛂 Approval needed: <title>`); **Editor** ("Personal preference for
this browser — applies to every automation you edit.") with the checkbox
**"Auto-map step inputs when connecting"**.

### 2.9 Saved versions (`Builder/VersionHistoryPanel.jsx`)

Panel title **"Version history"**; empty **"No saved versions yet."**; per row
**"View diff"** and **"Restore this version"**; a **"Compare with:"** picker and the
note "Need the exact delta? Use **Raw JSON** above for a line-by-line diff."

### 2.10 Runs & log (`admin/Studio/Runs/RunsStudio.jsx`)

Title **"Runs & log"**; intro "Every time an automation fired: what started it, what it did,
and what went wrong. Opening a run shows it step by step."
Scope switch **"Whose runs"** → **"My runs"** / **"Organisation"**; when scoped to the
org: "The organisation's runs do not update by themselves — refresh to see new ones.
Only the person who started a run can open it." A refusal shows "Could not read this
scope."

**"Now running"** strip, window **"last 24 hours"**; empty "Nothing has run in the last
24 hours."; and the honest failure line "Could not read what is running — this is not
“nothing is running”."

Filters (`Executions/ExecutionsFilterBar.tsx`): status chips **All · Finished · Failed ·
Running · Waiting for someone · Stopped**; range **24h · 7d · 30d · All**; selects
**Trigger**, **Live or test** (**Live runs** default · **Tests only** · **Live runs and
tests**) and **Automation**, folded behind a **Filter** button on narrower screens;
**Clear** resets only those selects.

Status words (`run_status.*`): **Finished · Failed · Running · Waiting to start ·
Paused · Stopped · Waiting for approval · Waiting for a form · Skipped ·
Nothing to do · Recovered · Frozen data**, plus the small **dry-run** pill shown
*beside* the outcome (so a dry-run that failed reads "Failed · dry-run").

---

## 3. Concepts a learner must understand

- **Automation / automation** — a saved graph with exactly one *primary* trigger, a set of
  steps and the edges between them, stored as a `definition` JSON document. Owned by
  one user (`userId`); automations are **owner-private on every licence tier** — there is
  no sharing column on the table.
- **Trigger** — how a run starts. Seven kinds (§4).
- **Additional trigger** — an automation may gain *extra* entry points in
  `definition.triggers[]`. Only `webhook`, `app_event` and `schedule` may be secondary
  (`CAN_BE_SECONDARY`); `manual`, `form`, `agent_call` and `app_trigger` can only ever
  be the single primary trigger, and dropping one asks before it *replaces* the current
  trigger.
- **Step** (lower-case) — one node of the graph. Has a type, a label, inputs, and an
  output other steps can bind to.
- **Step** (capital S, `kind: 'block'`) — a *reusable* automation with an input contract
  and a declared output, built in the same canvas, added to other automations via
  `call_block`, optionally **Published** and optionally exposed **In chat** as an
  agent tool. Lives in its own library, not the main list.
- **Flowlet** (`call_layer` / `layer_output`) — an inline sub-flow *inside* one automation.
  Grouping tool, not a shared object. "Create flowlet — Group steps into a reusable
  sub-flow."
- **Binding** — `{{steps.s1.output.total}}` / `{{trigger.output.subject}}`. Text mode
  interpolates; formula mode evaluates.
- **Run** — one execution. Carries `status`, `triggerKind`, `mode` (`live` or
  `dry_run`), `startedAt`/`finishedAt`, `durationMs`, `summary`, `error`, `errorClass`,
  `handledErrorCount`.
- **Journey (`rootRunId`)** — a run that pauses on a form page or an approval resumes as
  a *child* run. The history collapses the chain into ONE row; `journeyRunId` is the leg
  that Stop/Approve actually act on.
- **Dry-run** — a preview pass. Side-effecting tool calls are **synthesised**, not
  executed; a Privacy Shield block becomes an annotation ("would block") instead of a
  failure; a code step's code RUNS in the sandbox, but every outside call it makes
  (`ctx.http`, `ctx.integrations`) is only recorded and answered with a placeholder
  ("would have called"); `http_request` writes (and any read that carries a
  saved credential) are synthesised so a dry-run never decrypts a credential.
- **Live run** — every step executes for real.
- **Draft vs active** — a new automation is `isDraft: true`, `isActive: false`. Saves are
  validated at `stage: 'draft'` (only integrity problems block); **Activate** runs the
  strict pass and is the gate that lets anything go live.
- **Pinned output ("Frozen data")** — a step can serve a saved sample instead of running.
  Activation warns: "… serves pinned data instead of running — live runs will use that
  saved sample, not fresh data."
- **Privacy Shield step** — one palette entry, **four modes** (`Builder/flow/privacyModel.js`,
  `PRIVACY_MODES`, BFSF-355; editor in `flow/settings/privacyEditors.jsx`):

  | Mode id | Mode label in the editor | Stored runtime type | Scans | Branches | Hides |
  |---|---|---|---|---|---|
  | `check` | **Check for personal data** — "Scan a value and send the run down one path or the other." | `guard` | yes | yes | no |
  | `check_hide` | **Check and hide** — "Scan, branch on the answer, and replace what was found with placeholders." | `guard` + `onFound.tokenize` | yes | yes | yes |
  | `hide` | **Hide personal data** — "Replace personal data with placeholders. The real values come back later." | `tokenize` | yes | no | yes |
  | `reveal` | **Show real values again** — "Put the real values back where a step still holds placeholders." | `untokenize` | no | no | no |

  The mode is a *view* on three runtime types: `check` and `check_hide` are both stored as
  `guard` and told apart by `onFound.tokenize` (`readPrivacyMode`), which is why the node
  palette still lists exactly three types while the editor offers four modes. Only the two
  check modes have two ports, so switching mode can drop the "personal data" / "clean"
  connections — the editor asks first (`droppedEdgesOnModeChange`) rather than silently
  rewiring. A drop, and anything unrecognised, reads as **`check`**, because it is the only
  mode that changes no data.

  > **Correction 2026-09-15.** This sheet previously said "three modes: *Find personal data*,
  > *Hide personal data*, *Show real values again*" — it described the three runtime node
  > types (`guard`/`tokenize`/`untokenize`, whose labels those are) and missed **Check and
  > hide** (`check_hide`), the fourth mode in the editor's own mode picker.
- **Datatable** — org-scoped rows that outlive the run. Together with
  **To knowledge base**, the only two step types whose effect survives the run.
- **Egress log** — every integration action and AI tool call writes a metadata row for
  `source='automation'`, unconditionally. Content scanning is what the org's
  `monitorIntegrations` setting gates, not the logging.

---

## 4. Triggers (real palette copy, `flow/stepPalette.js` + `flow/triggerLabels.js`)

| Palette label | Palette description | Node name | Type kicker |
|---|---|---|---|
| **Trigger manually** | Run from a button click | Manual | Manual trigger |
| **On form submission** | Publish a form; every submission runs this | Form | Form trigger |
| **On a schedule** | Run at a fixed time, over and over | Schedule | Schedule trigger |
| **On webhook call** | Run when an HTTP request arrives | Webhook | Webhook trigger |
| **On app event** | Run when something happens in a connected app | App event | App-event trigger |
| **When an agent calls it** | Expose as a tool an AI agent can call from chat | Agent | Agent trigger |
| **From a Studio App** | Run when a Studio App action calls it, with typed inputs | Studio App | Studio App trigger |

Schedule editor (`flow/ScheduleBuilder.jsx`): **Every N minutes · Hourly · Daily ·
Weekly · Monthly · Advanced — custom pattern**. Default timezone
**`Europe/Amsterdam`**. It previews the next runs via `POST /_schedule/preview`
(default 3, hard cap 5). The word "cron" is deliberately kept out of the UI but stays
searchable.

Webhook trigger: **`POST /api/automation/webhook/:slug`** — public, but requires
`X-BeeFlow-Signature: sha256=<hmac>` over `"<nonce>\n<JSON body>"` plus a fresh
`X-BeeFlow-Nonce`. Body limit **256 kB**. Replayed nonce → 401. Inactive or draft
automation → **409 "Automation is not active"**. Request headers land at
`trigger.headers.<name>`, never inside `trigger.output`.

Form trigger: the automation gets a hosted public page at **`/f/<token>`**. It works only
when the automation is **both active and not a draft** (`live: row.isActive && !row.isDraft`).

---

## 5. Step palette (built-in types) — labels and descriptions

From `flow/nodeDefs.js` (label + desc) grouped as the ribbon groups them:

**AI**
- **AI step** — "Reason and call tools with AI"
- **Extract data** — "Pull named fields out of text — an invoice, an e-mail, a PDF"

**Action** — one node per connected app action (`integration_action`), grouped by the
integration catalog's categories.

**Flow control**
- **Condition** — "Keep, split or branch — one rule or many" (this ONE node replaced If,
  Switch and both Filters; the runtime type swaps between `condition`/`switch`/`filter`
  as the editor grows)
- **Repeat for each** (`loop`) — "Run the steps inside once for every item in a list"
- **Privacy Shield** (`guard`/`tokenize`/`untokenize`) — "Check for personal data, hide
  it, or show the real values again" (one entry; the editor then offers **four** modes, §3)
- **Stop with an error** — "End the run now and record why"
- **Back to the app** (`return_to_app`) — "End the run and tell the app what to do next"
- **Note** — "A sticky note for context — never runs"

**People & waiting**
- **Form: ask for more info** (`form_page`, mode `input`) — "Pause the run and show
  another form page on the same link"
- **Form: closing page** (`form_page`, mode `ending`) — "Close the form with a message
  about what happened"
- **Ask someone to approve** (`approval`) — "Pause the run until a person approves or
  rejects it"
- **Wait** — "Pause before the next step — seconds, minutes or hours"
- **Notification** — "Send a message or alert"

**Data & lists**
- **Datatable** — "Keep rows that outlast the run — and share them with other automations"
- **To knowledge base** (`knowledge_write`) — "Save text where an agent can find it later"
- **Edit data** (`set`) — "Add, rename and organise fields — for one record or a whole table"
- **Date & time** — "Get today's date, reformat one, add days, or compare two"
- **Make a document** (`generate_document`) — "Turn text from an earlier step into a PDF
  or Word file"
- **Shorten list** (`limit`), **Remove duplicates** (`dedupe`), **Collect one field**
  (`aggregate`), **Add up or count** (`summarize`)

**Integrations**
- **Call a web service** (`http_request`) — "Send a request to a system that has no
  ready-made action here"
- **Code** — "Run custom JavaScript" (works out of the box, no switch; see §8)

**Flowlets** — **Create flowlet** ("Group steps into a reusable sub-flow") and
**Flowlet output** ("Return data from this flowlet to its caller").

Two palette rules a builder must know:
- **`approval`, `form_page` and `return_to_app` are FILTERED OUT** inside a flowlet or a
  loop body — a pause has no address to resume to, and a terminal step isn't the end of
  a sub-graph.
- **`form_page` is shown but disabled** without a form trigger, with the reason
  *"Form steps run on the automation's own form link — switch the trigger to "Form" to use
  this."*

---

## 6. End-to-end workflows (exactly as a user clicks)

### W1 — Build a scheduled automation by hand, test it, ship it
1. Sidebar → **Studio** → **Automations**.
2. Press the sidebar's **+** (**New automation**). A draft row is created
   immediately — `POST /api/automation/` with `isDraft: true`.
3. The canvas shows **"What does this automation start with?"** — click the **Schedule**
   card.
4. In the node panel choose **Daily**, set the time, leave **Europe/Amsterdam**; the
   panel shows the next three firing times.
5. Press **+** on the ribbon (or drag from it) and add the steps, e.g. an **Action**
   (Gmail: search mail) → **AI step** → **Notification**. Every drop autosaves —
   "Changes save automatically."
6. Fill each step's fields. Use **Insert data from a previous step** to bind
   `{{steps.<id>.output.<field>}}`.
7. Press **Dry-run**. The Dry-run panel opens ("Dry-run preview (success)") and every
   node on the canvas gets its recorded input/output.
8. Fix anything under **"Fix this before the automation can run:"**.
9. Press **Activate**. The server runs the strict validation pass (unknown tools,
   missing required inputs, unauthorised knowledge bases, a cron with no next run) and
   only then sets `isActive: true`, `isDraft: false` and arms `nextRunAt`.
10. Watch **Runs** (in the builder) or **Studio → Runs & log**.

### W2 — Build with the assistant
1. Studio → Automations → **+** (New automation). On the empty canvas, the row
   **"Or describe the automation:"** has an **"Assistant"** button that opens the
   assistant panel (header **"Assistant"**) beside the canvas. A closed panel can
   also be reopened from the slim rail on the canvas's left edge. An empty chat shows
   **"Build with the assistant"** with a few suggested prompts that pre-fill the
   chat box (never auto-send).
2. Type the automation in plain language into the assistant panel and send. The stream goes to `POST /api/automation/builder/stream`
   (12 requests/min/user).
3. Watch the canvas narrate itself: **"Building · 0:07 · Placing Gmail…"**,
   **"Plan 3/6"**, **"Adding 4 steps…"**, **"Reviewing the automation…"**, finishing with
   **"Built · 9 steps · 1m 12s"**. While it builds, editing is paused — "The AI is
   building this automation — editing is paused until it finishes."
4. The assistant normally runs a dry-run itself ("Tested the automation") and then
   "Finished and saved".
5. **A finalised automation is still inactive** — the builder tooling cannot switch a
   automation on; a human presses **Activate**. (Stated explicitly in the automations MCP
   contract.)
6. Refine by chatting again, or open any node and edit it by hand.

### W3 — Publish a form that feeds an automation
1. New automation → pick the **Form** trigger card.
2. In the trigger panel give the form a title/description and add its questions; set
   the **audience** (org users/groups) — new forms are owner-only by default.
3. Add the steps that process the submission; optionally add **Form: ask for more info**
   for a second page and **Form: closing page** for the result screen.
4. Press **Dry-run**, then **Activate**.
5. In the trigger panel (or Studio → Forms) copy the **`/f/<token>`** link and send it.
   `POST /api/automation/:id/form` mints it; `POST /:id/form/:token/rotate` mints a new
   one and kills the old; `DELETE /:id/form/:token` takes it offline.
6. Every submission is one run; a paused multi-page form is **one** history row
   (`rootRunId`).

### W4 — Read a failed run and retry it
1. Studio → **Runs & log** (or the builder's **Runs** view).
2. Filter with the **Failed** chip; pick the automation in the **Automation** filter if you want one.
3. Click the row. The step timeline shows each step with its status icon, its recorded
   **input**, **output** and **error**, and the flow snapshot **as it was at run time**
   (the run's `version`, not today's definition).
4. Fix the step in the **Editor**.
5. Re-run just that step: node menu → run it with `POST /:id/steps/:stepId/run`
   (`mode: 'only' | 'from' | 'upTo'`), which replays upstream data instead of
   re-executing it.
6. Or retry the whole run: `POST /:id/runs/:runId/retry` — the new run is linked to the
   old one by `parentRunId`.

### W5 — Add a human approval
1. Open the automation → ribbon → **People** tab → **Ask someone to approve**.
2. Write the prompt (bindings allowed), pick approvers from the org directory
   (colleagues and org groups only — naming somebody outside your org is a **save**
   error, not a silent runtime fallback), optionally attach up to 5 files and 20
   question fields, and set a deadline.
3. Activate. When the run reaches the step it records `awaiting_approval` and stops.
4. The approver gets a notification ("🛂 Approval needed: …") and decides in
   **Studio → Approvals** (or the sidebar **Approvals** row).
5. On approve the run continues in a new leg; the history still shows one journey row.
6. If nobody decides in time the reaper flips the run to `error` with class
   **`ApprovalExpired`**.

### W6 — Turn an automation into a building block and call it from chat
1. The sidebar's **+** chevron → **New building block**.
2. Build it; its trigger is an input contract rather than a real trigger.
3. Press **Publish** ("automations and chats using this Step pick up the change").
4. Toggle **In chat** to expose it as an agent-callable tool.
5. In any automation, add it from the ribbon's **My building blocks** tab (a `call_block`
   step, shown on the canvas as a **Step** node).

---

## 7. Defaults, limits and numbers

**Graph size** (`server/automation/validate/constants.js`)
- Max **500 steps** per graph (root, or one flowlet), max **2000 edges** per graph,
  max **3000 nodes** total across root + all flowlets.
- Flowlet/Step nesting depth: **8** (`MAX_LAYER_DEPTH`); cycles are caught separately.

**Runs** (`core/automationRunner/shared.js`)
- Default per-run hard timeout **5 minutes**; per-automation override capped at **60
  minutes** (`run_timeout_ms`).
- Scheduler tick **60 s**; event polling tick **30 s**; reaper tick **60 s**; retention
  sweep hourly.
- **Max 5 concurrent runs** processed by a runner pod (`MAX_CONCURRENT`).
- A second run of the *same* automation waits up to **300 s** (`AUTOMATION_CONCURRENT_WAIT_MS`)
  and is then recorded as **"Skipped — this automation was already running."**
- Reaper: floor **6 min**, buffer **60 s**, max **5 attempts**.
- Run-history retention: **90 days** (`AUTOMATION_RUN_RETENTION_DAYS`, `0` disables),
  swept in batches of 5000, max 20 batches per pass.

**Steps**
- Loop `maxIterations`: **1…1000** (the validator's hint says "100 is a sensible
  default"); optional `batchSize` defaults to 1.
- Collection ops (Shorten list / Remove duplicates / Collect one field / Add up or
  count / Condition-over-a-list): hard ceiling **10 000 items**
  (`AUTOMATION_COLLECTION_MAX_ITEMS`); a step's own `maxItems` may only tighten it.
- **Edit data**: max **20 table operations**.
- **Extract data**: max **30 fields**, instructions max **2000 chars**, source text max
  **60 000 chars**. No model picker — it runs on the ONE extraction model an admin set
  (`data_extraction_model`, Admin → AI config). The field names ARE the output shape and
  are coerced to lowercase snake_case as you type.
- **Approval**: deadline default **7 days** (`AUTOMATION_APPROVAL_TTL_MS`), hard cap
  **30 days / 720 hours**; max **5 attachments**, max **20 fields**.
- **Form page** wait: default **1 hour**, min **1 minute**, max **7 days**.
- **Make a document**: max **25 MB**; kept **7 days** by default, 1–90 days allowed.
- **Note**: max 4000 characters, size 40–2000 px.
- **Datatable** step: max **20 filters**, read limit capped at **1000** rows.
- **Call a web service**: "Block requests to private/internal addresses" defaults to
  **on**.
- AI step: up to **5 skill ids**; model **tier** lives under **Advanced** and defaults to
  `auto`.

**Rate limits (per user, per minute)**
- Run / dry-run / step-run / retry / agent-invoke / schedule-preview: **30**
  (`AUTOMATION_RUN_TRIGGER_RPM`).
- Import: **10**. AI builder stream: **12**. Flowlet agent: **8**. Suggest scan: **10**.
  Label steps / summarise flowlet / map JSON fields: **20**. Feedback: **30**.
- Manual run waits synchronously up to **60 s**, then returns `202` with
  "Run is still in progress. Check the run history shortly."

**Other**
- Inbound webhook body limit **256 kB**; Gmail/MS Graph event bodies **128 kB**.
- Notification channels: `inapp` (always on), `email`, and on **approvals** only
  `nc_talk` / `nc_notification`. Notification *step* channels are `notification`/`inapp`
  and `email`; an unknown channel is filtered and reported, and a step with **no** known
  channel fails loudly rather than "delivering" nothing.
- Notification defaults: **On success** off, **On error** on (level `urgent`),
  **On approval** on (level `heads_up`).

---

## 8. What happens on failure

- A failing step is recorded immediately at `attempts: 1` with status `error`, its
  message and a typed **error class** (`TransientError`, `PermissionError`,
  `IntegrationError`, `ValidationError`, `TimeoutError`, `UserCanceledError`,
  `ApprovalExpired`, …). Unknown errors are classified into the nearest sibling.
- **Retry is opt-in per step** (`step.retry.max`, `step.retry.backoffMs`); there is no
  automatic retry by default. Every attempt is recorded — intermediate failures stay in
  the audit trail so flaky tools are visible.
- **`on_error` edge**: wire a step's failure output to its own path
  ("Added a fallback for failures" in the builder's activity log). When a failure is
  absorbed this way the run still reports **success** and carries
  `handledErrorCount` — the UI shows **"Recovered"** / "N handled".
  `on_error` is not allowed on branching steps (a condition/switch's own labels would be
  shadowed) nor on approval/form steps.
- **Stop with an error** ends the run deliberately and records why.
- A run that exceeds its timeout is reaped; a run stuck on an approval past its deadline
  becomes `error` / `ApprovalExpired`.
- A **concurrent** fire of the same automation waits, then is recorded as
  `Skipped: automation already running`.
- A **manual run on an app-event automation with no payload** does not pretend: for Gmail
  and Nextcloud triggers the server first tries to synthesise a payload from the most
  recent matching item, and if there is none it answers
  *"No matching email found in your inbox to test against. The automation is ready — it
  will fire when a new matching email arrives."*
- **Activation refuses** on: an invalid definition, an unknown or unpermitted tool, an
  empty required input, an unauthorised knowledge base, a bad stored cron
  (`Cannot activate — invalid schedule "…"`), or a cron with no upcoming run
  (`Cannot activate — schedule "…" has no upcoming run time. Check the day/month
  combination.`). Pinned steps produce a non-blocking warning.
- **Privacy Shield block** in a live run raises a `GuardrailBlockError`; in a dry-run it
  is downgraded to a "would block" annotation.
- **Code step** failures: there is NO switch for code steps (since 2026-09-29: no platform
  config flag, no organisation beta; they work out of the box). The only refusal is an install
  without the sandbox (isolated-vm): "Code step unavailable: ..." in a run, and the palette shows
  Code greyed out with "This server was installed without the code sandbox, so a code step could
  not run here."
---

## 9. Permission and licence gates

**Mount** (`server/index.js:716`):
```
app.use('/api/automation',
  requireModule('automation'),
  requireLicenseFeature('automations'),
  require('./routes/automation'));
```
and inside `routes/automation.js`: `requireAuth` → `requireBetaFeature('automations')`
→ `requireActiveOrgForMutations()`. (Public routes — inbound webhook, app-event pushes,
the hosted form — are mounted *above* `requireAuth` by design.)

- **Licence feature `automations` is Community** (`server/license/tiers.js`) — the
  "n8n-style free builder". Building is free.
- **Beta feature `automations`** (GA lifecycle) must also be on for the org; admins
  toggle it in the admin dashboard → Security → Beta. Super admins always pass.
- **`/api/automation/builder` (Build with AI)** carries the same pair.
- **Enterprise, on top**: `automation_sharing` (org-wide sharing; declared, no route
  consumes it yet), `projects` (team workspaces), and **`approvals`**. The approvals
  gate is applied **per route**: browsing (`GET /approvals`, `/approvals/facets`,
  `/approvals/directory`) needs the capability; reading ONE approval, deciding it and
  withdrawing it deliberately do **not**, so a lapse or downgrade cannot strand a paused
  run.
- **Frontend gate** for the Studio tab (`studioApps.jsx`):
  `hasLicenseFeature('automations') && canUse('automations')`, `lockOn: 'disable'` — a
  Community org sees the row locked rather than hidden.
- **`manage_automations`** (`server/config/orgRoles.json`) is held by **`org_admin`
  only** — not by `agent_admin`, `agent_editor`, `dpo`, `isms_auditor` or `member`. It
  gates exactly one thing: reading the **organisation's** runs
  (`GET /_runs/org`, `/_runs/org/facets`), checked with `hasPermission` against real
  groups/roles, never against `req.session.user.orgRole`. A refusal is a **403**, never
  a quiet narrowing to "my runs".
- **Ownership** is the real access rule for everything else: every per-automation and
  per-run route compares `a.userId` / `run.userId` to the session user and answers
  **403 Forbidden** otherwise. `GET /` filters on `user_id`. Folders are org-wide
  labels; the automations inside them stay per-user.
- Org-run rows carry `mine: boolean` — the client must check it **for true** before
  offering to open a run, because the per-run routes still 403 for anybody else.

---

## 10. How automations connect to the rest of the product

- **Datatables** — the `datatable` step reads/writes org-scoped tables; saving an automation
  syncs a usage index so a table knows which automations touch it.
- **Forms** — a form-trigger automation *is* a form; Studio → Forms lists them with
  `live`, `submissions`, `mine`, `canOpen`. A form can auto-provision an **answers
  table**.
- **Knowledge bases** — `knowledge_write` puts text where an agent can answer from it;
  the KB link is authorised at save, at activate **and** at run time.
- **Agents** — an `agent_call` trigger exposes the automation as a chat tool; an `ai_step`
  can be bound to an agent, whose three permissions (`useTools`, `useKnowledge`,
  `startAutomations`) are written explicitly, never left absent.
- **Studio Apps** — `app_trigger` lets an app action start an automation with typed inputs
  (including files); `return_to_app` ends the run and tells the app which screen to open,
  what to toast and what to refresh. `GET /:id/usage` lists which apps use this automation.
- **Approvals** — a shared surface with App Studio actions.
- **Privacy Shield / Compliance** — guard/tokenize/untokenize steps, the run-scoped token
  vault, and unconditional egress rows feeding the Compliance Hub (dry-run rows are
  flagged `is_dry_run` so they can be excluded).
- **Projects / Solutions** — an automation can be filed into a Studio Project and packaged
  into a Blueprint (Enterprise).
- **MCP** — `POST /mcp/automations` serves the automation-builder toolset to an external
  coding agent, off unless `AUTOMATION_MCP_ENABLED=1`. Its own contract text says: *"A
  finalised automation is still INACTIVE. Activation is a human decision made in the
  product."*
- **Portability** — `GET /:id/export` produces a sanitised envelope; `POST /import`
  brings it back as an inactive draft with fresh step ids.

---

## 11. Common mistakes

1. **Finalised ≠ live.** An automation the AI just built is a draft. Nothing fires until
   somebody presses **Activate**.
2. **Dry-run success ≠ live success.** Side effects, the outside calls of code steps and
   credentialled HTTP calls are *synthesised* in a dry-run. A dry-run can never prove the mail was sent.
3. **Forgetting the form link is dead while the automation is a draft.** `/f/<token>`
   returns 404 unless the automation is active **and** not a draft.
4. **Testing an app-event automation with a manual run and expecting real data.** Without a
   payload every binding resolves to `undefined`; Bee Flow only synthesises one for
   Gmail and Nextcloud triggers, and only if a matching recent item exists.
5. **Leaving a step pinned.** Pinned output looks like a working automation and serves stale
   sample data in every live run. Activation warns; people ignore the warning.
6. **Trying to put an approval or a form page inside a flowlet or a loop body.** The
   palette hides them there; a pause in a sub-graph has no address to resume to.
7. **Adding a form page without a form trigger.** The item is visible but disabled, with
   the reason attached.
8. **Assuming retries happen.** There is no default retry. If a flaky API matters, set
   `retry` on that step or wire an `on_error` branch.
9. **Assuming a colleague can see or run your automation.** Automations are owner-private on
   every tier; only the org-wide **run log** is shareable, and only with
   `manage_automations`.
10. **Expecting the org run log to open someone else's run.** It lists them; only the
    owner can open one.
11. **Naming an approver outside your organisation.** That is a save error, on purpose.
12. **Trusting `{{steps.x.output}}` as a whole.** A single whole-payload binding in a
    notification e-mails the entire object — and it will be scanned as egress.
13. **Deleting a folder expecting the automations to go.** They detach and return to the top
    level.
14. **Changing the definition after a run and then reading that run's timeline.** The
    timeline renders the *snapshot* of the version that ran, which is right but surprises
    people.
15. **Editing while the AI is building.** Edits are locked until the turn ends.
16. **Blowing the collection ceiling.** More than 10 000 items into a list op is a hard
    stop, not a slow run.

---

## 12. Three scenarios for "Van Dijk Groep" (Dutch SME)

### S1 — Procurement: inkoopfacturen automatisch klaarzetten
**Trigger:** *On app event* → Gmail `mail.new`, filter `hasAttachment` + subject contains
"factuur".
**Steps:** *Privacy Shield — Check for personal data* on the mail body (branch if it holds
more than a supplier's own contact data) → *Extract data* on the PDF text with fields
`leverancier`, `factuurnummer`, `factuurdatum`, `bedrag_excl`, `btw`, `totaal` →
*Condition*: `steps.extract.output.totaal > 2500` → **then**: *Ask someone to approve*
(approver = the purchasing manager, deadline 3 days) / **else**: straight through →
*Datatable* upsert into `inkoopfacturen` matched on `factuurnummer` → *Notification*
"On error" to the builder.
**Teaching points:** dry-run first (the mail is never answered, the table is never
written); the upsert **match column must be mapped** or it only ever appends; the
approval deadline is capped at 30 days.

### S2 — HR: onboarding van een nieuwe medewerker
**Trigger:** *On form submission* — a form "Nieuwe medewerker aanmelden" with name,
start date, department, manager, laptop yes/no.
**Steps:** *Edit data* to normalise the fields → *Date & time* to compute "start date
minus 5 working days" → *Repeat for each* over the department's standard task list →
inside the loop an *Action* (create a Nextcloud Deck card / a calendar item) →
*Make a document* to render the welcome letter as PDF → *Form: closing page* that hands
the PDF back as a download and says what was scheduled.
**Teaching points:** a multi-page form journey is **one** history row; the generated
document is kept 7 days by default (1–90); the loop's `maxIterations` is 1–1000;
the form's audience defaults to owner-only, so HR must widen it before sending the link.

### S3 — Sales: wekelijkse pijplijn-briefing
**Trigger:** *On a schedule* — Weekly, Monday 08:00, Europe/Amsterdam.
**Steps:** *Datatable* read of `offertes` filtered on status `open` (limit ≤ 1000) →
*Shorten list* to the top 25 by value → *Collect one field* for the account managers →
*AI step* ("summarise this pipeline into five bullets and name the three deals at risk",
model tier `fast`) → *Condition* on whether anything is at risk → *Notification*
(channels `inapp` + `email`) to the sales lead → *To knowledge base* so the sales agent
can answer "hoe stond de pijplijn vorige week?" in chat.
**Teaching points:** the schedule preview shows the next three fire times before you
save; `fast` is the house default tier; the KB link is re-authorised at activate **and**
at run time, so an unshared base fails the activation rather than running silently
without it.

---

## 13. List / read API endpoints for a "did the learner do it?" check

All are under **`/api/automation`**, all behind session auth (`requireAuth` — cookie or
`X-Session-Token`), plus `requireModule('automation')`, `requireLicenseFeature('automations')`
and `requireBetaFeature('automations')`. Unless noted, the route additionally checks
**ownership** and answers 403 for anyone else.

| Method | Path | Returns | Owner field |
|---|---|---|---|
| GET | `/api/automation/` | `{ automations: [...] }` — every automation of the **caller** (`kind='automation'` only, newest-updated first). Row: `id, userId, organizationId, projectId, folderId, kind, title, description, definition, version, isActive, isDraft, needsFirstRunConfirm, triggerType, scheduleCron, scheduleTz, nextRunAt, lastRunAt, lastStatus, runTimeoutMs, createdFromChatId, createdAt, updatedAt` (+ Step-only `isPublished, sharedGroups, publishedVersion, exposeAsTool, icon, category`). Optional `?triggerProvider=&triggerEvent=` narrowing (a bad value is a 400/503, never an unfiltered list). | `userId` |
| GET | `/api/automation/:id` | `{ automation }` — same row shape. | `userId` |
| GET | `/api/automation/:id/runs` | `{ runs, nextCursor }` — runs of one automation. Filters `status, triggerKind, mode, since, until, cursor, limit` (limit 1–100, default 50). | `userId` on each run |
| GET | `/api/automation/_runs/recent` | `{ runs, nextCursor }` — the caller's runs across all automations. Row: `id, automationId, automationTitle, automationKind, automationIcon, automationTriggerType, version, userId, triggerKind, triggerPayload, mode, status, startedAt, finishedAt, durationMs, error, errorClass, summary, handledErrorCount, parentRunId, rootRunId, journeyRunId, submittedByUserId, rootStepId, awaitingStepId, awaitingStepExpiresAt, cancelRequested`. | `userId` |
| GET | `/api/automation/_runs/facets` | `{ facets, rangeHours }` — counts by status/automation/trigger/error class. `?range=` hours, default 24, max 720. | — (caller-scoped) |
| GET | `/api/automation/_runs/active` | `{ active: [{ runId, automationId, status, startedAt }] }`. | — (caller-scoped) |
| GET | `/api/automation/_runs/org` | `{ runs, nextCursor, scope:'org' }` — **requires the `manage_automations` permission** (org_admin) *and* an organisation; otherwise 403. Explicit allow-list row (no `triggerPayload`): `id, journeyRunId, automationId, automationTitle, automationKind, automationIcon, automationTriggerType, rootStepId, rootTriggerLabel, triggerKind, mode, status, startedAt, finishedAt, durationMs, summary, error, errorClass, handledErrorCount, mine`. | `mine: boolean` |
| GET | `/api/automation/_runs/org/facets` | `{ facets, rangeHours, scope:'org' }` — same permission, checked again. | — |
| GET | `/api/automation/_runs/stream` | SSE of run lifecycle events for the caller; `?automationId=` narrows. | events carry `userId` |
| GET | `/api/automation/runs/:id` | `{ run }` — one run, reporting the **latest leg** of the journey. | `userId` |
| GET | `/api/automation/runs/:id/steps` | `{ steps, definition, version }` — the whole journey's steps plus the flow snapshot as it was at run time. Step row: `runId, stepId, parentStepId, stepType, attempts, status, startedAt, finishedAt, input, output, error, errorClass, …`. | run's `userId` |
| GET | `/api/automation/:id/versions` | `{ versions: [{ id, automationId, version, savedByUserId, savedByName, savedAt, changeSummary }] }`. | automation's `userId` |
| GET | `/api/automation/:id/versions/:versionId` | one stored definition. | automation's `userId` |
| GET | `/api/automation/:id/webhooks` | `{ webhooks: [...] }` with an absolute `url` per row. | automation's `userId` |
| GET | `/api/automation/:id/forms` | `{ forms: [...] }` with an absolute `/f/<token>` `url`. | automation's `userId` |
| GET | `/api/automation/forms` | `{ forms: [...] }` — **org-scoped** list of published forms; row: `id, url, automationId, triggerStepId, title, description, live, submissions, lastSeenAt, createdAt, mine, canOpen`. | `mine` |
| GET | `/api/automation/folders` | `{ folders }` — org-wide folders. | — |
| GET | `/api/automation/templates` | `{ templates, categories }` — the built-in gallery (no ownership). | — |
| GET | `/api/automation/templates/:id` | `{ template }`. | — |
| GET | `/api/automation/catalog` | apps, actions, triggers, side-effects available to the caller. | — |
| GET | `/api/automation/:id/usage` | `{ usage, complete }` — which Studio Apps/automations call this automation; each row has `canOpen`. | filtered to `automationOwner === a.userId` |
| GET | `/api/automation/:id/export` | sanitised portability envelope. | automation's `userId` |
| GET | `/api/automation/approvals` | `{ approvals, nextCursor, scope }` — `?scope=org` needs an org-admin role. **Enterprise `approvals` capability + module required for this route.** | viewer-scoped |
| GET | `/api/automation/approvals/facets` | `{ facets, scope }` — same gate. | — |
| GET | `/api/automation/approvals/:id` | one approval — deliberately **not** licence-gated (drain exemption). | assignee/viewer-scoped |

**Best checks for "the learner built and shipped an automation":**
- `GET /api/automation/` → find the row by `title`; assert `isDraft === false` and
  `isActive === true`, and for a scheduled one `nextRunAt !== null`.
- `GET /api/automation/:id/runs?mode=dry_run&limit=1` → proves they dry-ran it.
- `GET /api/automation/:id/runs?status=success&mode=live&limit=1` → proves it really ran.
- `GET /api/automation/:id/forms` → proves a form link exists, and `live` proves it opens.
- `GET /api/automation/:id/versions` → proves iteration (`version > 1`).

Write endpoints exist for everything the UI does (`POST /`, `PUT /:id`,
`POST /:id/activate` / `/deactivate`, `/run`, `/dry-run`, `/steps/:stepId/run`,
`/:id/runs/:runId/retry`, `/runs/:runId/cancel`, `/runs/:runId/approve-step`,
`/:id/webhook`, `/:id/form`, `/import`) — do not call these from a verification check.

---

## 14. Key source files

- Frontend section: `agent-hub/src/components/automation/index.jsx`,
  `.../Builder/BuilderShell.jsx`, `.../Builder/BuilderHeader.jsx`,
  `.../Builder/BuildTab.jsx`, `.../Builder/DiagramPane.jsx`,
  `.../Builder/NodeDetailView.jsx`, `.../Builder/SettingsTab.jsx`,
  `.../Builder/DryRunPanel.jsx`, `.../Builder/VersionHistoryPanel.jsx`
- Palette / node facts: `.../Builder/flow/stepPalette.js`, `.../flow/nodeDefs.js`,
  `.../flow/triggerLabels.js`, `.../flow/DiagramEmptyState.jsx`
- Start screen: `agent-hub/src/components/admin/Studio/AutomationsStudio/*`
- Runs: `agent-hub/src/components/admin/Studio/Runs/RunsStudio.jsx`,
  `agent-hub/src/components/shared/statusTokens.ts`
- Registry / gates: `agent-hub/src/components/admin/Studio/studioApps.jsx`,
  `.../studioNav.js`, `.../studioRoutes.js`
- API: `server/routes/automation.js` + `server/routes/automation/{crud,runs,versions,webhooksAndRunOps,approvals,catalog,events,formPublic}.js`
- Builder AI: `server/routes/ai/automationBuilder/*`
- Engine: `server/core/automationRunner/*` (`shared.js` = every constant,
  `execution.js` = the run loop, `runDag.js` = the walk, `exec*.js` = one per step family)
- Validation: `server/automation/validate.js` + `server/automation/validate/*`
- Licence/beta: `server/license/tiers.js`, `server/license/featureMap.js`,
  `server/core/entitlements/betaFeatures.js`, `server/config/orgRoles.json`
