---
title: Nextcloud — Tables
---

# Nextcloud — Tables

[Nextcloud Tables](https://apps.nextcloud.com/apps/tables) is Nextcloud's structured-data app. Bee Flow can read and write tables, columns and rows through agent tools and routine steps — and, for an organisation connected to Nextcloud, **link a Nextcloud table as a datatable** so routines, apps, knowledge bases and pages use it like any other table.

| | |
|---|---|
| Integration ID | `nextcloud-tables` |
| Auth | NC session (connector impersonation) |
| Required NC app | `tables` (2.x) |
| Source | `server/integrations/nextcloudTablesTools.js`, `server/core/dataEngine/sources/nextcloudTable/` |

## Tools

| Tool | Purpose |
|------|---------|
| `nextcloud_tables_list` | The tables the user can access. |
| `nextcloud_tables_create` / `_update` / `_delete` | Create, rename/archive, delete a table. |
| `nextcloud_tables_list_columns` / `_create_column` / `_delete_column` | Columns, with their numeric ids and types. |
| `nextcloud_tables_list_rows` | Rows keyed by column title, with a simple client-side filter. |
| `nextcloud_tables_create_row` / `_update_row` / `_delete_row` | Write rows, values keyed by column title. |

## A table from Nextcloud (datatable mirror)

In **Studio → Datatables → New table**, an account whose organisation is connected to Nextcloud gets a third kind: **A table from Nextcloud**. It links one or more Nextcloud tables (or views) as datatables:

- **A copy, kept live.** The rows are copied into a real datatable and kept in step with Nextcloud by three always-on mechanisms: while somebody has the table open it is re-checked against Nextcloud every few seconds and the rows update by themselves; in the background it is re-checked every minute; and Nextcloud pushes row changes as they happen. *Refresh now* forces a pass. There is no schedule to choose.
- **Changes go both ways.** A row added, changed or deleted in Bee Flow — in the Studio, a routine's *Datatable* step, an App Studio action or a page — is written to Nextcloud **first**; the copy is then refreshed from what Nextcloud answered. A refusal from Nextcloud (no permission there, a required column left empty, a value in the wrong shape) is shown as such and changes nothing on either side.
- **The columns are Nextcloud's.** They cannot be added to, removed, renamed or retyped in Bee Flow; the next refresh brings changes made in Nextcloud. Rows are not aged out by retention.
- **Row ids are Nextcloud's.** A mirrored row's `id` is the Nextcloud row id, so a routine can hand it straight to `nextcloud_tables_update_row`.
- **Who Nextcloud sees.** Every refresh and every write runs as the account that linked the table. Bee Flow's own sharing and grants decide who may see and change the copy. If that account loses access, the copy stays readable but stale, the Nextcloud tab says why, and an owner can re-link.

The same mirror engine also links **spreadsheet files** — an Excel file, a CSV or a Google Sheet in Nextcloud Files, OneDrive or Google Drive — as a fourth kind, *A spreadsheet from your files*, with the same live mechanisms and write-through. The differences (a key column or the row number as row identity, what each file format keeps when written back, shared files read-only unless opted in) are on [Spreadsheet files as datatables](spreadsheet-datatables.md). A *match* relation may cross the two kinds: a spreadsheet column can match a column of a Nextcloud Tables mirror and the other way round.

### Relations between linked tables

Two kinds, both ending up as a *link to a row* column:

- **Nextcloud's own relation columns** (Tables' `relation` type) are taken over automatically when the target table is linked too, together with a `<column>_label` column holding the linked row's name. When the target is not linked the column arrives as a plain number (the row id).
- **Declared in Bee Flow** — "column X of this table matches column Y of that table". The refresh fills a `<target>_ref` column with the id of the matching row (empty when there is none). Declare them in the link wizard's *Relations* step, or later on the table's *Nextcloud* tab.

### Limits

- At most 10 tables per link; a mirror copies at most 10 000 rows (the Nextcloud tab says when the cap bit).
- Bulk import into a mirror is row by row (max 500 per import).

### API

| Route | Purpose |
|-------|---------|
| `GET /api/datatables/nextcloud/linkable` | Tables and views the caller could link, with what is already linked. |
| `GET /api/datatables/nextcloud/describe?ncTableId=` | The columns a link would arrive with. |
| `POST /api/datatables/nextcloud/link` | Link tables (`{scope, tables:[{ncTableId\|ncViewId, name, key}], relations:[{from:{ncTableId,ncColumnId}, to:{…}}]}`). |
| `GET /api/datatables/:id/nextcloud` | The mirror's source and sync state. |
| `POST /api/datatables/:id/nextcloud/refresh` | Refresh now. |
| `PUT /api/datatables/:id/nextcloud` | Schedule and refresh-on-open. |
| `PUT /api/datatables/:id/nextcloud/relations` | Declared relations. |
| `POST /api/datatables/:id/nextcloud/relink` | Make the caller the linking account. |

Row reads and writes use the ordinary `/api/datatables/:id/rows` routes.
