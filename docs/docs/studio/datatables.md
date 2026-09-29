---
title: Datatables
---

# Datatables

A datatable is a table of rows that **stays put after a run ends**. An automation can
read back what an earlier run wrote, and a *different* automation can use the same
table — which is exactly why tables live in Studio rather than inside one builder
canvas: a table outlives the automation that created it.

URL: `/app/studio/datatables` · one table opens at `/app/studio/datatables/:id`.

**Tier:** Community for building and using your own tables. The section is gated on
the `automations` entitlement, the same one the server puts in front of
`/api/datatables`, and `automations` is part of the free Community core. Two settings
of a table are Enterprise:

- **Sharing** a table with the organisation, groups or people (`automation_sharing`);
- a **retention window** under *Data & retention* (`datatable_retention`).

Both are refused per request, never by hiding the section. When a licence lapses,
nothing that exists stops: reading and writing your rows keeps working, a table that is
already shared stays shared (narrowing it always works), and the retention sweep keeps
honouring every window that was already set. What a lapse refuses is sharing further
or setting a new window.

Using a table as a knowledge-base source is Enterprise too (`kb_datatable_sources`);
see [Knowledge bases](knowledge-bases.md).

## The list

- **Search** sits beside the heading at every list length — name, technical key or
  purpose.
- **A line above the button says where a new table would go**: "New tables here belong
  to your organisation" or "New tables here are personal — only this account can see
  them, and they cannot be shared."
- **New table** appears when the scope is personal, or when you hold the
  `manage_datatables` permission (the server asks for it only on an *organisation*
  table, so the owner of a personal table is never locked out of their own).
- A table nobody shared with you is not merely hidden — the server answers **404, never
  403**, so the list cannot be used to probe for tables. When a deep link names one you
  cannot see, the screen says *"That table is not available to you"* and does not
  speculate about why.

## Making one

**New table** opens a dialog with a **Simple** / **All options** switch.

| Field | Notes |
|---|---|
| What kind of table? | *An ordinary table* (you decide the columns) or *Web service answers* (fixed columns, written by the "remember answers in a table" tick on a **Call a web service** step) |
| Name | |
| Technical name | Lowercase letters, numbers and underscores. Renaming it later means moving the data |
| What is it for? | **Required** for an ordinary table — the sentence goes into your organisation's processing record |
| Who is it for? | *Your organisation* or *This account only*. A personal table can never be shared later |
| Columns | Optional here; can be added afterwards |

## One table

The tabs sit in the 48px command bar, like the editor's; the name in that bar renames
inline; the purpose and *"n columns · m rows"* sit above the content, which is one
960px column in the middle of the page — except **Rows**, which runs edge to edge.
Five tabs, and the fifth is the one that earns its place.

- **Columns** — add, rename and retype. One compact row per column: the name (with a
  pill when an automation writes to it), the kind as an icon and a word, and the
  example — a *One of a list* column shows its choices as chips, and the dashed **+**
  opens the choices editor. The grip on the left reorders: drag it, or focus it and use
  ↑ ↓. No technical name in the row; the key is derived from the name once and never
  changes on a rename. Column types are: Text, Number, Yes/no, Date, Date and time,
  One of a list, Several of a list, Long text, File. Keys match
  `^[a-z][a-z0-9_]{0,62}$`, cannot collide with the system columns (`id`,
  `created_at`, `updated_at`, `created_by`, `org_id`), and a table holds at most 100
  fields.
- **Rows** — a one-line toolbar (search, filter, the count and when the table last
  changed, *Refresh*, *Import*, *Export CSV*, **Add a row**), the table on the full
  width with numbers right-aligned, *Added* as a relative time, an empty choice cell
  as a dimmed *"no status yet"*, and a footer with the count and the pager. Import is a
  *paste from a spreadsheet*: it sniffs tab / semicolon / comma, handles the quoting
  Excel actually writes, reads `ja`/`nee` as true/false and treats "1.234,56" and
  "1,234.56" as the same amount. The whole paste goes in one request that answers with
  per-row errors and their line numbers.
- **Data & retention** (retention windows are Enterprise): how long rows are kept. Presets are *Never*, 7, 30 and 90
  days, or a custom window; beside it, *About to expire* counts what the next sweep
  takes. The window and the **date column it counts from** always travel together:
  the API refuses a retention window that does not name a column, because a window
  that silently inherits a default is one submission away from deleting rows on a rule
  nobody chose. On a *Web service answers* table the column is fixed (`fetched_at`) and
  shown disabled.
- **Sharing** (Enterprise): two cards side by side: *Who can read the rows* (private / entire
  organisation / specific groups) and *People and teams* invited by name, the owner
  always on it. Two axes, deliberately not one: *who may read* is the audience; *who
  may change* is either the invitation list or a second, separate decision to open
  writing to that same audience. One control for both would turn "share this with the
  company" into "let the company delete rows". What the two settings mean together is
  one line at the foot of the audience card. Widening access asks for confirmation and
  names who and what; narrowing it stays one click.
- **Used by** — which automations depend on this table. It is the only surface that can
  answer *"what would that break"*, so the destructive actions read it before they ask.
  To connect another automation: add a **Datatable** step there and pick this table.

The **⋯** menu on the header carries **Rename table** (it opens the inline edit),
**Duplicate** (a copy of the shape — name, purpose, columns — never of the rows; not
offered on a cache, a mirror or a form's answers), **Export (CSV)**, the technical name
(copyable), **Check & repair** (re-runs the table's own "create if missing" statements —
it only ever adds, it cannot drop a column or touch a row) and, after a line, **Delete
this table…** — the one place it lives.

Deleting opens a dialog that names what depends on the table and asks you to type its
name even when nothing does, because a table *is* data — its rows go with it.

## Build it with AI

Two places, one card. In the **New datatable** dialog (an ordinary table) a brief —
a sentence, or pasted material such as a spreadsheet's header row — fills in the name,
the purpose and the columns for you to check; nothing exists until you press
**Create**. On the **Columns** tab of an existing table the card takes a request ("add
a phone number", "rename Stage to Status") and the current columns travel along; the
result lands in the unsaved list above the **Save columns** bar.

The safety story has three layers, and they are the point:

1. **A column's key is where its rows live.** In a revision the server keeps a returned
   key only when the table already has it; every other column is keyed from its name.
   A rename moves the label and keeps the key, so a model can never turn "rename" into
   "drop and add".
2. **Removing and retyping are off unless you switch them on** — per request, with the
   tick *Allow removing or retyping columns for this request*. Off, a column the model
   left out is put back at its place and a changed type is kept, and the line under the
   box says so ("Kept a column the draft left out (Notes) — removing is off"). Select
   options only ever grow.
3. **Even then, nothing is dropped by the AI.** Saving is your step, and it walks
   through the designer's own confirmation, which names the row count and the
   automations that read a column before it goes. **Undo** on the card restores what the
   list held before the draft.

A cache, a mirror or a form's answers table has no card: their columns are not yours to
draft. The brief and the current columns go to the workspace's fast-tier model and
nowhere else; no row is ever read. Ten drafts a minute per person, each one usage row
(`datatable_ai_draft`). On the wire: `POST /api/datatables/ai/draft` with
`{ mode: 'create'|'revise', brief?, note?, current?, allowDestructive? }` →
`{ draft: { name, key, description, fields, notes, changes } }`; 400
`no_brief`/`no_note`/`no_current`, 409 `schema_locked`, 503 `no_model`, 502 `ai_unusable`.

## Who sees what

Your relationship to a table is a **grade**, shown as a chip in the header: *You own
this table*, *You can read and change rows*, or *You can read rows*. Editing a table's
shape needs the owner grade (plus `manage_datatables` on an organisation table).

## Where to next

- [Features → Automations](../features/automations.md) — the **Datatable** step that
  reads and writes these rows.
- [Studio → Runs & log](runs.md) — what a run actually wrote.
