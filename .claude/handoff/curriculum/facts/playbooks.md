# Fact sheet — Studio → Playbooks (audience: builder)

Status: **exists and is complete in code** (frontend + backend + tests + live harness). It is
recent, uncommitted-on-branch work (13–14 Sept 2026). Nothing here is a stub.

Source of truth read for this sheet:
- Frontend: `agent-hub/src/components/admin/Studio/Playbooks/` (PlaybooksStudio.jsx, NewPlaybookDialog.jsx,
  PlaybookRun.jsx, PhaseRail.jsx, HandoffCard.jsx, PlaybookCard.jsx, phaseMachine.js, playbookView.js,
  usePlaybook.js, playbooksApi.js, recipes.js, recipeForm.js, usePresenterFlag.js, `stages/*`)
- Registry/nav: `agent-hub/src/components/admin/Studio/studioApps.jsx` (section `playbooks`),
  `agent-hub/src/utils/studioRecentSources.js`, `agent-hub/src/i18n/en-defaults.js`
- Backend: `server/routes/playbooks.js`, `server/stores/playbookStore.js`,
  `server/playbooks/{lifecycle.js, recipeDoc.js, composeRecipe.js, copy.js}`,
  `server/playbooks/recipes/{index.js, invoiceTracker.js}`,
  `server/playbooks/phases/{tablePhase.js, fillPhase.js, designPhase.js}`,
  mount in `server/index.js:839`, counts in `server/routes/studio/counts.js`
- Harness: `scripts/playbook-live-run.sh`, `server/scripts/drive-playbook.js`, `server/scripts/playbook-cases/*.json`

---

## 1. What the feature is for

A **playbook** is a *phased AI build the person watches like a film and consents to phase by phase*.
Instead of asking the automation builder for an automation, then the app builder for an app, and wiring a
table by hand, you pick (or describe) a playbook and the AI produces a whole working set:

> a **table** → a **automation** that fills it → the **first real rows** → a **design** → an **app** on
> top → optionally an **approval flow**

After every phase the film stops and a **handoff card** appears: "Phase 2 of 6 landed — Automation",
the summary of what landed, the **brief the AI gets next in an editable textarea**, and
`Continue` / `Skip <phase>` / `Stop`. Nothing runs past a pause without the person saying so
(unless they switch on **Autopilot**, which still lingers on each landing for 3–8 seconds with a
"Continue now" escape).

Two doors into a playbook:
1. **A built-in recipe** — today exactly one ships: `invoice_tracker` ("Invoice tracker").
2. **"Describe it"** — a few sentences; the Fast model writes a *recipe document* (phases, table
   columns, inputs, briefs) which is previewed in the dialog before anything is created.

The page lives at `/app/studio/playbooks`, section **Playbooks** in the **Bundle** group of the
Studio rail (next to Solutions).

---

## 2. Screens, with their real labels

### 2.1 Studio rail entry
- Section label: **"Playbooks"** (`studio.tab.playbooks`), icon `Clapperboard`.
- Description under it: **"Watch the AI build a table, an automation and an app — one phase at a time"**
  (`studio.tab.playbooks_desc`).
- Group heading: **"Bundle"** (`studio.category.bundle`).
- "New" menu item: **"Playbook"** (`studio.new.playbook`) → navigates to `studio/playbooks/new`.
- When the plan/capability is missing the row is **locked, not hidden**; the hint is
  **"Available on a higher plan"** (`studio.locked_upgrade`) or **"Not switched on for your
  organisation — ask an admin"** (`studio.locked_not_granted`).

### 2.2 Playbooks list (`/app/studio/playbooks`) — `PlaybooksStudio.jsx`
- Section header title: **"Playbooks"**; primary button **"New playbook"** (`+` icon) — only when
  the user has `manage_apps`.
- Page heading: **"Playbooks"** plus the count; intro line:
  **"Watch the AI build a working set — a table, an automation that fills it, an app on top — and say
  yes after every phase."**
- Loading: **"Loading…"**. List error: **"Could not load your playbooks"**.
- Empty state (dashed card, Clapperboard tile):
  - Title: **"No playbooks yet"**
  - Body (can create): **"Start one and watch: the table appears, the automation takes shape, the rows
    arrive, the app builds itself — you say "go on" between the phases."**
  - Body (cannot create): **"Playbooks are started by whoever may build apps and automations here. Ask
    an administrator."**
  - Button repeated below: **"New playbook"**
- Each row (`PlaybookCard.jsx`) is one button: title, then a meta line —
  `recipeLabel · {done}/{total} phases · <current phase> · <status> · <relative time>`
  with the status words: **"Ready to start" / "Building…" / "Paused for you" / "Failed" / "Done" /
  "Stopped"**, and relative time **"just now" / "{n} min ago" / "{n} h ago" / "{n} d ago"**.

### 2.3 New playbook dialog (`/app/studio/playbooks/new`) — `NewPlaybookDialog.jsx`
Modal, size `lg`.
- Title: **"New playbook"**; subtitle: **"The AI builds in phases and stops after each one for your
  go-ahead."**
- Field group **"Playbook"** — choice cards:
  - **"Invoice tracker"** — *"Reads the PDF invoices in a Nextcloud folder into a table, then builds
    an invoice app on it — with an approval flow."* Note line shows the phase chain
    (`Table → Automation → First rows → Design → App → Approval flow`).
  - **"Describe it"** — *"Say what should be read, stored and built — the AI writes the phases."*
    Note: *"Table → automation → first rows → app → more"*.
- **"Language"** segmented control: `English` / `Nederlands`. Hint: **"The table's columns, the
  briefs the AI works from and the app's labels are all in this language."** (starts at the language
  on screen, `resolvedLocale`).
- Describe-it block (only on that card):
  - Label **"What should this playbook build?"**, textarea `maxLength 2000`,
    placeholder: *"e.g. Read the supplier contracts in /Contracten into a table with supplier, start
    date, end date and amount, then build an app that shows which contracts end within 90 days."*
  - Button **"Let the AI write the phases"** (→ **"Write it again"** once composed); while running:
    **"Writing the playbook…"**
  - Error: **"The AI could not write a runnable playbook — try a more concrete description."**
  - Preview card (`playbook-recipe-preview`): the AI's title, its description, the phases as chips
    with `→` between them, and **"Columns: {list}"** (`name (type)`).
- **"Name"** — text input, `maxLength 120`.
- **"Where the rows go"** — segmented: **"A new table"** / **"An existing table"**.
  - On "An existing table": label **"Table"**, select with placeholder **"Pick a table…"**; options
    read `name · rowCount · Nextcloud`; while loading: **"Loading your tables…"**.
    Hint: **"Own table or a Nextcloud mirror — you need edit rights; its columns are checked in the
    first phase."**
- One input per recipe input. For the built-in recipe: **"Nextcloud folder with the invoices"**,
  placeholder `/Invoices`. Invalid: **"The folder is an absolute Nextcloud path, e.g. /Invoices."**
  Extra hint when no Nextcloud org link: **"The automation reads this folder through your Nextcloud
  connection."**
- **"Model"** — segmented: **"Fast"** / **"Auto"**. Hint: **"Fast keeps every phase at one pace;
  Auto adds a classification step per turn."**
- **"Approver group (optional)"** — only when a phase `requires: 'approvals'`. Select with
  **"Me (the owner)"** plus the org groups. Without the capability it reads instead:
  **"The approval flow needs the Enterprise plan — the playbook skips that phase."** (lock icon).
- Footer: **"Cancel"** / **"Start"**. Create failures: **"Check the options."** or
  **"Could not start the playbook."**

### 2.4 The open playbook — `PlaybookRun.jsx` (fullscreen, like an open app)
Top bar (52 px):
- Back arrow, aria **"Back to playbooks"**; Clapperboard tile; the playbook title.
- Sub-line while active: **"Phase {n} of {total}: {phase}"** · elapsed clock (`mm:ss`) ·
  **"Pauses after this phase"** (only when Autopilot is off and the phase runs).
  When finished: **"Done"** or **"Stopped"**.
- **"Presenter"** pill when the presenter flag is on (Shift+P on either builder canvas).
- **"Autopilot"** toggle (`role="switch"`, Zap icon) — a per-user preference stored under
  `playbooks.autopilot`.
- **"Stop"** button.
- Conflict banner: **"This playbook changed elsewhere — showing the latest state."** (5 s).
- Error strip at the bottom with a **"Reload"** link.

Left rail (`PhaseRail.jsx`, 236 px; 280 px in presenter mode), `aria-label` **"Phases"**:
one 28 px circle per phase + label + state word + a fact line from the artifacts.
State words: **"Later" / "Ready to start" / "Building…" / "Paused for you" / "Done" / "Failed" /
"Skipped" / "Locked"**. Fact lines: **"{name} · {n} rows"**, **"Automation "{name}""**, **"{n} rows"**,
**""{name}" · {n} screens"**, **"App "{name}""**. A skipped approval phase adds
**"The table has no status column"**; a locked one adds the plan hint.

Stage (right), chosen by the phase's **kind**:
- **Table stage** (`playbook-stage-table`): the table tile materialising, columns sliding in
  350 ms apart. Words: **"Creating the table…"** / **"Checking the columns…"** / **"Starting…"** /
  **"Table ready"** · **"{n} rows"** · the table key; **"Nextcloud mirror"** pill; on failure
  **"The table did not land"**; and **"No status column — the approval flow will be skipped."**
  Below it, when the table already holds rows, the rows preview titled **"What the table holds today"**.
- **Automation stage**: the *real automation builder* (`BuilderShell`) mounted inside the playbook, with
  back label **"Back to the playbook"**. Before it mounts: **"Handing the brief to the automation
  builder…"**
- **Fill stage** (`playbook-stage-fill`): left, **"The run, step by step"** (the Executions step
  timeline + the read-only run canvas, polled every 1.5 s, with a **"running"** chip); right, a big
  counting row number with **"rows in the table"** → **"{n} rows · done"** and **"+{n} this run"**;
  under it the live rows preview **"Rows arriving in the table"** → **"What landed in the table"**,
  **"{shown} of {total}"**, **"Open the table"**, **"Reading the rows…"**, **"No rows yet."**,
  **"The rows could not be read right now."**
- **Design stage** (`playbook-stage-design`): wireframes. **"Designing the app"** /
  **"The AI thinks about this app as a designer first — screens, hierarchy, one accent — before it
  knows a single building block."** / **"The designer did not answer"**; once done the design name,
  tagline, **"Look {preset} · accent {accent}"**, **"{screens} screens · {elements} elements"** and
  the principle chips.
- **App stage**: the *real App Studio editor* (`AppEditorShell`) with the builder chat pane.
  **"Opening the app…"**, **"Could not open the app."**, **"No app was prepared for this phase —
  retry the previous step."** The builder chat shows **"The tier is set by the playbook"**.

Handoff card (`HandoffCard.jsx`) — docked **under** the stage (max 48 % height), three faces:
- *awaiting*: **"Phase {n} of {total} landed"** — <phase>, the summary, then either
  **"Next: {phase} — the brief the AI gets (edit if you like)"** with a textarea (`maxLength 3000`,
  a `0/3000` counter) for a builder phase, or one of
  **"Next: {phase} — the AI first designs the app as a designer, before it builds."** /
  **"Next: {phase} — the automation runs once so the table has real rows."** /
  **"Next: {phase} — the table is created."** /
  **"Next: {phase} — its brief is composed when you continue."** /
  **"This was the last phase — finish to see the result."**
  Buttons: **"Continue"** (→ **"Finish"** on the last phase), **"Skip {phase}"**, **"Stop"**.
- *failed*: **"Phase {n} did not land"** + the error; **"Retry"**, **"Skip this phase"**, **"Stop"**.
  Client error words: **"The builder stopped before it finished."**, **"The turn was stopped."**,
  **"The model returned nothing usable — try again."**, **"Stopped mid-build. Retry hands the builder
  the brief again on what is already there; Mark as done keeps it as it is."**
- *needs input*: **"The builder asked a question"** — *"Answer in the chat on the left and the phase
  goes on. Or, when what is there is enough, mark it done."* Buttons **"Mark as done"** (only when a
  automation/app id already exists), **"Stop"**, and a **"Hide"** (X).

Autopilot toast (bottom-right): **"Autopilot continues in {n} s"** + **"Continue now"**.

Stop confirmation: **"Stop this playbook?"** — *"What has landed stays — the table, the automation
draft, the app. A builder turn still running finishes on its own."* — confirm **"Stop"**.

### 2.5 Done card (`stages/DoneCard.jsx`)
- **"{title} is ready"** or **"Stopped — this is what landed"**.
- Meta: **"{n} of {total} phases built"** · **"in {time}"** · **"{n} rows"**.
- Doors: **"Automation"** / **"Table"** / **"App"** rows that open
  `studio/automations/<id>`, `studio/datatables/<id>`, `studio/apps/<id>`.
- Not-built list: `<phase>: ` **"not on this plan"** / **"skipped"** / **"The table has no status
  column"** / **"stopped mid-build — resume to retry it"** / **"not reached"**.
- Buttons: **"Back to playbooks"**, and for a stopped playbook **"Resume"**.

---

## 3. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Playbook** | One recorded build: a title, a recipe, options, and an ordered list of phases with their state. Stored in the `playbooks` table, one row, owner-only. |
| **Recipe** | The plan a playbook runs: which phases in which order, the table's columns, the inputs asked at start, and the brief template per builder phase. Either a built-in module (`invoice_tracker`) or a **recipe document**. |
| **Recipe document** | The recipe as plain data (`{id, version, source, title, description, table.fields, inputs, phases}`). "Describe it" makes one with the model; it is stored on the playbook row in the `recipe` JSONB column. |
| **Phase** | One step of the build with a `key`, a `kind`, a `label`, a `status`, a `brief`, `artifacts`, a `summary`, an `error` and an `attempt` counter. |
| **Kind** | What a phase *is*, and therefore which stage draws it: `table`, `automation`, `fill`, `design`, `app`, `app_turn`. Only these six exist. |
| **Phase status** | `pending` → `ready` → `running` → `awaiting` → `done`; plus `failed`, `skipped`, `locked`. `done`/`skipped`/`locked` are terminal. |
| **Brief** | The single short instruction a builder phase hands the AI. Composed server-side from the recipe template with the table's **real** ids and column keys — never a placeholder id. Editable by the person in the handoff card before Continue. |
| **Handoff / consent pause** | The card between phases. `awaiting` means the AI stopped and is waiting for a human "go on". |
| **Artifacts** | What a phase produced and later phases depend on: `datatableId/Key/Name/fields/mapping/rowCount`, `automationId/automationTitle`, `runId/runStatus/rowsBefore`, `design/designName/screenCount/elementCount`, `appId/appName`. |
| **Role / mapping** | Briefs address a column by a stable *role* (`totaal`, `status`); the mapping says which real column key plays that role in this table. That is how an existing table with other column names still works. |
| **Server-run phase** | `table`, `fill`, `design` — no builder is mounted; the page POSTs `…/run` and polls. |
| **Client-run phase** | `automation`, `app`, `app_turn` — the real builder is mounted in the stage, the page PATCHes the phase's state as the turn progresses. |
| **CAS / expectedVersion** | Every write carries the version the page last saw. If it does not match, the server answers **409** with the current playbook and the page reloads instead of overwriting. |
| **Autopilot** | Continue automatically after each landing, once per (phase, version), after a 3–8 s linger. Per-user browser preference, not a server setting. |
| **Presenter mode** | Bigger type and wider rails for a demo. Shared flag with the builder canvases (Shift+P). |
| **Locale of a playbook** | The interface language chosen in the dialog, stored in `options.locale`. It decides the table's column names and keys, the automation/app titles, the screen names, the status values and the phase summaries. Copy packs exist for `nl` and `en` only; any other language reads the English pack while the *model* is still asked for that language. |

---

## 4. End-to-end workflows (exactly as the user clicks)

### W1 — Run the built-in Invoice tracker on a new table
1. Sidebar → **Studio** → in the **Bundle** group click **Playbooks**.
2. Click **New playbook** (top right).
3. On the **Playbook** cards pick **Invoice tracker**.
4. Under **Language** pick `Nederlands` or `English`.
5. **Name**: leave "Facturen bijhouden"/"Invoice tracker" or type your own (≤ 120 chars).
6. **Where the rows go** → **A new table**.
7. **Nextcloud folder with the invoices**: type an absolute path, e.g. `/Facturen-Q3`.
8. **Model**: leave **Fast**.
9. **Approver group (optional)**: leave **Me (the owner)** (or pick a group; locked on Community).
10. Click **Start**. The playbook opens; phase 1 **Table** starts by itself.
11. Watch the columns appear; when the card says **"Phase 1 of 6 landed — Table"**, read the summary
    ("Tabel "Facturen" aangemaakt met 8 kolommen."), optionally edit the **Automation** brief, click
    **Continue**.
12. Phase 2 **Automation**: the automation builder runs inside the stage. When it finalises, the card says
    **"Phase 2 of 6 landed — Automation"**. Click **Continue**.
13. Phase 3 **First rows**: the run's steps play on the left, the row counter climbs on the right,
    the rows preview fills. On **"{n} rows · done"** click **Continue**.
14. Phase 4 **Design**: wireframes appear. Click **Continue**.
15. Phase 5 **App**: the App Studio editor builds the app. On landing click **Continue**.
16. Phase 6 **Approval flow** (if the plan allows): a second automation is built. Click **Finish**.
17. The done card appears: **"… is ready"**, "6 of 6 phases built", "in 14m 20s", and the doors
    **Automation / Table / App**.

### W2 — Describe your own playbook
1. **Studio → Playbooks → New playbook**.
2. Pick the **Describe it** card.
3. Choose the **Language**.
4. In **What should this playbook build?** write concretely *what is read, where it is stored and
   what the app shows* (≤ 2000 chars).
5. Click **Let the AI write the phases**; wait for **"Writing the playbook…"**.
6. Read the preview: the phase chips and **"Columns: …"**. Not right? Adjust the text and click
   **Write it again**.
7. Fill **Name**, **Where the rows go**, every input the AI declared, **Model**.
8. Click **Start** and drive the film exactly as in W1.

### W3 — Run a playbook onto an existing table (e.g. a Nextcloud Tables mirror)
1. **New playbook** → **Invoice tracker** (or your described one).
2. **Where the rows go** → **An existing table**.
3. Under **Table** pick the table (rows and a `Nextcloud` marker are shown in the option).
4. Fill the folder input, click **Start**.
5. Phase **Table** now says **"Checking the columns…"**. It maps your columns onto the roles.
   - Missing a required column → phase **fails** with *""X" lacks the columns an invoice needs: …"*.
     Fix the table (or pick another) and press **Retry**.
   - No `status` column → the table stage shows **"No status column — the approval flow will be
     skipped."** and the approval phase is auto-skipped with that reason.
6. Continue as in W1.

### W4 — A phase fails, or the builder asks a question
1. Card shows **"Phase {n} did not land"** with the reason.
2. Press **Retry** — the phase goes back to `ready` with `attempt + 1`; the brief is handed over
   again (for an app/automation that already exists, the brief is **prefilled in the chat** rather than
   auto-sent, so you press send yourself).
3. Or press **Skip this phase** (never possible for the **table** phase).
4. If instead the card says **"The builder asked a question"**: answer in the builder's chat on the
   left. If what is already built is enough, press **Mark as done** (only offered once an automation or
   app id exists) — or **Hide** to keep working in the chat.

### W5 — Stop and resume
1. Press **Stop** in the top bar → confirm **"Stop this playbook?"**.
2. The done card appears as **"Stopped — this is what landed"** with the doors that exist.
3. Reopen it from the list and press **Resume**. Any phase that was mid-turn is turned into
   `failed` with the reason **"interrupted"**, so the card offers **Retry / Skip / Stop** rather
   than waiting on a turn nobody restarts.

### W6 — Present it (demo mode)
1. Open a playbook; on a builder canvas press **Shift+P**.
2. The bar shows the **Presenter** pill, type and rails grow.
3. Optionally switch **Autopilot** on: each landing lingers (fill 8 s, design/table 6 s, others 3 s)
   with **"Autopilot continues in {n} s"** and a **"Continue now"** link.

---

## 5. Defaults, limits and numbers

Creation & options
- Recipes shipped: **1** (`invoice_tracker`). Its phases: **6** — `table, automation, fill, design, app, approvals`.
- Title: **≤ 120** chars. Description for "Describe it": **≤ 2000** chars.
- Folder input: must start with `/`, **≤ 300** chars. Any other input: **≤ 300** chars.
- Model tier default **`fast`**; UI offers `fast` / `auto`; the API also accepts `standard`/`thinking`.
- `tableMode` default **`new`**; `locale` default **`nl`** server-side, the dialog starts at the
  language on screen. Copy packs: **nl, en**.
- Default folder in the built-in recipe: **`/Invoices`** (document default).
- Approver default: **the owner** (`{userId:…}`); a group must belong to the owner's organisation.

Recipe documents (AI or hand-written)
- Max **8** phases, **30** table columns, **6** inputs.
- Brief **template** ≤ **1400** chars; the **rendered** brief ≤ **1000** chars; the built-in
  recipe's own briefs are capped at **1000** and asserted at module load.
- A patched brief (what the person types in the handoff card) ≤ **3000** chars.
- Compose: Fast tier, `maxTokens 4000`, `temperature 0.2`, forced tool call, **exactly one**
  repair round if the validator objects.

Design phase
- Fast tier, `maxTokens 2500`, `temperature 0.7`; max **6** screens, **6** sections/screen,
  **8** elements/section; the design block appended to the app brief is capped at **1600** chars.
  Element kinds: `stat, chart, table, filters, form, detail, list, text, button, image`.
  Look presets: `classic, cloud, atlas, midnight, field, paper, mono` (default `cloud`,
  default accent `#1e7f4f`; the prompt forbids purple/violet/indigo).

Runtime
- Rate limits: **60 requests/minute/user** on the whole router; **10/minute** on
  `POST …/phases/:key/run` and `POST /recipes/compose`.
- List: the route asks the store for **100** rows (store default 50, hard max 500); the Studio
  counts endpoint asks for 500.
- Page poll while a server-run phase runs: **2000 ms** (paused in a hidden tab). Fill step poll:
  **1500 ms**; rows preview re-read: **4000 ms**; rows preview shows **8** rows and up to **9**
  columns.
- Fill phase: the HTTP response waits at most **60 s** for the run, then answers **202
  `{pending:true}`** and finishes in the background; a run that has not finished after
  **15 minutes** fails with *"The run did not finish within 15 minutes."*
- Autopilot linger: `fill` **8 s**, `design`/`table` **6 s**, everything else **3 s**.
- Column reveal stagger **350 ms**, design screens **450 ms**, rows **120 ms**.
- Approvals automation brief sets `expiresInHours 168` (7 days) on the approval it creates.

---

## 6. What happens on failure

| Situation | What the product does |
|---|---|
| Version conflict (two tabs, a late builder callback) | **409 `version_conflict`** with `currentVersion` + the whole current playbook. The page adopts it and shows **"This playbook changed elsewhere — showing the latest state."** It never retries blindly. |
| Table phase, no `manage_datatables` | **403 `manage_datatables_required`**, phase → `failed`. |
| Table phase, existing table you may only read | **422 `table_read_only`**: *"You can read "X" but not write to it — the automation needs to add rows."* |
| Table phase, existing table missing required columns | **422 `table_unusable`** with `missing: […]`. |
| Table key already used | **409 `key_taken`**. |
| Automation phase, builder never finalised | PATCH to `awaiting` is refused **409 `automation_not_finalized`**. |
| Automation/app belongs to someone else | **403 `not_owner`**. |
| Fill phase, no automation before it / automation gone | **422 `automation_missing`**. |
| Fill phase, automation's trigger is not manual | **422 `trigger_not_manual`** — *"The automation starts on "schedule", not by hand…"* |
| Fill phase, the run ends `error`/`cancelled`/`failed` | Phase → `failed` with the run's error or *"De automation eindigde met status "error"."* |
| Design phase, model unreachable/empty | **422 `design_failed`/`design_empty`/`model_unavailable`**, phase → `failed`, retryable. |
| Compose, model unreachable | **502 `compose_failed`**; empty answer → **422 `compose_empty`**; unusable plan → **422 `recipe_invalid`** with a list of findings shown after the error text. |
| A phase needs a column the table lacks (`requiresRole`) | The phase is **skipped automatically** with `error: 'no_status_column'` and the summary *"Skipped: the table has no status column to record an approval in."* |
| Approvals capability missing | The phase is **`locked`**, shown with a lock and the plan hint; `retry` on it answers **409 `capability_missing`** until the capability exists. |
| Stop while a turn runs | The playbook goes `stopped`; on **Resume** the running phase becomes `failed` with `interrupted`. Artifacts (table, automation draft, app) are **kept**. |
| Delete a playbook | **204**; the table, automation and app it built are **not** touched. |
| Illegal transition asked by the client | **409 `illegal_transition` {from,to}** — e.g. a client trying to run `table`/`fill`/`design` itself is told *"The server runs the X phase; POST /phases/X/run."* |
| Brief edited after the phase started | **409 `illegal_transition`** — *"The brief can only change before the phase starts."* |
| Skip the table phase | **409** — *"The table phase cannot be skipped — every later phase builds on it."* |

---

## 7. Permission and licence gates

Mount (`server/index.js:839`):
```
app.use('/api/playbooks',
  requireModule('apps'), requireModule('automation'),
  requireCapability('app_studio'), requireLicenseFeature('automations'),
  require('./routes/playbooks'));
```
- Modules **apps** *and* **automation** must be active for the org.
- Capability **`app_studio`** — Enterprise licence feature + a GA beta toggle (`core/betaFeatures.js`).
- Licence feature **`automations`** — Community core (free), so the binding constraint is `app_studio`.

Router-level (`server/routes/playbooks.js`):
- `router.use(requireAuth)` — every call needs a session.
- **Reading is auth-only**: `GET /recipes`, `GET /`, `GET /:id`.
- **Every write needs `manage_apps`** (`requirePermission(Permissions.MANAGE_APPS)`):
  `POST /`, `PATCH /:id`, `POST /:id/phases/:key/run|skip|retry`, `DELETE /:id`,
  `POST /recipes/compose`.
- **Owner-only**: every store call is `WHERE id = $1 AND user_id = $2`. Another user's playbook is
  **404, never 403** — existence is not leaked.
- Inside the table phase: `manage_datatables` decides whether a *new organisation* table may be
  created (`hasPermission(..., Permissions.MANAGE_DATATABLES)`); an existing table additionally
  needs **editor grade** for the caller (`datatableAccess.gradeAtLeast(grade, 'editor')`).
- Approval phase: `entitlements.hasCapability('approvals', …)` — **Enterprise** (`license/tiers.js`).
  Without it the phase is created `locked` and `GET /recipes` returns `approvalsAllowed:false`.

Which org roles hold `manage_apps` (`server/config/orgRoles.json`):

| Role | manage_apps | manage_datatables |
|---|---|---|
| `org_admin` (Organisation Admin) | ✅ | ✅ |
| `agent_admin` (Agent Admin) | ✅ | ✅ |
| `agent_editor` (Agent Editor) | ✅ | ❌ |
| `member`, `dpo`, `isms_auditor` | ❌ | ❌ |

Frontend: `PlaybooksStudio` calls `hasPermission('manage_apps')` → hides **New playbook** and swaps
the empty-state body. The Studio section gate is
`hasLicenseFeature('automations') && canUse('automations') && hasLicenseFeature('app_studio') && canUse('app_studio')`,
`gateCapability: 'app_studio'`, `lockOn: 'disable'` (locked row, not a hidden one).

---

## 8. How Playbooks connects to the rest of the product

- **Datatables** — the `table` phase creates a Studio datatable through the same shared creator the
  automation builder uses (`core/dataEngine/createStudioDatatable`), or verifies an existing one
  (including a **Nextcloud Tables mirror**, `managedKind === 'nextcloud_table'`). The rows preview
  reads `GET /api/datatables/:id/rows`; the "Open the table" link goes to `studio/datatables/<id>`.
- **Automations / Automations** — the `automation` phase *is* the automation builder (`BuilderShell`) mounted
  inside the playbook, with the brief auto-sent and the tier pinned. The automation it produces is a
  normal automation, visible in Studio → Automations.
- **Executions / Runs** — the `fill` phase runs that automation once via `core/automationRunner` and
  shows the run with the Executions step timeline and the read-only run canvas.
- **App Studio** — the `app`/`app_turn` phases mount the real `AppEditorShell` + `BuilderChatPane`
  on an app the server pre-created when the previous phase was confirmed.
- **Approvals** — the approval phase builds a **second automation** that parks a row and calls
  `builder_add_approval`; the human decision happens in **Studio → Approvals**, never inside the app.
- **Nextcloud** — the built-in recipe reads a Nextcloud folder through the user's Nextcloud
  connection (`nextcloud_list_files` / `nextcloud_read_file`).
- **Studio rail counts** — `GET /api/studio/counts` includes a `playbooks` key, gated identically.
- **Studio recents flyout** — `studioRecentSources.js` maps `/api/playbooks` rows to
  `{id, name: title, description: recipeLabel, updatedAt}` with a folded status
  (running → processing, awaiting/stopped → paused, done → ready, any failed phase → failed).

---

## 9. Common mistakes

1. **Expecting phases to run unattended.** They do not: every landing waits for **Continue**.
   Autopilot only automates the pauses, and even then lingers 3–8 s.
2. **Trying to skip the Table phase.** Refused everywhere (button hidden, API 409): every later
   brief is built on the table's real ids.
3. **Picking an existing table you can only read**, or one whose columns don't map. The table phase
   fails with `table_read_only` / `table_unusable`. Check edit rights and column names first.
4. **Forgetting the status column** when you want the approval flow. No `status` → the approval
   phase is silently *skipped* (it says so, but people miss the rail line).
5. **A non-manual automation.** The `fill` phase can only run an automation with a **manual** trigger. If
   the builder gave it a schedule or a file trigger, the phase refuses with `trigger_not_manual`.
6. **Typing a relative folder.** The folder must be an absolute Nextcloud path starting with `/`.
7. **Two tabs on one playbook.** The second write hits a 409 and the page reloads; work in one tab.
8. **Expecting Delete to clean up.** Deleting a playbook leaves the table, the automation and the app
   in place — remove those in their own sections.
9. **Expecting approvals to live in the app.** They do not; approvals are decided in
   Studio → Approvals. A playbook that adds "approve in the app" is asking for the wrong thing.
10. **Editing a brief too late.** The textarea only affects the *next* phase; once a phase is
    running the brief is frozen (409).
11. **Assuming the description language is the build language.** The **Language** control decides
    the table's columns, the app's labels and the summaries — not the words you typed.
12. **Vague "Describe it" prompts.** A description that yields only a table phase is rejected by the
    validator (`no_builder_phase` — *"a table alone builds nothing"*). Say what is read, where it is
    stored, and what the app should show.

---

## 10. Three scenarios for Van Dijk Groep (Dutch SME)

### S1 — Procurement: supplier invoices from Nextcloud (the built-in recipe)
Anne (Office Manager, role **Agent Admin**) drops every supplier PDF in the Nextcloud folder
`/Inkoop/Facturen-Q3`. She opens **Studio → Playbooks → New playbook**, picks **Invoice tracker**,
Language **Nederlands**, Name `Inkoopfacturen Q3`, **A new table**, folder `/Inkoop/Facturen-Q3`,
Model **Fast**, approver group **Inkoop**. She presses **Start** and watches: the table *Facturen*
appears with 8 columns (Datum, Leverancier, Factuurnummer, Excl. btw, Btw, Totaal, Status, Bestand);
the automation *Facturen inlezen* is built (list files → read file → data_extraction → add_row); the
fill run pushes 32 rows into the table before her eyes; the designer sketches an **Overzicht** and a
**Factuur** screen; the app is built; and the approval automation parks the oldest `open` invoice for
the Inkoop group in **Studio → Approvals**. Teaching points: the consent pause, the existing-vs-new
table choice, and where the approval actually happens.

### S2 — HR: sick-leave notes into a register ("Describe it")
Mo (HR, role **Agent Editor**, so he has `manage_apps` but *not* `manage_datatables`) describes:
*"Lees de ziekmeldingsformulieren in /HR/Ziekmeldingen in een tabel met medewerker, startdatum,
verwachte einddatum en afdeling, en bouw een app die per afdeling laat zien wie er nu ziek is."*
He presses **Let the AI write the phases**, reads the preview (Tabel → Automation → Eerste rijen →
Ontwerp → App) and the proposed columns, then **Start**. Teaching points: (a) a described playbook
is previewed *before* anything is created; (b) because Mo lacks `manage_datatables` the table phase
may refuse to create an organisation table — he either gets the permission or points the playbook at
an existing table; (c) the privacy rule: the rows stay inside Bee Flow — a playbook never ships
personal data to an outside system.

### S3 — Sales: the quotation pipeline on an existing Nextcloud Tables mirror
Sales already keeps offers in a Nextcloud Tables table mirrored into Studio as *Offertes*. Jeroen
(Sales lead, **Org Admin**) starts a described playbook, chooses **An existing table** → *Offertes ·
214 · Nextcloud*, and the first phase reports **"Tabel "Offertes" gecontroleerd: 6 kolommen
herkend (Nextcloud-spiegel)"** — plus, because the mirror has no `status` column, **"No status
column — the approval flow will be skipped."** He continues; the automation writes new offers *through*
the mirror into Nextcloud, and the app gives Sales an overview with a value-per-month chart.
Teaching points: mapping columns onto roles, what a Nextcloud mirror changes (writes go to
Nextcloud), and how a missing column quietly removes a phase.

---

## 11. API surface — list/read endpoints for a "did the learner do it?" check

All are mounted under `/api/playbooks` behind:
`requireModule('apps')` + `requireModule('automation')` + `requireCapability('app_studio')` +
`requireLicenseFeature('automations')`, then `requireAuth` in the router, and rate-limited to
60 req/min/user. **Reads need only a session; every write additionally needs `manage_apps`.**
Everything is scoped to the caller as owner (`user_id`), so a check sees only the learner's own work.

| Method | Path | Auth | What comes back |
|---|---|---|---|
| `GET` | `/api/playbooks` | session (mount gates) | `{ playbooks: [row] }` — the caller's own playbooks, newest `updatedAt` first, up to 100. Row: `id`, `title`, `recipeId`, `recipeLabel`, `status` (`active`/`done`/`stopped`), `currentPhase`, `progress {done,total,locked}`, `phases: [{key, kind, label, status}]`, `updatedAt`, `createdAt`. **No explicit owner field — ownership is implicit: the list is `WHERE user_id = <caller>`.** |
| `GET` | `/api/playbooks/:id` | session | `{ playbook }` — the full row: `id, organizationId, userId (owner!), recipeId, recipe (document or null), title, status, options {tableMode, datatableId, tableTitle, folderPath, inputs, tier, locale, approverGroupId}, phases[…full objects: key, kind, label, status, brief, briefVersion, briefEdited, attempt, startedAt, finishedAt, artifacts{…}, summary, error], currentPhase, version, createdAt, updatedAt}`. 404 for someone else's id. Side effect: refreshes a `fill` phase that is still running. |
| `GET` | `/api/playbooks/recipes?locale=nl` | session | `{ recipes: [document], approvalsAllowed: boolean }` — the built-in recipes as documents in that language (id, title, description, table.fields, inputs, phases with labels and brief templates). Useful to assert which recipe/columns the learner should have seen. |
| `GET` | `/api/studio/counts` | session (`routes/studio/counts.js`, per-key gates) | includes `playbooks: { count, owners }` for the caller — a one-request "does this user have ≥ 1 playbook". |
| `GET` | `/api/datatables` | session | `{ datatables: [{id, name, key, rowCount, managedKind, …, usageCount}], scope }` — to verify the table the playbook created exists and holds rows. |
| `GET` | `/api/datatables/:id/rows?limit=8` | viewer grade on the table | `{ rows: [...] }` — to verify real rows landed (what the playbook's own rows preview reads). |

Write endpoints (for completeness, all `manage_apps`):
`POST /api/playbooks` (201 `{playbook}`), `PATCH /api/playbooks/:id` (CAS on `expectedVersion`),
`POST /api/playbooks/:id/phases/:key/run` (table/fill/design; fill may answer **202
`{playbook, pending:true}`**), `POST …/phases/:key/skip`, `POST …/phases/:key/retry`,
`POST /api/playbooks/recipes/compose` (`{recipe, warnings}`), `DELETE /api/playbooks/:id` (204).

Error codes a learner may meet: `recipe_unknown`, `recipe_invalid`, `bad_options`,
`version_required`, `bad_patch` (400); `manage_datatables_required`, `not_owner` (403); `not_found`
(404); `version_conflict`, `illegal_transition`, `automation_not_finalized`, `capability_missing`,
`artifacts_missing`, `phase_not_ready`, `key_taken` (409); `table_unusable`, `table_read_only`,
`trigger_not_manual`, `automation_missing`, `design_failed`, `compose_empty` (422); `compose_failed` (502).

---

## 12. Handy facts for lesson writing

- Deep links: `/app/studio/playbooks`, `/app/studio/playbooks/new`, `/app/studio/playbooks/<pb_id>`.
- Playbook ids look like `pb_a1b2c3d4e5f6` (`pb_` + 6 random bytes hex).
- DB: table `playbooks` (`id, organization_id, user_id, recipe_id, recipe JSONB, title, status,
  options JSONB, phases JSONB, current_phase, version, created_at, updated_at`), index on
  `(user_id, updated_at DESC)`.
- Phase transition table (server-enforced): `pending→ready|locked|skipped`,
  `ready→running|skipped|locked`, `running→awaiting|failed|skipped`, `awaiting→done|failed|skipped`,
  `failed→ready|skipped`, `skipped→ready`, `locked→skipped|ready`, `done→` (nothing).
- The client may only ask for `running`, `awaiting`, `failed`, `done`. `ready`, `skipped` and
  `locked` are the server's to set (via `/skip`, `/retry`, and phase preparation).
- Test/QA hooks: `data-testid` values `playbook-run`, `playbook-rail`, `playbook-phase-<key>`,
  `playbook-handoff` (`data-face="awaiting|failed|needs_input"`), `playbook-continue`,
  `playbook-skip-next`, `playbook-retry`, `playbook-stop`, `playbook-autopilot`,
  `playbook-next-brief`, `playbook-card-<id>`, `playbook-start`, `playbook-compose`,
  `playbook-recipe-preview`, `playbook-row-counter`, `playbook-rows-preview`.
- A live end-to-end harness exists: `./scripts/playbook-live-run.sh server/scripts/playbook-cases/01-invoice-new-table.json`
  (13 cases, exit 0 pass / 1 mismatch / 2 harness / 3 stream error).
