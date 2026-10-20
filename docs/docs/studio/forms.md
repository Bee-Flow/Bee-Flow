---
title: Forms
---

# Forms

A form is **the front of an automation**: whoever fills it in starts it. Studio → Forms is
the *directory* of every form published in the organisation — which ones are actually
live, whether anything is coming in, and which automation is behind each one.

URL: `/app/studio/forms`. A form opens on its own **Form page** at
`/app/studio/forms/<automation id>[/<tab>]` — addressed by the id of the *automation* behind
it, never by the form's public URL token. That token is the form's whole credential, and
a route carrying it would write it into the address bar, the history and every
screenshot of this screen. For the same reason Forms is absent from Studio's "recently
edited" panel and from Studio search.

**Tier:** Community. The section is gated on `automations`, exactly like Automations
and Datatables, because it is the same server mount (`/api/automation`, and
`GET /forms` carries no extra gate). `automations` is part of the free Community core.

## A directory, not an editor

This is the deviation worth knowing before anything else: **a form is not an object of
its own in this product.**

- What a visitor fills in is declared on an automation's **trigger**
  (`trigger.kind === 'form'`).
- The pages after page one are **`form_page` steps** in that same automation.
- The public **address** is a row the server mints whenever such a trigger is saved.

Three places, one automation. The Form page is a *view* on that automation, not a second
document: its Questions tab edits the trigger's form declaration and saves it through
the ordinary automation save (one validation pipeline, one version history), and **Open
the automation** is always one click away for what the page does not do — the pages after
page one, and the steps.

**New form** asks one thing before anything exists: *what happens with the answers?*

- **Collect answers in a table** (the default, recommended) creates the automation with
  `trigger.form.collect: true`. The server creates an answers table on that same save
  and the Form page opens on Questions — the automation builder is never shown.
- **Form that starts an automation** is the path that always existed: a form trigger, then
  the builder. No table unless you add one as a step.

Nothing is posted until *Create form*, so closing the dialog leaves no untitled automation
behind.

## What a row shows

- **Title** and description, from the automation.
- **A status pill with three values, not two**: *Live*, *Not live*, or *Status
  unknown*. Live means the link works. *Not live* means the automation behind it is paused
  or still a draft, so the link answers "not available". *Status unknown* is its own
  state rather than a guess in either direction — telling someone a live form is off,
  or that a dead link works, are both wrong in a way this screen refuses to be.
- **Submissions** and when the last one arrived — shown only when the row actually
  carries the numbers. Absent, never zero.
- **Copy the link**.
- **Answers · n responses** — when the form collects into a table and this account
  has a grade on that table; it opens the Form page on its Answers tab.
- A **collects answers** chip on forms that write to a table.
- **Open the automation** — only for forms you built. `/api/automation/:id` is scoped to
  its owner, so for a colleague's form the row says *"Built by a colleague — only they
  can open the automation behind it"* instead of offering a button that would be refused.

## The address

Copying gives you the absolute form of `/f/<token>`.

**It is not a public link.** Public forms are switched off server-side: the whole form
surface sits behind sign-in, and the organisation that owns the form is the outer
wall — nobody outside it opens the link, ever. Inside it, **who can fill the form in
is the owner's choice** (the Share tab, *Who can fill it in*):

- **Only the people and groups you choose** — the default for a new form. Until the
  owner adds someone, the form is theirs alone. A group means every member of that
  organisation group; a person is one colleague.
- **Everyone in the organisation** — every signed-in colleague with the link. Forms
  that existed before this choice did keep working this way.

Whatever is chosen, a colleague the form is not for gets the same *not available* as
an unknown token — there is no "not yours" to probe for. `/app/forms` (the fillers'
page) lists only the forms the signed-in person may open; the Studio directory lists
every form of the organisation, with an owner-only chip saying who it is shared with.
Rotating the link keeps the audience: a new token is not un-sharing. Signed in, the
same form also renders inside the workspace at `/app/forms/<token>`, with the sidebar
still around it.

The token in that address **is** the credential — there is no second factor. Listing it
on this screen is the point of the screen (the builder panel no longer shows it), but
it deliberately does not travel: no Studio route carries it, it is not in "recently
edited", and it is in no graph, Blueprint or export.

## Two Forms screens, two audiences

| Where | Who it is for |
|---|---|
| `/app/studio/forms` | The person who **builds** forms — is it live, is anything coming in, which automation is behind it |
| `/app/forms` | The person who **fills one in** — a tile is the form, and nothing else is on show |

Both rows exist on purpose. On `/app/studio*` the Studio rail replaces the sidebar
entirely, so only one of the two is ever on screen at a time.

## An empty list and a failed read are different screens

If the list cannot be read — a refusal, an outage, or a body that is not the shape the
route promises — you get an error banner with **Try again**, never "No forms yet". The
count in the header is rendered only from a list that actually arrived, and it is
dropped again the moment a refresh fails: this screen will not claim an organisation
has 0 forms on the strength of a request it could not read.

## The Form page

Four tabs for the owner — **Questions · Share · Answers · Settings** — and only
**Answers** for a colleague the answers table is shared with. The header renames the
form inline, shows the same three-valued status pill as the directory, copies the link
(or opens it in a new tab) and, for the owner, opens the automation.

- **Questions** is the same field editor the automation builder uses, with a sticky
  Save/Discard bar and, above it, **Build it with AI** (below). Leaving with unsaved
  changes asks first — on a tab switch and on the browser's own leave. A multi-page
  form says how many more pages there are and sends you to the automation to edit them.
- **Share** creates or rotates the link, sets *who can fill it in* (people and groups
  of the organisation, or the whole organisation — see *The address*), and, when the
  form collects, wraps the answers table's sharing card: *sharing the table is sharing
  the dashboard*. The two audiences are separate on purpose: who may answer is not
  who may read the answers.
- **Settings** holds the *Live* toggle (it runs the automation's full validation and shows
  the reason when it refuses), the *Collect answers in a table* toggle, a link to the
  table's data-and-retention settings, and the danger zone. Deleting the form deletes
  the automation; the answers table stays.

## Build it with AI

The card above the question editor takes a **brief** — a sentence, or pasted material
the form should be based on: an intake checklist, an e-mail, a policy, notes — and
drafts the whole form: heading, intro, questions with the right types (a dropdown
with its choices, a yes/no, a date, a file), the button text and the thank-you line.
The same box is on the *New form* dialog (*Describe it*): create the form and it lands
on Questions with the draft already applied.

With questions already there the box takes a **request** instead ("add a phone
number", "make the address optional", "shorter labels") and the current questions
travel along; *Start over from a description* switches back to a brief.

What the AI may not do is the point:

- **Nothing is saved.** The draft lands in the unsaved editor; you read it, change
  what you like, and Save — or *Undo* puts back exactly what was there, or *Discard
  changes*. On a form that collects answers this is the whole safety story: a misread
  brief is one Undo, never a retired column.
- **A kept question keeps its name.** The name is the column in the answers table
  and the binding in the automation. In a revision the server keeps a returned name only
  when it is one the form already has; every new question is named from its label.
  A model cannot rename a column by returning a fresh name for an old question.
- **Only input types.** Download and notebook fields point at a generated file and
  cannot be on the first page; an unknown type becomes text; a dropdown without
  choices becomes a text field; more than 40 questions are cut and the note says so.
- **The brief is quoted material.** It may contain a pasted e-mail with "ignore the
  above" in it; the prompt fences it, and the result is still only a list of
  questions a person reviews.
- **Only your text travels.** The brief, the request and the current questions go to
  the workspace's fast-tier model; no other form, table or row is read. Each call is
  one usage row (`form_ai_draft`), ten a minute per person.

On the wire: `POST /api/automation/forms/ai/draft` with
`{ mode: 'create'|'revise', brief?, note?, current? }` → `{ draft: { form, notes } }`;
400 `no_brief`/`no_note`/`no_current`, 503 `no_model`, 502 `ai_unusable`.

## Answers in a table

When a form collects, its answers table is a datatable of the managed kind
`form_answers`: **definition-owned**. Its columns are the form's questions and nothing
else, so the schema editor is locked — change the questions on the form and the table
follows on the next save, without touching a row.

**What the table looks like.** Two fixed columns — `run_id` (the run the submission
started) and `completed_at` (when the last page was answered) — then one column per
question, in form order. Question types map to column types: text, textarea and e-mail
→ text; number → number; date → date; select → select (its options only ever grow,
never shrink); checkbox → yes/no; file → a file reference. Display-only fields (a download, a
notebook) get no column. `created_at` is the moment of submission and
`created_by` the submitter, which is always a signed-in colleague while public forms are
off.

**How the table follows the form.**

| You do this on the form | The table does this |
|---|---|
| Rename a question's label | Renames the column header. Values untouched. |
| Change a question's type | Retires the old column and adds a new one. Nothing is ever dropped by itself. |
| Remove a question | Keeps the column, flagged *no longer on the form*. The owner can remove it later from Datatables → Columns; the dashboard folds these away under *No longer on the form (n)*. |
| Add the same question back | Un-retires the column. |
| Reorder questions | Reorders the columns. A question is recognised by its page and its field name, not by its position. |
| Switch *Collect* off | The table, its rows and its sharing stay exactly as they are; new submissions no longer land there. Switching it on again re-adopts the same table. |
| Delete the form | The table stays, released to an ordinary table. |
| Delete the table | Refused while a form writes to it (*in use*, naming the form). Switch *Collect* off first — or accept that the next save of a collecting form creates a fresh, empty one. |

**When the row is written.** A submission is inserted into the table *before* the run
is queued — the run queue is in memory; the table is the durable record. A single-page
form marks the row complete at once; a multi-page form completes it when the last page
is answered, and the dashboard counts the rest as *open*. If the row cannot be written —
the table's quota is full, or the table is gone — the submission still succeeds and the
problem is shown on the table's source card (`lastWriteError`).

**Who sees the answers.** Permission is the answers table's own grade ladder: the owner,
the organisation's admins, and anyone the table is shared with (viewer or editor).
There is no separate "form viewer" role and no respondent-facing "my submissions".
A colleague with a grade sees the form in Studio → Forms with an *Answers* button and,
on the Form page, only the Answers tab; a colleague without one does not see the
button, and the deep link answers *not available*.

**The dashboard.** The same dashboard sits on the Form page's Answers tab and as the
first tab of the answers table in Studio → Datatables.

- A range bar — today, 7, 30 (default), 90 days, all time, or two dates.
- Four tiles: responses in the period, all time, today, and the last response (or
  *completed all pages* on a multi-page form).
- A timeline bucketed by day, week or month depending on the range.
- One card per question, shaped by its type: a bar list with counts and percentages
  for a choice, a yes/no split, average · median · lowest · highest tiles for a number,
  a per-month chart for a date, the five most recent quotes for free text with *See all
  answers* (which narrows the responses table to that column), and a count for files.
- Recent responses that open in a drawer with every answer in form order; the owner
  can jump from there to the run.
- Every response, as the ordinary row browser with CSV export.

The dashboard refetches every 30 seconds while the page is visible. Everything it shows
is computed through the datatable query compiler under the caller's own access filter —
there is no path that reads a row the caller could not read in the table.

**On the wire.** `GET /api/datatables/:id/answers/summary?from&to` (viewer),
`POST /api/datatables/:id/aggregate` (viewer; generic group-by/aggregate over the
table under the same filter), `DELETE /api/datatables/:id/answers/columns/:fieldId`
(owner; 409 `column_live` unless the column is retired), `POST
/api/datatables/:id/answers/release` (owner; 409 `still_linked` while a form writes),
`GET /api/automation/forms/:automationId`, `POST
/api/automation/forms/:automationId/answers-table` and `PUT
/api/automation/forms/:automationId/audience` (owner; `{ audience: 'org'|'restricted',
sharedGroups, sharedUserIds }`, validated against the organisation — a group it does not
have or a person outside it is a 400, never dropped). Directory rows carry `canOpen`
(the visitor gate's verdict for the caller) and `audience` (the lists only for the
owner). Refusals: `PUT /:id/schema` → 409
`schema_from_definition`; a `rowScope: 'own'` on such a table → 400 `answers_row_scope`;
`POST /api/datatables/managed` with this kind → 400 `kind_needs_form`.

## Wizards: choices, conditions and lists

A form does not have to be one long page. Put a few questions on the first page and
add **Form page** steps after it for the rest. Each page only asks what is still
needed, can look at what the automation has learned in the meantime, and can be skipped
altogether. None of it needs code: everything below is set with pickers in the form
editor (open a page and use **Open form editor** for the full-screen view with a live
preview).

### New kinds of question

Besides short and long text, email, number, date, dropdown, checkbox, file upload and
"pick from an app", a question can now be:

- **Choice buttons** (`radio`): one answer, shown as buttons. It behaves exactly like a
  dropdown, just easier to scan when there are two to four options.
- **Several choices** (`multiselect`): the visitor may tick more than one. The answer is
  a *list* of the options picked. You can set the fewest and the most they may tick.
- **Text block** (`info`): some words between the questions (instructions, a reminder,
  what happens next). It asks nothing and stores nothing. Write it in markdown; on a
  later page it can contain values from earlier steps. Text blocks can go on the first
  page, on a later page and on a closing page.

A choice does not need a separate label. Type one option per line and the answer stored
is that text. Where you want people to read something different from what is stored
(or add a short note under an option), choose **Show a different label or a hint**: the
*value* stays what the automation sees, the *label* is only what people read, and the
*hint* is a small line under the option.

### Choices from an earlier step

On a later page, a dropdown, choice buttons or several-choices question can take its
options from a **list produced by an earlier step**: the rows a lookup found, the
documents a search returned, the people a table holds. Switch the question from
**Fixed list** to **From an earlier step**, pick the list, and say which part of each
item is the **value**, which is the **label** and, optionally, a **hint**. The pickers
show the fields of the first item of your example data. Without an example you can type
the field names.

The answer is always the **value**; the label is only what people read. So route on the
value (an id, a code), never on the label text. Options are de-duplicated by value. An
empty list shows "no options" and the question is no longer required, so nobody gets
stuck on a question they cannot answer. The first page cannot do this, because it is
shown before anything has run.

### One question per list item

**Ask this once per item of a list** repeats a question for every item of a list from an
earlier step: rate each line of an order, confirm each document that was found, give a
date for each attendee. The question's label becomes the heading; each item supplies the
text of its own question. The answers come back as **one list** that later steps can
loop over:

```
steps.<page>.output.<name> = [ { key, label, answer }, … ]
```

`key` is the item's value, `label` the question as it was shown and `answer` what the
visitor gave. If the list is empty the answer is an empty list.

### Showing a question only when…

Under a question, **Only show this question when…** hides it unless an *earlier*
question on the same page has a given answer. Pick the question, then *is*, *is not*,
*contains*, *is empty*, *is not empty*, *is greater than* or *is less than* (the choices
depend on the type of question), then the value. A hidden question is not asked, is
never required and is stored as empty. The server checks the condition again when the
form is submitted, so a hidden answer cannot be smuggled in.

A condition the picker cannot show (one with several parts) appears as text in the same
place, and stays editable there.

### Answer rules

**Answer rules** on a question narrow what is accepted. A number or a date takes a lowest
and highest allowed; short text, long text and email take a fewest and most characters;
short and long text can also require a **pattern** (the whole answer has to fit it; for
example `[A-Z]{2}[0-9]{4}` accepts `AB1234`) with the sentence the visitor reads when it
does not. Rules are only checked on an answer that was given: use **Required** for "must
answer". A broken rule shows an inline message and the page does not submit.

### Skipping a page

On a Form page step, **Only show this page when…** takes a condition on what the
automation knows when it reaches the page (the form's earlier answers, an earlier step's
result). When it is not met the page is *skipped*: nobody sees it, the run goes straight
on without pausing, and its answers stay empty. Use it for the second half of a form that
only some visitors need.

### Stopping early with a closing page

To end a form early with a clear message (we cannot continue, here is why), put a
condition before the page and, on the branch that must stop, add a **closing page**. Write
its message with values from earlier steps, and leave that branch without further steps.
The visitor sees the message instead of the rest of the form.

### Two ways in with one form

An automation has one form. If two kinds of visitor need different questions (report or
request, for example), ask that first with choice buttons on the first page and use
**Only show this page when…** on the later pages, or branch on the choice with a switch
and give each branch its own pages.

### A second try

For "upload a document, and allow one more try when the check fails": put the check in a
flowlet and call it after the first upload page. Then add a **Condition** on the check's
result. Only on its failure branch, add a second Form page that asks for the file again and
call the same flowlet on the new file, so the second check never runs when the first one
passed. Let both branches end in the same step. From there on, read the file with
`coalesce(second file, first file)` and the result with `coalesce(second result, first result)`:
a step that did not run reads as empty, and `coalesce` skips empty values. Form pages cannot
sit inside a loop, which is why the retry is written out once.

### Busy forms

A wizard that many people fill in at the same time should have **Run at the same time**
set to *Allowed at the same time* in the automation's settings (the "run several at
once" option). Otherwise a second visitor waits for the first run to finish. While a visitor waits, the page can tell them how long a run usually takes.

### Limits you can change

Two environment variables set how large a dynamic list may get. Both have a generous
default and **0 means unlimited**:

| Variable | Default | What it caps |
|----------|---------|--------------|
| `AUTOMATION_FORM_MAX_OPTIONS` | `200` | The options of one choice question (typed or loaded from a list). |
| `AUTOMATION_FORM_MAX_FIELDS_FROM` | `50` | The questions one "once per item" question expands into. |

## Where to next

- [Features → Automations](../features/automations.md) — the automation a form starts.
- [Studio → Datatables](datatables.md) — the answers table is one of these.
- [Studio → Runs & log](runs.md) — what happened after someone submitted.
