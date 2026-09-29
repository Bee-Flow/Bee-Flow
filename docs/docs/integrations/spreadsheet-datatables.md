---
title: Spreadsheet files as datatables
---

# Spreadsheet files as datatables

A datatable can be **a spreadsheet from your files**: one worksheet of an Excel file, a CSV file or a Google Sheet that lives in **Google Drive**, **OneDrive** or **Nextcloud Files**. The rows are copied into a real datatable and kept in step with the file, like the [Nextcloud Tables mirror](nextcloud-tables.md); rows changed in Bee Flow are written into the file first. Routines, apps, knowledge bases and pages then use it like any other table.

| | |
|---|---|
| Kind | `spreadsheet_file` (`source.provider` = `google_drive` · `onedrive` · `nextcloud_files`) |
| Formats | `xlsx`, `csv`, Google Sheets (read and write) · `xls`, `xlsm`, `ods` (read only) |
| Auth | The linking account's Google / Microsoft connection (Settings → Connections) or its Nextcloud session |
| Required | The storage's integration switched on for the organisation (`google-drive`, `onedrive`, `nextcloud`) |
| Source | `server/core/dataEngine/sources/spreadsheetFile/`, `server/routes/datatablesSpreadsheets.js` |

## Linking a file

In **Studio → Datatables → New table** an account that has at least one of the three storages connected gets the card **A spreadsheet from your files**. The wizard browses the storage (own files, *Shared with me* on Drive and OneDrive, search), picks one or more files (at most **10 sheets per link**), and per sheet:

- **the worksheet** (a CSV has one);
- **the header row** (1–50): the cells of that row become the columns; rows above it are ignored, columns run up to the last non-empty header cell; a blank header becomes *Column C*, a duplicate header gets *#2*;
- **the column types** — text, number, date, date & time, yes/no are recognised from the cells (a type is chosen when at least 95 % of the sampled cells fit it); the wizard lets you change them, and *select* is an explicit choice. Types are **declared** at link time and never re-guessed afterwards; only a column that is new to the sheet is guessed on its first arrival, and the *Spreadsheet* tab says so;
- **how a row is recognised** — see [Key column or row number](#key-column-or-row-number);
- **relations** to other linked tables (a *match* relation: "column X of this sheet matches column Y of that table"), also to a Nextcloud Tables mirror.

Every table starts with `sync.status: running`; the first refresh fills it within seconds.

## What is kept in step, and how

The copy is a real table with the sheet's columns. Three always-on mechanisms keep it in step with the file; there is no schedule to choose.

1. **While someone has the table open** (the *Rows* or *Spreadsheet* tab) it is re-checked every 5 seconds.
2. **In the background** the ticker re-checks every linked file once a minute.
3. **Push**, where the storage has one — see the table below.

A re-check is cheap: only the file's **version marker** is asked for (a Nextcloud etag, a Drive `version`, a Graph `cTag`), one metadata call. The file is downloaded and read again **only when the marker moved**, and even then rows are rewritten only when the content really changed (a rename, a share or a comment moves Drive's version without changing a cell — the copy's `dataVersion` stays put). *Refresh now* forces a full read.

| Storage | Re-check while open | Ticker | Push |
|---|---|---|---|
| **Nextcloud Files** | every 5 s | every minute | Yes — the connector forwards `file.changed`, `file.new`, `file.renamed`, `file.deleted`, `file.restored` and `file.copied` from Nextcloud's `webhook_listeners`. Nextcloud delivers those through its **cron**, so a push can be minutes late unless the instance runs a dedicated webhook worker; never rely on it alone. A rename **by the account that linked the file** re-points the table to the new path; a rename by anyone else, or a delete, makes the next refresh report `spreadsheet_not_found` until an owner re-links (*Re-read the columns* / relink can point the table at the moved file). |
| **OneDrive** | every 5 s | every minute | Only as a hint: when the linking account has a routine with a OneDrive **file trigger**, the Graph notification that routine already receives also makes every table that account linked in OneDrive re-check now. Without such a routine there is no push — the 5 s re-check and the ticker are the guarantee. |
| **Google Drive** | every 5 s | every minute | None. Drive's change notifications need a verified domain, so Google Sheets and files in Drive rely on the re-check and the ticker only — a change in the file shows within seconds while the table is open, within a minute otherwise. |

## Key column or row number

A sheet has no row ids, so the wizard asks how a row is recognised:

- **A key column** (recommended for anything an automation refers to): a column that is unique and never empty at link time — an invoice number, an SKU. The row's `id` is the key's value (`F-2026-001` stays as it is; a value with spaces or other characters becomes `k_<hash>`). The row keeps its identity when rows are inserted, deleted or sorted in the sheet; a changed key counts as a new row. Rows whose key is empty or repeats an earlier row are **skipped** and counted on the *Spreadsheet* tab. Editing the key column from Bee Flow moves the row to its new id (the answer carries the new `id`).
- **The row number** (default): the id is `r<n>`, the sheet's own row number (`r2` is the first data row under a header in row 1). Inserting or deleting a row above shifts everything below it — the next refresh renumbers, and an open editor gets an honest conflict. A row deleted from Bee Flow in this mode triggers an immediate renumbering pass (the answer says `renumbered: true`).

A key column that disappears from the header (renamed, removed) makes the table fall back to row numbers for that refresh, with a warning, until an owner picks another column under *Spreadsheet → settings*.

## Writing back

A row added, changed or deleted in Bee Flow — in the Studio, a routine's *Datatable* step, an App Studio action, a page, a bulk import — is written into the **file first**; the copy is refreshed from what the file answered. Before every write the file's marker is compared with the one the last refresh saw: when the file changed in between, **nothing is written**, the copy is refreshed and the caller gets `spreadsheet_conflict` (try again). Several tables linked to sheets of one workbook take turns on that file.

| Format · storage | Mode | What is kept | What is lost |
|---|---|---|---|
| Google Sheet | `sheets_api` — cells written one by one through the Sheets API | Number and date formats, everything else in the sheet | — |
| `.xlsx` in OneDrive (work/school account) | `graph_workbook` — cells written through the Excel workbook API | Everything: the workbook is edited by Excel Online itself | — |
| `.xlsx` in Nextcloud, Google Drive, or a consumer OneDrive | `exceljs_put` — the file is edited in place and uploaded with an `If-Match` guard | Cell styles, fonts, fills, borders, number formats, column widths, merges, validations, other sheets, untouched formulas | Charts, pivot tables, slicers, some images, macros |
| `.csv` anywhere | `csv_put` — the whole file is rewritten and uploaded | Delimiter, quoting, BOM, line endings, encoding and decimal separator as found; untouched lines byte for byte | — |
| `.xls`, `.xlsm`, `.ods` | `none` — **read only** | — | The panel says: save the file as `.xlsx` to write rows back. An `.xlsm` is refused because writing it would drop the macros; `.ods`/`.xls` because rewriting them would drop styles. |

Formula columns are read (their computed value) and never written: a write into one is refused with `derived_column`. Derived *match* columns are refused the same way.

A **text** value that a spreadsheet would read as a formula — one starting with `=`, `+`, `-` or `@` (a phone number such as `+31 6 …`, a pasted `=SUM(…)`) — is always stored as **text**: Sheets and the Excel workbook API type the cell as text, an `.xlsx` edited in place stores it as a string, and a `.csv` gets it with a leading apostrophe (`'+31 6 …`, what Excel shows; Bee Flow reads the value without it). Rows come from routines, actions and public forms as well as from the file's owner, and a file that runs a formula when it is double-clicked is not one Bee Flow writes. Number, date and yes/no columns are never touched by this: `-5` in a number column is a number.

### Files that are not yours

A file **shared with** the linking account (shared-with-me on Drive/OneDrive, a shared folder on Nextcloud) is **read only by default**: writing rows typed by Bee Flow editors into someone else's storage is something the linker must choose. The wizard offers **Also write rows into this shared file** per file; the *Spreadsheet* tab shows the state. A file the linking account may not change at the storage (`no_permission`) is read only regardless.

### Who the storage sees

Every refresh and every write runs as the **account that linked the file**. Bee Flow's own sharing and grants decide who may see and change the copy. When that account's connection expires or it loses access, the copy stays readable but stale, the *Spreadsheet* tab says why (`linker_unavailable`, `spreadsheet_forbidden`, `nc_scope_denied`), and an owner can **re-link** — which also lets the table point at another file or sheet. Unlinking (deleting the table) never touches the file.

## Limits

- Files up to **20 MB**; sheets up to **10 000 rows** (the tab says when the cap bit) and **100 columns**.
- At most **10 sheets per link**.
- Bulk import into a linked sheet is one download, all rows, one upload (max 500 rows per import). A duplicate key inside an import refuses the whole batch and uploads nothing.
- Select options grow on refresh (up to 100) and never shrink; a cell outside its declared type lands empty and is counted per column on the *Spreadsheet* tab.

## Troubleshooting

| Code | Meaning | What to do |
|---|---|---|
| `provider_not_connected` (403) | The storage is not connected for this account (`detail: needs_reauth` when a connection expired). | Settings → Connections. |
| `provider_integration_off` (403) | The storage's integration is switched off for the organisation. | An admin switches on Google Drive / OneDrive / Nextcloud under Integrations. |
| `nc_scope_denied` (403) | The account's Nextcloud scope does not include the file's folder. | Widen the scope, or re-link from an account whose scope covers it. |
| `spreadsheet_forbidden` (403) | The storage refused the linking account for this file. | Re-link from an account that may use the file. |
| `spreadsheet_not_found` (404) | The file is no longer at its path / id (moved, renamed by someone else, deleted). | Relink to the moved file; a Nextcloud rename by the linking account is followed automatically. |
| `sheet_missing` (404) | The worksheet is no longer in the file. | Relink to another sheet. |
| `spreadsheet_conflict` (409) | The file changed between the last refresh and this write; nothing was written. | The copy is refreshing — try again. |
| `spreadsheet_locked` (409) | The file is locked at the storage (someone has it open for editing). | Try again in a moment. |
| `already_linked` (409) | That sheet is already a datatable in this scope (`datatableId` says which). | Use the existing table. |
| `key_duplicate` (409) | The key already exists in the sheet (or twice within one import). | Change the key. |
| `spreadsheet_write_unsupported` (409, `reason`) | Read-only file: `xls` · `xlsm` · `ods` · `not_owned` · `no_permission`. | Save as `.xlsx`, tick the shared-file opt-in, or fix the permission. |
| `spreadsheet_too_large` (413) | Over 20 MB. | Split the file. |
| `format_unsupported` (415) | Not a spreadsheet Bee Flow can read. | — |
| `header_missing` / `key_missing` / `key_not_unique` (422) | The header row is blank; the key is empty for this row; the chosen key column is not unique. | Pick another header row or key column. |
| `spreadsheet_rejected` (422) | The storage or the codec refused a value (the message names the column). | Fix the value. |
| `derived_column` (400) | A write into a formula or match column. | Write the source column instead. |
| `spreadsheet_unavailable` / `linker_unavailable` (503) | The storage could not be reached, or the linking account can no longer sign in. | Wait, or renew the connection / re-link. |

On the *Spreadsheet* tab, `sync.lastErrorCode` carries the code of the last failed refresh and `sync.identity` / `sync.coercion` the skipped rows and the cells that did not fit their column.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/datatables/spreadsheets/providers?scope=` | Which of the three storages this account can browse (and why not). |
| `GET /api/datatables/spreadsheets/browse?provider&folderId&q&shared&pageToken&scope` | Folders and spreadsheet files (`folderId` = `root` · `shared` · an id; on Nextcloud the id is the path). |
| `GET /api/datatables/spreadsheets/describe?provider&fileId&sheet&headerRow&scope` | The sheets of a file and the columns, types, key candidates, preview and write mode a link would arrive with. |
| `POST /api/datatables/spreadsheets/link` | Link sheets (`{scope, tables:[{provider, fileId, sheet, headerRow, keyColumn, columns, sharedWriteOptIn?, name, key}], relations:[…]}`) → 201, or 207 when some failed. |
| `GET /api/datatables/:id/source` | The mirror's source and sync state (never the column map, a marker or a token). |
| `GET /api/datatables/:id/source/pulse` | `{dataVersion, rowCount, sync}` — the 5 s re-check while the table is open. |
| `POST /api/datatables/:id/source/refresh` | Refresh now (full read). |
| `PUT /api/datatables/:id/source` | Refresh-on-open, header row, key column, column types (a retype gives the column a new field id). |
| `PUT /api/datatables/:id/source/relations` | Declared relations. |
| `POST /api/datatables/:id/source/relink` | Make the caller the linking account; optionally point at another file or sheet. |

Row reads and writes use the ordinary `/api/datatables/:id/rows` routes; an answer may carry `id` (a key edit moved the row) or `renumbered: true` (a row-number delete).
