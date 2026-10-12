# Fact sheet — Apps (App Studio), audience: builder

Verified against the working tree on branch `claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.
Every label below is copied from source (`agent-hub/src/i18n/en-defaults.js`, JSX literals) or
from a server constant. Where the shipped docs disagree with the code, the code wins and the
drift is flagged.

**exists: true.** App Studio is a large, mature feature — ~40 server modules under
`server/appStudio/`, 10 route files, ~90 frontend modules under
`agent-hub/src/components/admin/Studio/AppStudio/`.

---

## 1. What it is for

App Studio lets a builder assemble an internal tool — an intake form, a tracker, a dashboard, a
small back office — as a **structured JSON component tree**, never as code. The AI builder can
write the whole thing from a sentence; the visual editor then refines it. An app owns its own
tables, its own roles and row rules, its own actions, and can be published to the organisation,
to specific groups, or (for one named screen) to the open internet.

- Builder surface: `/app/studio/apps` (Studio → **Apps**)
- End-user directory: `/app/apps` (AppsHomePage)
- One app, run view: `/app/apps/<appId>` (AppRunPage)
- Anonymous public page: `/p/<token>` (PublicAppPage)
- API base: `/api/studio-apps`

> **Naming trap for authors.** The capability/licence id is `app_studio`. A plain `apps` key
> exists too and is the **module** flag (`requireModule('apps')`). And `server/routes/apps.js`
> mounted at `/apps` is a *different, older* App Marketplace CRUD — not App Studio. Never cite
> `/apps` (no `/api`) endpoints as App Studio.

Key source files:
- `server/routes/studioApps.js` (CRUD, publish, versions, public pages, check, templates)
- `server/routes/studioAppsRun.js` (action run bridge), `studioAppData.js` (records/schema/members),
  `studioAppFiles.js` (attachments), `studioAppConnectors.js`, `studioAppDatasets.js`,
  `studioAppPublic.js` (anonymous), `studioAppUsage.js`, `studioAppBrowse.js`
- `server/routes/ai/appStudioBuilder.js` (AI builder SSE)
- `server/appStudio/` — `componentSpecs/`, `validate.js`, `canonicalize.js`, `rlsGateway.js`,
  `publicAccess.js`, `actionExecutor.js`, `builderTools.js`, `templates/`, `studioAppQuota.js`
- `agent-hub/src/components/admin/Studio/AppStudio/` — `AppList.jsx`, `editor/`, `inspector/`,
  `tables/`, `rbac/`, `runtime/`, `chat/`, `bi/`, `flow/`, `state/`

---

## 2. Screens, with real labels

### 2.1 Studio → Apps (gallery) — `AppStudio/AppList.jsx`

Registry entry (`Studio/studioApps.jsx`, `id: 'apps'`): label **"Apps"**, description
**"Build and publish internal apps"**, icon `LayoutGrid`, url segment `apps`, create-button
label **"App"** → `studio/apps/new`.

- Toolbar: heading **"Apps"**, primary button **"New app"**.
- Error strip: the message + **"Retry"**.
- Empty state: title **"Build your first app"**, body *"Turn an automation into a small internal
  tool — a form, a dashboard, a tracker — without writing code. Describe what you need and the
  AI can build it for you."*, action **"New app"**.
- Owner card: icon tile, name, description, badges **"Published"**, **"Storage NN%"**
  (only above 80 % of the DB cap; tooltip `Storage NN% of the app's database limit`),
  **"Update beschikbaar"** (tooltip `Nieuwe templateversie beschikbaar (vX → vY)`), and
  `Updated <date>`.
- Owner kebab (`App actions`, aria `Actions for <name>`): **Open · Rename · Delete**.
- A card for an app somebody else shared shows a hover affordance **"Open"** and links to
  `/app/apps/<id>` (the run view) — you cannot edit someone else's app.
- Rename modal: title **"Rename app"**, field aria **"App name"**; toasts **"App renamed."** /
  **"Could not rename the app."**, **"App deleted."** / **"Could not delete the app."**,
  **"App bijgewerkt naar de nieuwste templateversie."**

### 2.2 New app modal — `NewAppModal` in `AppList.jsx`

- Title **"New app"**, description *"Start from scratch or pick a template — the AI can build
  the rest with you."*
- Tabs (aria `How to start`): **"Start blank"** · **"From template"**
- Name field label: **"Name"** (blank tab) or **"Name (optional — templates bring their own)"**,
  placeholder **"e.g. Vacation requests"**, `maxLength={120}`.
- Blank tab button: **"Create app"**.
- Template gallery: card = title + category pill + description; captured templates carry an
  **"Eigen"** pill (tooltip `Gemaakt van een eigen app — versie N`) and a **"Verwijderen"**
  button (tooltip `Dit eigen sjabloon verwijderen`). Every card has **"Remix with AI"**.
- Empty/error: **"No templates available yet."**, **"Try again"**.

Built-in templates (`server/appStudio/templates.js` + `templates/`): *Request form* (Forms),
*Lookup console* (Data), *Ops dashboard* (Dashboards), *Team hub* (Content), *Approval inbox*
(Data), plus the data-backed ones: *BI reports*, *Support desk*, *AI system register*,
*Aanvraag automatisering*, *Knowledge base governance*, *Data subject requests*, *Quote intake*,
*Sprint planning*, *Invoice approvals*, *Data breach register*, *Processing register
(verwerkingsregister)*, *Meeting dossier*. An org's own captured templates (`utpl_…`) appear in
the same gallery.

### 2.3 The editor — `editor/AppEditorShell.jsx` + `editor/EditorHeader.jsx`

Three columns: **AI builder** chat (left, collapsible/resizable 280–480 px, default 340) ·
canvas (centre) · **Inspector** (right, 260–560 px, default 320).

Header row: `←` **"Back to Apps"** · app tile + name (aria **"App name"**, rename via
**"Rename app"**) · save pill **"Saved · v{version}"** / **"Saving…"** / **"Saving failed"** ·
the five-segment view control · notices · **"View as"** · publish pill · **"More"** (⋯).

- View segments (aria **"Editor view"**): **Edit** · **Preview** · **Data** · **Logic** · **Roles**.
  `PANEL_VIEWS = ['data','logic','roles']`; Edit/Preview are canvas *modes*.
- **"View as"** menu (aria **"View as role"**, tooltip *"Preview which screens and components a
  role sees"*): **"Owner (full view)"** plus each app role. Banner: **"Previewing as"** …
  *"screens and components hidden from this role are hidden here. Lists and tables still show
  everything you can see; each person only gets their own rows once they open the app themselves."*
  · **"Exit preview"**.
- Publish pill: **"Publish"** / **"Publish changes"**; tooltips *"Everything on this canvas is
  live."* and *"The version people use is older than what you see here — publish to make these
  changes live."*
- ⋯ menu: **"Command palette"**, **"Version history"**, **"View as role…"**, **"Undo"**,
  **"Redo"**, **"Close"**.
- Notices popover: **"From the last save"** (aria *What the last save reported*), **"All {count}"**.
  Issue counter: **"{count} to check"** / **"1 to check"**, each row with **"Show me"**.
- Conflict dialog: **"This app changed in another tab"** — *"Someone (or another tab) saved a
  newer version while you were editing."* Choices **"Load latest"** and **"Overwrite with mine"**.
- Version history: **"Version history"**, rows **"Version {n}"**, **"Restore"**,
  *"Restoring creates a new version — nothing is lost."*, empty **"No saved versions yet —
  versions appear when the app is published or restored."**

Screen tabs (`editor/ScreenTabs.jsx`): **"Add screen"**, default name **"Screen {n}"**,
**"Screen options"**, **"Rename"**, **"Set as home screen"**, **"Delete screen"**
(*"The screen and everything on it are removed from the app. You can undo this."*),
**"Manage navigation…"**, and the refusal **"An app needs at least one screen"**.

Component ribbon (`editor/ComponentRibbon.jsx`): kicker **"Components"**, tabs
**"Start here"** / **"All"**, categories **Basics · Content · Layout · Data · Input · AI**,
search placeholder **"Search a component…"**, no-match **"No components match “{query}”"**,
card tip **"Click to add — or drag it onto the canvas"**, and **"Hide the component strip"** /
**"Show the component strip"**.

Canvas: drag handle *"Drag to move · Alt+↑/↓ to reorder"*, resize handles
**"Resize width"** / **"Resize height"**, multi-select **"{n} selected"**,
**"Duplicate selected"** / **"Delete selected"**, delete confirm **"Delete this {label}?"** /
**"Delete {n} components?"**. Node badges: **"Hidden in the running app"**,
**"Only shown when {expr}"**, **"Only usable when {expr}"**, **"Checks {n} rules before
submitting"**, **"points at an action that no longer exists"**.

Inspector (`inspector/InspectorPanel.jsx`, aria **"What to edit"**): tabs
**"Look"** / **"Behaviour"**, sections **"Content"**, **"Style"**, **"Logic"**, **"Actions"**.
Event headings: **"When clicked"**, **"When submitted"**, **"When it changes"**,
**"When a row is clicked"**, **"When a row is selected"**, **"When a card is moved"**,
**"When a decision is made"**.

### 2.4 Data view (`views.tables`) — `tables/TablesManager.jsx`

Title **"Tables"**, description *"The tables this app stores its rows in — fields,
relationships and the rows themselves."* Tabs: **Tables · Rows · Relationships · Connectors ·
People**. Footer **"Save changes"**; loading **"Loading tables…"**.

- **Rows** is disabled until the table exists server-side — tooltip *"Save the table first —
  until then there is nowhere to keep its rows."*; hint **"Save the table to start adding rows."**
- A table linked to a Studio datatable: badge **"Linked"**, **"Linked to a Studio table"**,
  *"The columns below describe what this app expects to find there. Changing them does not
  change the Studio table."*, mode **"Read only"** / **"Read and write"** /
  **"Unknown access — this link does not work"**, hint **"Rows come from a Studio table."**
- **People** tab: checkbox **"Let this app see who is in your organisation"** —
  *"Person fields can then offer your real colleagues, and work assigned to someone is assigned
  to their account… Only names are shared — never e-mail addresses, and never anyone outside
  your organisation."*
- One-click generators drop a bound form/grid onto the current screen
  (`state/generators.js` buildFormForTable / buildGridForTable).

### 2.5 Logic view — `editor/LogicaTab.jsx`

Title **"What happens in this app"**, description *"Every component that does something, by
screen. Select one to change it."*, empty **"Nothing is wired yet — select a button on the
canvas and choose what it should do."** Columns: **When · What happens · Status · Open**.
Trigger phrasings: **"When the screen is opened"**, **"When a new row is added"**,
**"When this app calls it"**, **"When someone runs it by hand"**, **"On a schedule"**,
**"When a webhook arrives"**, **"When an agent calls it"**, **"When data in the app changes"**,
**"Nothing starts this yet"**, **"No action yet"**. Second block:
**"Your automations in this solution"** — *"Automations you own, filed in the same solution and
working on the tables this app is bound to… Automations owned by someone else are not listed here."*
Status pills: **"{count} runs by you in the last 24 hours"**, **"{count} decisions waiting for
you"**, **"Not available"**.

### 2.6 Roles view — `rbac/RolesManager.jsx`

Title **"Roles"**, description *"Decide who gets which role, what each role sees, and which
rows they can touch."* (aria *Roles and access*). Sub-tabs **"Screen access"** and
**"Row rules"**. Controls: **"Default role (everyone else)"** with options
**"App default (full access)"** / **"No access"**, **"Organisation groups"**,
per-person assignment (**"Choose a person…"**, **"No one is assigned directly yet."**,
**"Add a role above before assigning people."**). Leaving mid-edit:
**"Leave without saving?"** — *"Your changes to roles and row rules have not been saved yet.
Leaving now discards them."* → **"Discard changes"** / **"Keep editing"**.

### 2.7 Variables — `variables/VariablesManager.jsx`

**Not a sixth segment**: Variables is the second sub-tab of the **Data** view
(`editor/EditorViews.jsx` → `DataView`, tabs **Tables** | **Variables**, the Variables tab
carrying a badge with the count). Description *"Named values your screens and actions share —
formulas read them as vars.<name>."*

- Intro copy: *"A variable is a named value your screens and actions share. Formulas read it as
  `vars.name`. Giving one a starting value means a list filtered on it filters straight away,
  instead of showing everything until something sets it."*
- Per-variable fields: **"Name"** (hint *"How a formula refers to it: vars.<name>."*; once the
  variable is used the name is locked — *"In use, so the name is fixed — nothing rewrites the
  formulas that read it."*), **"Shown as"**, **"Holds"** (type), **"Starts out as"**
  (`DefaultField`, follows the type), **"What it is for"** (*"Shown to whoever edits this app
  next."*). Each row shows **"used {n}×"** / **"unused"** and a Delete button (never behind a
  hover).
- Add: **"New variable"**; at the ceiling the button is disabled with the title
  *"An app can hold 30 variables."* Empty state **"No variables yet."**
- Undeclared reads: **"One formula reads a variable that does not exist"** /
  **"{n} formulas read variables that do not exist"** — *"Nothing gives vars.x a value, so it
  resolves to nothing — and a filter using it is dropped, which shows every row instead of
  none."* → **"Declare it"** / **"Declare them all"**.
- Delete confirm: **"Delete “{name}”?"** — *"{n} places still use it, and will start resolving
  to nothing"* + the sites → **"Delete anyway"**.
- Writing one at run time is the sequence step `set_variable` (`flow/stepCatalog.js`):
  label **"Set a variable"**, group **"On screen"**, blurb *"Put a value in one of the app's
  shared variables."* A `resultVar` on a step writes one too.
- Caps (`limits.js`): **30** variables per app (`MAX_VARIABLES`), each default at most
  **2 048 bytes** (`MAX_VARIABLE_DEFAULT_BYTES`).

### 2.8 Publish modal — `editor/PublishModal.jsx`

Title **"Publish app"**, body *"Choose who can open this app. Publishing takes a copy of the
app as it is now — you can keep editing afterwards, and readers stay on that copy until you
publish again."* Status line **"Currently:"** + **"Last published {when}"**.

Three audiences: **"Private draft"** · **"Everyone in your organization"** · **"Specific groups"**.
Buttons **"Apply"** / **"Cancel"**; also **"Check this app"** (*"Tries the app’s screens and
logic without changing anything."*) → **"Checking…"**, **"Everything loaded and every step
checks out."**, **"{n} things are broken"** (*"These stop the app working for the people you
share it with."*), **"{n} things worth a look"** (*"These do not stop you publishing."*).
A refused publish (422) renders **"{n} things to fix before publishing"** with
*"Nothing changed for your readers — they still see the version you published last."*
Each row has **"Show me"** to jump to the node; **"View live"** opens the app.

Nextcloud block: checkbox **"Show in the Nextcloud app menu"**, description *"Adds this app to
the top bar of your organization’s connected Nextcloud… Everyone on that Nextcloud sees the
icon; only the audience you chose above can use the app."* Results: **"Added to the Nextcloud
app menu — reload Nextcloud to see it."**, **"Saved — the icon appears in Nextcloud within a
few minutes."**, **"Saved — the app icon appears once your organization’s Nextcloud is
connected to Bee Flow."**, **"Removed from the Nextcloud app menu — reload Nextcloud to update
it."**

Toasts: **"App published to your organization."**, **"App shared with the selected groups."**,
**"App unpublished — it is a private draft again."**, **"Publishing failed."**

### 2.9 AI builder pane — `chat/BuilderChatPane.jsx`

Title **"AI builder"** (shell toggles **"Show the AI builder"** / **"Hide the AI builder"** /
**"The AI is building — click to watch"**). Empty state **"Build with AI"** —
*"Describe the app you want — I'll build it on the canvas"*. Composer placeholder
**"Describe a change, or paste a screenshot…"** (busy: **"The AI is building…"**),
**"Send"** (Enter), **"Stop"**, **"Attach an image"** (*"You can attach up to {n} images"*).
Quick actions: **"Use my data"**, **"New screen"**, **"Fix errors"** (disabled label
**"No issues to fix"**).

Build banner: **"Building"**, **"Phase {i}/{n}"**, **"Plan {done}/{total}"**,
**"Follow the build"**, **"Built · {n} components · {s} screens · {t}"**,
**"Stopped — draft saved"**, **"Checking the app…"**.
Activity rows read like *"Created a table"*, *"Added a screen"*, *"Wired a control"*,
*"Set up roles"*, *"Added sample rows"*, *"Checked the data"*, *"Checked and saved the app"*,
*"Not applied"* / **"{n} refused"** (tooltip *Calls the builder refused — each row says why*).
Validation strip: **"{n} issues to review"**, **"Fix"**, **"Technical detail"**,
**"The AI is fixing {n} issues…"**

### 2.10 End-user surfaces

- `/app/apps` (**"Apps"**): **"Recently used"**, **"All apps"**, search **"Search apps…"**,
  category pills **All · Sales · Service · Finance · HR · Internal**, empty state
  **"No apps yet"** — *"No apps have been shared with you yet. When someone in your
  organization publishes an internal tool to you, it will appear here."*, footnote
  *"An app is a small tool someone in your organization built in App Studio…"*,
  **"Build in Studio"**, **"Only what you are allowed to use appears here"**.
- `/app/apps/<id>` refusals: **"This app is shared with specific groups"** /
  **"This app is not available to you"** / **"Could not load this app"**.
- `/p/<token>` (anonymous): errors **"Deze pagina bestaat niet (meer)"** /
  **"De pagina kon niet worden geladen"** with **"Opnieuw proberen"**.

---

## 3. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **App (Studio app)** | A JSON definition — screens, sections, components, actions, roles, variables — stored as one row in `studio_apps`. Never code. |
| **Definition vs published definition** | The *draft* is what you edit; **Publish** freezes a validated copy into `published_definition`. Everyone but the owner always runs the frozen copy. |
| **Screen** | One page of the app. It has sections; sections hold components. One screen is the **home screen**. |
| **Section** | The grid row band inside a screen. Components sit in a 12-column grid inside it. |
| **Component** | A visual building block (`heading`, `form`, `data_grid`, `kanban`, `chart`, `ai_chat`, …). 47 types in six ribbon categories. |
| **Action** | What a control does when something happens. One `kind` (Run automation, Add a row, Go to screen, Show a message, …) or a `sequence` of steps. |
| **Sequence / step** | A multi-step flow. Client steps (navigate, toast, confirm, set_variable, condition, loop, switch…) run in the browser; **data-mutating steps** (create_record, run_automation, send_email, ai_extract, …) are re-resolved and executed on the server. |
| **Binding** | Where a component gets its data: a table (+ filters/sort), a dataset, a connector, a formula, or a previous action's result. |
| **Data model** | The app's own tables and fields (`PUT /:id/schema`). Each app gets its own private database. |
| **Linked table (datatable source)** | A model table whose rows actually live in a **Studio datatable** outside the app. Effective access = the *minimum* of (viewer's grade on the datatable, owner's grade, the app role's table access). Renaming its columns changes nothing in the datatable. |
| **Role** | An app-local role (`{key,label}`). Resolution order: owner → members row → `roleMapping.byGroup` → `roleMapping.default` → none. |
| **Access mode** | Per table: `app` (anyone who can open the app), `owner`, `role`, `none`. |
| **Row rule (RLS)** | A bounded expression over `record.*` and `viewer.*` (e.g. `record.created_by == viewer.id`) compiled to parameterised SQL server-side. Apps can never run raw SQL. |
| **Connector** | An external read: an integration tool, an automation, or a REST endpoint. Always runs **as the app owner**, behind an SSRF guard; credentials are never pasted into the app. |
| **Dataset** | A saved query/upload the app reads from; large (multi-GB) datasets are a separate Enterprise feature. |
| **Variable** | A named value shared across screens and actions; formulas read it as `vars.<name>`. |
| **Public page (`publicAccess`)** | A whitelist of screens an anonymous visitor may open at `/p/<token>`. Visitors carry the reserved role `public`, which is **denied by default** on every table. |
| **Template / captured template** | A starting point. Built-ins are code; a captured template (`utpl_…`) is an app your org saved to its own gallery, and can be deleted. |
| **Checkpoint / version** | A snapshot in `studio_app_versions`, written on publish, on restore and at AI phase boundaries. Only the newest **20** per app are kept. |
| **CAS save (baseVersion)** | Every draft save carries the version it was read at; a stale save gets a 409 with the server's copy so you can reconcile. |

---

## 4. End-to-end workflows

### W1 — Build an app with the AI, then publish it

1. Left sidebar → **Studio** → **Apps**.
2. Click **New app** (or the section's **+ App**).
3. Keep the **Start blank** tab; type a name, e.g. `Leveranciersaanvragen`. Click **Create app**.
4. The editor opens with the AI builder pane on the left. Type the request in
   **"Describe a change, or paste a screenshot…"** and press Enter.
5. For a larger app the AI first proposes a plan card. Read it, edit a line if needed, click the
   plan's build button. The banner shows **"Phase {i}/{n}"** and **"Plan {done}/{total}"**.
6. Watch the activity rows (*Created a table*, *Added a screen*, *Wired a control*,
   *Checked the data*). Use **"Follow the build"** if the canvas lags behind.
7. When the banner reads **"Built · N components · S screens · …"**, switch the header to
   **Preview** and click through the app.
8. Header → **Publish**. Choose **Everyone in your organization** or **Specific groups**
   (then pick groups). Optionally tick **Show in the Nextcloud app menu**.
9. Click **Check this app** first if you want the pre-flight; then **Apply**.
10. Toast **"App published to your organization."** Use **View live** to open `/app/apps/<id>`.

### W2 — Design the data model by hand and put a form on screen

1. In the editor, header → **Data**. The tab strip shows **Tables · Rows · Relationships ·
   Connectors · People**.
2. On **Tables**, add a table (e.g. `purchase_requests`) and add fields — types are
   `text, richtext, number, date, datetime, bool, select, multiselect, relation, file, computed`.
3. Click **Save changes**. This runs the server migration; only now does the table exist.
4. The **Rows** tab becomes enabled. Add a few rows by hand (or paste from a spreadsheet via the
   paste-import panel).
5. Back on **Tables**, use the generator to drop a bound **form** or **grid** for that table onto
   the current screen.
6. Close the Data view, select the new form on the canvas, and in the Inspector's
   **Behaviour** tab set **"When submitted"** → **"Add a row"**, pointing at the table.
7. Preview, submit a test row, then check it under **Data → Rows**.

### W3 — Wire a button to an automation

1. Select (or add) a **Button** on the canvas.
2. Inspector → **Behaviour** → **"When clicked"**. Four cards are offered:
   **Run automation** · **Go to screen** · **Add a row** · **Show a message**; everything else is
   under **"All options"** (AI · extract from document, AI · generate / summarize,
   AI · search knowledge base, Open a web page, Open a dialog, Close a dialog, Send an e-mail,
   Several steps (a flow)).
3. Pick **Run automation**. Either **"Choose an automation…"** from your own automations, or
   **"Make an automation for this app"** — which creates one already carrying a Studio App trigger
   (**"It starts with {n} inputs matching this form."**).
4. Map the inputs under **"Change what gets sent"** (a `field` mapping takes a form field; a
   `static` mapping is a fixed value).
5. Use **"Test with what is on screen"** — *"Runs the automation for real, with the values standing
   in this form right now, and opens the run in the builder."*
6. Set the echo line: what the button shows **While it runs**, on **Done** and on **Failed**.

### W4 — Roles and row-level access

1. Header → **Roles**.
2. Add the roles the app needs (e.g. `inkoper`, `manager`). Keys are slugified automatically.
3. Set **Default role (everyone else)** — **App default (full access)** or **No access**.
4. Map **Organisation groups** → role, and add individual people where needed (members beat
   group mapping, which beats the default).
5. Switch to **Screen access** and hide screens a role must not see.
6. Switch to **Row rules**: per role, per table, set the access mode (`app`/`owner`/`role`/`none`)
   and a row expression such as `record.created_by == viewer.id`.
7. Save (the roles panel has its own Save — leaving without it discards the edits:
   **"Leave without saving?"**).
8. Verify with **View as** → the role, then **Preview**. Remember: the preview hides screens and
   components; **row** filtering only really happens when that person opens the app themselves.

### W5 — Open one screen to the outside world (`/p/<token>`)

1. Design a single intake screen (prefer ONE screen with sections gated by `visibleWhen` over a
   multi-screen wizard — a wizard can be skipped by navigating).
2. Grant the reserved role `public` on the target table **explicitly** —
   `{create: true, read: "own"}` is the usual intake shape. Without this the visitor gets nothing:
   `public` is denied by default.
3. Set the `publicAccess` block (entry screen, allowed screens, optional title/theme/design).
   Today this is done by the AI builder tool `app_set_public_access` or over the API — **there is
   no dedicated panel in the editor UI** (no frontend module references `publicAccess`).
4. **Publish** the app — anonymous visitors are always served the frozen published definition.
5. Mint the URL: `POST /api/studio-apps/<id>/public-pages` → `{ token, url, createdAt,
   lastSeenAt, visits }`. Max **3** live URLs per app.
6. Share the `/p/<token>` link. The page mints a fresh anonymous viewer id per load
   (`anon:<hex>`) and a visitor bearer token.
7. Revoke with `DELETE /api/studio-apps/<id>/public-pages/<token>`. Both mint and revoke write an
   audit event (`appStudio/publicationAudit.js`).

### W6 — Recover from a bad change

1. Header → **⋯** → **Version history**. Rows read **"Version {n}"**.
2. Click **Restore** on the snapshot you want. *"Restoring creates a new version — nothing is
   lost."* → toast **"Version restored."**
3. If another tab saved meanwhile you get **"This app changed in another tab"** —
   choose **Load latest** (keeps your unsaved work only in this tab's undo history) or
   **Overwrite with mine**.
4. For an AI turn: every AI turn is one undo step (Cmd/Ctrl+Z), and the builder also writes
   checkpoints at phase boundaries.

---

## 5. Defaults and limits (code-verified numbers)

### Definition caps — `server/appStudio/componentSpecs/limits.js`

| Limit | Value |
|---|---|
| Screens per app | **40** |
| Sections per screen | **40** |
| Total nodes (sections + components) | **500** |
| Actions per app | **60** |
| Nesting depth (components) | **6** |
| Steps in one action sequence | **60** |
| Sequence nesting depth | **6** |
| `loop.maxIterations` ceiling | **200** |
| Any single string prop | **5 000** chars |
| Definition size | **512 KB** (`MAX_DEFINITION_BYTES`) |
| App name | **80** chars (`MAX_NAME_LEN`; the New-app input allows 120 and the server truncates) |
| Roles per app | **20** |
| Variables per app | **30** (each default ≤ 2 048 bytes) |
| Select options | **100** · Table columns **12** · Data-grid columns **20** |
| Chart series **12** · reference lines/bands **8** | |
| Kanban columns **12** · swimlanes **12** · card fields **6** | |
| Record-detail fields **30** · filter-bar fields **8** · stepper steps **10** · key–value fields **20** | |
| Static rows **200** · navigate params **20** · validations per field **10** · formula length **2 000** | |

### Data caps — `server/core/dataEngine/dataModel/vocabulary.js` (`DATA_LIMITS`)

| Limit | Value |
|---|---|
| Tables per app | **50** |
| Fields per table | **100** |
| Rows per table | **100 000** |
| Rows per app | **500 000** |
| Database size per app | **256 MB** |
| Attachment size | **25 MB** |
| Attachments per app | **5 000** (`STUDIO_APP_MAX_ATTACHMENTS`) |
| Connectors per app | **50** (declared params per connector **20**) |
| Table/field name | **120** chars; computed expression **500** chars |

### Other numbers

- Public URLs per app: **3** (`MAX_PUBLIC_PAGES_PER_APP`).
- Screens a public page may expose: **12** (`MAX_PUBLIC_SCREENS`).
- Version snapshots kept per app: **20** (`MAX_VERSIONS_PER_APP`).
- AI builder: **24** iterations per turn max, **8 192** output tokens per round,
  **5** checkpoints per turn, **4** consecutive refusals of one tool ends the turn,
  up to **4** attached images (≤ 5 MB each decoded).
- Storage pill appears above **80 %** of the DB cap.
- Category string ceiling **64** chars.

### Rate limits (per user + app, per minute, env-tunable)

AI builder **12** · data reads **60** · data writes **20** · action runs **10** ·
sequence steps **60** · connector runs **20** · connector sync **6** · send e-mail **5/min and
200/day** · file intake **6** · AI steps **30** · AI browse **4** · dataset query **30**.
Public page: **60/min per IP**, **240/min per token**, steps **30**, uploads **20**.

> **Doc drift to flag in lessons:** `docs/docs/studio/apps.md` still says *20 screens* and
> *20 connectors per app*. The code says **40** and **50**. Teach the code values.

---

## 6. What happens on failure

| Situation | What the learner sees / gets |
|---|---|
| Draft save while another tab saved | **409** `{ conflict: true, currentVersion, definition }` → the **"This app changed in another tab"** dialog. Never auto-retried. |
| Draft save that fails validation | **422** `{ errors, warnings }`. Data-reference problems are demoted to **warnings** on draft saves so a half-wired draft stays saveable. |
| Definition over 512 KB | **413** `App definition exceeds 524288 bytes`. |
| Publish with a broken draft | **422** *"Fix the app's validation errors before publishing"*. Modal stays open, lists each `{code, severity, path, message, hint}`, **"Show me"** jumps to the node. **Nothing changes for readers.** |
| Publish referencing an automation that is missing, inactive or owned by someone else | Blocked at publish (`action.automation_missing/_inactive/_invalid`). Draft saves let it through. |
| Publish to groups from two different orgs | **400** *"Cannot publish to groups across multiple organisations"*. |
| Publish with no organisation on the owner | **400** *"Cannot publish: owner has no organisation"*. |
| Row / DB / attachment quota reached | **409** `{ code: 'quota_exceeded', limit, used }` with a message like *"Table row limit reached (100000)"*. **Deleting rows always works**, so you can recover. |
| A member of the org who is not in the published groups opens the app | **403** `{ code: 'not_in_audience' }` — *"This app is shared with specific groups in your organisation"*. |
| Anyone outside the org | **404** *"App not found"* — existence never leaks. |
| Non-owner tries to publish/save/delete a readable app | **403** *"Only the owner can change publish state"*. |
| Missing `manage_apps` permission | *"Permission 'manage_apps' required"* on create/save/publish. Read and run still work. |
| Public page not working | `GET /:id/public-pages` returns `blockers[]`: `no_public_access`, `not_published`, `not_in_published`, `surface_unresolved` — each with a sentence explaining the fix. |
| Public visitor token expired | **401** *"Your session expired — reload the page to continue."* |
| AI builder failure | Typed SSE `error` codes surfaced as copy: *"I ran out of build turns for this request, but your progress is saved."* (`budget_exhausted`), *"The model ran out of room while reasoning and never got to building."* (`model_truncated`), *"The model stopped twice without calling a tool or saying anything…"* (`model_empty_reply`), *"You've reached your plan's AI limit."* (`subscription_limit`), *"The app changed in another tab while the AI was building."* (`save_conflict`), plus `rate_limited`, `model_unavailable`, `transient_upstream`, `model_rejected`, `validation_failed`, `internal`. **In every case the draft is saved.** |
| Template data install fails | The app is still created; the response carries `dataInstall: { ok:false, error }` so the failure is not silent (the app would otherwise have screens but no tables). |
| Template upgrade refused | **409** `not_pristine` / `no_newer_version` / `not_from_template`. |

---

## 7. Permission, licence and capability gates

Four independent layers, all checked:

1. **Module** — `requireModule('apps')` on the whole `/api/studio-apps` mount.
2. **Licence feature** — `app_studio` lives in the **enterprise** tier list
   (`server/license/tiers.js`). Not in Community.
3. **Capability / beta** — `requireCapability('app_studio')`; registered in
   `server/core/entitlements/betaFeatures.js` as **GA** (auto-on for Enterprise orgs; an org
   admin can disable it). Frontend gate in `Studio/studioApps.jsx`:
   `hasLicenseFeature('app_studio') && canUse('app_studio')`, `lockOn: 'disable'`.
4. **Permission** — `requirePermission('manage_apps')` on every **write** route:
   `POST /`, `PUT /:id`, `PUT /:id/definition`, `PATCH /:id/publish`,
   `PATCH /:id/nextcloud-menu`, `DELETE /:id`, `POST /:id/versions/:versionId/restore`,
   `POST /:id/template-upgrade`, `POST|DELETE /:id/public-pages…`, `DELETE /templates/:id`.

Who holds `manage_apps` (`server/config/orgRoles.json`): **org_admin**, **agent_admin**,
**agent_editor**. **member**, **dpo** and **isms_auditor** do **not**. Reading and *running* an
app stay on the capability — using what someone else built is the ordinary case.

Other gates in the same area:
- `GET /api/studio-apps/usage` — `requirePrimaryOrgAdmin()` (org admin or super admin).
- Large datasets — router-level `requireFeature('large_datasets')` (also Enterprise).
- Approvals raised from an app action need the `approvals` licence feature.
- Studio MCP (`POST /mcp/studio`) — off unless `STUDIO_MCP_ENABLED=1`, plus a `bfmcp.…` bearer
  token, plus the `app_studio` capability, plus `canWriteStudioApp` on the target app.
- `/api/public-app/*` has **no** capability gate by design: once an owner (whose org is gated)
  mints a public page, its visitors are anonymous third parties.

Ownership model: an app has exactly one `userId` owner. **Only the owner edits.** Actions run
**acts-as-owner** (the automation must belong to the app owner), with the viewer's identity carried
in the trigger payload as `_viewerUserId` for audit only — never used to scope the run.

---

## 8. How Apps connects to the rest of the product

- **Automations (automations)** — the primary action kind. A button can create an automation already
  carrying a Studio App trigger and matching inputs. Automations fired from an app must be owned by
  the app owner and active. Logic view also lists your automations filed in the same Solution.
- **Datatables** — a model table can be `source: {kind:'datatable'}`, mirroring an org datatable.
  Effective access is the minimum of viewer grade, owner grade and app-role access.
- **Approvals** — `request_approval` steps raise approvals into Studio → Approvals
  (Enterprise `approvals`).
- **Knowledge bases** — the `kb_query` action/step searches a KB.
- **Solutions (projects)** — an app carries `projectId`; project members are an *additional*
  audience on top of org/group publishing.
- **Playbooks** — `/api/playbooks` runs phased AI builds that own an automation *and* an app; it
  requires both modules and the `app_studio` capability plus the `automations` licence.
- **Nextcloud connector** — a published app with `nextcloudMenu` gets an icon in the org's
  Nextcloud top bar (`GET /api/nextcloud/studio-apps` feeds the connector).
- **Forms** — a separate Studio section (a form is a *automation*, keyed by the automation id at
  `/app/studio/forms/<automationId>`). Do not confuse it with an app's public page.
- **Usage/telemetry** — action runs are logged to `ai_usage_log` with
  `agent_type = 'studio_app_builder'` for builder turns; run counts feed `GET /usage-counts`.

---

## 9. Common mistakes

1. **Editing the template file instead of the app.** Work on a customer app goes through the
   `app_*` tools on the live app (the MCP endpoint or the in-product builder), not through
   `server/appStudio/templates/`. A template change needs a server image rebuild.
2. **Forgetting to publish.** Every non-owner — and every anonymous visitor — runs the *frozen*
   copy. Editing the canvas changes nothing for readers until **Publish changes**.
3. **Expecting the public page to inherit table access.** The reserved role `public` is denied
   by default. If you do not grant it explicitly per table, the visitor's form submits nothing.
   (An ordinary table defaults to `app`, which *would* have handed every visitor every row —
   which is exactly why the deny-by-default exists.)
4. **Adding rows before saving the table.** The Rows tab is disabled until the model is saved and
   migrated. *"Save the table first — until then there is nowhere to keep its rows."*
5. **Renaming a linked datatable's column expecting it to change the datatable.** It does not —
   the app-side columns only describe what the app expects to find there.
6. **Treating the role preview as a security test.** *View as* hides screens and components; row
   security is enforced by the server only when that person actually opens the app.
7. **Wiring a colleague's automation.** The automation must belong to the app owner, or publish fails
   with `action.automation_missing` / `action.automation_invalid`.
8. **Publishing an automation that is inactive.** Blocked at publish, allowed on a draft save.
9. **Rotating a public URL by minting a new one and forgetting to revoke the old.** Up to 3 live
   URLs exist simultaneously; the old link keeps working until you delete it.
10. **Hitting the action-step caps and blaming the builder.** 60 steps / depth 6 per action.
    Raising a LIMIT constant requires a server rebuild.
11. **Assuming `/usage-counts` counts app opens.** It counts *action runs* (`unit: 'action_runs'`)
    — an app that writes records another way counts 0 while it runs daily.
12. **Splitting a public wizard over several screens.** A visitor can navigate past screens; the
    guidance is one screen with `visibleWhen`-gated sections.
13. **Expecting the Nextcloud icon to follow a "Specific groups" audience.** Nextcloud menu
    entries are instance-wide; everyone sees the icon, only the audience can use the app.
14. **Confusing `/apps` (the old App Marketplace router) with `/api/studio-apps`.**

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

### S1 — Procurement: *Inkoopaanvragen* (purchase requests)

Van Dijk Groep's site managers mail purchase requests to the office, where Nadia retypes them.
Build an app **"Inkoopaanvragen"** with one table `aanvragen`
(`aanvrager` person, `project` text, `leverancier` text, `omschrijving` textarea,
`bedrag` number, `nodig_op` date, `status` select `nieuw/goedgekeurd/afgewezen`,
`bijlage` file). Screens: **Nieuwe aanvraag** (a form; **When submitted** → *Add a row*) and
**Openstaand** (a data grid filtered on `status == "nieuw"`, plus a *Goedkeuren* button running a
`request_approval` step to the office manager). Roles: `aanvrager` (row rule
`record.created_by == viewer.id`) and `inkoop` (full read). Publish to **Specific groups** →
the *Uitvoering* group. Teaching points: person field needs **People → "Let this app see who is
in your organisation"**; the 25 MB attachment cap; the approval step needs the Enterprise
`approvals` feature.

### S2 — HR: *Verlofaanvragen* (leave requests) with a public page

HR wants a leave request form that seasonal workers without a Bee Flow account can also fill in.
One app, two audiences: an internal **Overzicht** screen (kanban by `status`, grouped per team)
for HR, and one **Aanvraag indienen** screen opened publicly at `/p/<token>`. Grant the reserved
role `public` on `verlof` as `{create: true, read: "own"}` so a seasonal worker sees back only
their own submission. Publish the app, then mint the public URL and style it in Van Dijk's house
colours via the public page's own `theme` (the back office keeps the app's look). Teaching
points: `public` is deny-by-default; the app must be published before `/p/` works; **never** put
BSN or salary data on a table a public role can read; the blockers list tells you exactly which
of the four preconditions is missing.

### S3 — Sales: *Offerte-intake* (quote intake)

Sales wants quotes tracked instead of living in mailboxes. Start from the built-in
**"Quote intake"** template (*From template* → **Remix with AI**), then tell the builder:
*"Add a `Vervolgacties` screen with a list of quotes whose `status` is `verzonden` and whose
`vervaldatum` is within 7 days, and a button that runs my automation 'Offerte-herinnering'."*
Wire the button to an existing automation (or **Make an automation for this app**, which seeds the
Studio App trigger with matching inputs), map the quote id and the customer e-mail, then
**Test with what is on screen**. Publish to **Everyone in your organization** and tick the
Nextcloud menu so the team reaches it from Nextcloud's top bar. Teaching points: the *Remix*
flow; the send-e-mail limit of 5/min and 200/day; **Check this app** before publishing; the
"Update beschikbaar" pill only appears while the app is still pristine since install.

---

## 11. List/read API endpoints for a "did the learner do it?" check

All of these live under `app.use('/api/studio-apps', requireModule('apps'),
requireCapability('app_studio'), …)` in `server/index.js` and additionally require a signed-in
session (`requireAuth`, cookie session — no API key path). Anything the caller may not see is a
404, never an empty row.

| Method | Path | Auth | JSON row / body |
|---|---|---|---|
| GET | `/api/studio-apps` | session + `app_studio` | `{ apps: [ … ] }` — meta only. Each row: `id, userId` **(owner)**, `organizationId, projectId, name, description, icon, accentColor, category, definitionVersion, publishedVersion, isPublished, sharedGroups[], templateId, templateVersion, templateInstallHash, nextcloudMenu, publishedAt, createdAt, updatedAt`. Scope: everything the caller may open (own + published-and-in-audience + project). |
| GET | `/api/studio-apps/mine` | session + `app_studio` | `{ apps: [ …same row… , usage:{dbBytes, dbRatio}, templateUpgrade:{available, fromVersion, toVersion} ] }` — **only apps the caller owns**. The cleanest "did they create an app?" check. |
| GET | `/api/studio-apps/:id` | session + `app_studio` | Owner → `{ app: <full row incl. definition>, readOnly:false }`. Reader → `{ app: <meta, no definition>, readOnly:true }`. 403 `not_in_audience` for an org member outside the groups; 404 otherwise. |
| GET | `/api/studio-apps/:id/runtime` | session + `app_studio` | `{ id, name, icon, accentColor, definition, … , viewer: { id, name, email, isOwner, roleKey } }` — draft for the owner (`?draft=1`), published copy for everyone else. Good for "is it published and does it render?" |
| GET | `/api/studio-apps/:id/versions` | session, **owner only** (404 otherwise) | `{ versions: [...] }` — publish/restore snapshot history. Confirms a publish or a restore happened. |
| GET | `/api/studio-apps/:id/public-pages` | session, owner only | `{ pages:[{ token, url, createdAt, lastSeenAt, visits }], publicAccess, blockers:[{code,message}] }` — confirms a public page exists *and* why it would not work. |
| GET | `/api/studio-apps/:id/schema` | session + `app_studio` (owner-scoped data model) | `{ model, modelVersion }` — the tables/fields the learner designed. |
| GET | `/api/studio-apps/:id/data/tables` | session, rate-limited 60/min | `{ tables: [{ id, key, name, icon, fields:[{id,key,name,type,subtype,required,unique,options?,relation?}], …link flags }] }` — RLS-filtered for the caller's role. |
| GET | `/api/studio-apps/:id/data/tables/:tableId/records` | session, 60/min | `{ records: [...], nextCursor, appVersion }` — confirms rows were actually created. |
| GET | `/api/studio-apps/:id/datasets` | session, 60/min | `{ datasets: [...] }` |
| GET | `/api/studio-apps/:id/data/connectors` | session | `{ connectors: [...] }` |
| GET | `/api/studio-apps/:id/members` | session | the app's per-user role assignments. |
| GET | `/api/studio-apps/:id/ref?screenId&nodeId` | session | Always **200**: `{ …app/screen/node names or ids }` — "the app is gone" and "you may not see it" are answers, not errors. |
| GET | `/api/studio-apps/usage-counts?window=month` | session + `app_studio` | `{ window, unit:'action_runs', counts: { [appId]: number } }`. Windows come from `usageStore.RUN_COUNT_WINDOWS`; an unknown one is a **400** `invalid_window`. Apps the caller may not see are **absent**, not zero. |
| GET | `/api/studio-apps/usage` | session + **org admin** (`requirePrimaryOrgAdmin`) | `{ totals, apps, limits:{maxDbBytes, maxRowsPerApp, maxRowsPerTable, maxAttachmentsPerApp, maxAttachmentBytes} }` — org-wide storage breakdown. |
| GET | `/api/studio-apps/templates` | session + `app_studio` | `{ templates: [{ id, title, description, category, icon, source:'builtin'\|'captured', version, … }] }` |
| GET | `/api/studio-apps/catalog` | session + `app_studio` | the static component/theme/action catalog (`Cache-Control: private, max-age=3600`). |
| GET | `/api/studio-apps/builder/session/:appId` | session, owner-scoped | `{ snapshot }` — the persisted AI chat; **404** if the learner never used the builder. |
| GET | `/api/public-app/:token` | **none** (anonymous, 60/min per IP, 240/min per token) | `{ app:{id,name,icon}, definition, entryScreenId, visitorToken }` — proves a public page is live. |
| GET | `/api/nextcloud/studio-apps` | connector auth | the published + menu-flagged apps the Nextcloud connector renders. |

**Recommended verification recipes**

- *"Did the learner create an app?"* → `GET /api/studio-apps/mine`, look for a row whose
  `userId` is the learner and whose `name` matches.
- *"Did they publish it to the org?"* → same row: `isPublished === true` and
  `sharedGroups.length === 0` (org-wide) or `> 0` (groups). `publishedVersion` non-null.
- *"Did they build a data model / add rows?"* → `GET /:id/schema` then
  `GET /:id/data/tables/:tableId/records`.
- *"Did they wire a real action?"* → `GET /:id` as the owner and inspect
  `definition.actions` (map keyed by action id, each with a `kind`).
- *"Did they open a public page?"* → `GET /:id/public-pages` — `pages.length > 0` **and**
  `blockers.length === 0`.
- *"Did they actually use the AI builder?"* → `GET /api/studio-apps/builder/session/:appId`
  returns 200 rather than 404.

---

## 12. Appendix — vocabulary lists worth quoting verbatim

**Component types (47)** — Basics: `button`. Content: `heading`, `text`, `image`, `callout`,
`markdown`, `page_header`, `file_preview`, `browser_view` (Live browser). Layout: `container`,
`pane`, `card`, `tabs`, `tab`, `modal`, `divider`, `spacer`. Input: `form`, `input_text`,
`input_textarea`, `input_number`, `input_select`, `input_multiselect`, `input_checkbox`,
`input_date`, `input_datetime`, `input_file`, `input_richtext`, `input_html`, `input_relation`,
`input_person`, `input_dataset`. Data: `table`, `list`, `data_grid`, `chart`, `pivot`, `stat`,
`kanban`, `calendar`, `repeater`, `record_detail`, `filter_bar`, `badge_list`, `progress`,
`stepper`, `timeline`, `file_gallery`, `message_thread`, `connector_status`, `approval_list`.
AI: `ai_chat`.

**Action kinds (12)** — `run_automation`, `ai_extract`, `ai_generate`, `kb_query`,
`create_record`, `navigate`, `toast`, `open_url`, `open_modal`, `close_modal`, `send_email`,
`sequence`.

**Sequence step kinds (26)** — client: `navigate`, `toast`, `open_url`, `open_modal`,
`close_modal`, `reset_form`, `download_file`, `confirm`, `set_variable`, `refresh`,
`condition`, `loop`, `switch`. Server (data-mutating): `run_automation`, `create_record`,
`update_record`, `delete_record`, `request_approval`, `ai_extract`, `ai_generate`, `kb_query`,
`send_email`, `generate_file`, `file_intake`, `dataset_query`, `ai_browse`.

**AI builder tools (39)** — `app_propose_plan`, `app_set_plan`, `app_mark_phase`, `app_set_meta`,
`app_set_theme`, `app_set_nav_groups`, `app_add_screen`, `app_update_screen`, `app_remove_screen`,
`app_add_section`, `app_update_section`, `app_add_components`, `app_update_component`,
`app_move_node`, `app_remove_node`, `app_find_nodes`, `app_set_action`, `app_remove_action`,
`app_bind_action`, `app_upsert_table`, `app_link_datatable`, `app_remove_table`,
`app_seed_records`, `app_upsert_dataset`, `app_set_roles`, `app_set_variables`,
`app_set_public_access`, `app_get_draft`, `app_get_data_model`, `app_query_data`, `app_dry_run`,
`app_screenshot`, `app_finalize`, `app_list_automations`, `app_inspect_automation`,
`app_list_connectors`, `app_list_templates`, `app_apply_template`, `app_save_as_template`.

**Field types (11)** — `text`, `richtext`, `number`, `date`, `datetime`, `bool`, `select`,
`multiselect`, `relation`, `file`, `computed`.
**Filter operators (15)** — `eq, neq, gt, gte, lt, lte, contains, notContains, startsWith,
endsWith, in, notIn, between, isNull, isNotNull`.
**Access modes (4)** — `app`, `owner`, `role`, `none`. Reserved anonymous role: `public`.
**System columns** (never usable as field keys) — `id, created_at, updated_at, created_by, org_id`.
