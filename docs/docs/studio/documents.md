---
title: Documents
description: Reusable document templates, customer-specific sections and reviewed PDF output.
---

Documents stores printable HTML and CSS, with a shared definition of parameters,
conditional sections and styling. The editor, AI builders, automation runs and
app actions use that same definition.

## Organize and create

Use the **Documents**, **Templates** and **Reusable sections** views to search,
sort and browse your library. Folders can contain other folders. Deleting a folder
moves its documents and child folders to its parent. Select documents to move them
or assign category tags together.

Start with a blank document, duplicate an existing document, or choose a security,
proposal, invoice, letter or report starter. Starters and workspace controls are
available in English and Dutch. Use **Parameters → Save a copy as template** to
make a reusable version. Customer sample values are excluded from saved templates.

Documents are private by default. Templates and reusable sections can be explicitly
shared with the team. Organization members can read and copy shared items; their
owner and organization administrators can edit them. Archiving retains revisions
already referenced by generated documents and routines.

## Presentations

A presentation is a document of type **Presentation**: the same library, folders,
templates, parameters, history and per-run filling — with slides instead of a page.
Its body is an **outline** in plain text (`# ` the cover title, `## ` per slide, `- `
bullets, `### Card {icon: rocket}` blocks for two to six cards, ```` ```chart ```` and
```` ```stats ```` blocks, `<!-- layout: timeline -->`, `<!-- style: accent -->`,
`Notes:` for speaker notes, `{{placeholders}}` where a routine fills values). The
editor shows the slides as they will print, scaled to the window, and **Edit outline**
opens the text beside them; the slides redraw as you type, before anything is saved.
**Customer preview** fills the placeholders with sample values into the same viewer.

The **Look** tab sets this presentation's style on top of the house style — style family,
colours, typefaces, cover and table style, logo placement, footer, slide numbers — and
lets it bring its own logo or its own template deck (`.pptx`), or drop the house-style
ones. Every control also offers *House style*, so an unset choice follows the
organisation. **Download PowerPoint** builds a real `.pptx`; **PDF** the same deck on
paper. The AI assistant edits the outline (content) or the look (design) as a reviewable
proposal, like a page.

A deck the chat builds (`create_presentation`) is kept here too, so it opens in Bee Flow
without a download and can be rebuilt in another look. Start one from **New document →
Blank presentation** or the pitch, quarterly-review and project kick-off starters.

## Notebooks

A notebook is a document of type **Notebook**: a page you write with **sources** next
to it and an AI assistant that answers from them. It sits in the same library as your
other documents. You can search it, sort it, file it in a folder, give it categories,
and filter on **Notebooks**. Start one with **New document → Notebook**.

Add sources from the rail on the left:

- upload a file (PDF, Word, Excel, CSV, text);
- fetch a website;
- paste text;
- pick a meeting note.

Each source shows its state while it is read: fetching, extracting, then indexing.
When it is ready you see its word count. If reading fails, the reason is shown with
**Retry** and **Remove**. You can cancel a source that is still being read. A
notebook holds up to 200 sources, and pasted or imported text up to 2 million
characters per source.

The assistant searches the sources for the passages that matter to each question,
rather than reading every source in full. It shows the passages it used as source
chips under its answer. It can also write in the notebook itself.

Notebooks need the Notebooks feature in your plan and the **Use Notebooks**
permission. Without them the type is not offered and no notebooks are listed.
Deleting a notebook removes it for good, with its sources, chat and versions. A
notebook has no archive.

**Upgrading.** Existing notebooks need no conversion. After the upgrade every
notebook appears in its owner's Documents library, outside any folder, with its
sources, chat, versions and project filing as they were. Old `/app/notebooks/…`
links open the same notebook in Documents.

## Spreadsheets

A spreadsheet is a document of type **Spreadsheet**: a grid of columns A to Z and up to
2,000 rows. Start one with **New document → Spreadsheet**. Type a value in a cell, or a
formula that starts with `=`.

Formulas support:

- the operators `+ - * / ^`, `&` (joins text) and `%`;
- the comparisons `= <> < > <= >=`;
- cell references (`B3`, also `$B$3`) and ranges (`A1:B9`);
- the functions `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `AND`, `OR`,
  `NOT`, `ROUND`, `ABS`, `CONCAT`, `LEN`, `UPPER`, `LOWER` and `TRIM`.

A formula that can't be worked out shows an error code in its cell:

- `#DIV/0!` for a division by zero;
- `#REF!` for a cell outside the sheet;
- `#NAME?` for an unknown function;
- `#VALUE!` for text where a number is needed;
- `#CIRC!` for a formula that refers back to itself.

Use the arrow keys, Enter and Tab to move, F2 or a double click to edit, and Delete to
clear. Copy and paste work with other spreadsheet programs. Changes save on their own.
**Download CSV** exports the computed values.

The cells are stored in a **datatable** of yours. It is listed under Studio → Datatables,
so routines and apps can read the sheet like any other table. Each row of that table is a
row of the sheet: `row_no` is the row number and the columns `a` to `z` hold what was
typed, so a formula is stored as its text. Its columns are managed by the spreadsheet and
cannot be removed. Deleting that table under Datatables leaves the spreadsheet without
its cells.

Spreadsheets need Datatables in your plan. Without them the type is not offered. A
spreadsheet you already have stays readable and editable if the plan changes.

In a chat, the assistant can read a spreadsheet and fill in or change its cells. It
cannot start a new one.

## Parameters and conditional sections

**Parameters** defines each input's label, type, requiredness, short explanation,
detailed instructions, example and default. Supported types are text, number,
boolean, date, choice and lists with typed item fields. Inserting a parameter
creates a protected placeholder in the text editor.

**Sections** provides the document outline and condition editor. Conditions combine
all/any groups with comparisons. Each customer preview can use the approved rule
automatically or an explicitly reviewed include/exclude override.

For example, a security template can have a boolean `remoteAccess` input and a
remote-access section that applies when it equals `true`. Its `remoteControls`
input is required only when that content applies. A supplied `false` excludes the
section; an absent applicability input is **needs input**, never an inferred no.
The numeric value `0` and boolean value `false` are valid inputs.

**Customer preview** shows the included, excluded and unresolved sections with
reasons. Missing required values, invalid types or unresolved applicability block
final PDFs. Drafts remain available for review. Security starters require supplied,
verified facts and do not invent customer controls or certification.

Reusable sections keep their nested conditions and source revision. Updates appear
for review. Existing documents change only after the proposed update is applied.

## Design and AI assistance

**Design** offers neutral, branded and formal presets, colors, font, spacing,
paper size, margins, logo placement and header/footer visibility. New starters use
shared style tokens. For older custom CSS, ask the **AI assistant** to convert the
stylesheet to the design controls and review the resulting preview.

The assistant has separate design, content and applicability modes. Design proposals
preserve the body, parameter definitions and section rules. Applicability suggestions
show reasons and require review before becoming overrides. Applying a proposal creates
a restorable revision.

House styling is captured with each revision. Changing organization branding does
not rewrite pinned output. Turning a document's house style off and back on explicitly
captures the current branding.

## Automations and apps

The automation and app AI builders can search beyond the initial prompt catalog with
`builder_search_documents` / `app_search_documents`, then inspect the full contract
with `builder_read_document` / `app_read_document`. A read can include the whole body
or a selected section. Builders must inspect the selected revision before configuring
document bindings, including batch creation and updates.

Document-fill steps store `documentId`, `documentVersionId`, `values` and
`sectionOverrides`. A presentation document fills into a `.pptx` (or, with `format: pdf`,
a PDF deck) through the same step; the routine `presentation` step's **Also keep it in
Documents** stores the deck it built as a presentation in the library. Canvas settings show the same parameter instructions and allow
reviewing a newer revision. Existing steps without an explicit version resolve to
the document's migration baseline, preserving their previous template content.

Manual previews, PDF downloads, dry runs, live runs and app actions share the
validation/fill pipeline. Final output fails with an actionable retry message when
styled PDF rendering is unavailable. It does not substitute a differently laid-out PDF.
Existing file output fields remain available, with revision and validation diagnostics.

## Saving, recovery and limits

Text and settings saves are serialized. Export, closing the editor, restoring history
and AI changes flush pending text. Conflicting revisions are refused; failed text
and settings remain recoverable in the current browser session. Recovery can save a
separate private copy. Downloads use the successfully saved revision.

The API rejects unsafe parameter paths and oversized documents. Current ceilings are
512 KB of document HTML, 128 KB of CSS, 256 KB of settings (4 MB for a presentation,
whose settings may carry a template deck), 200 parameters, 100 sections,
500 items per template loop and three nested template blocks. A final render that
exceeds a limit fails rather than silently dropping content.

The existing document-store initialization performs the idempotent migration: IDs,
URLs, authored HTML/CSS and history are retained; legacy history receives full baseline
snapshots and frozen house styling. Organization ownership comes from verified user
records. Legacy placeholder definitions remain provisional, without guessed requiredness;
review their explanations and requirements in **Parameters**.

## Verification for contributors

Run focused server tests from `server`, including `documentContract.test.js`,
`documentSections.test.js`, `documentDiscovery.test.js`, `documentAssistant.test.js`,
`routes/studioDocuments.test.js`, and the existing composition, authoring and execution
tests. React coverage lives in `agent-hub/src/pages/documents` and the app/automation
document settings tests.

Real browser PDF tests:

```bash
DOCUMENT_BROWSER=/path/to/chrome node core/documents/documentBrowser.test.js
```

Migration tests require an explicitly supplied **disposable** PostgreSQL instance.
They create and drop a dedicated temporary database:

```bash
DOCUMENT_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
  node stores/documentStore.integration.test.js
```

Word/PDF template import, collaborative live editing and electronic signatures are
outside this release.
