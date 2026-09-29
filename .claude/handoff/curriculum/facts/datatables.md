# Fact sheet — Datatables (Studio → Datatables)

Audience: **builder**. Everything below was read from the code on branch
`claude/builder-redesign-fase-1-6sun0h` (2026-09-14). UI strings are quoted
**verbatim** from the English defaults (`agent-hub/src/i18n/en-defaults.js`,
639 `datatables.*` keys) and from the component fallbacks.

Key source files
- Frontend: `agent-hub/src/components/admin/Studio/Datatables/` (DatatablesStudio.jsx,
  DatatableCard.jsx, DatatableDetail.jsx, ColumnDesigner.jsx, RowBrowser.jsx,
  RowFilterBuilder.jsx, ImportPanel.jsx, RetentionPanel.jsx, DatatableSharing.jsx,
  NewDatatableDialog.jsx, AiTablePanel.jsx, LinkNextcloudTablesDialog.jsx,
  LinkSpreadsheetDialog.jsx + `spreadsheet/`, SourceMirrorPanel.jsx, datatablesApi.js,
  datatableDisplay.js)
- Rail entry: `agent-hub/src/components/admin/Studio/studioApps.jsx` (id `datatables`)
- Backend: `server/routes/datatables.js` (2233 lines), `server/routes/datatablesAi.js`,
  `server/routes/datatablesNextcloud.js`, `server/routes/datatablesSpreadsheets.js`
- Access: `server/auth/datatableAccess.js`; limits: `server/core/dataEngine/datatableLimits.js`;
  vocabulary: `server/core/dataEngine/dataModel/vocabulary.js`;
  managed kinds: `server/core/dataEngine/dataModel/managedTables.js`;
  retention sweep: `server/jobs/datatableRetention.js`;
  routine step: `server/core/automationRunner/execDatatable.js`

---

## 1. What the feature is for

A **datatable** is a table of rows that lives **outside** any single routine or app and
**outlives the run that wrote it**. The section intro says it plainly:

> "Rows that stay put after a run ends. An automation can read back what an earlier run
> wrote, and other automations can use the same table."

Rail description: *"Rows your routines keep between runs"*.

Three things make it different from an App Studio table:
1. It is **shared org data** with its own sharing model and its own "Used by" list —
   which routines, apps, web pages and knowledge bases depend on it.
2. It carries a **GDPR Art. 30 processing purpose** (the description is mandatory),
   a lawful basis, a subject column and a **retention window** that a nightly job enforces.
3. It can be a **mirror** of an external source: a Nextcloud Tables table/view, or one
   worksheet of a spreadsheet in Google Drive / OneDrive / Nextcloud Files. Rows edited in
   Bee Flow are written back to the source.

**No route anywhere accepts SQL.** Every read/write is a closed descriptor (table id,
a field key from that table's own declared list, an operator from `FILTER_OPS`, bound
values). A `sql` / `query` / `rawSql` / `rawQuery` key anywhere in a body is rejected by
name with `400 {code:'sql_not_accepted'}` — "Datatables are queried with filters, not SQL".

---

## 2. Screens, with their real labels

### 2.1 Studio rail → "Datatables"
- Rail label `studio.tab.datatables` = **"Datatables"**, description **"Rows your routines keep between runs"**, icon `Table2`, category *build*.
- New-menu entry label: **"Table"** (`studio.new.datatable`) → route `studio/datatables/new`.
- URL: `/app/studio/datatables`, `/app/studio/datatables/<id>`, `/app/studio/datatables/<id>/<tab>`.

### 2.2 List screen (`DatatablesStudio.jsx`)
- Section header title: **"Datatables"**; primary button **"New table"** (+ icon).
- Body heading: **"Tables"** with the count beside it.
- Intro paragraph (quoted above).
- Search box, always visible: placeholder **"Search a table…"**, aria-label
  **"Search tables by name, key or purpose…"**. Filters on name, key and description.
- Scope notice (one line above the list), one of:
  - **"New tables here belong to your organisation. You choose afterwards who may read or change them."**
  - **"New tables here are personal — only this account can see them, and they cannot be shared."**
- Empty state (dashed placard): title **"No datatables yet"**; body when you may create:
  **"Make one when an automation needs to remember something between runs — a list of
  customers it has already e-mailed, a running total, rows a second automation picks up."**;
  body when you may not: **"Tables in this organisation are created by an administrator.
  Once one is shared with you it appears here, and your automations can use it."**
- No search hit: **"No table matches that."**
- Deep-linked table you hold no grade on: **"That table is not available to you."**
  (never "you do not have access" — the 404 must not reveal existence)
- Each card (`DatatableCard.jsx`) shows: name, a kind chip — **"ordinary table"** /
  **"answers from a web service"** / **"answers from a form"** / **"from {source}"** —,
  a retention chip **"kept {n} days"**, the description (or **"No description"**),
  row count ("1 row" / "{n} rows"), the audience word (**"Personal"** / **"Whole organisation"**
  / **"Shared with groups"** / **"Private"**), scope word (**"only this account"** /
  **"organisation"**), your grade (**"You own this table"** / **"You can read and change rows"**
  / **"You can read rows"** / **"Shared with you"**), and usage (**"not used yet"** /
  **"used by {n}"**). A mirror also shows **"refreshing…"**, **"refresh failed"** or
  **"not every row"**.

### 2.3 "New datatable" dialog (`NewDatatableDialog.jsx`)
Title **"New datatable"**; header toggle **"Simple" / "All options"**.

Fieldset **"What kind of table?"** — up to four cards:
- **"An ordinary table"** — *"You decide the columns. Automations read and write the rows."*
- **"Web service answers"** — *"For the “remember answers in a table” tick on a Call a web
  service step. Its columns are fixed, because an automation writes them by name."*
- **"A table from Nextcloud"** — *"A copy of a Nextcloud Tables table or view, kept in step
  with it. Rows changed here are changed in Nextcloud; the columns are Nextcloud’s."*
  (visible for any Nextcloud-bound org; disabled with a reason when the integration is off)
- **"A spreadsheet from your files"** — *"A copy of a sheet in Google Drive, OneDrive or
  Nextcloud, kept in step with the file. Rows changed here are written to the file; the
  columns are the sheet’s header row."* (shown only when a storage probe returns providers)

Then, for an ordinary table:
- **"Build it with AI"** panel (see 2.9).
- **"Name"** (placeholder `Customers`)
- **"Technical name"** (All options only; placeholder `customers`; help: *"Lowercase letters,
  numbers and underscores. Renaming it later means moving the data, so it is worth a moment now."*)
- **"What is it for?"** (textarea, placeholder *"Customers we have already sent the onboarding
  e-mail to."*, help **"Required — this sentence goes into your organisation’s processing record."**)
- **"Columns"** + hint *"optional · can also be added later"*, rows of "Column name" + type
  select + remove; **"Add a column"**.
- Fieldset **"Who is it for?"**: **"Your organisation"** (*"You decide afterwards who may read
  or change the rows. Automations your colleagues own can use it."*) vs **"This account only"**
  (*"Only this account can see the rows — not colleagues, not administrators. It cannot be
  shared later."*). Shown only when the account is in an organisation.
- Footer: **"Technical name: `customers` · editable under All options"**, **"Cancel"**,
  **"Create"** (or **"Choose tables…"** / **"Choose files…"** for a mirror).
- Success sheet: **"The table is ready"** → **"Open the table"**.

### 2.4 Table detail (`DatatableDetail.jsx`)
Back link **"All datatables"**; the table name is inline-editable; a status chip shows your
grade. Tabs live **inside the 48px command bar** (Ronde 2, 2026-09-14):

| Tab | Shown when |
|---|---|
| **"Dashboard"** | form-answers table only; it is the default tab there |
| **"Nextcloud" / spreadsheet source tab** | mirrors only; default tab there |
| **"Columns"** | always (default for an ordinary table) |
| **"Rows"** (with the row count) | always; the only edge-to-edge tab |
| **"Retention"** | not on a mirror |
| **"Sharing"** | always |
| **"Used by"** (with the count) | always; last |

Under the bar: the description, then `6 columns · 412 rows`.

⋯ menu (**"More about this table"**): **"Rename table"**, **"Duplicate"** (sub-label
*"columns only, no rows"*), **"Export (CSV)"**, **"Technical name"** (copies the key),
**"Check & repair"**, **"Open in {source}"** (mirrors), **"Delete this table…"** /
**"Unlink this table…"**.

Delete dialog: **"Delete this table"** (or **"Unlink this table"**). You must type the table
name (`requireName`) and it lists the routines that break. Extra notices:
- form answers: *"This table holds the answers to a form. Deleting it deletes every answer;
  the form stays and stops collecting."*
- managed: *"Rows here hold what a third-party service answered, in plain text, readable and
  exportable by everyone with access to this table."*

**Check & repair** modal: **"Everything matches: the table and every column it should have are
there."** / **"{n} column(s) are in the model but not in the storage: {keys}."** /
**"The storage for this table has not been made yet."**; blurb *"Repairing re-runs this
table’s own “create if missing” statements. It only ever adds — it cannot drop a column or
touch a row."*; buttons **"Repair it"**, **"Close"**.

### 2.5 Columns tab (`ColumnDesigner.jsx`)
- Table head: **"Column" · "Kind" · "Example"**.
- Empty: **"No columns yet. Every table already has id, created_at, updated_at and created_by
  — add the ones your automation needs on top."**
- **"Add a column"**; hint *"Drag the handle to reorder. Columns an automation writes to are
  marked; removing one breaks that step until you fix it there."*
- Unsaved bar: **"Unsaved column changes"** + **"Discard"** / **"Save columns"**; success note
  **"Columns saved."**
- Read-only variants: **"You can see the columns but not change them. The table’s owner, or an
  administrator, can."**; mirror: **"These columns come from {source} and cannot be added to,
  removed, renamed or retyped here. Change them in {source} — the next refresh brings them here."**;
  form answers: **"These columns are the questions on the form. Add, rename or remove questions
  on the form — the table follows…"**; managed: **"The locked columns are filled in
  automatically and cannot be removed, renamed or retyped. Columns of your own can be added
  alongside them."**
- Destructive-change dialog: title **"This throws away data"**; *"Removing {keys} deletes its
  values in all {n} rows."*, *"Changing the type of {keys} rewrites every existing value, and
  anything that does not fit the new type is lost."*, *"{n} automations read one of these
  columns and will stop working: {names}."*
- Conflict: **"Someone else changed these columns while you were editing. Their version is now
  shown — please make your change again."**

**Column types offered** (`datatableDisplay.COLUMN_TYPES`; the picker shows the shorter
"kind" word, the dropdown the label):

| type | label | blurb |
|---|---|---|
| `text` | Text | A name, an e-mail address, a reference |
| `number` | Number | Amounts and counts you can compare |
| `bool` | Yes / no | A checkbox |
| `date` | Date | A day, with no time of day |
| `datetime` | Date and time | A moment |
| `select` | One of a list | Pick a single option you define |
| `multiselect` | Several of a list | Pick any number of options you define |
| `richtext` | Long text | Notes, a description, a message body |
| `file` | File | An attachment reference |

`relation` and `computed` exist in the storage vocabulary but are **not offerable** here
(a relation arrives only on a mirror). Options editor placeholder:
*"Option one, Option two, Option three"*.

### 2.6 Rows tab (`RowBrowser.jsx`)
Toolbar: search (**"Search the text columns…"**, only when a text-ish column exists),
**"Clear"**, **"Filter"** / **"Filter ({n})"**, a row-count line
(*"the {n} most recent of {total}"*, *"page {p} · {n} of {total}"*), *"updated {when}"* or
*"refreshed {when}"*, **"Refresh"**, **"Import"**, **"Export CSV"**, **"Add a row"**.

Grid columns are your columns plus **"Added"** (created_at) and, with retention on,
**"Expires"** (*"due to go"*, *"today"*, *"in {n} days"*). Per row: **"Edit this row"**,
**"Save this row"**, **"Stop editing this row"**, **"Delete this row"**.
Selection bar: **"{n} rows selected"**, **"Clear selection"**, **"Delete selected"**.
Pager: **"Load more"**, **"Previous page"**, **"Next page"**.

Empty states: **"This table has no columns yet — add some on the Columns tab first."**,
**"No rows yet. An automation with a Datatable step writing to this table will fill it, or
you can add one here."**, **"No rows match that search."**

Filter builder (`RowFilterBuilder.jsx`): **"Show rows that match"** + **"all conditions"** /
**"any condition"**; **"Add a condition"**, **"Clear"**, **"Apply {n} conditions"**.
Operator words: *is, is not, is more than, is at least, is less than, is at most, contains,
does not contain, starts with, ends with, is one of, is none of, is between, is empty,
is filled in*.

Delete confirmations: **"Delete this row?"** — *"It is gone for good, and any automation that
reads it by id stops finding it."*; **"Delete {n} rows?"** — *"They are gone for good, in one
go, and any automation that reads them by id stops finding them."*

### 2.7 Import panel (`ImportPanel.jsx`)
**"Paste from a spreadsheet"**, **"Back to rows"**. Help: *"Copy the rows in Excel or Google
Sheets — including the header row — and paste them here."* Placeholder shows
`Name;Email;Starts on` / `Anna de Vries;anna@example.com;14-03-2026`.
Mapping: **"Where does each column go?"**, per column a select with **"Don’t import this one"**.
Buttons **"Import {n} rows"**; guard **"Point at least one column at a field first."**
Result: **"{n} rows imported"**, **", {n} skipped"**, per-line **"Line {n}: <error>"**,
**"Paste another block"**. Parsing handles tab/semicolon/comma, Excel quoting, `ja/nee` →
true/false and both decimal conventions (shared with App Studio's `spreadsheetPaste`).

### 2.8 Retention tab (`RetentionPanel.jsx`)
- **"Rows are deleted after"** — segmented: **"Never"**, **"7 days"**, **"30 days"**,
  **"90 days"**, **"Other…"** (custom **"Days"** + **"Apply"**, 1–3650).
- **"Counted from"** + a date-column picker (**"Pick a date column…"**). Without a date column:
  **"This table has no date column yet, so there is nothing to count an age from. Add one on
  the Columns tab first."**
- State line: **"Rows are deleted {n} days after their {field}."** or **"Rows stay until
  something deletes them — an automation step, or you."**; **"Last swept {when}."**
- **"About to expire"** card: **"{n} rows expire in the next 7 days"**, or *"rows — nothing
  expires on its own"*.
- Standing caveat: **"A run that read these rows keeps its own copy in its run history, which
  ages out on the run-history window instead."**

### 2.9 Sharing tab (`DatatableSharing.jsx`)
- On a personal table the whole tab is replaced by **"This table cannot be shared"** —
  *"It belongs to this account alone. Nobody else can read or change its rows — not
  colleagues, not administrators — and there is no setting that would change that. To share
  data with the rest of your organisation, make an organisation table."*
- **"Who can read the rows"**: **"Private"** (*"Only you and the people you invite."*),
  **"Entire organisation"** (*"Everyone can read; only invited people can edit."*),
  **"Specific groups"** (*"Only members of the groups you pick."*). Picking "Specific groups"
  before choosing one shows **"Nothing has changed yet — picking a group is what shares the table."**
- Write toggle: **"Let everyone who can read it change it too"** — *"Off by default. With this
  off, only the people you invite below can add, change or delete rows."*
- **"People and teams"** (caption *"invited by name"*) — per grantee **"A person"** / **"A group"**,
  grade read or read-and-write.
- Summary: *"<readers> can read every row."* / *"Rows can be added, changed and deleted by
  <writers>."*, and for the widest setting **"That is the widest setting there is: anyone in
  your organisation can delete every row, and any automation they run can too."**
- Confirm dialog **"Give more people access?"** → **"Share it"** / **"Leave it as it is"**.
- Paywall (402): **"Sharing a datatable with colleagues is part of a paid plan. Your own
  tables, and every table already shared with you, keep working exactly as they do now."**

### 2.10 Used by tab
Empty: **"No automation uses this table yet. Add a Datatable step to one and pick this table."**
Permanent hint: **"To connect another automation: add a Datatable step there and pick this table."**
Consumer kinds recorded: `automation`, `app`, `webpage`, `kb`.

### 2.11 "Build it with AI" panel (`AiTablePanel.jsx`)
Heading **"Build it with AI"**. Create mode intro: *"Describe what the rows should hold, or
paste what the columns should be based on — a spreadsheet’s header row, an e-mail, a list.
The fields below are filled in for you to check."* Placeholder: *"e.g. Supplier invoices:
supplier, invoice number, date, amount excl. VAT, VAT %, total, status (new / approved /
rejected)"*. Button **"Draft the columns"** → **"Drafting…"**; result **"{count} columns
drafted — check them below, then Create."**
Revise mode: intro *"Say what should change. Columns you keep stay as they are — and so do
their rows. Nothing is saved until you press Save."*; toggle **"Allow removing or retyping
columns for this request"** (default OFF), button **"Change the columns"**, **"Undo"**,
change summary *"{n} added / {n} renamed / {n} retyped / {n} removed"*.
Nothing is stored by the AI route — the draft only fills the unsaved form.

### 2.12 Mirror wizards and source tab
- **"Link tables from Nextcloud"** — steps **"Tables" → "Names & columns" → "Relations" →
  "Review"**; **"Link {n} tables"**; max **10 tables per link**; review note: *"The rows are
  copied from Nextcloud in the background and kept in step with it. Rows you change here are
  changed in Nextcloud."*
- **"Link spreadsheets from your files"** — steps **"Files" → "Sheets & columns" →
  "Names & columns" → "Relations" → "Review"**; storage tabs, **"Shared with me"**,
  **"Find a spreadsheet"**, **"All files"**; *"At most {n} sheets can be linked in one go."*;
  review note: *"…Rows you change here are written to the file."* and, for a read-only file,
  *"One or more files are read-only here; their rows cannot be changed from Bee Flow."*
- Source tab (`SourceMirrorPanel.jsx`): **"Kept in step with {source}"**, **"Refresh now"**,
  **"Open in {source}"**, *"{source} is read and written as the account that linked this
  table."*, **"Changes go both ways"**, **"Rows are not aged out here — they stay as long as
  they are in Nextcloud."**, status strip **"Live · in step with {source}"** /
  **"Refreshing from {source}…"** / **"The last refresh failed: {error}"**.

---

## 3. Concepts a learner must understand

- **Datatable** — a named table of rows in the workspace that outlives any run; routines,
  apps, web pages and knowledge bases can all read and write it.
- **Scope (organisation vs personal)** — a table belongs either to the organisation or to one
  account. A *personal* table is deny-by-default: it grades `owner` for its account and
  `null` for everyone else, **org admins and super-admins included**, and it can never be
  shared (`personal_table_not_shareable`).
- **Technical name (key)** — the physical Postgres table name. Lowercase letter first, then
  lowercase letters/digits/underscores, ≤63 chars (`/^[a-z][a-z0-9_]{0,62}$/`). It can never
  be changed afterwards (PATCH refuses `key` as `immutable_field`).
- **Purpose / description** — mandatory free text; it *is* the GDPR Art. 30 processing
  purpose. Server: "Say what this table is for — it goes in your processing record".
- **Grade ladder** — `viewer` (read rows, run find_rows) < `editor` (+ every row write) <
  `owner` (+ columns, sharing, retention, delete). `owner` is derived (creator, or an org
  admin of that same org) and is never stored as a grant; grants only carry viewer/editor.
- **Audience vs write mode** — two independent things. Audience (`private` /
  `organisation` / `groups`) decides who may READ. Writing comes from an explicit grant, or
  from the separate opt-in `writeMode: 'audience'`. **An empty `sharedGroups` on a published
  table means the WHOLE organisation**, for reading only.
- **Row scope** — `all` (everyone with access sees every row) or `own` (only whoever added the
  row). It can be narrowed but **never widened**: `own → all` is refused 409
  `row_scope_widening` because it would retroactively disclose existing rows.
- **System columns** — every table already has `id`, `created_at`, `updated_at`, `created_by`,
  `org_id`. A column key may not collide with them.
- **Model version** — the columns are one optimistic-locked document per scope. `GET /schema`
  returns `modelVersion`; `PUT /schema` must send it back as `expectedVersion` or it is a 400.
- **Breaking change** — dropping a column (or the table) that a routine still names. The
  server answers `409 {code:'breaking_change', breaking:[…]}` / `409 {code:'in_use', usage}`
  until the caller confirms (`confirmBreaking`).
- **Retention window** — `retentionDays` + `retentionField`. A nightly sweep deletes rows
  older than the window measured from that date column. Setting days without naming the column
  is refused (`retention_field_required`). Max 3650 days (ten years).
- **Managed table** — a table whose columns the platform owns:
  `http_cache` ("Web service answers"), `form_answers` (a form's answers),
  `nextcloud_table` and `spreadsheet_file` (mirrors). Their contract columns cannot be
  removed, renamed or retyped; extra columns of your own are allowed on `http_cache`.
- **Source mirror** — a table whose rows are a live copy of an external source. Writes go to
  the **source first**, then the copy is refreshed from what the source answered.
- **Used by (usage index)** — the recorded consumers of the table and of each column; it is
  what the destructive dialogs read.
- **Keyset cursor** — row paging uses `nextCursor`, not an offset, so pages do not skip or
  repeat while a routine writes.

---

## 4. End-to-end workflows (click by click)

### W1 — Create an ordinary organisation table and put rows in it
1. Left rail → **Studio** → **Datatables**.
2. Click **"New table"** (top right).
3. In **"What kind of table?"** leave **"An ordinary table"** selected.
4. **"Name"** → `Leveranciers`. (The footer now shows `Technical name: leveranciers`.)
5. **"What is it for?"** → one sentence; it is required and goes in the processing record.
6. Under **"Columns"** click **"Add a column"** for each column: type the name, pick the type
   in the dropdown. (Optional — you can add them later.)
7. In **"Who is it for?"** pick **"Your organisation"** or **"This account only"**.
8. Click **"Create"**. The table opens on the **"Columns"** tab.
9. Open the **"Rows"** tab → **"Add a row"** → fill the cells → **"Add row"**.
10. Use **"Import"** to paste a block from Excel, or **"Export CSV"** to take it out again.

### W2 — Add a column safely to a table routines already use
1. Open the table → **"Columns"** tab.
2. Click **"Add a column"**, type its name, pick the **Kind** (for "One of a list" also fill
   the options box).
3. Drag the handle to put it in the right order.
4. Click **"Save columns"** → note **"Columns saved."**
5. If you also REMOVED or RETYPED a column, the dialog **"This throws away data"** appears and
   names the rows and the routines it costs; confirm only after checking the **"Used by"** tab.
6. If a colleague saved in the meantime you get *"Someone else changed these columns while you
   were editing…"* — reload and redo your change.

### W3 — Share a table with a group, read-only
1. Open the table → **"Sharing"** tab. (A personal table has no such tab — it says so.)
2. Under **"Who can read the rows"** choose **"Specific groups"**.
3. Tick one or more groups. (Until you do, the panel warns *"Nothing has changed yet — picking
   a group is what shares the table."*)
4. Confirm in **"Give more people access?"** → **"Share it"**.
5. Leave **"Let everyone who can read it change it too"** OFF.
6. To let named people write: in **"People and teams"** invite a person or group with the
   read-and-write grade.
7. On Community you get the paywall line instead — sharing needs `automation_sharing`.

### W4 — Set a retention window
1. Open the table → **"Retention"** tab.
2. Under **"Rows are deleted after"** pick **"30 days"** (or **"Other…"** → type days →
   **"Apply"**).
3. In **"Counted from"** pick the date column the age is measured from — this is mandatory;
   without it you get *"Pick the date column the age is measured from."*
4. Read back the state line: **"Rows are deleted 30 days after their created_at."**
5. Check **"About to expire"** to see how many rows go in the next 7 days.
6. Remember the caveat: a routine's `find_rows` output copy in the run history is **not**
   deleted by this sweep.

### W5 — Mirror a Nextcloud Tables table
1. **"New table"** → card **"A table from Nextcloud"** (disabled with a reason when the
   Nextcloud Tables integration is off) → **"Choose tables…"**.
2. Step **"Tables"**: tick the tables/views (max 10 per link).
3. Step **"Names & columns"**: per table set **"Name"**, **"Technical name"**,
   **"What is it for?"** and check **"Columns, as they will arrive"**.
4. Step **"Relations"**: accept Nextcloud's own relation columns, or match two columns.
5. Step **"Review"** → **"Link {n} tables"**.
6. **"The tables are ready"** → **"Open the table"**. The table opens on the source tab,
   **"Kept in step with Nextcloud"**; the first refresh runs in the background.
7. Use **"Refresh now"** to force a pass, **"Open in Nextcloud"** to jump to the source.
8. Edit rows on the **"Rows"** tab — each write goes to Nextcloud first
   (*"Writing to Nextcloud…"*), and the copy is rewritten from Nextcloud's answer.

### W6 — Draft a table with AI, then use it from a routine
1. **"New table"** → **"An ordinary table"** → in **"Build it with AI"** describe the table
   (e.g. the supplier-invoices example) → **"Draft the columns"**.
2. Check the filled-in Name / purpose / Columns (use **"Undo"** to go back) → **"Create"**.
3. Go to **Studio → Automations**, open or make a routine, add a **Datatable** step.
4. Pick this table and an operation: `find_rows`, `count_rows`, `add_row`, `save_row`,
   `update_rows` or `delete_rows`.
5. For `update_rows` / `delete_rows` give at least one condition — the step refuses to run
   unbounded.
6. Run the routine, then open the table's **"Rows"** tab to see what it wrote, and the
   **"Used by"** tab to see the routine listed.

---

## 5. Defaults and limits (the numbers)

Storage envelope, per SCOPE (one org, or one account's personal tables) —
`core/dataEngine/datatableLimits.js`:
- **50** tables per scope (`MAX_TABLES_PER_SCOPE`)
- **100 000** rows per table (`MAX_ROWS_PER_TABLE`)
- **500 000** rows per scope (`MAX_ROWS_PER_SCOPE`)
- **256 MB** per scope (`MAX_BYTES_PER_SCOPE`)
- An ops warning is logged from **90 %** of any of these.
- Refusal body: `409 {error, code:'quota_exceeded', limit, used}` (the runner sees
  `errorClass: 'datatable_quota'`).

Shape limits (`dataModel/vocabulary.js`):
- **100** columns per table (`MAX_FIELDS_PER_TABLE`), **100** options on a select,
  **120** chars for a name, key ≤63 chars.

HTTP surface (`routes/datatables.js`):
- Rate limit **120 requests/minute per user** on the whole router.
- Body limit **256 kb**, except `POST /:id/rows/bulk` at **2 MB**.
- Row page: default **50** (the UI's `PAGE`), server max **500** (`ROWS_PAGE_MAX`).
- Bulk import: **5 000** rows per request, written in chunks of **500**.
- Bulk delete: **200** ids per request (four UI pages).
- CSV export: up to **100 000** rows streamed in one response, BOM-prefixed UTF-8;
  a leading `=`, `+`, `-`, `@` is prefixed with `'` so Excel cannot treat it as a formula.
- Filters: **20** conditions per list request; match mode `all` or `any` (no nesting).
- Retention: **1–3650 days**; UI presets **7 / 30 / 90**; "About to expire" horizon **7 days**.
- AI draft: **10 requests/minute per user**, max 4000 output tokens, fast-tier model.
- Mirror import cap: **500** rows per bulk into a mirror.

Routine `datatable` step (`automation/validate/constants.js`):
- ops `find_rows, count_rows, add_row, save_row, update_rows, delete_rows`
- **20** filters max, limit max **1000**, `update_rows`/`delete_rows` require ≥1 condition.

Mirrors (`core/dataEngine/sources/mirror/constants.js`):
- Row cap **10 000** per mirror (`ENGINE_READ_CAP`, tunable DOWN via
  `DATATABLE_MIRROR_ROW_CAP`), write chunk **500**.
- Default schedule **15 minutes**; floor **1 minute**; ceiling **7 days**.
- "Live" re-check while a tab is open: pulse, re-checking at most once per **5 s**;
  kick debounce **5 s**; a stalled pass is taken over after **10 minutes**.
- Nextcloud link: max **10** tables per link.

Retention sweep (`jobs/datatableRetention.js`):
- max **5 000** rows per table per pass, deleted in chunks of **500**;
- rows whose date column is NULL are never swept;
- operator brake `DATATABLE_RETENTION_DISABLED`;
- it has its own tick and **no module gate** — retention must not stop when a licence lapses.

---

## 6. What happens on failure

| Situation | Answer |
|---|---|
| No grade at all on the table | **404 "Not found"** — existence is not probeable, even for an org admin on a colleague's personal table |
| A grade, but too low | **403 "This needs <grade> access to the datatable"** |
| Key already used in the scope | **409 `key_taken`** — "A table with this key already exists in your organisation" / "You already have a table with this key" |
| Table/row/scope quota | **409 `quota_exceeded`** with `limit` and `used` |
| `PUT /schema` without `expectedVersion` | **400 `version_required`** |
| Concurrent column edit | **409 `version_conflict`** + `currentVersion` |
| Dropping a column a routine uses | **409 `breaking_change`** + the `breaking` list; retry with `confirmBreaking` |
| Deleting a table routines use | **409 `in_use`** + `usage` |
| Editing a row without `expectedUpdatedAt` | **400 `expected_updated_at_required`** |
| Somebody else edited the row | **409 `row_conflict`** + the current row ("Someone else changed this row while you had it open") |
| Widening rowScope `own → all` | **409 `row_scope_widening`** |
| Retention days without the column | **400 `retention_field_required`** |
| Sharing a personal table | **400 `personal_table_not_shareable`** |
| Sharing without the licence | **402 / `capability_required`** → the paywall line; **reads and row writes keep working** |
| Old client sending `{isPublished, sharedGroups}` | **409 `stale_client`** — "This page is out of date — reload it and choose the audience again" |
| `sql`/`query`/`rawSql` in a body | **400 `sql_not_accepted`** |
| Bulk import > 5000 rows | **413 `too_many_rows`**; bulk delete > 200 ids → **413 `too_many_ids`** |
| A bad row in an import | Nothing is written until the whole file is compiled; the answer lists per-row errors **with line numbers** and imports the rest |
| Mirror refresh already running | **202 `{alreadyRunning:true}`** |
| Mirror write refused by the source | The source's own refusal is shown and **nothing changes on either side** |
| Model and Postgres out of step | **"Check & repair"** — `GET /:id/health` reports `missingColumns`/`tableExists`; `POST /:id/repair` re-emits add-only DDL |

---

## 7. Permission and licence gates

**Mount** (`server/index.js:724`):
```
app.use('/api/datatables',
    requireModule('automation'), requireAuthedUser,
    requireLicenseFeature('automations'), require('./routes/datatables'));
```
plus, inside the router: `requireBetaFeature('automations')`,
`requireActiveOrgForMutations()`, `perUserRateLimit({windowMs:60_000, max:120})`.

**Licence** (`server/license/tiers.js`)
- `automations` — **Community**. Creating, reading and writing datatables (including a
  personal one) rides this key.
- `automation_sharing` — **Enterprise**. Enforced per route with
  `requireCapability('automation_sharing')` on `PUT /:id/sharing` and `POST /:id/grants` only.
  Removing a grant is deliberately NOT gated, and reads/row writes on a table you already hold
  a grade on are never gated — a lapse must not punch a hole in live data.

**Org permissions** (`server/config/orgRoles.json`, `auth/permissions.js`)

| role | `use_datatables` | `manage_datatables` |
|---|---|---|
| org_admin | yes | yes |
| agent_admin | yes | yes |
| agent_editor | yes | no |
| member | yes | no |
| dpo | no | no |
| isms_auditor | no | no |

- `manage_datatables` is required for creating/changing an **organisation** table
  (`requireManageForOrgScope()` — it is skipped entirely for a personal table, where the grade
  resolver has already proved you ARE the account). The frontend mirrors this:
  `canCreate = scope?.kind === 'user' || hasPermission('manage_datatables')`, and
  `canEdit = isOwner && (canManage || table.scopeKind === 'user')`.
- **Caveat for lesson authors:** `use_datatables` is *declared* in `auth/permissions.js`
  ("Read and write rows in datatables shared with you…") and granted to four roles, but
  `Permissions.USE_DATATABLES` is **not referenced by any route** — access is decided by the
  grade ladder, not by that permission. Don't teach it as a gate.

**Grade rules** (`auth/datatableAccess.gradeForPrincipal`), in order:
0. personal table → `owner` only for its account, `null` for everyone else (returns, never falls through);
1. cross-organisation → `null` (checked before ownership, before org-admin, before audience);
2. the creator → `owner`;
3. an org admin **of that same organisation** → `owner`;
4. the strongest explicit grant (`editor` wins immediately);
5. `write_mode = 'audience'` + in the read audience → `editor`;
6. a viewer grant, or the read audience → `viewer`; otherwise `null`.

The routine runner resolves the grade **on every run** through the same function, so a
revoked grant stops working immediately.

---

## 8. How it connects to the rest of the product

- **Routines / Automations** — the `datatable` step (`core/automationRunner/execDatatable.js`)
  is the main consumer: `find_rows, count_rows, add_row, save_row, update_rows, delete_rows`.
  It looks for the table in the run's organisation and then in the owner's personal scope, and
  nowhere else (`datatable_no_org` otherwise). An unresolved filter **skips** the operation, it
  never widens it to "all rows".
- **Forms** — "Collect answers in a table" on a form creates a `form_answers` managed table
  whose columns ARE the form's questions. The table detail then opens on a **"Dashboard"**
  tab, links **"Open the form"**, and a retired question's column can be dropped from the
  Columns tab. `POST /:id/answers/release` unlinks the table from the form ("keep the answers,
  forget the form").
- **App Studio** — an app table may be sourced from a datatable
  (`model.tables[].source = {kind:'datatable', datatableId, mode:'read'|'readwrite'}`). The
  builder tool `app_link_datatable {name}` links an existing Studio table; a linked table is
  never seeded or re-fielded by the builder.
- **Web pages / CMS** — pages appear as `webpage` consumers in "Used by"; a page's data card
  deep-links to `studio/datatables/<id>?tab=sharing`.
- **Knowledge bases** — `kb` is a consumer kind too.
- **http_request step** — the "remember answers in a table" tick writes into an `http_cache`
  managed table; its retention window IS the cache expiry ("There is no second, hidden clock").
- **Nextcloud Tables / Google Drive / OneDrive / Nextcloud Files** — source mirrors.
- **Compliance** — the description feeds the Art. 30 processing record; `lawfulBasis`,
  `subjectColumn` and the retention window are the DSR/ROPA hooks; the CSV export is stamped
  by `compliance/dataPortability/stampExport('datatables')`.
- **Studio Home rail** — `GET /api/studio/counts` returns a `datatables` count with exactly
  the same gate and scoping as the list route.

---

## 9. Common mistakes

1. **Treating "Specific groups" as narrow before a group is picked.** An empty group list on a
   *published* table means the WHOLE organisation. The server now refuses the ambiguous old
   body (409 `stale_client`) and requires a non-empty list, but the mental model still trips
   people.
2. **Assuming sharing makes a table writable.** Audience = read. Writing needs an explicit
   grant or the separate **"Let everyone who can read it change it too"** switch.
3. **Expecting an org admin to be able to read a colleague's personal table.** They cannot —
   rule 0 returns `null` for everyone but the account.
4. **Trying to rename the technical name.** `key` is immutable (`immutable_field`); renaming
   means creating a new table and moving the rows. Get it right in the dialog.
5. **Setting a retention window and expecting a sensible default column.** `retentionField`
   must travel in the same request; the UI forces the **"Counted from"** picker.
6. **Believing retention erases everything.** A routine's `find_rows` output sits in the run
   history and ages out on `AUTOMATION_RUN_RETENTION_DAYS` (default 90) instead.
7. **Dropping a column that a nightly routine writes** — confirm only after reading
   **"Used by"**; the failure otherwise surfaces at 3 am inside somebody else's run.
8. **Editing a mirror's columns in Bee Flow.** They belong to Nextcloud / the sheet's header
   row; change them there and refresh.
9. **Setting a retention window or rowScope `own` on a mirror** — refused
   (`mirror_no_retention`, `mirror_row_scope`): every synced row is created_by the linker.
10. **Trying to widen rowScope from "own" to "all"** — refused; make a new table.
11. **Expecting `own` on a form-answers table to be useful** — refused
    (`answers_row_scope`): the form writes the rows, so readers would see nothing.
12. **Pasting a 20 000-row file into Import** — 5 000 rows max per request; split the file.
13. **Duplicating a table expecting the rows** — **"Duplicate"** is explicitly *"columns only,
    no rows"*.
14. **Assuming the row count is exact.** `rowCount` is maintained arithmetically and re-synced
    by the retention sweep; it is approximate between sweeps.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

### 10.1 Procurement — `leveranciersfacturen` (supplier invoices)
Van Dijk Groep receives ~120 supplier invoices a month by e-mail. A routine reads the
mailbox, extracts the fields and writes one row per invoice into an **organisation** table
`leveranciersfacturen`.
- Columns: `leverancier` (Text), `factuurnummer` (Text), `factuurdatum` (Date),
  `bedrag_excl` (Number), `btw_pct` (Number), `totaal` (Number),
  `status` (One of a list: nieuw / goedgekeurd / afgekeurd), `opmerking` (Long text).
- Purpose sentence: *"Supplier invoices received by e-mail, one row per invoice, so approvals
  and payment runs use the same list."*
- Sharing: **"Specific groups"** → *Inkoop* read; write by invitation for the two buyers.
- Retention: 2555 days (7 years, the Dutch tax retention period), counted from `factuurdatum`.
- Second routine each Monday: `find_rows` where `status is nieuw` → a reminder to the buyers.
- Teaching points: the AI draft panel produces exactly these columns from one brief; the
  "Used by" tab then shows both routines; dropping `status` would break the Monday routine.

### 10.2 HR — `verzuimmeldingen` (sick-leave notifications)
A form on the intranet lets employees report sick leave. "Collect answers in a table" creates a
`form_answers` table `verzuimmeldingen`; the columns are the form's questions.
- The table opens on its **"Dashboard"**; **"Open the form"** jumps back to the form.
- Sharing: **"Private"** plus a grant to the *HR* group — this is health-adjacent data, so it
  must never sit on **"Entire organisation"**.
- Retention: e.g. 730 days counted from `completed_at`; the **"About to expire"** card shows
  what goes in the next week.
- A retired question's column stays, marked "no longer on the form", and HR can remove it —
  which deletes those answers for good.
- Teaching points: you cannot edit these columns here (change the form); rowScope `own` is
  refused because the form writes the rows; deleting the table deletes every answer while the
  form survives and stops collecting.

### 10.3 Sales — `offertes` mirrored from a Google Sheet
Sales keeps a quotes sheet in Google Drive that two account managers edit daily. Instead of a
copy-paste routine, they link it: **"New table" → "A spreadsheet from your files" →
"Choose files…"**, pick `Offertes 2026.xlsx`, sheet `Q3`, header row 1.
- The table `offertes` is a `spreadsheet_file` mirror: the columns are the sheet's header row,
  refresh every 15 minutes by default and live-refreshed while somebody has the tab open.
- A routine reads it (`find_rows` where `status is verzonden` and `vervaldatum` is before
  today) and sends a follow-up; a second routine writes `status = opgevolgd` back — which is
  written **into the file**.
- No Retention tab: rows stay as long as they are in the file.
- If the sheet is an `.xls` or the linker does not own it, the table is read-only here —
  no Add, no Import, no Edit, no Delete.
- Teaching points: the linker's account is the one that reads and writes the file; a broken
  link is fixed with **"Re-link"**; deleting the table only **unlinks** it — the file is untouched.

---

## 11. List/read API endpoints for a "did the learner do it" check

All are under `/api/datatables`, mounted behind **session auth**
(`requireAuthedUser`) + `requireModule('automation')` + `requireLicenseFeature('automations')`
+ `requireBetaFeature('automations')`, and rate-limited to 120/min per user. Every `/:id`
route additionally resolves the caller's grade (404 when there is none).

| Method + path | Auth / grade | JSON it returns |
|---|---|---|
| `GET /api/datatables` | session; no extra permission | `{ datatables: [ … ], scope: {kind:'org'\|'user', id, label} }`. Each row: `id, name, key, description, rowCount, rowScope, isPublished, sharedGroups, writeMode, retentionDays, retentionField, lastRetentionAt, lawfulBasis, subjectColumn, projectId, managedKind, source, sync, ownerUserId, updatedAt, scopeKind, grade, usageCount`. **Owner field: `ownerUserId`**; `grade` is the caller's own grade. |
| `GET /api/datatables/:id` | viewer | `{ datatable: <same projection, incl. ownerUserId + grade> }` |
| `GET /api/datatables/:id/schema` | viewer | `{ fields: [{id, key, name, type, options?, required?…}], modelVersion }` |
| `GET /api/datatables/:id/rows` | viewer | `{ rows, hasMore, count, nextCursor, total }`. Query: `limit` (≤500), `cursor`, `filters` (JSON `[{field,op,value}]`, ≤20), `match` (`all`/`any`), `sort` + `dir`, `q`. Rows carry the system columns incl. **`created_by`** (the row's owner) and `org_id`. |
| `GET /api/datatables/:id/rows/:rowId` | viewer | `{ row }` (404 when not visible) |
| `GET /api/datatables/:id/rows.csv` | viewer | `text/csv` stream, BOM + system columns + declared columns; stamped as a portability export |
| `GET /api/datatables/:id/grants` | viewer | `{ grants: [{id, granteeType, granteeId, grade, grantedBy, createdAt}] }` |
| `GET /api/datatables/:id/usage` | viewer | `{ usage: [ … ] }` — one entry per consumer with `consumerKind` (`automation`/`app`/`webpage`/`kb`), the consumer id, its title and **its owner** (`automation_owner` / `app_owner` / `webpage_owner` / `kb_owner`), the mode (`read`/`write`/`readwrite`) and the step positions |
| `GET /api/datatables/:id/health` | **owner** | `{ modelVersion, schemaStamp, tableExists, missingColumns, stampBehind, healthy }` |
| `GET /api/datatables/:id/source` and `/:id/nextcloud` | viewer, mirrors only (404 otherwise) | `{ source: {kind, linkedByUserId, linkedAt, schedule, refreshOnView, rowCap, relations, …kind extras}, sync }` |
| `GET /api/datatables/:id/source/pulse` / `/:id/nextcloud/pulse` | viewer, mirrors only | `{ dataVersion, rowCount, sync }` |
| `GET /api/datatables/:id/answers/summary` | viewer, `form_answers` only | the dashboard's numbers + `{ form: {automationId, title, live, url, linked, mine} }`; `?from=&to=` |
| `POST /api/datatables/:id/aggregate` | viewer (a read, but POST) | `{ … }` — count/sum/avg/min/max/p50/p90 with optional date buckets |
| `GET /api/datatables/nextcloud/linkable` | session + `manage_datatables` for org scope | `{ connected, reason, tables: [...] }` |
| `GET /api/datatables/nextcloud/describe?ncTableId=\|ncViewId=` | same | the columns a link would arrive with |
| `GET /api/datatables/spreadsheets/providers` | same | `{ providers: [{provider, connected, reason?}] }` |
| `GET /api/datatables/spreadsheets/browse` | same, plus the storage limiter (30/min) | folders + spreadsheet files, with which sheets are already linked |
| `GET /api/datatables/spreadsheets/describe?provider=&fileId=` | same | the columns one sheet would arrive with |
| `GET /api/studio/counts` | session | `{ counts: { …, datatables: <n>, … }, makers }` — same gate and scoping as the list route; the key is omitted (never 403) when the caller may not see it |

**Best checks for "the learner made a table"**: `GET /api/datatables` and look for a row whose
`key`/`name` matches, with `grade === 'owner'` and `ownerUserId === <learner>`; then
`GET /api/datatables/:id/schema` for the columns and `GET /api/datatables/:id/rows?limit=1`
(or the row `total`) for "they put data in it". For "they shared it":
`GET /api/datatables/:id` → `isPublished` / `sharedGroups` / `writeMode`, or
`GET /api/datatables/:id/grants`. For "they set retention": `retentionDays` + `retentionField`
on the same projection. For "a routine uses it": `GET /api/datatables/:id/usage`.

Write routes exist for completeness but are not verification calls: `POST /`, `POST /managed`,
`POST /ai/draft`, `PATCH /:id`, `PUT /:id/schema`, `POST /:id/repair`, `POST /:id/rows`,
`PUT /:id/rows/:rowId`, `POST /:id/rows/bulk`, `DELETE /:id/rows/:rowId`,
`POST /:id/rows/bulk-delete`, `PUT /:id/sharing`, `POST /:id/grants`,
`DELETE /:id/grants/:grantId`, `POST /:id/source|nextcloud/refresh`,
`PUT /:id/source|nextcloud`, `PUT /:id/source|nextcloud/relations`,
`POST /:id/source|nextcloud/relink`, `DELETE /:id/answers/columns/:fieldId`,
`POST /:id/answers/release`, `DELETE /:id`,
`POST /nextcloud/link`, `POST /spreadsheets/link`.
