# Fact sheet — Studio → Solutions (audience: builder)

Status: **the area exists and is fully built** (not a stub). One caveat on the brief: there is **no
cross-instance marketplace**. What the brief calls "marketplace" is the **Catalogue** tab — the
Blueprints kept on *this* instance, scoped to your own organisation. `SolutionsOverview.jsx` says so
explicitly: *"A cross-instance 'Bee Flow catalogue' is deliberately not here: the catalogue is this
organisation's own Blueprints, org-scoped by blueprintStore, and nothing on this screen reaches past
that."* (The separate "marketplace" at `/app/admin/modules` is the **module hub**, a different
feature — do not mix them up in lessons.)

Source of truth read for this sheet:
- Frontend: `agent-hub/src/components/admin/Studio/Solutions/*` and `agent-hub/src/components/projects/*`
- Backend: `server/routes/projects.js`, `server/routes/projects/packaging.js`,
  `server/projects/{summary,completeness,membership}.js`,
  `server/projects/packaging/{capture,install,upgrade,manifest,scrub,resolutions,releaseNotes}.js`,
  `server/stores/blueprintStore.js`, `server/license/{tiers,featureMap}.js`

---

## 1. What the feature is for

A **Solution** is not a new database object. It is a **project seen as the thing it bundles**: the
routines, apps, webpages, tables, agents, knowledge bases and approvals that work together, plus the
wiring between them. Studio → Solutions is the **builder's** view of that project. The same project's
*collaboration* side (chats, members, memory) stays on `/app/projects`, which is where the people who
*use* the Solution live.

The point of the area is portability: a builder assembles a Solution, runs the **Check**, **Publishes**
it (or exports it to a file) as a **Blueprint**, and a colleague — or another organisation on the same
instance — **installs** that Blueprint as a brand-new Solution through a three-step wizard. Later the
publisher issues a new version and the installed copy shows an **update banner** with a plan of what
would change.

Doc-comment framing worth quoting to learners (from `SolutionsStudio.jsx`):
> "A Solution is not a new entity — it is a project, seen as the thing it bundles… Builders live here,
> next to Automations, Apps and Webpages, because a Solution is built out of exactly those."

### The design rule that runs through every screen
"**A failed read is not an empty workspace.**" Every list, count, check and tally on these screens can
answer `null` = *could not find out*, which is deliberately different from `0` = *there are none*. The
UI never renders a null as a zero or a green tick. This is a genuinely teachable product behaviour,
not an implementation detail — several UI strings exist only to say it out loud.

---

## 2. Where it lives / how you get there

- Left sidebar → **Studio** → rail row **Solutions** (label key `studio.tab.solutions`, description
  "Bundle routines, apps and webpages into one installable Solution", icon `Boxes`, category `bundle`,
  kind colour `solution`).
- URL: `/app/studio/solutions` (overview) and `/app/studio/solutions/<projectId>` (one Solution).
- The Studio "New" menu offers **Solution** (`studio.new.solution`), which navigates to
  `studio/solutions/new`.
- On Community the row is **locked, not hidden** (`lockOn: 'disable'`, `gateCapability: 'projects'`)
  — "the row is how an org learns Solutions exist".

---

## 3. Every screen, with its real labels

### 3.1 Solutions overview (`SolutionsOverview.jsx`)

| Element | Real string |
|---|---|
| Heading | **Solutions** |
| Intro | "A Solution bundles routines, apps and webpages that work together — and packages as a Blueprint you can install elsewhere." |
| Name field placeholder | "Name the Solution…" |
| Create button | **New Solution** (`data-testid="solutions-create"`) |
| Install button | **Install a Blueprint** (file picker, `.json` only) |
| Create error | "Could not create it." |
| Bad file error | "That file is not a Blueprint." |

Segmented control with three tabs:
1. **From us** — Solutions built here
2. **Installed** *(with a count badge — only when the read succeeded)* — the ones that came out of a Blueprint
3. **Catalogue** — the Blueprints kept on this instance

Empty states (each reachable ONLY after a successful read):
- From us: "Nothing here yet. Create a Solution, or install a Blueprint someone handed you."
- Installed: "Nothing here came from a Blueprint yet. Install one from the Catalogue, or from a file."
- Catalogue empty: "No Blueprints are kept on this instance yet. Publish a Solution and it appears here for colleagues to install."
- Catalogue intro line: "Installing one of these creates a new Solution. Everything arrives as a draft."
- Catalogue card: icon, name, "Blueprint v{version}", description, **Install** button.

Failure notices (the "notice strips" above the cards):
- "The overview could not be loaded, so this is not 'you have no Solutions'. Try again shortly."
- "Not all of this could be read: {sections}. What is missing is left blank on the cards rather than shown as nothing."
- "Only the {count} most recently changed Solutions are shown here."
- Catalogue error: "The Blueprints kept on this instance could not be listed, so this is not 'there are none'. Installing from a file still works."

### 3.2 Solution card (`SolutionCard.jsx`)
Icon (defaults `📦`) · name · sub-line "*owner · installed at v3*" · health chip · count chips · description ·
run line · update chip.

- Health chip states/labels: "{n} things to fix" (error), "{n} things to look at" (warning),
  **Could not be fully read** (title: "Part of this Solution could not be read, so how much needs
  fixing is not known."), **Complete**, **Not checked** (title: "The checks did not run for this
  Solution, so this is not a clean bill of health.").
- Count chips (7 counted kinds, `COUNTED_SECTIONS`): routines, apps, pages, tables, agents,
  knowledge bases, notebooks. `approvals` is deliberately **not** counted (an approval listing is
  viewer-scoped; a count would leak how many decisions you may not see).
- Partial counts: "Not everything could be counted: {sections}".
- Run line: "{n} runs today" / "{n} failed" / "Nothing ran today" / "Runs could not be counted".
- Update chip: "v{version} available" or "A newer version is available" or
  "Whether there is a newer version could not be checked".
- Role words: owner / editor / viewer.

### 3.3 Solution detail — header (`SolutionDetail.jsx`)
- Back link: **All Solutions**
- Title is inline-renameable (editor+ only).
- Status chip: **Blueprint v{version}** — shown only when exactly ONE person's publication series
  exists for this project (version is bumped per `solution_key` + `created_by`), otherwise nothing.
  Never an invented "v1.0".
- Primary button: **Publish** (owner only; disabled when blocked, tooltip
  "Not while there are things to fix — or while the checks could not be run.")
- Extras: **Export**, **Open in Projects**
- Audience capsule ("Who can reach this Solution. Change it on the project page.", "Members only",
  "{count} groups").
- Six tabs: **Content**, **Check** (badge = finding count, red if any block), **Versions**,
  **Installs** (badge = total installs), **Flow**, **Overview**.

### 3.4 Content tab (`SolutionContentTable.jsx`)
Three grouped bands:
- **People use** → apps, webpages
- **Work happens** → routines, approvals
- **Knowledge & data** → tables, agents, knowledge bases, notebooks

Per row: name, sub-badges **live** / **paused** / **draft** / **public form** / **public**,
status pill **Needs fixing** / **Worth a look**, a "Depends on" pill row, and a remove control
(editor+ and only for items you own). "Add existing" opens `SolutionAddResource` ("Choose a kind…",
"Nothing of yours left to add here.", errors "That could not be added." / "That list could not be
loaded. Try again shortly."). Section failure: "Could not load this section. Your items are safe —
try again shortly." Empty section: "Nothing here yet."

### 3.5 Check tab (`SolutionControlPanel.jsx`)
Two groups: **Has to be fixed first** and **Worth a look**. Each finding row shows the validator's own
message, an optional remediation line, and a **Show me** deep link (only when the server could name a
row to open). Strips:
- "The checks could not be run just now, so nothing here is confirmed. Publishing stays unavailable until they can."
- "Part of this Solution could not be read, so this list is not the whole story and publishing stays unavailable."
- "Nothing needs your attention. Everything here is wired up and owned consistently."
- "None of these stop you publishing — they are things to tidy when you get to them."

### 3.6 Versions tab (`SolutionVersionsTab.jsx`)
One row per publication: **v{version}** (or "Version unknown"), publication time (or "not recorded"),
and a grouped diff — "{n} things changed", "{n} things are new in this version", unchanged group.
Per changed entity, one AI-written sentence where it exists, else
"Changed — a one-line summary could not be written for this one."
- "No record of what changed was kept for this version, so this is not 'nothing changed'."
- "The written summaries were left out because the note was too large. The list below is still exact."
- "This version carries nothing that can be listed."
- "This Solution has not been published yet, so there are no versions."

### 3.7 Installs tab (`SolutionInstallsTab.jsx`)
- "{n} Solutions in your organisation came from this Blueprint"
- "{n} other Solutions elsewhere on this instance came from it"
- Always-present caveat: "These are at least this many — only installations on this instance are
  counted, and only where the install could be tied back to this Blueprint. A copy installed on
  another instance is invisible here."
- "How often this Solution has been installed could not be read, so this is not 'never'."
- "No installation on this instance could be tied back to this Blueprint yet."

### 3.8 Export / Publish dialog (`SolutionExportDialog.jsx` + `ProjectBlueprintTab.jsx`)
- Title **Export this Solution** or **Publish this Solution**
  (publish intro: "A published Solution is kept on this instance, so colleagues can install it
  without a file changing hands.")
- "Whoever installs it has to supply" — the typed requirements preview: "a table for \"invoices\" ·
  step 4 · in Invoice intake", "a connection", "someone to approve", "a knowledge base",
  "{kind} outside this Solution ({id})".
- Button **Package this Solution**; checkbox "Also keep it on this instance, so colleagues can
  install it without a file" (forced ON in publish mode); **Download** button afterwards.
- Result line: "{n} routines · {n} apps · {n} webpages".
- "What this Blueprint does not carry" — the warnings list. This is the point of the screen.
- Intro: "A Blueprint is this Solution written down — its routines, apps and webpages, and the links
  between them — so it can be installed somewhere else. Decisions, credentials and people never
  travel with it."
- Refusals: "Only the project owner can package it." / "Packaging a Solution is part of the {required}
  plan. This organisation is on {current}." / "Only the project owner can package it — export reads
  every member's work, not just yours."
- Download filename: `<slugified-name>.blueprint.json`

### 3.9 Install wizard (`InstallBlueprintModal.jsx` + `installWizardSteps.jsx`)
Modal title **Install a Blueprint**, subtitle "{step}/3 · {title}". Footer note on every step:
**"Everything arrives as a draft."** Buttons: **Back**, **Next**, **Install**, **Open it**.

**Step 1 — What is in it**
- Provenance claim (only if the file names an org): "This file says it was published by \"{name}\",
  version {version}. That is what the file says about itself — anyone who can edit the file can
  change it. Check with whoever sent it."
- Field **Name for this Solution**
- **What it brings** — chips per kind, or "This Blueprint carries nothing at all."
- **What this Blueprint does not carry** — the exporter's own warnings, forwarded.

**Step 2 — Connect it up**
- Intro: "None of this travelled with the file. Answer what you can here; anything you leave can be
  set in the Solution afterwards."
- Empty: "Nothing here needs connecting."
- Table rows: **A table for "{key}"** → dropdown "Choose a table…" / **Create an empty table**;
  context "step {step} · in {name} · flowlet {key}"; "Used by {n} steps".
- Connection rows: **A credential for this request** → "Leave it unset".
- Approver rows: **Who approves here** → "Leave it to the Solution's owner".
- **What the file asks its pages to be allowed to do** — "A page's tools run as whoever installed it,
  so installing grants none of these. Tick the ones you want to hand over yourself."
  - "Let \"{page}\" use {tool}" + "Connected to your account" / "Not connected to your account —
    connect it in Settings → Integrations, then grant it on the page." / "Whether this app is
    connected could not be checked…"
  - "\"{page}\" asks to let anonymous visitors spend your AI budget." + "It asks for up to ${cap} a
    day. Installing never switches this on — open the page and decide there." (shown, never offered:
    no REST route can switch public AI on)
  - "\"{page}\" wants to run a routine that is not in this file."
- Every picker that fails: "That list could not be loaded, so what you can choose from here is not
  the whole picture."

**Step 3 — Who can reach it**
- "Who else can reach this Solution. You install as its owner either way, and you can change this
  later on the project page."
- Adder: **Person** / **Group** → "Choose…" → **Can view** / **Can edit** → **Add**
- Empty: "Nobody else, for now."

**Step 4 — Installed**
- "Installed." ; "Not installed: {kind} — {why}" ; warnings ; **Still to grant, on the pages
  themselves** ; per-failure lines "{tool} could not be granted: {why}", "{who} could not be added:
  {why}", "the server could not be reached".
- Failure before creation: "That Blueprint could not be read, so there is nothing to describe and
  nothing has been installed." / "Installing a Blueprint is not part of this plan." / "The install
  failed." / "Reading the Blueprint…"

### 3.10 Update banner + upgrade dialog (`upgradeClient.jsx`)
- Banner: "Version {version} of the Blueprint this Solution came from is available. You have version
  {installed}." + button **See what would change** (owner only).
- Unknown: "Whether there is a newer version of this Solution could not be checked, so this is not
  'up to date'."
- Dialog **Update this Solution** — "To version {version} of the Blueprint it came from."
- Five plan groups:
  1. "{n} things are replaced by the new version" — "You have not touched these since you installed them."
  2. "{n} things are added"
  3. "{n} things you changed stay as they are" — "Your version is kept — the update does not write over it."
  4. "{n} things stay as they are" — "These are left as they are without checking whether you changed
     them — a table or knowledge base is never rewritten because it holds live data, and anything the
     update could not read is left alone rather than guessed at. This is not a statement that you did
     not change them."
  5. "{n} things you deleted are not brought back" — "These were installed once and are gone now.
     Deleting them was a decision, so the update leaves them out."
- Buttons **Cancel** / **Update it** / **Close**; result "Updated. {replaced} replaced, {added} added.";
  "Some of it did not go through:"; "This update would not change or add anything here."; "The update
  did not go through. Nothing that was already replaced is undone — try again, and read the plan first."

---

## 4. Concepts a learner must understand

- **Solution** — a project viewed as a bundle of routines, apps, webpages, tables, agents, knowledge
  bases, notebooks and approvals. Studio → Solutions is its builder view; `/app/projects` is its
  collaboration view. Same row in the database.
- **Blueprint** — a Solution written down as JSON: the entities and the links between them, with
  everything organisation-specific removed. It is installable elsewhere. Stored as
  `project_blueprints` (the gallery) and/or downloaded as a file.
- **Publish vs Export** — Export produces a JSON file (private by default); Publish is Export with
  "keep it on this instance" forced on, which writes the gallery row **and** an immutable history row
  in one transaction.
- **Catalogue** — the gallery of Blueprints on this instance, scoped to your organisation (plus
  personal ones you created). Not a Bee Flow-wide store.
- **The Check (completeness)** — an aggregator that runs four existing validators (App Studio,
  routines, project graph, knowledge bases) over the members of one Solution and returns one list of
  findings plus a single verdict, `blocked`. It is the publish gate.
- **`blocked` / `complete`** — `complete: false` means part of the Solution could not be read;
  **unknown blocks**, so a failed read disables Publish just as a real error does.
- **Requirement / hole** — something the Blueprint deliberately does not carry, recognisable by its
  exact shape: a `datatable` step with an empty `datatableId` (the author's `datatableKey` survives),
  an `http_request` step whose `auth` is exactly `null`, an `approval` step with no seat set.
- **Resolutions** — what the installer supplies in the Connect step to fill those holes. The one
  rule: *a resolution only ever fills a hole, it never overwrites a step that is already wired.*
- **Scrub** — the outbound filter. Allow-list based: everything a Blueprint carries is named, and
  anything unlisted is dropped and reported (`any.unlisted_field`), so a column added next year does
  not travel by default.
- **Bridge grants are REQUIRES, not data** — a webpage's tool grants run **as the page's author**, who
  after an install is the installer. So install grants none of them; they are listed and handed over
  by the installer on purpose, through the page's own grants route.
- **Version series** — `project_blueprints.version` is bumped per `(solution_key, created_by)`.
  `solution_key` is `sol_<projectId>`. Two owners who both publish the same project produce two
  independent series, which is why the header chip disappears in that case.
- **Additive upgrade** — an upgrade replaces untouched entities, keeps edited ones, adds new ones and
  **never deletes anything**. Tables and knowledge bases are add-only, never replaced, because they
  hold live data.
- **Provenance** — a file's `source` block is a *claim*. The server's own `canRead` on the real
  gallery row is what decides anything; `install.provenanceOf` always lets the established value win
  over the claimed one.

---

## 5. End-to-end workflows (as a user clicks them)

### W1 — Build and publish a Solution
1. Left sidebar → **Studio** → **Solutions**.
2. Type a name in "Name the Solution…" and press **New Solution**. (It is created with icon `📦`.)
3. The Solution opens on the **Content** tab. Use "Add existing" → "Choose a kind…" to file in your
   existing routines, apps, webpages, tables, agents and knowledge bases. (You can only file in items
   **you own**; you need editor+ on the Solution.)
4. Open the **Check** tab. Fix everything under "Has to be fixed first" using **Show me**, which deep-links
   to the builder screen for that object (`/app/studio/apps/<id>`, `/app/studio/automations/<id>`, …).
5. Re-open **Check** until it says "Nothing needs your attention…" (or only shows "Worth a look").
6. Press **Publish** in the header (owner only; greyed out while blocked).
7. In **Publish this Solution**, read "Whoever installs it has to supply" and press
   **Package this Solution**. The "keep it on this instance" box is already ticked and locked.
8. Read "What this Blueprint does not carry". Optionally press **Download** for the file too.
9. Close the dialog. The header chip now reads **Blueprint v1**; the **Versions** tab shows the release.

### W2 — Install a Blueprint from the Catalogue
1. Studio → **Solutions** → tab **Catalogue**.
2. Pick a card and press **Install**.
3. Step **1/3 · What is in it**: read the provenance claim and "What it brings"; change
   **Name for this Solution** if wanted; read "What this Blueprint does not carry". Press **Next**.
4. Step **2/3 · Connect it up**: for each "A table for \"{key}\"" choose an existing table or
   **Create an empty table**; for each "A credential for this request" pick a connection or leave it
   unset; for "Who approves here" pick a person/group or leave it to the owner. Tick only the tool
   grants you are willing to hand over. Press **Next**.
5. Step **3/3 · Who can reach it**: add people or groups with **Can view** / **Can edit**. Press **Install**.
6. Step **Installed**: read "Not installed: …", the warnings, and "Still to grant, on the pages
   themselves". Press **Open it**.
7. The new Solution opens. **Everything arrives as a draft** — routines are inactive drafts, webpages
   are unpublished. Activate what you want, by hand.

### W3 — Install from a file someone e-mailed you
1. Studio → **Solutions** → **Install a Blueprint** (top of the overview, next to New Solution).
2. Pick the `.json` file. A non-JSON file gives "That file is not a Blueprint."
3. The same 3-step wizard runs. Difference: a file install has **no established provenance** — the
   "This file says it was published by…" line is a claim only.

### W4 — Ship a new version and update an installed copy
1. On the source Solution, change whatever needs changing, run **Check**, press **Publish** again.
   The version bumps to v2 and a release row records the exact per-entity diff (plus one AI sentence
   per changed entity when the model could write one within the deadline).
2. On the installed copy (possibly another org on the same instance), the owner sees the banner
   "Version 2 of the Blueprint this Solution came from is available. You have version 1."
3. Press **See what would change** and read the five groups.
4. Press **Update it**. Read "Updated. {n} replaced, {n} added." and any failures.
5. Nothing is deleted; anything you edited is kept as-is and listed.

### W5 — Check how far your Solution has travelled
1. Open the Solution → tab **Installs** (owner only; the route is `requireProjectRole('owner')`).
2. Read the two numbers plus the permanent caveat that they are a lower bound.
3. Tab **Versions** to see every publication and what each one changed.

### W6 — Hand a Solution's access to a team
1. Header → **Open in Projects** (`/app/projects/<id>`).
2. Members/shares live there (owner only). Roles are viewer / editor / owner.
3. Back in Studio, the audience capsule in the header reflects it.

---

## 6. Defaults, limits and numbers

| Thing | Value | Where |
|---|---|---|
| Blueprint size ceiling (stored only) | **16 MB** | `blueprintStore.MAX_BLUEPRINT_BYTES` |
| Blueprints kept per organisation | **100** | `MAX_BLUEPRINTS_PER_ORG` |
| Publication history kept per project | **20** | `MAX_RELEASES_PER_PROJECT` |
| Release-note size | **64 KB** | `MAX_NOTES_BYTES` |
| Solutions on the overview | **60** max (`hasMore` says there are more) | `MAX_SUMMARY_PROJECTS` |
| Solutions whose Check is aggregated per overview load | **24**, 4 at a time | `COMPLETENESS_BUDGET` / `_CONCURRENCY` |
| `?since=` clamp on the run tally | **7 days**, never in the future | `MAX_SUMMARY_SINCE_MS` |
| Release-note model call timeout / whole-layer deadline | **6 s / 12 s** | `packaging.js` NOTE_CALL_TIMEOUT_MS / NOTE_DEADLINE_MS |
| Project name / description / custom instructions | **120 / 1000 / 8000** chars | `routes/projects.js` |
| Knowledge bases per project | **50** | `MAX_KB_IDS` |
| Member mutations (invite/role/remove) | **30 per 60 s per user** | `memberMutationLimiter` |
| Conversations per assign batch | **200** | `MAX_CONVERSATION_BATCH` |
| Provenance claim string truncation (client) | **200 chars** | `installRequirements.MAX_CLAIM_CHARS` |
| New Solution default icon | `📦` | `SolutionsOverview.NewSolutionForm` |
| "Keep it on this instance" default | **off** for Export, **forced on** for Publish | `ProjectBlueprintTab` |
| App table data in a Blueprint | **opt-in per table, default none** | `capture.js` |
| Webpage `data.db` | **never exported** | `capture.js` |
| Installed routines | `is_active = FALSE`, `is_draft = TRUE` | `install.js` |
| Installed webpages | unpublished | `install.js` |
| Public AI on an installed page | **off**, whatever the file says | `install.js` |
| Integration grants on an installed page | **empty, always** | `install.js` |

---

## 7. What happens on failure

- **Overview read fails** → error strip "The overview could not be loaded, so this is not 'you have
  no Solutions'." No cards, no empty state. The `/summary` 500 path still returns
  `{ projects: [], unavailable: ['all'], hasMore: false }` so a careless client shows nothing rather
  than a clean screen — but the real client checks the status.
- **One tally fails** → that number is `null`, named in `unavailable`, and rendered as a gap, never 0.
- **Check cannot run** (500, network, not yet loaded) → **Publish stays disabled**. `blocked` is only
  false when the server explicitly said so (`data.completeness?.blocked !== false`).
- **Publish succeeds but the gallery write fails** → you still get the manifest back with
  `_saveError`, the download still works, and the error is shown. The capture is not lost.
- **Release notes fail or are too big** → the release is published **without** notes; the Versions tab
  then says "No record of what changed was kept for this version, so this is not 'nothing changed'."
- **Blueprint over 16 MB** → refused with a message naming the fattest entity, e.g. "This Blueprint is
  18.2 MB, over the 16 MB limit. The largest part is the app \"Orders\" at 9.4 MB."
- **101st Blueprint** → "There are already 100 Blueprints here. Delete one before saving another."
- **Install with a missing licence for a kind** → that kind is **skipped, not refused**: every entity
  lands in `report.skipped` with "App Studio is not part of this plan." / "Webpages are not part of
  this plan." / "Tables are not part of this plan." The rest installs.
- **Install partially fails** → the Solution still exists. Grants and shares are attempted *after* the
  install and report their own outcomes; nothing downstream may re-report as "the install failed".
- **Grant a tool the installer has not connected** → 409 `connection_required` from the webpage grants
  route, surfaced as "{tool} could not be granted: {why}".
- **Upgrade fails midway** → "Nothing that was already replaced is undone — try again, and read the
  plan first." Upgrades are not transactional across entities.
- **Installs count unreadable** → "…could not be read, so this is not 'never'." Never 0.
- **Blueprint id you may not read** → 404 (same answer as "does not exist"), so ids in other orgs
  cannot be probed.
- **Project you hold no role on** → 404 (not 403). 403 is reserved for "your role is too low".

---

## 8. Permission and licence gates

### Licence (server-enforced)
- Mount: `app.use('/api/projects', requireModule('projects'), requireAuthedUser,
  requireCapability('projects'), projectFeatureGate, …)` — `projects` is an **Enterprise** licence
  feature (`server/license/tiers.js`), plus a per-deployment kill switch
  `configStore.feature_projects_enabled`.
- Sub-router: `routes/projects/packaging.js` starts with
  `router.use(requireFeature('blueprint_packaging'))` — **Enterprise**, a *second* gate on top of
  `projects`. It is router-level because the mount is shared. Everything under `/package/*` (export,
  publish, install, catalogue, releases, installs, upgrade) needs it.
- Installer capability predicate: `INSTALLER_FEATURES = ['app_studio', 'webpages', 'automations']`.
  A feature not in that list reads as DENIED, which is how datatables were once silently skipped —
  `packaging.capabilities.test.js` now pins it.
- Module catalog: id `projects`, name **Solutions**, capabilities `['projects','blueprint_packaging']`.

### Project role ladder (`server/auth/projectAccess.js`)
`viewer(0) < editor(1) < owner(2)`. 404 for "no role at all", 403 for "role too low".

| Action | Role |
|---|---|
| Read Solution, Content, Flow, Check, graph, activity | viewer |
| Rename, file resources in/out, threads | editor |
| Export / Publish, releases, installs, upgrade plan + apply, share/unshare, delete | **owner** |
| Install a Blueprint (creates a project) | any authed user with the licence |

Why owner for export: "Export reads EVERY member of the project, including apps and routines
belonging to other members. Editor is not enough for that."

### Org roles (`server/config/orgRoles.json`)
Roles present: `org_admin`, `dpo`, `isms_auditor`, `agent_admin`, `agent_editor`, `member`.
**There is no Solutions-specific org permission** — access is the licence gate plus the per-project
role, not an org role. Do not teach a `manage_solutions` permission; it does not exist.

### Other guards worth knowing
- Sharing is **cross-tenant blocked**: the target user/group must be in the project's organisation,
  and an org-less project (`''`) only matches an equally org-less counterpart.
- `GET /summary?ids=` can only *intersect* what `listUserProjects` already allowed — it is a narrowing,
  never a second door.
- `GET /:id/package/installs` is the only answer in the area that looks across organisations, and its
  payload is a hand-written allow-list of **two integers**. No names, ids, times or per-org breakdown.

---

## 9. How Solutions connects to the rest of the product

- **Routines / App Studio / Webpages / Datatables / Agents / Knowledge Studio / Meeting notes** —
  these are the *members* of a Solution. Solutions does not edit them; every "Show me" and every row
  click deep-links out to the object's own builder screen.
- **Approvals** — filed into a Solution and shown on the Content tab, but never counted (viewer-scoped)
  and **never packaged** ("an approval is a decision, not a thing somebody owns").
- **Notebooks** — counted and filed, but **not carried by a Blueprint**; capture warns about it.
- **Projects** (`/app/projects`) — the same rows. Chats, members, memory and audience live there.
- **Studio Home / attention** — shares the "empty knowledge base in use" rule with the Check tab via
  `emptyKnowledgeBaseFinding`, so both screens say the same thing about the same base.
- **Integrations** — the Connect step reads `/api/integrations/connections`; grants go to the webpage's
  own `POST /api/webpages/:id/grants/integrations`.
- **Automation catalog** — the table picker reads `/api/automation/catalog`.
- **Data portability / compliance** — export is stamped by
  `compliance/dataPortability/stampExport('solutions')`.
- **Live feed** — `blueprint.published` is emitted as a **poke with no payload** (no version, no
  Blueprint id) plus a `project_activity` row for the polling fallback; the screen then re-reads the
  org-scoped lists itself.

---

## 10. Common mistakes (great lesson material)

1. **Expecting a Blueprint to carry data.** It does not. Tables travel as *shapes* — no rows, no
   grants. Knowledge bases travel as empty shells. A webpage's database is never exported. App table
   data is opt-in and off by default.
2. **Expecting it to arrive running.** Everything arrives as a draft: routines inactive, pages
   unpublished, public AI off, integration grants empty. Learners who install and then wait for a
   schedule to fire will wait forever.
3. **Reading "Not checked" as "fine".** Only "Complete" — reachable exclusively from a whole, successful
   read with zero findings — means fine.
4. **Trying to publish while the Check has not run.** Publish is disabled for *unknown* as well as for
   *broken*. "Nothing in the list" is not the same as "allowed to publish".
5. **Assuming an editor can export.** Export/Publish/Upgrade/Installs/Versions are owner-only. This
   surprises teams where one person builds and another administers.
6. **Ticking every grant box in the wizard.** Those tools run **as you**. A Blueprint from another org
   asking for `gmail_send` is asking for authority over your mailbox.
7. **Trusting the "This file says it was published by…" line.** It is a claim written in the file.
8. **Expecting the version chip always to appear.** It hides when two different people have published
   the same project, because there is then no single "the version".
9. **Expecting an upgrade to remove things.** Nothing is ever deleted, and tables/knowledge bases are
   never replaced — only added. A dropped routine stays behind.
10. **Reading the Installs numbers as exact.** They are a lower bound on *this instance only*.
11. **Confusing Studio → Solutions with /app/projects.** Same entity, two audiences. Members are only
    changeable on the project page.
12. **Confusing the Catalogue with the module marketplace** at `/app/admin/modules`.
13. **Expecting a partial-licence install to fail loudly.** It quietly skips whole kinds and tells you
    only in the report — read "Not installed: …".
14. **Leaving a resolution blank and assuming the step will work.** It will install with a hole; the
    Check tab (and a failed run) is where you find out.

---

## 11. Three scenarios for "Van Dijk Groep" (Dutch SME)

### 11.1 Procurement — "Inkoopfacturen Q3"
Van Dijk Groep's finance lead builds a Solution called **Inkoopfacturen**: a routine that reads the
purchasing mailbox, a `data_extraction` step that pulls supplier, invoice number and amount, a
datatable keyed `inkoopfacturen`, an approval step for anything above €2 500, and a small App Studio
screen for the controller.
- She files all five into the Solution on the **Content** tab.
- **Check** flags "Worth a look" on the routine because it is still a draft, and "Has to be fixed
  first" on the app because a button is wired to nothing. She fixes the button via **Show me**.
- She presses **Publish**; the dialog says whoever installs it has to supply *a table for
  "inkoopfacturen" · step 6 · in Factuurintake* and *someone to approve · step 9*.
- The Blueprint appears in the **Catalogue** as **Inkoopfacturen v1**.
- The subsidiary Van Dijk Techniek installs it, chooses **Create an empty table** for
  `inkoopfacturen`, picks their own controller as approver, and shares the Solution with the group
  *Administratie* as **Can view**.
- Teaching point: the parent company's supplier rows, its approver seats and its mail credential all
  stayed behind. Only the *shape* travelled.

### 11.2 HR — "Onboarding nieuwe medewerker"
HR builds a Solution with a public webpage (the intake form), a routine that creates the account
request and books the laptop, a knowledge base *Personeelshandboek*, and an agent that answers new
starters' questions.
- **Check** reports: *"Personeelshandboek" is used for answers but holds no documents, so anything
  grounded on it finds nothing.* — advice, not a block. HR uploads the handbook first anyway.
- On Publish, the warnings list says the knowledge base "travels as an empty knowledge base — its
  documents and its sources stay here", and that the agent's tool grants acting as its owner "travel
  acting as whoever uses the agent, never more".
- The HR manager at a sister company installs it, sees in step 2 that the intake page **asks to let
  anonymous visitors spend your AI budget, up to $5 a day**, and leaves it off. She opens the page
  afterwards and decides there.
- Teaching point: an installed agent can never exceed the person using it; public AI is a decision
  you make on the page, never something an install hands over.

### 11.3 Sales — "Offertemotor", and version 2
Sales builds **Offertemotor**: a routine that turns a filled-in form into a PDF quote, a datatable
`offertes`, an approval step for discounts over 10 %, and a customer-facing webpage.
- They publish v1 and the operations team installs it in their own project.
- Three weeks later sales adds a `generate_document` step and a second approval tier, and publishes
  **v2**. The release note lists "2 things changed · 1 thing is new in this version", one sentence
  each.
- Operations sees the banner "Version 2 of the Blueprint this Solution came from is available. You
  have version 1." and presses **See what would change**:
  - *1 thing is replaced by the new version* — the quote routine ("You have not touched these since
    you installed them.")
  - *1 thing you changed stays as it is* — the webpage, which they restyled in Van Dijk house style.
  - *1 thing stays as it is* — the `offertes` table, never rewritten because it holds live data.
- They press **Update it**: "Updated. 1 replaced, 1 added."
- Teaching point: the house-style page they invested in is not overwritten, and their quote history
  is never touched.

---

## 12. List / read API endpoints for "did the learner do it?" checks

All of these are session-cookie authenticated (`req.session.user`) and sit behind the `projects`
licence gate at the `/api/projects` mount. Everything under `/package/*` additionally needs the
`blueprint_packaging` licence feature.

| Method + path | Auth / role | JSON it returns (row fields) |
|---|---|---|
| `GET /api/projects` | authed; no project role (scoped to owner + shares) | **Array** of `{ id, name, description, customInstructions, knowledgeBaseIds, color, icon, ownerId, organizationId, extractMemories, version, installedFromBlueprintId, installedFromOrgId, installedVersion, permission, createdAt, updatedAt }`. **Owner field: `ownerId`**; caller's own role is `permission` (`owner`/`editor`/`viewer`). |
| `GET /api/projects/summary?ids=&checks=0&since=` | authed; no project role | `{ projects: [...], unavailable: string[], checkedCount, completenessBudget, hasMore }`. Each row: `{ id, name, description, icon, color, ownerId, organizationId, permission, updatedAt, createdAt, installedFromBlueprintId, counts{automations,apps,webpages,datatables,agents,knowledgeBases,notebooks}, runs{today,failed}|null, completeness{blocked,complete,findings,errors,warnings,unavailable}|null, update{blueprintId,name,installedVersion,latestVersion,available}|null, unavailable[], complete }`. **Owner field: `ownerId`**. Capped at 60 rows. |
| `GET /api/projects/:id` | project **viewer** | project details + shares |
| `GET /api/projects/:id/resources` | project **viewer** | `{ role, notebooks, apps, automations, webpages, datatables, agents, knowledgeBases, approvals }` — each section is an array **or `null`** meaning "could not be read". Items carry their own owner fields (`userId`/`ownerId`/`ownerUserId`). Best endpoint to verify "did they file X into the Solution". |
| `GET /api/projects/:id/graph` | project **viewer** | `{ nodes, edges, problems, role }` |
| `GET /api/projects/:id/completeness` | project **viewer** | `{ findings[], blocked, complete, unavailable[], requires{items,counts,unreadable}, role }`. Each finding: `{ code, severity, message, remediation, kind, targetRef{kind,id,...}, blockedAt, deepLink }`. Best endpoint to verify "is the Solution publishable". 500 path still returns `blocked:true, complete:false`. |
| `GET /api/projects/:id/activity?limit=&offset=` | project **viewer** | activity rows; a publication appears as action `blueprint.published` |
| `GET /api/projects/:id/members` | project **viewer** | owner + members |
| `GET /api/projects/:id/package/releases` | project **owner** + `blueprint_packaging` | `{ releases: [{ id, version, notes, publishedAt }] }` — hand-written allow-list; `publishedBy` is deliberately **not** returned. Max 20 rows. Best endpoint to verify "did they publish". |
| `GET /api/projects/:id/package/installs` | project **owner** + `blueprint_packaging` | `{ installsHere, installsElsewhere }` — two integers or `null`. Nothing else. |
| `GET /api/projects/package/blueprints` | authed + `blueprint_packaging` | `{ blueprints: [{ id, solutionKey, version, name, description, icon, createdBy, sourceProjectId, organizationId, createdAt, updatedAt }] }` — **meta only, no manifest**. **Owner field: `createdBy`**; `solutionKey` is `sol_<projectId>`. Best endpoint to verify "is their Solution in the catalogue". |
| `GET /api/projects/package/blueprints/:blueprintId` | authed + `blueprint_packaging`, and `canRead` (same org, or creator of a personal one) | `{ blueprint: { …meta…, manifest } }`. 404 for both "no such id" and "not yours". |

Write endpoints in the same area, for completeness (not for verification reads):
`POST /api/projects`, `PUT /api/projects/:id` (editor), `PUT /api/projects/:id/resources` (editor),
`POST /api/projects/:id/share` (owner), `POST /api/projects/:id/package/export` (owner),
`POST /api/projects/package/install` (authed), `POST /api/projects/:id/package/upgrade/plan` (owner),
`POST /api/projects/:id/package/upgrade` (owner),
`DELETE /api/projects/package/blueprints/:blueprintId` (creator only).

Supporting reads the install wizard uses (outside `/api/projects`): `GET /api/automation/catalog`,
`GET /api/integrations/connections`, `GET /auth/users`, `GET /auth/groups`.
