---
title: Automations
---

# Automations

:::warning[Pro tier feature]

Requires a Pro or higher licence key. See [Tiers](../getting-started/tiers.md).

:::

Automations (also called **automations**) are trigger-based workflows. When something happens — a cron tick, an inbound webhook, a Nextcloud event, or a button press — Bee Flow runs a graph of steps end-to-end and logs every input/output along the way.

The same toolbox the chat assistant uses is available to automations: ~30 integrations, AI steps, generated media (image / video / audio / transcription), and a set of utility nodes for shaping data without code.

## Anatomy

```
Trigger ─▶ Step 1 ─▶ Step 2 ─▶ … ─▶ Step N
              │          │
              │          └─ each step is logged in `automation_run_steps`
              └─ outputs flow forward via refs ({{steps.step1.output.foo}})
```

Every step has a stable `id`, a `type`, an optional `label`, and a set of `inputs` bound to upstream values. The runner walks the DAG defined by `definition.edges`; branches and loops fan out from there.

## Trigger types

| Type | When it fires | Config |
|------|---------------|--------|
| `schedule` | A cron expression in the org timezone. | `schedule_cron`, `schedule_tz` |
| `webhook` | A signed POST to `/api/automation/webhook/{slug}` lands. | Create the URL and its signing secret in the trigger's Webhook panel; see [Webhook trigger format](#webhook-trigger-format). |
| `event` | A subscribed app event happens (Nextcloud event poller every 30 s, Microsoft Graph subscription, integration webhooks). | Pick the event in the builder. |
| `manual` | A user clicks "Run now" in the UI, or calls `POST /api/automation/{id}/run`. | None. |

The next-run time for cron triggers is computed by [`server/automation/cron.js`](https://github.com/Bee-Flow/beeflow). Due jobs are claimed atomically by the runner with `SELECT … FOR UPDATE SKIP LOCKED` so multiple server replicas can share the load without double-firing.

## Step types

The runner ([`server/core/automationRunner.js`](https://github.com/Bee-Flow/beeflow)) supports the following step types. Validation lives in [`server/automation/validate.js`](https://github.com/Bee-Flow/beeflow) and is the source of truth for the up-to-date list.

### Action steps

| Step type | What it does |
|-----------|--------------|
| `integration_action` | Calls a single integration tool directly (no LLM). E.g. `gmail_send`, `nextcloud_deck_create_card`, `sheets_append_rows`. |
| `ai_step` | Calls an agent or a bare model with the previous step's output as input. Optional structured output (`outputSchema`) so downstream steps can reference `output.fieldName` instead of free-text. |
| `code` | Runs JavaScript in a sandboxed worker. Useful for a quick transform between steps. |
| `http_request` | **Call a web service** — a plain HTTP call to any URL, for systems with no ready-made action in the Action list. `url`, `headers` and `body` are templates. Output is `{status, ok, headers, body, truncated, data}`: **`body` is the raw text, `data` is that same body already parsed** when the response is JSON. Bind a list to `data` — `arrayRef` and Repeat for each both require a real array, so `body` (a string) can never satisfy them. `parseResponse` decides when that happens: `auto` (default — parse when the content-type says JSON), `always` (for services that send JSON labelled as text), `never`. A response clipped at the 1 MB cap is never parsed, and a malformed body simply leaves `data` absent rather than failing the run. `blockPrivateTargets` defaults to **on** and blocks localhost, private ranges and cloud-metadata addresses. |
| `notification` | Sends one or more channels (in-app banner, Talk message, etc.). Title + body accept `{{template}}` placeholders. |

### Control flow

In the builder, branching and filtering are a single **Condition** step. Give it
one or more named rules; every rule becomes an output on the node. Whether it
decides about the whole run or about each item of a list is **detected** when you
wire it up — a Condition placed below a step that returns a list works through
that list, with the source already bound (override it under Advanced). What
happens to whatever matched no rule follows from the rule count: one rule keeps
the matches and drops the rest, several rules add an "otherwise" output.

The definition still uses the three types below — the editor picks whichever one
expresses what you described, and re-points the node's connections when the shape
changes.

| Step type | What it does |
|-----------|--------------|
| `condition` | One rule, deciding about the run. Outgoing edges labelled `then` / `else` (shown as *match* / *otherwise*). |
| `switch` | Several rules. Each case is its own outgoing edge, plus a `default`, so the canvas shows the routing visually. A case matches either by `value` (compared against the step's `expr`) or by its own boolean `expr` rule. With `arrayRef` set, the step works through a LIST: each row is offered to the rules (bound as `item`), and every rule that caught rows fires its branch carrying them at `output.matchesByCase.<case>`. |
| `loop` | Iterates over an array reference (`overRef: 'steps.x.output.items'`), running the inner body for each element. Item available as `loop.<itemVar>`. |
| `wait` | **Wait** — pauses the run for a fixed duration (up to 24h). Stored in seconds; the builder shows and accepts seconds, minutes or hours. |
| `stop_error` | **Stop with an error** — halts the run with a templated error message. Useful in a switch's `default` case to fail loudly when an unexpected value lands. |
| `slide` | **Slide** — one slide of a presentation as a *value*, never a file: a `title`, markdown `content` ("- " bullets with one level of nesting, a paragraph, a "\|" table, a "> " quote), optional speaker `notes`, an optional `image` (a Bee Flow storage URL or `data:` URL) and an optional `layout` (picked from the content when absent). **Visuals**: `chart` — `{type: column\|bar\|line\|area\|pie\|donut, data, labels?, values?, stacked?, unit?}` where `data` is a whole reference to rows (`{{steps.query.output.rows}}`), a "\|" table or "label: value" lines; columns are auto-detected (first text column = labels, every number column = a series) unless `labels`/`values` name them — one slide from a whole table, no loop needed. `stats` — KPI tiles, one per line `value \| label \| delta` (max 4). `layout: timeline` — the bullets become numbered steps ("Title — text", max 6). `style: accent\|dark` — paints this one slide for emphasis. Pure and cheap, so `forEach` is allowed: "one slide per row" is the shape it exists for. Output is `{slide}`. |
| `presentation` | **Presentation** — turns slides into a real PowerPoint (`.pptx`, default) or a PDF deck in the organisation's document house style and keeps the file like `generate_document` does. `slides` is the one input and takes three shapes: (1) the markdown outline an `ai_step` wrote (`{{steps.write.output.text}}` — "# " title once, "## " per slide, "- " bullets, `<!-- notes: … -->` for speaker notes); (2) a list of whole references to `slide` steps (`["{{steps.s1.output.slide}}", …]`); (3) the results of a `slide` step with `forEach` (`{{steps.<slide>.output.results[*].output.slide}}`). Output is `{fileId, filename, mimeType, size, format, slideCount, sourceHandle}` — no URL; a `form_page` download field, an approval attachment and `nextcloud_upload_file` with `sourceHandle:{kind:"ref",path:"steps.<id>.output.sourceHandle"}` (opens in Nextcloud Office) take it unchanged. In an `ai_step` outline, visuals are a ```` ```chart ```` block (`type: bar`, `labels: Q1, Q2`, one `Name: 1, 2` line per series — or JSON rows), `<!-- chart: bar -->` above a table, a ```` ```stats ```` block (`€ 1,2M \| Omzet \| +12%` per line), `<!-- layout: timeline -->` and `<!-- style: accent -->`. The **Look** section (`preset`, `accent`, `background`, `font`, `titleFont`, `coverStyle`, `tableStyle`, `logo` — an image URL, a `data:` URL or `none` —, `logoPlacement`, `footerText`, `slideNumbers`, `template: none` to skip the house-style template deck) overrides the house style's presentation settings for this deck only; the colours, the logo and the footer are templates, so an automation can take a client's brand from a record. Charts are native, editable PowerPoint charts coloured from the deck's palette; in the PDF deck they are drawn as vector graphics. `saveCopy` (with an optional `copyName` template) also keeps the deck in **Studio → Documents** as a presentation that opens in Bee Flow. Deleted after `expiresInDays` (default 7). |
| `generate_document` | **Make a document** — renders text from an earlier step into a real PDF or Word (`.docx`) file. `content` is a template, normally one reference such as `{{steps.ai_1.output.text}}`; markdown is rendered with its headings, bold, links, lists and tables intact. Output is `{fileId, filename, mimeType, size, format}` — deliberately no URL. To hand the file to a visitor, follow it with a `form_page` carrying a `download` field bound to `{{steps.<id>.output.fileId}}`; the form builds a link scoped to that visitor's session. The file is deleted after `expiresInDays` (1–90, default 7), so write it to Drive or Nextcloud as well if it has to be kept. PDFs render through the headless-browser container; without one the step falls back to a plainer built-in renderer rather than failing. |

### Utility nodes

These run with no LLM call and no integration tool — they exist to shape data between steps so simple workflows stay author-able by non-developers.

| Step type | What it does |
|-----------|--------------|
| `set` | **Edit data** — build an object from `{ key: bindingValue }` pairs, or work through a whole table (see below). Used to rename, default, or re-shape data. |
| `datetime` | **Date & time** — `now`, `parse`, `format`, `addDays/Hours/Minutes`, `diff`, `extract`. Single-purpose date math without leaning on the code step. Give it an `arrayRef` and it works through a whole TABLE instead: the operation runs per row with the row bound as `item` (so `input` reads `item.updated`), every row keeps the columns it already had, and the result is added as one new column. The column is named by `target`, defaulting to the `part` for `extract` (so extracting the day gives you a `day` column) and to the operation otherwise. Output is `{items, count}`. A row whose date cannot be read gets `null` there and is counted in `output.warning`; if *no* row could be read the step is recorded as **skipped** — that is the wrong column, not bad data. |
| `filter` | Drop array items that don't match a boolean expression. Reads `arrayRef`, writes `output.items`. (This is a Condition step in list mode with one rule.) |
| `flatten` | **Flatten a list**: one row for every item of a list inside a list, such as one row per attachment with its email's details. See below. |
| `limit` | **Shorten list** — take the first or last N items of an array. |
| `dedupe` | **Remove duplicates** — drop duplicates by a chosen field (or by the whole item), preserving order. A `keyField` no item carries passes everything through with a warning rather than collapsing the list. |
| `aggregate` | **Collect one field** — pluck ONE field from every item into a flat list. Reads `arrayRef` + `field`; writes `output.values` (array), `output.count`, `output.foundCount`. A field no item carries records the step as *skipped* rather than emitting a list of blanks. |
| `summarize` | **Add up or count** — `sum / count / avg / min / max` of a numeric field across items. Writes `output.result` (single scalar), `output.op`, `output.count`, `output.usedCount`. A field no item carries records the step as *skipped*, not a green `0`: a notification saying "Total: €0" is worse than no answer. |

### Flatten a list

Some lists hold a list in every item: emails with their attachments, orders with their lines. **Flatten a list** turns that into one flat table with one row per inner item, and copies the outer item's fields onto every row. It sits in the Lists group, right after Filter a list.

Example: "Search mail" then "Read many" gives 4 emails with 16 attachments each. Add Flatten a list after Read many and it fills itself in: it works through the emails, makes one row per attachment, and copies the short header fields of each email. The result is 64 rows, each with the attachment's own fields (`attachmentId`, `filename`, `mimeType`, `size`) and the email's `from`, `to`, `subject` and `date`. A Filter after it can keep only the PDFs ("Kept 8 of 64 attachments"), and "Read attachment" after that runs once per row with `messageId` and `attachmentId` mapped by name.

- **Stored as a route.** `arrayRef` is the outer list plus the inner one, e.g. `steps.read_many.output.messages[*].attachments`. Deeper routes such as `orders[*].lines[*].taxes` work too (pick them under **More options**).
- **Columns are decided when you design the step, not at run time.** The step stores which outer fields it copies and under which name (`parents[].fields`). A generic name such as `id` becomes `messageId`; a field the attachment already carries with the same value (Gmail's `messageId` and `threadId`) is not written twice; a field with the same name but a different value gets the outer item's name in front. Nothing is overwritten. Long text (`body`, `html`, anything over 1,000 characters), objects and lists of records are left out by default; **Choose fields** changes the selection.
- **Nothing disappears silently.** An email without attachments makes no row by default. The editor warns about it before the run and offers **Keep it anyway** (`keepEmpty`), which gives such an email one row with empty attachment fields. The run note says how many made no row.
- **Output** is `{ items, count, inputCount, emptyCount }`, the same `items` envelope the other list steps write, so the output table, the field picker, Filter and per-item steps work on it unchanged.
- **Size.** More outer items, or more rows, than the collection limit (10,000, or the step's lower **Max input items**) stops the step with an error that says to put a Filter or a Limit before it. Nothing is cut off silently.

The AI builder adds it with `builder_add_array_op` (`op: "flatten"`, `arrayRef` the outer list, `childField` the list inside each item, optional `keepFields` and `keepEmpty`).

### Edit data on a table (list mode)

Give an Edit data (`set`) step an `arrayRef` pointing at an upstream array and it works through the whole list instead of building one object. The builder detects this automatically when you wire it below a step that produces a list; the mode stays overridable under **Advanced**.

The presence of `arrayRef` is the platform's general "work through a list" switch — Condition, the collection ops and **Date & time** all read it the same way. In the builder you rarely set it by hand: dropping a whole COLUMN into a field (a path containing `[*]`, e.g. `steps.search.output.results[*].updated`) switches the step into list mode and rewrites the field to address the row as `item`.

- Every row gets the step's fields **added** to it, evaluated per row — the row is available as `item` (and its position as `_index`) in refs and expressions, e.g. `lower(item.email)`.
- After the per-row fields, the **table operations** run top to bottom:

| Operation | What it does |
|-----------|--------------|
| `rowId` | Number every row: `{ op: 'rowId', target: 'id', start? }` (default start 1). |
| `groupId` | Shared id for rows whose key column(s) hold equal values: `{ op: 'groupId', target, keys: ['to','subject'] }`. Case-insensitive; missing/empty cells group together; numbered 1..N in order of first appearance. |
| `rename` | Move a column: `{ op: 'rename', from, to }` (an existing `to` is overwritten). |
| `keep` / `remove` | Column projection: `{ op: 'keep'\|'remove', keys: [...] }`. |
| `sort` | Stable sort on one column: `{ op: 'sort', key, direction: 'asc'\|'desc' }`. Numbers sort numerically, text case-insensitively; missing values go last in both directions. |

The output is `{ items, count }` — the same envelope filter/limit/dedupe write, so downstream steps bind `steps.<id>.output.items` (or `items[*].<column>`).

Row rules worth knowing: rows in = rows out (dropping rows is the Filter step's job); a non-object row (a list of plain values) is wrapped as `{ value: <row> }` first; a field that resolves to nothing is written as `null`, never silently dropped; operations run in the order listed — sort **before** `rowId` numbers the sorted order, which is a feature. Column names in operations are top-level keys, like every other list step.

`operations` and the per-step `forEach` ("run once per item") cannot be combined — list mode already runs the fields per row.

## Bindings

Step inputs are not free strings — they're typed bindings so the runner knows what kind of substitution to perform. Four kinds:

| Kind | Shape | Example |
|------|-------|---------|
| `literal` | `{ kind: 'literal', value: <any> }` | Hard-coded value (`"Hello"`, `42`, `true`). |
| `ref` | `{ kind: 'ref', path: 'steps.<id>.output.foo' }` | Single dotted reference to an upstream value. |
| `template` | `{ kind: 'template', value: 'Hi {{steps.x.output.name}}!' }` | String with `{{…}}` interpolation. |
| `expr` | `{ kind: 'expr', value: 'a > 5 && b == "x"' }` | A safe expression evaluated by [`server/automation/expr.js`](https://github.com/Bee-Flow/beeflow). |

The visual builder shows refs as `‹Step Label›.foo` on the canvas instead of the raw `steps.<id>.output.foo` so non-developers can read the diagram at a glance. The raw value stays available in the inspector + on hover.

**Text matching ignores case.** `contains`, `startsWith`, `endsWith` and `includes` compare case-insensitively, and so do a switch's case values — a rule that reads "subject contains ISV" also keeps `Re: isv contract`. Use `lower()` / `upper()` when you need explicit normalisation elsewhere in an expression.

**Reading JSON text.** The expression function `parseJson(text, "path")` parses JSON text and picks a value out of it — `parseJson(steps.h1.output.body, "order.total")`, or `parseJson(item.payload, "items[*].sku")` inside a list. Invalid JSON gives `null`, never an error; already-parsed objects pass through. In the Edit data step the builder writes these for you: when upstream data contains JSON text it offers **"Pick fields from it"** with a clickable tree.

## Run lifecycle

```
pending  ─▶ running  ─▶ success
                  │
                  ├─▶ failed (non-retryable error)
                  │
                  ├─▶ awaiting (paused at an approval step)
                  │
                  └─▶ cancelled (user stopped, or supersedes flag)
```

Run row fields (`automation_runs` table):

| Field | Notes |
|-------|-------|
| `id`, `automation_id`, `version` | The version of the automation definition that ran. |
| `user_id` | Who triggered it (or system, for schedules). |
| `trigger_kind` | `schedule` / `webhook` / `event` / `manual`. |
| `trigger_payload` | The exact payload the trigger received. Available to steps as `trigger.output.<…>`. |
| `mode` | `dry_run` (test, side-effects synthesised) or `live`. |
| `status` | See diagram. |
| `started_at`, `finished_at`, `duration_ms` | Timing. |
| `error` | Error message, if any. |
| `summary` | Short LLM-generated one-liner. |
| `parent_run_id` | Set when a run was retried from a step. |
| `awaiting_step_id` | Set when paused on approval. |
| `cancel_requested` | Boolean cancellation flag. |

Step rows (`automation_run_steps`) record `step_id`, `step_type`, `attempts`, `status`, `started_at`, `finished_at`, `input_json`, `output_json`, `error`.

### Dry-run vs live

Every automation has two run modes:

- **Dry-run** — invoked from the builder's `Dry-run` button. Steps that have side-effects (tools that send / create / update / delete) are not actually invoked; instead the runner synthesises a sample output from each tool's declared output schema ([`server/automation/outputSchemas.js`](https://github.com/Bee-Flow/beeflow)) so the variable tree stays connected. Read-only tools and pure utility nodes execute for real.
- **Live** — the trigger fires the automation and every step runs end-to-end. The first live run from a draft is gated behind a one-time confirmation dialog so authors don't accidentally email customers while testing.

The side-effect map ([`server/automation/sideEffectMap.js`](https://github.com/Bee-Flow/beeflow)) is **fail-closed**: any tool that isn't on the read-only allow-list is treated as a write. New write integrations get conservative handling automatically.

## Validation flow

1. Author drafts the automation (`is_draft=true`). Saves are debounced + versioned.
2. The first time a draft runs live, the user is asked to confirm — `needs_first_run_confirm=true`.
3. Live runs honour `run_timeout_ms` (default 5 minutes, max 1 hour).
4. A reaper job resets stuck runs older than `REAPER_FLOOR_MS` (6 minutes).
5. Failed runs can be **retried from a specific step** via `resumeFromStep()`. The retry creates a child run linked via `parent_run_id`.

The validator runs on every save and surfaces issues as red/yellow chips on the affected nodes:

- Disconnected outputs (a step that nothing references and that has no outgoing edge)
- Tools the user doesn't have access to (integration not connected, or org-disabled)
- Steps with missing required config (e.g. a `loop` with no `overRef`)
- Cyclic graphs (not allowed)
- Refs pointing at step IDs that don't exist
- Switch cases that all fall through to the same branch

## The visual builder

Automations are authored in a React Flow graph at **Studio → Automations** (URL: `/app/automations`).

### Palette

The left palette lists every node type the user can use right now: a category per integration the org has enabled (and the user has connected, or has org-key access to), plus the utility / control-flow nodes. Apps the user can see but hasn't connected get an amber "Connect" chip — they're still draggable, and the inspector links to the connect flow.

Brand artwork is shared with the chat sidebar so the same Nextcloud / Gmail / GitHub / etc. logos appear in both places. A bundled brand letter-mark falls back when no SVG is registered.

### Inspector

Click a node → the right-hand inspector shows its config. Inputs render as the right widget per binding kind (text input for literals, dropdown of upstream refs for `ref`, two-line text area for `template`, expression editor for `expr`). Saves are debounced and serialised through a single in-flight request so rapid edits don't stomp each other.

### Variable tree

The inspector's variable picker shows a tree of every output produced by every preceding step. Tools advertise their shape via [`server/automation/outputSchemas.js`](https://github.com/Bee-Flow/beeflow), so even before a first run you can pick `steps.gmail_search.output.messages[0].subject` from a typed picker rather than typing the path by hand.

### AI builder assistant

A chat panel runs alongside the canvas. It exposes a small set of `builder_*` tools to a model: add a step, wire an edge, set an input binding, configure a switch case. Ask "wire an automation that classifies inbound mail and posts urgent ones in Talk" and it'll author the graph step-by-step. You confirm before anything saves.

### Run data on the canvas

Executing a step (▶) or pinning its output makes that data the working truth for
everything you do next: a node added below it auto-binds its source list from the
real rows, the variable pickers show real values instead of placeholders, and the
connection chips report what actually travelled ("10 records", or for a filter
"3 of 201 records"). Pins live in the automation itself, so they survive a reload;
the last run's results are re-fetched automatically when you reopen the builder.

### Coloured connections

Connections can carry a colour so a busy canvas reads at a glance:

- **Manual** — hover a connection and pick one of eight swatches (the "auto" dot
  clears it). The colour is saved with the automation and survives node moves,
  deletes (the bridged connection inherits it) and rule renames.
- **Branches** (the default lens) — each case of a Filter & Route node gets a
  stable automatic colour, so "pdf" and "word" leave the node as two visibly
  different lines, each with its own record count. Parallel lines to the same
  node fan apart instead of overlapping. Semantic ports (match/otherwise/on
  error) keep their fixed meaning colours.
- **PII** — when the org Privacy Shield applies to automations, builder test-runs
  scan step outputs and colour each line by the dominant PII *group* of what
  flows through it (Contact green, Financial orange, …). The chip tooltip lists
  the detected categories with counts — counts only, never values, and marked
  "approximate" for partial scans. Production runs are never slowed down for
  this: they only reuse what the Shield's own guards already detected.

The lens is per-user ("Lines: Off · Branches · PII" on the canvas); a manually
picked colour shows in every lens. The arrow next to the lens opens the **rules
panel**: every routing rule with its current colour (click to pin one — it
applies to all of that rule's connections at once) and the editable PII
group → colour legend, which is saved with the automation. During a run, colour
stays the line's identity — activity shows as a moving dash, a traversed
coloured line thickens, and only a failed step turns its line red.

## Organising the library

With nothing open, the right pane shows **All automations** — the whole library
in the shape you prefer, switched at the top right:

- **List** — one automation per row with its trigger, Live/Paused/Draft state,
  last-run outcome and next run. Click a column header to sort by it.
- **Cards** — a gallery with the description on each card, for browsing by name.
- **Board** — lanes by **status** (Live · Paused · Draft), by **trigger** kind,
  or by **folder**, so the shape of the library is visible at a glance.

The pills above the view narrow it: *Live · Paused · Draft · Failing · Running*
and, when more than one kind is in use, the trigger kind. Each pill's number is
what clicking it will show. The sidebar's filter box applies here too. The
view, sort and grouping are remembered per person; every row, card and lane
tile carries the same actions menu as the sidebar (⋮ or right-click).

The sidebar groups automations into **folders** — one level, shared across the
organisation, so everyone sees the same names. Drag an automation onto a folder to
file it, or use **Move to folder…** in its right-click menu. Which folders are
open is remembered per person; nothing about your own view leaks to colleagues.

Removing a folder **never deletes the automations in it** — they move back to
the top of the list. That is deliberate: a folder is org-wide, so it can easily
hold automations belonging to people you cannot see, and "tidy up the sidebar"
must never be a way to destroy someone else's work.

## Find repeating work

The **Find repeating work** tab (next to *All automations*, *Templates* and
*Runs*) looks at your own recent work and points out what you keep doing by
hand, so you can turn it into an automation. It only reads, it runs only when
you press **Scan my recent work**, and nothing is built without you.

### Sources

The scan reads four groups of sources over the last 90 days. Each one is a
tile you can switch off; the choice is remembered in your browser. A group with
nothing connected shows a **Connect** link instead.

| Source | Read from | Kind |
|--------|-----------|------|
| **Mail** | Gmail, Outlook, Nextcloud Mail | Live: the mailbox is read at scan time |
| **Calendar & meetings** | Teams and Google Meet imports, Nextcloud Talk recordings in Meeting Notes | History Bee Flow already keeps |
| **Files** | Nextcloud Files, OneDrive, Google Drive | Live |
| **Bee Flow activity** | The tools you called yourself in chat, and the documents you uploaded to a knowledge base | History Bee Flow already keeps |

An optional **Focus** (for example "invoices") narrows what the scan looks for.

### What is read

Only metadata, and only your own:

- **Mail**: the subject, the date, whether you received or sent it, whether it
  had an attachment, and whether it looks like a newsletter. The sender's
  domain is replaced by a pseudonym for that scan (`d1`, `d2`). Message
  bodies, previews, addresses and names are never read into the scan. Gmail is
  capped at 200 received and 200 sent messages, Outlook at 200 per folder
  (Inbox and Sent Items), Nextcloud Mail at 100 per mailbox.
- **Files**: the file name, when it appeared or changed, and a key for its
  folder that does not reveal the folder's name. Only files you created or
  changed count; folders and deletions are skipped.
- **Meetings**: a key for the meeting series, the title and how long it took.
  Meetings you chose not to import are left out.
- **Bee Flow activity**: which tool you called and when, from chats you ran
  yourself. Calls made by an automation, dry runs and the scan's own reads are
  left out. Documents count only when you uploaded them, not when a connector
  synced them.

Every subject, file name and title becomes a **template** the moment it is
read: numbers, dates, references, e-mail addresses and links turn into
placeholders (`Invoice <n> from <domain:d1>`), and the Privacy Shield's
detector masks names and organisations. When the detector is not installed,
every capitalised word that could be a name is masked instead. The raw result
is dropped right after this step. Every live read of an app goes through the
Privacy Shield's checks and is logged in the egress ledger as `pattern_scan`.

### How a pattern is found

Finding the pattern is not left to the AI. Bee Flow counts what repeats: how
often (at least 4 times, on at least 3 different days), how steadily (daily,
on weekdays, weekly, every two weeks, monthly), which steps follow each other,
and roughly how much time it takes you per month. Time is always a range, and
it says whether it was measured from your own chat sessions or estimated. With
less than two weeks of history a pattern is marked as an **early signal**.
Patterns you already automated are left out.

### What the AI sees

Only de-identified patterns: the template with its placeholders, the app ids,
the counts, the rhythm, the weekday counts, the time range and the suggested
steps. No message text, file content, name or address reaches the model, and
the request passes the [Privacy Shield](./privacy-shield.md) first. The AI only
writes a title, one sentence on why, and the prompt for the builder. Any number
it adds that the pattern does not hold is removed, and if the call fails each
pattern gets a plain title instead.

### Pattern cards

Each card shows the rhythm ("Pattern · Weekly · Mon 09–10"), how often it
happened, in how many weeks, the time it takes per month, the apps involved, a
strip with the count per weekday, the template, and a preview of the
automation (trigger, then up to three steps). **Why this ranks here** lists
the reasons behind its place in the list.

- **Build this** opens the builder and sends the pattern, so the assistant
  starts building right away.
- **Adjust first** opens the builder with the text filled in but not sent.
- **Not now** hides the pattern for 30 days.
- **Not repetitive** asks why: *These are not the same task* ranks that group
  lower next time; *I prefer to do this myself*, *This is already automated*
  and *Bee should not look at this* hide it.

Hiding can be undone for a few seconds. Feedback is stored against the
pattern itself, not against the AI's wording, so it holds on the next scan.

Results and feedback are **personal**: a colleague never sees your scan, even
in the same organisation. Only templates and numbers are stored, scans are
removed after 30 days, and deleting a user removes theirs. When a scan finds
nothing, **Suggest ideas instead** runs the older idea mode: the AI looks
through your connected apps (behind the same Privacy Shield checks) and
suggests automations. Those are marked as ideas, because nothing was measured.

## Moving an automation between installs

**Export JSON** in an automation's right-click menu downloads a portable envelope:

```json
{ "format": "beeflow.automation", "schemaVersion": 1, "exportedAt": "…",
  "automation": { "title": "…", "description": "…", "triggerType": "…", "definition": { … } } }
```

It is an allow-list copy, and what it leaves behind matters as much as what it
carries. Never exported: the row's ids, your user and organisation, the
**builder conversation** (the entire AI chat that produced the automation),
pinned step outputs (captured live data), the saved manual-trigger sample
payload, and webhook or form tokens — those are credentials, and they live in
their own tables. Saved HTTP credentials are cleared too: the id names a row in
*this* workspace's vault, so carrying it elsewhere is meaningless at best.
Every removal is reported back to you when you export.

**Import** (the ⬆ button beside `+`) always creates a **new draft** — it never
overwrites an existing automation. Step ids are re-keyed on the way in, per graph,
so importing the same file twice gives you two independent copies rather than
two documents fighting over one set of steps. Anything the file needs and this
install lacks — a missing integration, a reusable Step it calls — comes back as
a warning rather than a refusal, so you can connect what is missing and then
activate.

## Three worked examples

### 1. Inbox triage every 10 minutes

- **Trigger** — `schedule`, cron `*/10 * * * *`, tz `Europe/Amsterdam`.
- **Step 1** (`integration_action`) — `nextcloud_mail_search` for messages newer than `trigger.last_seen_at` tagged `urgent`.
- **Step 2** (`condition`) — `steps.search.output.messages.length > 0`. Else branch ends.
- **Step 3** (`ai_step`) — Inbox-Triage agent, prompt: *"Summarise these emails. Highlight any with action verbs in the subject."* `outputSchema: { summary, urgentCount, items }`.
- **Step 4** (`integration_action`) — `nextcloud_talk_send_message` to `#triage`, body: `"{{steps.ai.output.summary}}"`.

### 2. Sort an intake folder with AI

- **Trigger** — `event`, Nextcloud "file added in `/Intake`".
- **Step 1** (`ai_step`) — Document-classifier agent. `outputSchema: { type: 'invoice|contract|report|unknown', urgency: 'low|high' }`.
- **Step 2** (`switch`) — on `steps.ai.output.type`, branches: `invoice` → `nextcloud_move` to `/Facturen`; `contract` → `/Contracten`; `report` → `/Rapporten`; `default` → `/Onbekend` + a Talk notification.
- **Step 3** (in the `invoice` branch) — `condition`: `steps.ai.output.urgency == 'high'`. Then branch creates a Nextcloud task plus an in-app notification.

### 3. Daily standup digest at 09:00

- **Trigger** — `schedule`, cron `0 9 * * 1-5`.
- **Step 1** (`integration_action`) — `nextcloud_deck_list_changes` for boards in `automation.config.boards` since 18:00 yesterday.
- **Step 2** (`aggregate`) — pluck `assigneeUid` across the changes into a flat list.
- **Step 3** (`ai_step`) — Standup-Digest agent groups the list per assignee and renders Markdown.
- **Step 4** (`integration_action`) — `nextcloud_talk_send_message` to `#standup`.

### Generated-media patterns

Image, video, audio, and transcription tools all return a file URL. Wire that URL into a downstream Drive upload, Gmail attachment, Talk message, or Notification.

```
ai_step (subject)  ─▶  generate_image (prompt: subject)  ─▶  notification (body: {{steps.img.output.url}})
```

## Available actions

Every integration the chat assistant can call is also an `integration_action` step. Highlights:

- **Nextcloud** — Files, Calendar, Contacts, Deck, Talk, Tasks, Notes, Mail, Activity, Notifications, Status.
- **Google** — Gmail, Calendar, Drive, Docs, **Sheets**, **Slides**, Contacts, Keep, Groups, Maps.
- **Microsoft** — Outlook (full + read-only), Calendar, OneDrive, Contacts.
- **Generated media** — `generate_image`, `generate_video`, `elevenlabs_tts`, `elevenlabs_music`, `elevenlabs_sfx`, `transcribe_audio`.
- **DevOps & collab** — GitHub, YouTrack, SignRequest, Fireflies, Gamma.
- **Data & search** — Web Search, Knowledge-base search, Webpages.

Full list: [Integrations](../integrations/index.md).

## Webhook trigger format

A webhook trigger gets its own URL and signing secret. Create them in the
trigger's **Webhook** panel in the builder, or with
`POST /api/automation/{automationId}/webhook` (see the
[REST reference](../api/rest.md#automations)). The URL ends in a random slug,
not in the automation's id, and there is no bearer token: every request is
signed.

```http
POST /api/automation/webhook/{slug}
Content-Type: application/json
X-BeeFlow-Nonce: <a fresh random value for every request>
X-BeeFlow-Signature: sha256=<hex>

{"order":"1042","status":"paid"}
```

The signature is an HMAC-SHA256, keyed with the webhook secret, over the
nonce, a newline and the JSON body:

```text
X-BeeFlow-Signature: sha256=hex(HMAC_SHA256(secret, nonce + "\n" + body))
```

- **Sign compact JSON.** The server parses the body and checks the signature
  against `JSON.stringify(parsedBody)`, so sign the body in exactly that form:
  no spaces or line breaks, and nothing `JSON.stringify` would write
  differently (`1.0` comes back as `1`, and integer-like keys such as `"10"`
  move to the front). A pretty-printed body fails with `Bad signature`.
  Building the body with `JSON.stringify` and sending that same string, as in
  the Node.js example below, always matches. A request without a JSON body is
  checked as `{}`.
- **Use every nonce once.** A nonce is remembered per webhook for at least 24
  hours, and a repeat is refused. A random hex string per request is enough.
- **The secret is shown once**, when the webhook is created or rotated.
  Rotating (`POST /api/automation/{automationId}/webhook/{slug}/rotate`) keeps
  the URL and makes the old secret fail at once. Deleting the webhook makes
  the URL answer 404.

The **Copy as signed cURL** button next to a webhook gives this recipe with
the URL and the secret filled in and an empty `{}` body (it works while the
secret is on screen, right after you create or rotate the webhook):

```bash
BODY='{"order":"1042","status":"paid"}'
NONCE=$(openssl rand -hex 16)
SIG="sha256=$(printf '%s\n%s' "$NONCE" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-BeeFlow-Signature: $SIG" \
  -H "X-BeeFlow-Nonce: $NONCE" \
  --data "$BODY"
```

The same from Node.js:

```js
const crypto = require('node:crypto');

const body = JSON.stringify({ order: '1042', status: 'paid' });
const nonce = crypto.randomBytes(16).toString('hex');
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(`${nonce}\n${body}`).digest('hex');

await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-BeeFlow-Nonce': nonce, 'X-BeeFlow-Signature': signature },
  body,
});
```

What comes back:

| Status | `error` | Meaning |
|--------|---------|---------|
| 202 | | `{ "accepted": true, "automationId": "…" }`. The signature checked out and the run starts in the background; follow it in the automation's run history. |
| 400 | `Invalid JSON body` | The body is not valid JSON. |
| 401 | `Missing signature or nonce` | A header is missing, or the signature does not start with `sha256=`. |
| 401 | `Bad signature` | Wrong secret, or the signed text is not the compact body. |
| 401 | `Replayed nonce` | This nonce was already used on this webhook. |
| 404 | `Unknown webhook` | No webhook with this slug: never created, or deleted. |
| 409 | `Automation is not active` | The automation is a draft or switched off. |
| 413 | `Request body too large` | The body is over the server's JSON size limit. |
| 429 | `Too many requests …` | More than 120 requests a minute to one webhook, or 300 a minute from one IP address (`AUTOMATION_WEBHOOK_RPM_PER_SLUG`, `AUTOMATION_WEBHOOK_RPM_PER_IP`). A `Retry-After` header says when to try again. |

In the run, the JSON body is `trigger.output`, so a step reads the example's
order number as `{{trigger.output.order}}`. A few request headers ride along
at `trigger.headers.<name>`, lowercased with dashes turned into underscores:
`content-type` (as `trigger.headers.content_type`), `user-agent` and every
`x-*` header. `X-BeeFlow-Signature` and `X-BeeFlow-Nonce` are never passed
on.

## Tier limits

- **Pro** — up to 100 active automations per org. Min cron interval: 5 min.
- **Enterprise** — unlimited active automations. Min cron interval: 1 min. Approval steps. Webhook IP-allowlist.
- **Full** — same as Enterprise plus white-labelled webhook URLs.

## Where to next

- [Studio overview](../studio/index.md) — where automations live in the UI.
- [Integrations](../integrations/index.md) — every action a step can call.
- [API → REST reference](../api/rest.md) — programmatic creation.
- [Admin → Audit & compliance](../admin/audit-and-compliance.md) — exporting run logs.
