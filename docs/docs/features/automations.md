---
title: Automations
---

# Automations

:::info[Free in Community]

Building and running automations is free: no licence key and no cap on how many you
run. A few parts are Enterprise (approval steps, sharing, the privacy steps and the
compliance checks); see [Tiers](#tiers) below and
[Free vs paid features](../getting-started/tiers.md).

:::

Automations (also called **routines**) are trigger-based workflows. When something happens — a cron tick, an inbound webhook, a Nextcloud event, or a button press — Bee Flow runs a graph of steps end-to-end and logs every input/output along the way.

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
| `presentation` | **Presentation** — turns slides into a real PowerPoint (`.pptx`, default) or a PDF deck in the organisation's document house style and keeps the file like `generate_document` does. `slides` is the one input and takes three shapes: (1) the markdown outline an `ai_step` wrote (`{{steps.write.output.text}}` — "# " title once, "## " per slide, "- " bullets, `<!-- notes: … -->` for speaker notes); (2) a list of whole references to `slide` steps (`["{{steps.s1.output.slide}}", …]`); (3) the results of a `slide` step with `forEach` (`{{steps.<slide>.output.results[*].output.slide}}`). Output is `{fileId, filename, mimeType, size, format, slideCount, sourceHandle}` — no URL; a `form_page` download field, an approval attachment and `nextcloud_upload_file` with `sourceHandle:{kind:"ref",path:"steps.<id>.output.sourceHandle"}` (opens in Nextcloud Office) take it unchanged. In an `ai_step` outline, visuals are a ```` ```chart ```` block (`type: bar`, `labels: Q1, Q2`, one `Name: 1, 2` line per series — or JSON rows), `<!-- chart: bar -->` above a table, a ```` ```stats ```` block (`€ 1,2M \| Omzet \| +12%` per line), `<!-- layout: timeline -->` and `<!-- style: accent -->`. The **Look** section (`preset`, `accent`, `background`, `font`, `titleFont`, `coverStyle`, `tableStyle`, `logo` — an image URL, a `data:` URL or `none` —, `logoPlacement`, `footerText`, `slideNumbers`, `template: none` to skip the house-style template deck) overrides the house style's presentation settings for this deck only; the colours, the logo and the footer are templates, so a routine can take a client's brand from a record. Charts are native, editable PowerPoint charts coloured from the deck's palette; in the PDF deck they are drawn as vector graphics. `saveCopy` (with an optional `copyName` template) also keeps the deck in **Studio → Documents** as a presentation that opens in Bee Flow. Deleted after `expiresInDays` (default 7). |
| `generate_document` | **Make a document** — renders text from an earlier step into a real PDF or Word (`.docx`) file. `content` is a template, normally one reference such as `{{steps.ai_1.output.text}}`; markdown is rendered with its headings, bold, links, lists and tables intact. Output is `{fileId, filename, mimeType, size, format}` — deliberately no URL. To hand the file to a visitor, follow it with a `form_page` carrying a `download` field bound to `{{steps.<id>.output.fileId}}`; the form builds a link scoped to that visitor's session. The file is deleted after `expiresInDays` (1–90, default 7), so write it to Drive or Nextcloud as well if it has to be kept. PDFs render through the headless-browser container; without one the step falls back to a plainer built-in renderer rather than failing. |

### Utility nodes

These run with no LLM call and no integration tool — they exist to shape data between steps so simple workflows stay author-able by non-developers.

| Step type | What it does |
|-----------|--------------|
| `set` | **Edit data** — build an object from `{ key: bindingValue }` pairs, or work through a whole table (see below). Used to rename, default, or re-shape data. |
| `datetime` | **Date & time** — `now`, `parse`, `format`, `addDays/Hours/Minutes`, `diff`, `extract`. Single-purpose date math without leaning on the code step. Give it an `arrayRef` and it works through a whole TABLE instead: the operation runs per row with the row bound as `item` (so `input` reads `item.updated`), every row keeps the columns it already had, and the result is added as one new column. The column is named by `target`, defaulting to the `part` for `extract` (so extracting the day gives you a `day` column) and to the operation otherwise. Output is `{items, count}`. A row whose date cannot be read gets `null` there and is counted in `output.warning`; if *no* row could be read the step is recorded as **skipped** — that is the wrong column, not bad data. |
| `filter` | Drop array items that don't match a boolean expression. Reads `arrayRef`, writes `output.items`. (This is a Condition step in list mode with one rule.) |
| `limit` | **Shorten list** — take the first or last N items of an array. |
| `dedupe` | **Remove duplicates** — drop duplicates by a chosen field (or by the whole item), preserving order. A `keyField` no item carries passes everything through with a warning rather than collapsing the list. |
| `aggregate` | **Collect one field** — pluck ONE field from every item into a flat list. Reads `arrayRef` + `field`; writes `output.values` (array), `output.count`, `output.foundCount`. A field no item carries records the step as *skipped* rather than emitting a list of blanks. |
| `summarize` | **Add up or count** — `sum / count / avg / min / max` of a numeric field across items. Writes `output.result` (single scalar), `output.op`, `output.count`, `output.usedCount`. A field no item carries records the step as *skipped*, not a green `0`: a notification saying "Total: €0" is worse than no answer. |

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

Every routine has two run modes:

- **Dry-run** — invoked from the builder's `Dry-run` button. Steps that have side-effects (tools that send / create / update / delete) are not actually invoked; instead the runner synthesises a sample output from each tool's declared output schema ([`server/automation/outputSchemas.js`](https://github.com/Bee-Flow/beeflow)) so the variable tree stays connected. Read-only tools and pure utility nodes execute for real.
- **Live** — the trigger fires the routine and every step runs end-to-end. The first live run from a draft is gated behind a one-time confirmation dialog so authors don't accidentally email customers while testing.

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

Routines are authored in a React Flow graph at **Studio → Routines** (URL: `/app/routines`).

### Palette

The left palette lists every node type the user can use right now: a category per integration the org has enabled (and the user has connected, or has org-key access to), plus the utility / control-flow nodes. Apps the user can see but hasn't connected get an amber "Connect" chip — they're still draggable, and the inspector links to the connect flow.

Brand artwork is shared with the chat sidebar so the same Nextcloud / Gmail / GitHub / etc. logos appear in both places. A bundled brand letter-mark falls back when no SVG is registered.

### Inspector

Click a node → the right-hand inspector shows its config. Inputs render as the right widget per binding kind (text input for literals, dropdown of upstream refs for `ref`, two-line text area for `template`, expression editor for `expr`). Saves are debounced and serialised through a single in-flight request so rapid edits don't stomp each other.

### Variable tree

The inspector's variable picker shows a tree of every output produced by every preceding step. Tools advertise their shape via [`server/automation/outputSchemas.js`](https://github.com/Bee-Flow/beeflow), so even before a first run you can pick `steps.gmail_search.output.messages[0].subject` from a typed picker rather than typing the path by hand.

### AI builder assistant

A chat panel runs alongside the canvas. It exposes a small set of `builder_*` tools to a model: add a step, wire an edge, set an input binding, configure a switch case. Ask "wire a routine that classifies inbound mail and posts urgent ones in Talk" and it'll author the graph step-by-step. You confirm before anything saves.

### Run data on the canvas

Executing a step (▶) or pinning its output makes that data the working truth for
everything you do next: a node added below it auto-binds its source list from the
real rows, the variable pickers show real values instead of placeholders, and the
connection chips report what actually travelled ("10 records", or for a filter
"3 of 201 records"). Pins live in the routine itself, so they survive a reload;
the last run's results are re-fetched automatically when you reopen the builder.

### Coloured connections

Connections can carry a colour so a busy canvas reads at a glance:

- **Manual** — hover a connection and pick one of eight swatches (the "auto" dot
  clears it). The colour is saved with the routine and survives node moves,
  deletes (the bridged connection inherits it) and rule renames.
- **Branches** (the default lens) — each case of a Filter & Route node gets a
  stable automatic colour, so "pdf" and "word" leave the node as two visibly
  different lines, each with its own record count. Parallel lines to the same
  node fan apart instead of overlapping. Semantic ports (match/otherwise/on
  error) keep their fixed meaning colours.
- **PII** — when the org Privacy Shield applies to routines, builder test-runs
  scan step outputs and colour each line by the dominant PII *group* of what
  flows through it (Contact green, Financial orange, …). The chip tooltip lists
  the detected categories with counts — counts only, never values, and marked
  "approximate" for partial scans. Production runs are never slowed down for
  this: they only reuse what the Shield's own guards already detected.

The lens is per-user ("Lines: Off · Branches · PII" on the canvas); a manually
picked colour shows in every lens. The arrow next to the lens opens the **rules
panel**: every routing rule with its current colour (click to pin one — it
applies to all of that rule's connections at once) and the editable PII
group → colour legend, which is saved with the routine. During a run, colour
stays the line's identity — activity shows as a moving dash, a traversed
coloured line thickens, and only a failed step turns its line red.

## Organising the library

With nothing open, the right pane shows **All automations** — the whole library
in the shape you prefer, switched at the top right:

- **List** — one routine per row with its trigger, Live/Paused/Draft state,
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
organisation, so everyone sees the same names. Drag a routine onto a folder to
file it, or use **Move to folder…** in its right-click menu. Which folders are
open is remembered per person; nothing about your own view leaks to colleagues.

Removing a folder **never deletes the automations in it** — they move back to
the top of the list. That is deliberate: a folder is org-wide, so it can easily
hold routines belonging to people you cannot see, and "tidy up the sidebar"
must never be a way to destroy someone else's work.

## Moving an automation between installs

**Export JSON** in a routine's right-click menu downloads a portable envelope:

```json
{ "format": "beeflow.automation", "schemaVersion": 1, "exportedAt": "…",
  "automation": { "title": "…", "description": "…", "triggerType": "…", "definition": { … } } }
```

It is an allow-list copy, and what it leaves behind matters as much as what it
carries. Never exported: the row's ids, your user and organisation, the
**builder conversation** (the entire AI chat that produced the routine),
pinned step outputs (captured live data), the saved manual-trigger sample
payload, and webhook or form tokens — those are credentials, and they live in
their own tables. Saved HTTP credentials are cleared too: the id names a row in
*this* workspace's vault, so carrying it elsewhere is meaningless at best.
Every removal is reported back to you when you export.

**Import** (the ⬆ button beside `+`) always creates a **new draft** — it never
overwrites an existing routine. Step ids are re-keyed on the way in, per graph,
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
not in the routine's id, and there is no bearer token: every request is
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
| 202 | | `{ "accepted": true, "automationId": "…" }`. The signature checked out and the run starts in the background; follow it in the routine's run history. |
| 400 | `Invalid JSON body` | The body is not valid JSON. |
| 401 | `Missing signature or nonce` | A header is missing, or the signature does not start with `sha256=`. |
| 401 | `Bad signature` | Wrong secret, or the signed text is not the compact body. |
| 401 | `Replayed nonce` | This nonce was already used on this webhook. |
| 404 | `Unknown webhook` | No webhook with this slug: never created, or deleted. |
| 409 | `Automation is not active` | The routine is a draft or switched off. |
| 413 | `Request body too large` | The body is over the server's JSON size limit. |
| 429 | `Too many requests …` | More than 120 requests a minute to one webhook, or 300 a minute from one IP address (`AUTOMATION_WEBHOOK_RPM_PER_SLUG`, `AUTOMATION_WEBHOOK_RPM_PER_IP`). A `Retry-After` header says when to try again. |

In the run, the JSON body is `trigger.output`, so a step reads the example's
order number as `{{trigger.output.order}}`. A few request headers ride along
at `trigger.headers.<name>`, lowercased with dashes turned into underscores:
`content-type` (as `trigger.headers.content_type`), `user-agent` and every
`x-*` header. `X-BeeFlow-Signature` and `X-BeeFlow-Nonce` are never passed
on.

## Tiers

**Community** has the whole builder: every trigger (schedule, webhook, app event,
form, button, chat), AI steps, integration actions, logic, loops, datatables, dry runs
and run history, with no cap on the number of automations. Automations are private to
the person who builds them.

**Enterprise** adds four things on top:

| What | Licence feature |
|---|---|
| **Approval steps**: a person decides before a step acts on your behalf | `approvals` |
| **Sharing** a routine with people or groups (run, view, edit) | `automation_sharing` |
| The **Guard** and **Tokenize** privacy steps (**Untokenize**, which only puts values back, is not gated) | `automation_privacy_steps` |
| The **compliance checks** on a routine, from the Compliance Center | `compliance_hub_gdpr` |

The org-wide [Privacy Shield](privacy-shield.md) under every run is the same on both
tiers; only the steps an author places in a routine are Enterprise.

The check sits where a routine starts to act without its author watching: switching it
on, publishing a version, and the builder's test runs of a copy that is not live yet.
A refusal is a readable 403 that names each step.

When a licence lapses, what is already live keeps working. A Guard or Tokenize step in
the live version keeps running, and publishing a new version that still carries it is
allowed. Approvals that are already pending can still be decided, so the paused run
behind them completes, and the people a routine is already shared with keep their
access; removing a share always works. What a lapse refuses is new: a routine with a
new Guard or Tokenize step cannot go live, sharing further is refused, and approval
steps need the licence every time (a run that reaches one stops there with a message
saying approvals need Enterprise).

## Where to next

- [Studio overview](../studio/index.md) — where automations live in the UI.
- [Integrations](../integrations/index.md) — every action a step can call.
- [API → REST reference](../api/rest.md) — programmatic creation.
- [Admin → Audit & compliance](../admin/audit-and-compliance.md) — exporting run logs.
