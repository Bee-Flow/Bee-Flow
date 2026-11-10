---
title: App Studio
---

# App Studio

App Studio lets you build internal apps — trackers, dashboards, intake forms, small
tools — inside Bee Flow, without writing code. Describe what you need and the AI
builds the whole thing: a data model, sample data, the screens, and the logic that
ties them together. Then you refine it visually.

URL: `/app/studio/apps` · end-users open a published app at `/app/apps/:id`.

**Tier:** Enterprise (GA). App Studio is on by default for Enterprise organisations;
an org admin can disable it under beta/feature settings. Everyone who opens a
published app needs the same Enterprise `app_studio` entitlement. An app is shared
inside your organisation; an app can also open a limited set of its screens to
anonymous visitors behind a link (a *public page*), and only those screens and the
actions wired to them are reachable without signing in.

## Build with AI

Open **Studio → Apps → New**, then describe the app in the builder chat:

> "Build a ticket tracker. Tickets have a title, status (open/in-progress/done),
> priority, and an assignee. A kanban board grouped by status, a form to file a new
> ticket, and a 'My tickets' screen that only shows the current user's tickets."

The AI builds it end to end:

- **Data model** — it designs tables with typed fields (text, number, date, select,
  relation, file, …), relations between tables, and per-role access rules.
- **Sample data** — it seeds realistic demo rows so the app isn't empty.
- **Screens & components** — forms, tables, data grids, charts, kanban boards,
  calendars, record-detail views, stats, and more, wired to your data.
- **Actions** — buttons and forms that create/update records, run one of your
  [Automations](../features/automations.md), navigate, or call an external connector.
- **Roles & access** — it can set up roles (e.g. *admin*, *member*) and row-level
  rules (e.g. members see only rows they created).

**Plan first.** For a larger app the AI proposes an editable **plan** — the screens,
tables, roles and datasets it intends to build — as a card in the chat. Review it,
tweak any part, then hit **Build it**. Small changes ("make the header blue", "add a
notes field") skip the plan and apply directly. Before finishing, the AI **dry-runs**
the app — it actually reads the data through each binding, as the owner and as each
role, and fixes anything that comes back empty or broken.

Every AI turn is one undo step, and the builder writes **checkpoints** you can revert
to from version history.

## The visual editor

Anything the AI builds, you can refine by hand:

- **Component ribbon** — the strip at the top of the canvas groups every component
  by category (Basics, Content, Layout, Data, Input). Click to add, or drag onto the
  canvas; hover any card for a short description of what it does. The strip stays one
  row tall — long categories scroll sideways — and can be collapsed to just its tabs
  when you want the canvas. Both side panels (the AI builder chat and the inspector)
  collapse and resize the same way, so the editor fits comfortably on a laptop screen.
- **Inspector** (right panel) — **Content**, **Style**, **Logic** and **Actions** for
  the selected component. Logic covers visibility (`Only show when …`), enablement,
  field validation rules, and computed values — all written as safe formulas with a
  live preview and a variable picker (`currentUser`, form fields, `screen.params`,
  datasets, …).
- **Data bindings** — point a component at a table (with filters + sort), a saved
  dataset/query, a formula, an automation result, or an external connector. Filters can
  use formulas (e.g. show rows where `assignee == currentUser.id`).
- **Preview / view-as-role** — switch to Preview to use the app live, and view it as
  any role to check what that role sees. (Row security is always enforced by the
  server, not just the preview.)

### When a step fails

A step that fails stops its action and shows the real reason: "Record not found",
"The AI provider had a temporary problem", or, for an unexpected fault, a short
reference you can quote to your administrator (it is also in the server log). Three
settings change that, per step, in the action flow editor:

- **If it fails, try again** (`retry`): try the step up to 3 more times, with a wait
  in between (1 second by default). Only failures a retry can help are tried again,
  such as a busy database or a temporary problem at the AI provider; "not found" or
  "not allowed" is not. Steps that reach outside the app (sending an email, running an
  automation, asking for an approval, browsing, copying a document) are never retried,
  because a second attempt would do it twice.
- **If it still fails** (`onError`): run fallback steps in the step's **If it fails**
  branch on the canvas, then carry on with the rest of the action ("Fallback, then go
  on"), or end the action quietly after them ("Fallback, then stop"). The fallback
  steps can read the failure as `error.message`, `error.step`, `error.code` and
  `error.attempts`; outside that branch `error` is empty. A handled failure shows no
  error message.
- **All or nothing** (`transaction`): put several *Add a row*, *Change a row* and
  *Delete a row* steps inside it (at most 50) and they are saved together: if one
  fails (for example a row that no longer exists), none of them is kept. A row added
  earlier in the block can be used by a later one (`vars.order.id`). It works on the
  app's own tables; a table linked to a Studio datatable lives in another store and
  cannot be part of it.

### Long-running actions

An action that reads many documents or calls the AI many times can take minutes. Turn
on **Keep running when the page is closed** (`background: true` on a sequence) and a
click starts the work on the server: the page shows its progress (the current step,
"Item 3 of 12" in a loop, or your own text) and the result when it is done. You can
leave or close the page; when you come back the run is shown again.

- **What can be in it**: steps that run on the server (rows, AI, e-mail, files,
  automations, approvals), *Set a variable*, conditions, loops and *Run another
  action*. Messages and refreshes are shown when the run ends. A confirmation is only
  possible as the first step (it is asked before the run starts). Navigation, dialogs,
  opening a link, resetting a form, downloading a file and AI browsing need the page
  and cannot be part of it: put them in a second action on the same button.
- **Once at a time per item** (`lockKey`): a value such as the record id. While a run
  with the same value is going, a second start is refused with "This is already
  running for the same item". Use a prefix per action, for example `'order:' + item.id`.
- **Progress text** (`progressVar`): the variable your *Set a variable* steps write,
  for example `status` = "Reading document 2 of 5".
- **Limits**: a loop still stops after 200 items, and a list of rows reads 50 rows
  unless you set a limit. A run stops after 30 minutes or 5,000 steps, and each person
  can have 3 runs of an app going at once (20 per app). Every AI call has a time-out
  (120 seconds) with one retry. On self-hosted these are environment variables
  (`STUDIO_APP_BACKGROUND_*`, `STUDIO_AI_CALL_TIMEOUT_MS`, see `server/.env.example`).
- **Restarts**: when the server restarts during a run, the run ends as *interrupted*.
  It does not continue by itself, because its steps may already have written rows or
  sent mail; start it again when that is safe.

Results and variables of a finished run are kept for 24 hours, the run itself for 30
days.

### Change many rows, idempotent writes

- **Rows matching a filter**: *Change a row* and *Delete a row* can work on every row
  that matches a filter instead of one row. Pick "Rows matching a filter" in the step
  settings, add the conditions (for example *Status is Done*) and, if you like, a
  maximum. At most 500 rows change per run, oldest first; the result says how many
  matched, how many changed and how many remain, so running the step again continues
  where it stopped. Only rows the person's role may change or delete are touched. A
  condition whose value is empty (an empty form field) changes nothing at all: an
  empty filter never means "every row". Inside *All or nothing* such a step also sees
  the rows added earlier in the block.
- **Update instead of duplicate** (`writeTo.upsertKey`): *Read a document* (and file
  intake) can write its rows with a key, one to five columns such as order number and
  line. A row whose key matches an existing row updates that row, so reading the same
  document twice does not double the table. A row with an empty key is added as new.
- **Replace a set** (`writeTo.replaceWhere`): delete the rows matching a filter first
  (for example the lines of this order), then write the new ones. Without a key this
  happens in one go: either the old rows are replaced or nothing changes. With a key the
  old rows are deleted first and the new ones are written one by one. More than 500
  matching rows, or a filter value that is empty, refuses the step with nothing changed.

### Runs: what happened when an action ran

**Logic → Runs** lists every run of the app's actions, newest first: when, which action,
who (by name; a public page's visitor and the mailbox hook as such), how it ended, how long
it took, how many steps ran and the estimated AI cost. Filter by action, status and person;
**Include tests and MCP runs** adds the runs of saved tests and of an AI agent's test runs.
Open a run to see each step in order with its duration, its error and error code, how often
it was tried, whether an *On error* handler dealt with it, and for an AI step the model,
tier, tokens and cost (an estimate in the price's own currency; billing is separate).

- **What is logged**: every click or public-page use of an action that does work on the
  server (all server steps of one click form one run), background runs, mailbox hooks,
  saved tests and MCP test runs. An action of only client steps (a message, navigation)
  is not logged.
- **What is not**: the data. No field values, results, variables or prompts are kept, and
  error texts are cut to their first line with quoted values and e-mail addresses removed.
- **Who sees it**: the app owner.
- **How long**: 30 days by default. On self-hosted, `STUDIO_APP_RUN_RETENTION_DAYS` (0 =
  keep), `STUDIO_APP_RUN_LOG=off` stops recording, and `STUDIO_APP_RUN_LOG_MAX_STEPS` /
  `STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP` cap the size (see `server/.env.example`).
- A run whose page was closed before it reported its end closes itself after a minute
  without activity; its status then follows its steps.
- The mobile app's runs appear as one run per server step for now.

## Data tables, roles & access

Open **Data** to design the data model directly: add tables and fields, define
relations, and set **access**:

- **Access mode** per table — `app` (everyone who can open the app), `owner`, `role`,
  or `none`.
- **Row-level rules** per role — a bounded expression over `record.*` and `viewer.*`
  (e.g. `record.created_by == viewer.id`). These compile to parameterised SQL on the
  server; there is no way for an app to run raw SQL.

Every app gets its own private database. Records are created with the acting user
stamped in `created_by`, and all reads/writes are filtered by the role rules — so a
member can never see or change rows a rule hides, regardless of what the screen shows.

## External connectors

An app can read from external sources through **connectors** (Data → Connectors):

- **Integration tool** — call one of your connected integrations.
- **Automation** — run one of your Automations and use its output.
- **REST** — an HTTPS endpoint with a declared parameter list.

Connectors run **as the app owner** on the server (never with viewer-supplied
credentials), behind an SSRF guard that blocks private/internal addresses. The AI can
*wire* an existing connector into the app, but it never authors credentials — you set
those up yourself.

A **mailbox** connector (Gmail or Outlook) fills conversation, message and attachment tables and can run an
action for each new mail; see [Mailbox apps](./mailbox-apps.md).

## Mailbox replies as drafts

A **send e-mail** step normally sends the reply at once. Set its `mode` to `"draft"`
and the reply is saved as a **draft in the connected mailbox** instead: nothing is
sent, and an employee reviews and sends it from Outlook or Gmail themselves. The default
is `"send"`, so existing apps behave as before.

- **Outlook** — with a message or conversation to reply to, the draft is a reply to
  that message (the quoted history stays and the conversation is kept); otherwise it
  is a standalone draft. A shared mailbox works the same way.
- **Gmail** — the draft is filed in the right conversation with the reply headers.
- **Attachments** — the same app files as for sending; for Outlook up to 3 MB in total.
- **Result** — `resultVar` holds `drafted`, `draftId`, `webLink` and `webLinkKind`.
  Bind an "Open in Outlook" button to `webLink`. Outlook returns the link itself
  (`webLinkKind: outlook_web`); for Gmail it is a compose link built from the draft
  (`gmail_compose`).
- **In the app** — with `recordOutbound` on (the default) the draft is added to the
  conversation with direction `draft`. It never counts as a sent reply: it does not
  start a first-response time and does not mark the conversation as answered. Add
  `draft` to the options of the table's `direction` column to filter on it.
- **Permissions** — saving a draft writes to the mailbox. Outlook needs the
  `Mail.ReadWrite` permission (`Mail.ReadWrite.Shared` for a shared mailbox), Gmail
  the compose permission. When the connection is known to lack it, the step fails
  before anything is called, with code `draft_scope_missing`.

## Documents in an app

Studio documents (pages, designed documents, presentations and spreadsheets) can be
shown inside an app with three components from the **Content** and **Input** groups:

- **Document** (`document_viewer`): one document, read-only. A presentation or page
  looks exactly like its Studio preview; a spreadsheet shows its computed values, one
  tab at a time. Its source is a fixed document id, or a formula, record field or
  action result that holds one.
- **Document picker** (`input_document`): lets the user choose from the documents you
  list (`documentIds`) and/or one of your folders (`folderId`), narrowed to pages,
  presentations or spreadsheets. It submits the chosen id.
- **Document compare** (`document_compare`): what changed between two documents, or
  between two versions of one (give it only a left document and the user picks a
  version). Text is compared paragraph by paragraph with the changed words marked,
  presentations slide by slide (plus a summary of the look: theme, colours, fonts,
  template), spreadsheets per tab, row, column and cell. Side by side or inline, with
  "only changes" and next/previous change.

The **Copy document** step (`copy_document`) copies a document into your library; for
a presentation it can apply another presentation's look (`templateDocumentId`). Bind
its result to a compare's right side, with the original on the left, and the user sees
exactly what the new look changed.

**Whose documents.** An app reads documents as its owner, and only the owner's own
documents (or an organisation team template). A document merely shared with the owner
is never shown: an app's audience is wider than that share. On top of that an app shows
only what you put into it (a fixed id in a component, a picker's list or folder, a copy
step's source or template) plus the copies it made itself, and only through components
the viewer's role can see. A formula pointing anywhere else gets "not available". The
server checks this on every read.

## Publishing & consuming

Publish from the editor's **Publish** button. Three audiences:

- **Private** — only you (unpublish).
- **Entire organisation** — everyone in your org.
- **Specific groups** — pick one or more groups.

Published apps appear for your audience at **`/app/apps`** (the Apps directory) and
open at `/app/apps/:id`. Apps are responsive — the layout stacks on mobile.

### Publish to the Nextcloud app menu

If your organisation's Nextcloud is connected to Bee Flow (the [Nextcloud
connector](../getting-started/nextcloud.md)), a published app can also get **its own
icon in Nextcloud's top bar**. Tick **"Show in the Nextcloud app menu"** in the
Publish dialog and apply; Bee Flow tells the connector right away, the connector
adds the menu entry, and the dialog confirms it — **reload Nextcloud to see the
icon**. It opens the app on its own page inside Nextcloud — buttons, forms, data
grids and automations all work through the user's Nextcloud sign-in.

Things to know:

- **Everyone on the Nextcloud sees the icon.** Nextcloud's menu entries for
  connected apps are instance-wide — there is no per-group entry — so the icon
  cannot follow a "Specific groups" audience. Only the audience you chose can
  use the app: a colleague outside it who opens the icon sees a notice that the
  app is shared with specific groups and whom to ask. Access, roles and
  row-level rules are enforced by the Bee Flow server exactly as inside Bee Flow.
- **Renames, unpublishes and deletes propagate right away** too. If the
  connector cannot be reached at that moment (the dialog then says "within a
  few minutes"), its own periodic check picks the change up — every 5 minutes
  by default, `BEEFLOW_STUDIO_MENU_SYNC_SECONDS` on the connector. Unpublishing
  removes the entry; republishing restores it without re-opting-in.
- Nextcloud users must be synced Bee Flow users in the app's organisation
  (that's the connector's normal user-sync) and the org needs the
  `app_studio` entitlement.

## Managed by a Solution stage

An app in a **UAT or Production stage** of a [Solution](solutions.md#stages-and-deployments)
is a copy that arrives by deployment, so it is **read-only**: the editor shows a *Managed by
a Solution stage* banner with a link to open the app in Dev and one to the stage settings,
and a save, a rename or a delete answers `409 managed_part`. What a stage keeps is its
**audience**: *Publish* only moves who the app reaches (everyone, groups, or nobody); it
never freezes a new definition, because the published copy is the deployed release. An app
that has not been deployed yet has nothing to publish (`managed_part_not_deployed`).

The app's own data is the stage's own: a deployment never copies rows from Dev. Its data
model can **grow** with a release (new tables and columns, applied additively); a change
that would drop or retype something is blocked in the deployment plan. In an App Studio
action, a step that writes to a managed part reports `managed_part` instead of failing
silently.

## Limits & quotas

App Studio enforces generous per-app limits. Writes are blocked with a clear message
(HTTP 409, `code: quota_exceeded`) once a cap is reached; **deleting rows always works**
so you can recover. An amber "Storage NN%" pill appears on an app's card once its
database passes 80% of the size cap.

| Limit | Value |
|-------|-------|
| Tables per app | 50 |
| Fields per table | 100 |
| Rows per table | 100,000 |
| Rows per app | 500,000 |
| Database size per app | 256 MB |
| Attachment size | 25 MB |
| Attachments per app | 5,000 |
| External connectors per app | 50 |
| Screens · components and sections · actions | 40 · 500 · 200 |
| App definition size | 512 KB |

**Rate limits** (per user, per app; env-tunable on self-hosted): AI builder 12/min,
data reads 60/min, data writes 20/min, action runs 10/min, sequence steps 60/min,
connector runs 20/min, document compares 60/min. The size caps of documents in an app
(picker options, versions, spreadsheet tabs, compare detail) are environment variables
too; see `server/.env.example`.

Org admins can see per-app and total storage under **App Studio usage**
(`GET /api/studio-apps/usage`).

## Templates & remix

**New → From a template** ships ready-made, data-backed starting points (CRM pipeline,
ticket tracker, asset inventory, event planner, team directory) — each with a data
model and sample data. Choose **Remix with AI** to instantiate a template and open the
builder with a prompt prefilled, so you can adapt it by describing the changes.

## Where to next

- [Automations](../features/automations.md) — the Automations your app's actions can run.
- [Licensing → Tiers](../licensing/tiers.md) — where App Studio sits in the tier matrix.
