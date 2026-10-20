---
title: Tables in Automations
---

# Tables in Automations

A **table** is a spreadsheet or CSV that an automation has read and can edit without code: leave out rows, add a column, count per group, build a cross-table, then hand the small result to an AI step or a PDF. The table itself is kept by the run, so it can hold far more rows than fits in a step's output.

Two steps do the work, both in the builder:

- **Read table** opens an uploaded or generated file and turns every sheet into a table.
- **Edit table** takes a table from an earlier step and applies a list of operations to it, one after the other.

Both can be used inside a loop or with a per-item repeat, and the AI builder knows them.

## Not the same as a datatable

A [datatable](datatables.md) is a small table that stays put between runs, for lookups such as a code book. A table in this page belongs to **one run**, can be large, and is deleted after a while. Use a datatable for a lookup list you maintain; use a table for the data someone uploads.

## Read table

Point **Source** at a file: a **File** answer on a form (`trigger.output.<field>`) or a file an earlier step made. The step reads `.xlsx`, `.xlsm`, `.xls`, `.ods` and `.csv`.

| Setting | What it does | Default |
|---|---|---|
| Sheets | All sheets, only the first one that has data, or a list of names | All |
| Header row | The row that holds the column names (1 to 50) | 1 |
| Provenance sheet | A sheet named `provenance`, `metadata`, `about`, `info` or `readme` is read as key and value pairs (first two columns) instead of as a table. Choose `none`, or name another sheet | Auto |
| Format and delimiter | Taken from the file itself; set them only when the guess is wrong | Auto |
| Skip hidden sheets | Hidden sheets are not read, unless you name them | On |
| Keep for | How many days the tables are kept (1 to 90) | 7 |

The step's output holds one **table handle** per sheet (name, columns, row count and a few preview rows), not the rows themselves:

- `output.table`: the first table.
- `output.tables`: every table, in sheet order.
- `output.tablesByName`: the same, by sheet name.
- `output.provenance`: the key and value pairs of the provenance sheet, when there is one.
- `output.sheets` and `output.source`: what was found in the file.

A file over a limit **fails loudly**. Nothing is ever cut off silently. The file is untrusted: it is checked for size, for a compressed file that expands far beyond its size, and for XML entity tricks before anything is parsed, and macros are never run.

## Edit table

Point **Source** at the table to edit (for example `steps.<read>.output.table`), then add operations. They run in the order shown. Each can be switched off without deleting it, and each can carry a note for the next person.

The output holds:

- `output.table`: the result, as a new table (hand it to another Edit table step).
- `output.rows` and `output.markdown`: the rows and a ready-made table in markdown, **only when the result is small** (up to 200 rows by default). Bind these in an AI step or a document.
- `output.segments`: the list of segments, when you used **Segments**.
- `output.description`: what each column holds, when you used **Describe**.
- `output.opStats` and `output.warnings`: what each operation did, and what to look at.

### The operations

**Join.** Adds columns from a second table (or a list) to every row, matched on one to three key pairs. Matching ignores capitals and surrounding spaces unless you switch that off, and a key can have alternative column names for files that call it differently. *Left* keeps every row; *Inner* keeps only rows with a match. By default only the first match is used; choose to keep all of them. Example: add the department name to each answer, matched on a code.

**Pseudonymise.** Replaces identifying columns by a short code that is the same for the same value, so groups can still be counted but nobody can be recognised from the table. The columns you choose are dropped, and the code goes in a new column (16 characters by default, 8 to 64). The code is a one-way hash combined with a secret **salt** read from a [Solution](solutions.md) variable; without the salt the codes cannot be recomputed. The salt must be at least 16 characters, and the step fails with a clear message when it is missing. Put this operation **first**.

**Derive.** Adds or replaces columns, each from a fixed value, a reference, a template or a formula. A formula sees the current row as `row`, for example `formatDate(row.order_date, 'YYYY-MM', 'en')` for the month of a date. Formulas use the same restricted language as the rest of Automations; there is no code.

**Bucket.** Turns a number or a value into a label. *Bands* are ranges you name (a minimum is included, a maximum is not, either end can be open); *Equal parts* cuts the rows into 2 to 20 equally large groups; *Values* maps listed values to a label. Everything else gets the label for "other".

**Group.** One row per combination of up to five columns, with the figures you ask for: count, sum, mean, median, smallest, largest, distinct count and share. Optionally **weighted** by a column (counts and sums add up the weights, the mean is weighted, median and the smallest and largest stay unweighted), sorted, and with a **minimum group size**: a group with fewer rows than that shows its group but no figures. The result always has an `n` column with the number of rows behind each line.

**Pivot.** A cross-table: one row per value of one column, one column per value of another, and in each cell a count, a sum or a mean. Show cells as a percentage of the row, the column or the total, with totals, a column order, a number of decimals and an optional weight. Cells built on fewer rows than the minimum are left empty, and so are the totals that would give them away. At most 200 value columns are made; the rest are added together as "Other".

**Filter.** Keeps the rows that meet your rules. Each rule is a column, a test and a value. Tests: equals, does not equal, contains, does not contain, starts with, ends with, is one of, is none of, greater than (or equal), less than (or equal), between, is empty, is not empty, and "contains item" for a cell that holds a list such as `a; b; c`. Text tests ignore capitals and surrounding spaces, number tests understand `1,5` and `1.5`. Combine rules with *all* or *any*. Rules can also come from the run itself (**rules from**): a list of rules made by an earlier step or the current segment of a repeat. A formula on top is optional.

**Select columns.** Keep a list of columns (in that order) or drop a list, and rename columns.

**Sample.** The first *n* rows, or a random *n* rows or *p* percent. The random pick is repeatable: the same seed on the same table gives the same rows.

**Segments.** Builds a list of groups to report on, for example "all", "each region" and "each channel". Each split names a column; a cell that holds a list (`a; b`) counts in each of its values. A segment smaller than the minimum (30 by default) is **not listed at all**. The result table lists the segments with their size; `output.segments` holds the usable ones, each with the rules that select its rows. Repeat a step per segment and feed `item.rules` into a Filter's *rules from* to work on one segment at a time.

**Describe.** Changes nothing in the rows. It looks at the columns and reports, per column, what kind it is (one choice, several choices, a scale, a number, a date, free text, an identifier), how many are filled, how many different values there are, the most common options, and whether it can be used to split on. Columns that look personal, and identifiers, show no sample values.

## Preview in the builder

While you edit the operations, the builder shows the first rows of the result and what each operation did (rows in, rows out, the columns after it). A problem points at the field to fix, not at a stack trace. The preview reads at most 1,000 rows of the table you picked, stores nothing, and uses a fixed made-up salt, so pseudonyms in the preview differ from the ones in a real run. Rules that come from a later step are not resolved in the preview.

## Seeing a table in a run

In a run, a step that kept a table shows a chip with its name, rows and columns. **Open table** shows the rows 50 at a time with the column names and a pager ("Rows 51 to 100 of 1,204"). **Download as CSV** saves the whole table; a cell that starts like a formula gets a leading apostrophe, so a spreadsheet will not run it. You need access to the run to see its tables. A table from an earlier run of the same automation (for example one kept for a later step) opens from the run that made it.

Tables are deleted after the number of days set on the step that made them (7 by default). An expired table says so instead of showing rows.

## Limits

Every limit is an environment variable on the server. `0` means unlimited, except where noted.

| Variable | What it limits | Default |
|---|---|---|
| `AUTOMATION_TABLE_MAX_ROWS` | Rows in one table | 1000000 |
| `AUTOMATION_TABLE_MAX_BYTES` | Uncompressed size of one stored table | 536870912 (512 MB) |
| `AUTOMATION_TABLE_MAX_COLUMNS` | Columns in one table | 1000 |
| `AUTOMATION_TABLE_MAX_FILE_BYTES` | An uploaded workbook or CSV | 26214400 (25 MB) |
| `AUTOMATION_TABLE_MAX_UNCOMPRESSED_BYTES` | What the parts of a workbook may expand to | 268435456 (256 MB) |
| `AUTOMATION_TABLE_MAX_SHEETS` | Sheets read from one workbook | 50 |
| `AUTOMATION_TABLE_PREVIEW_ROWS` | Preview rows in a table handle (`0` keeps none) | 20 |
| `AUTOMATION_TABLE_INLINE_ROWS` | Largest result that also comes as `rows` and `markdown` (`0` never) | 200 |
| `AUTOMATION_TABLE_PAGE_MAX_ROWS` | Rows one page of the run view may return | 500 |
| `AUTOMATION_TABLE_MAX_TABLES_PER_RUN` | Tables one run may write | 2000 |
| `AUTOMATION_TABLE_MAX_OPS` | Operations in one Edit table step | 50 |
| `AUTOMATION_TABLE_MAX_GROUPS` | Distinct groups one Group may build | 100000 |
| `AUTOMATION_TABLE_JOIN_MAX_RIGHT_ROWS` | Rows of the second table a Join holds in memory | 500000 |
| `AUTOMATION_TABLE_PIVOT_MAX_COLUMNS` | Value columns a Pivot makes | 200 |
| `AUTOMATION_TABLE_MAX_SEGMENTS` | Segments one Segments operation lists | 500 |
| `AUTOMATION_TABLE_MIN_GROUP_FLOOR` | A **floor** for the minimum group size (`0` = no floor) | 10 |
| `AUTOMATION_TABLE_PREVIEW_INPUT_ROWS` | Rows the builder preview reads | 1000 |
| `AUTOMATION_TABLE_PREVIEW_RPM` | Previews per person per minute | 60 |
| `AUTOMATION_TABLE_CSV_RPM` | CSV downloads per person per minute | 30 |

A result over a limit stops the step with a message that names the variable. Nothing is cut off to make it fit.

## Privacy

- **Pseudonymise first.** When a file holds names, e-mail addresses or ids, pseudonymise before anything else, so no later step, preview or document ever sees them. The salt lives in a Solution variable, not in the automation, so the automation can be exported and shared without it. The editor warns when a salt is typed into the automation itself.
- **Small groups stay hidden.** Group, Pivot and Segments can hide groups below a minimum size. The organisation has a floor that no step can go under: the larger of `AUTOMATION_TABLE_MIN_GROUP_FLOOR` and the organisation's own minimum group size (`minGroupSize` in the `automation_table_policy` organisation setting; there is no settings screen for it yet). A step can ask for more, never less. Group, Pivot and Segments always apply it, even when a step leaves its own minimum at 0.
- **Tables expire.** They are deleted after the days set on the step and are only readable by people who may see the run.
- **Tables do not go to public pages.** A form page offers files for download, never a table, and the routes that read a table need a signed-in person with access to the run. Give an AI step only the small, grouped result (`output.markdown`), never the whole table; a model that gets a table of answers gets the answers.

## Templates

The template gallery has four recipes in the **Reports** category. Each starts from a form with one file field and ends with a page that offers a PDF; between them it reads the table, edits it, lets an AI step write a short summary from the result (told to use only numbers from the table) and makes the PDF.

| Template | What it does |
|---|---|
| Satisfaction by region | Leaves out empty scores, then shows the share of each score per region, with totals and small cells hidden |
| Sales by month and product | Takes the month from each order date, then totals amount, orders and units per month and product |
| Resolution time by category | Average and count per category, and a category by speed table (under 4, 4 to 24, 24 to 72, over 72 hours) |
| Anonymous segment overview | Replaces the id by a pseudonym, drops free text and counts answers per region and channel, hiding groups under 30. Needs a Solution variable named `TABLE_SALT` with at least 16 characters |

Each recipe card has a **Sample data** link: a made-up CSV with exactly the columns the recipe expects, so you can try it before you have data of your own. The files hold invented values only.

To adapt a recipe, open it in the builder and change the operations: the columns it names are the ones in the header row of your file.
