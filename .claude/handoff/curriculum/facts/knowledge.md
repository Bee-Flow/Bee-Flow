# Fact sheet — Knowledge (Studio → Knowledge bases)

Audience: **builder** (someone who assembles knowledge bases and wires them into agents,
chats and routines). Everything below was read out of the code on branch
`claude/builder-redesign-fase-1-6sun0h`, 2026-09-14. UI strings are quoted from the
English defaults (`agent-hub/src/i18n/en-defaults.js`); a Dutch install shows the
translated form of the same key.

Primary code:
- Frontend: `agent-hub/src/components/admin/Studio/KnowledgeStudio/`
  (`index.jsx`, `KnowledgeOverview.jsx`, `KnowledgeDetail.jsx`, `SourcesTab.jsx`,
  `AddSourcePanel.jsx`, `SourceDetail.jsx`, `SettingsTab.jsx`, `TestQuestionCard.jsx`,
  `ScheduleMenu.jsx`, `freshness.js`, `sourceKinds.js`, `knowledgeApi.js`)
- Backend: `server/routes/knowledgeBases.js` +
  `server/routes/knowledgeBases/*.js`
- Engine: `server/core/kb/` (sources adapters, ingest privacy,
  usage, visibility), `server/jobs/kbSourceRefresh.js`
- Chunking/retrieval: `search-service/app/config.py`,
  `server/core/agentRuntime/knowledgeSearch.js`

**The area exists and is substantial** (not a stub). One caveat for lesson authors: the
brief mentions "sync sources (Nextcloud/Drive/etc)". A **Nextcloud folder source is not
buildable yet** — the button is visible but disabled with "Coming soon — this kind of
source is not available yet." There is no Google Drive / OneDrive source kind at all in the
Studio; the only Drive path is a legacy agent-designer panel that reads file text and posts
it as plain text (`useKnowledgeBases.ingestDriveFiles` → `POST /api/kb/:id/ingest/text`).

---

## 1. What the feature is for

A **knowledge base** is the material the AI is allowed to quote from. The empty state says it
best: *"A knowledge base is the material your AI may quote from: a folder, a table, a page,
meeting notes. Add sources once and they keep themselves up to date."*

You add **sources** (where content comes from); each source produces **documents**; documents
are cut into **chunks** and embedded so retrieval can find the passage that answers a
question; the answer comes back with **citations** naming the document (and page / row range /
date when known). The base is then pointed at an **agent**, a **direct chat**, or an
**AI step in a routine**.

The list deliberately answers "is this working?", not "how big is it": each row carries who
uses it and how fresh it is, and the document count is demoted to the meta line.

---

## 2. Screens, with real labels

### 2.1 Studio rail entry
- Sidebar → **Studio** → category **AI** → **Knowledge** (`studio.tab.knowledge`), description
  "Knowledge bases your AI can search". Route: `/app/studio/knowledge`.
- Studio "New" menu → **Knowledge base** → navigates to `/app/studio/knowledge/new`, which
  means *create one and open it* (there is no create form). The new base is named
  **"New knowledge base"**.

### 2.2 Overview — `/app/studio/knowledge` (`KnowledgeOverview.jsx`)
- Header: **Knowledge bases**, a status chip with the number of bases, primary button
  **+ New knowledge base** (only when the viewer has `manage_knowledge`;
  `data-tour="knowledge-create"`, `data-testid="kb-create"`).
- Category chips: **All** · *each used category* · **Uncategorised**. Chips only appear for
  categories actually in use; "Uncategorised" only when at least one base has no category.
- Search box appears **only when there are more than 4 bases**: placeholder
  "Search a knowledge base…", aria-label "Search knowledge bases by name or purpose".
- Row (grid `1fr 200px 160px`): icon + name; meta line
  `category · N sources · N documents · personal|entire organisation|groups`;
  usage pills ("3 agents", "1 skill") or the dashed warning pill **"used by nothing"**;
  freshness cell — **"updated {when}"** (green dot), **"refreshes on its own" /
  "no sources yet" / "nothing yet"** (grey dot), or red **"empty, but in use"** with an
  alert icon. **There is no failed/error verdict**: `TONE` in `freshness.js` is exactly
  `OK` / `IDLE` / `PROBLEM`, and a source whose refresh keeps failing changes nothing here —
  the timestamp simply stops moving. The error lives on that source's own row in the
  **Sources** tab (`error`, `consecutiveErrors`).

  > **Correction 2026-09-15.** The grey list above used to include **"live" / "on change" /
  > "after every meeting" / "on a schedule"**. Those per-mode sentences come from
  > `refreshModeKey()`, which `freshnessOf()` only reaches when it is handed the KB's
  > `sources`. Its single caller — `FreshnessCell` in `KnowledgeOverview.jsx` — calls
  > `freshnessOf(kb, { usageCount })` **without** sources, so the overview folds every
  > auto-refreshing base into one promise, "refreshes on its own" (from `autoRefreshCount`).
  > The mode words are real, but they belong to the **Refresh** column of the Sources tab,
  > not to this cell. The sheet's "no failed state" reading was already right and stays.
- Empty state: title **"No knowledge bases yet"**, body as quoted in §1, button
  **+ New knowledge base**.
- Search with no hits: "No knowledge base matches that."
- Suggestion banner (at most one, dismissible per person per browser):
  *"“{kb}” isn't used by anything, and “{agent}” answers with no knowledge at all."* with
  **Link them** and **Not now**.
- Errors: "Could not load your knowledge bases", "Could not create a knowledge base."

### 2.3 One knowledge base — `/app/studio/knowledge/<id>/<tab>` (`KnowledgeDetail.jsx`)
Header: back link **"Back to Knowledge"**, editable title (inline rename when you may
manage), status chip **"Updated {when}"** or **"Nothing in it yet"**, an audience capsule
(Personal / Entire organisation / Groups), and on the Sources tab the primary button
**+ Add a source** (which moves focus into the panel on the right).

Four tabs — the tab id is the third URL segment, so every tab is linkable:
1. **Sources** (`sources`)
2. **Test question** (`ask`)
3. **Settings** (`settings`)
4. **Used by** (`usage`, label key `usage.table_label`), with a count

#### Sources tab (`SourcesTab.jsx`)
- Search "Search sources…"; summary line `N sources · N documents · N refresh automatically`.
- Table columns: **Source** · **Refresh** · **Last updated** · (row menu).
- Second line per row is kind-specific: "uploaded · 12 files", "web page · 1 page" /
  "whole site · 40 pages", "columns Artikel, Prijs · 212 rows", "summary, decisions ·
  8 meetings", "pasted text · by Tessa", "filled by an automation · 4 documents",
  "imported · N documents".
- Refresh cell: **manual** / **live** / **on change** / **after every meeting** /
  **on a schedule**. Last-updated cell: relative time, **"never"**, or **"always current"**
  for a live source.
- Row menu (⋯, only with manage rights): **Refresh now** · **Rename** ·
  **Refresh schedule…** · **Open** · **Delete** (red).
- Empty: "No sources yet. Add one on the right — it keeps itself up to date from then on."
  No match: "No source matches that."
- Footer note with a shield icon: *"Whoever may see this knowledge base also sees what the AI
  quotes from it. Sources containing personal data are marked by Privacy Shield
  automatically."*
- Delete confirmation: title `Delete “{name}”?`, body *"Its {count} documents leave this
  knowledge base. The original files stay where they are."*, button **Delete**.
- **There is no "chunks" number and no "Re-index" button in Studio** — deliberately removed
  (the route still exists for operators).

#### Add a source panel (`AddSourcePanel.jsx`) — card title **"Add a source"**
Seven buttons in this order:
1. **Folder in Nextcloud** — *disabled*, tooltip "Coming soon — this kind of source is not
   available yet."
2. **Upload files** — drop zone **Choose files**, hint **"Up to 20 files, 20 MB each"**;
   oversize files are refused client-side with "Too large, so not uploaded: {names}".
3. **Table** — "Which table?" (select, placeholder "Pick a table…"), "Which columns"
   (checkboxes; all ticked when a table is picked; system columns id/created_at/updated_at/
   created_by/updated_by/deleted_at are never offered), hint *"Every column you include
   dilutes the ones that answer questions. Leave out what nobody would ask about."*,
   "Which column names the row", consequence line *"Rows you can read become searchable for
   everyone who can see this knowledge base — the table's own row permissions do not follow
   them here."*, button **Add this table**.
4. **Meeting notes** — "Which tag?" (placeholder "e.g. sales", suggestions from the org's own
   tags), "What goes in": **Summary** (always on, cannot be unticked), **Decisions**,
   **Open questions**, **Actions**; consequence *"Everyone who can see this knowledge base
   will be able to read these summaries — including people who cannot open the meetings
   themselves. Transcripts never go in."*, button **Add meetings**.
5. **Web page / URL** — "Address" (placeholder `https://example.com/terms`), checkbox
   **"Follow links on the same site"**, then "At most this many pages" (default **50**,
   min 1, max 500), button **Add source**.
6. **Paste text** — "Name" (placeholder "e.g. Frequently asked questions") and "Text";
   over the cap: "That is longer than 500,000 characters — split it into a few sources."
7. **Let an automation fill it** — spans both columns and opens an *explanation*, not a form:
   *"A routine adds itself here. Give any routine the “To knowledge base” step, point that
   step at {name}, and it appears in this list the moment the routine is saved."* plus
   *"Whatever it writes becomes an answer your agents give, with a citation — so send it
   finished text, not working notes."*, a list of routines already feeding the base
   ("passes data through · last run {when}" / "no run yet") and the button **Open Routines**.
- Without `manage_knowledge` every button is disabled with "You need "manage knowledge" to add
  a source."

#### Refresh schedule menu (`ScheduleMenu.jsx`) — title **"Refresh"**
Modes offered are only the ones the *kind* supports (server-supplied `supportsModes`):
**Only when I ask** · **On a schedule** · **When it changes** · **After every meeting** ·
**Live — always current**. Then three presets: **Every day at 06:00** (`0 6 * * *`),
**Every Monday at 06:00** (`0 6 * * 1`), **The 1st of each month at 06:00** (`0 6 1 * *`),
a "Custom schedule ({cron})" line for anything an operator PATCHed, and the footer
**"Times are in {tz}."** (the browser's zone).

#### Test question card (`TestQuestionCard.jsx`) — title **"Test question"**
Input placeholder "e.g. How long is a quote valid?", button **Ask**. Citations render
**before** the answer; then the streamed answer; then a collapsed
**"Passages found (n)"** list with a relevance bar drawn relative to the best hit and
**no percentage**. Nothing found is shown as a result, not an error: *"Nothing in this
knowledge base matched that question. That is a result: the sources here do not cover it
yet."* Footer: "This is how you check the right source is found, before an agent uses it."
The card appears twice: on the Sources tab (right column) and as the whole **Test question**
tab.

#### Settings tab (`SettingsTab.jsx`)
- **Name**; **What is in it** (textarea, placeholder *"A sentence an agent can read to decide
  whether to look here."*). Both commit on blur.
- **Where it can be used** — three toggles: **Agents**, **Chat**, **Routines**; hint *"This
  decides which pickers offer this knowledge base. It does not change who may read what is in
  it — that is below."* A toggled-off surface that still has links shows "still attached to
  {n}". Turning the last one off is refused: "A knowledge base has to be usable somewhere.
  Pick another place first."
- **Who may see and use it** — Personal / Entire organisation / Groups, hint *"An agent can
  only answer from this knowledge base for someone who may see it. Everyone else gets the same
  answer with this left out — never an error."*
  A base with no organisation shows instead **"Personal — only you can see this"** +
  **Move to my organisation** with the warning *"It stays unshared until you pick an audience
  — but administrators will be able to see and manage it, and this cannot be undone."*
- **Category** picker.
- **Make a copy** — **Empty copy** / **Copy with its sources**; hint *"Documents are never
  copied. A copied source reads its own files and pages again on its first refresh, so the
  copy gets what is there now."*
- Danger zone — **Delete this knowledge base**, notice *"Its documents go with it. The
  original files, pages and folders they were read from stay where they are."*, plus
  "This list may be incomplete — {kinds} could not be checked." when the usage scan was
  partial.

#### Used by tab
Rows for every agent / skill / routine / app that references the base; things the asker may
not see are counted but not named. Empty: *"No agent, skill or automation uses this knowledge
base yet."*

### 2.4 One source — `/app/studio/knowledge/<id>/<tab>/<sourceId>` (`SourceDetail.jsx`)
- Header: back link **"Back to {kb name}"**, editable source name, chip
  **"{total} files · {done} processed"**, and a **"Refresh: {mode}"** dropdown button.
- Filter chips with counts: **All n** · **Processed n** · **Skipped n** (amber when > 0) ·
  **With personal data n**. Search "Search a file…".
- Table columns: **File** · **What the AI took from it** · **Status** · **Changed**.
  Sub-line under the file name is "14 pages" / "3 sheets" / "1.8 MB".
- Statuses: **processing** (spinner), **processed**, **shielded** (shield icon),
  **skipped**, **failed**, **duplicate**; plus a small **not checked** badge when
  `pii_status = 'unscanned'`. The "What the AI took from it" cell falls back to the
  `status_reason` when there is no summary, and appends "· overlaps another source".
- Paging at 50 rows: "{from}–{to} of {total}", **Previous** / **Next**.
- Two footers: *"“Shielded” means personal data (name, address, IBAN) was replaced before the
  text entered the knowledge base. The AI knows the terms, not the customer."* and, when
  relevant, *"Some of these were stored without being checked for personal data — the checker
  was unavailable or the document was too large. They are checked again on the next refresh."*
- Row menu: **Delete**. Empty: "Nothing here yet."

### 2.5 Related screens outside Studio
- **Agent designer → "Can use" → Knowledge** card: rows read
  "knowledge base · 42 documents · updated yesterday"; **+ Link** opens the tool chooser at
  *From Studio › Knowledge bases*. An unreadable link stays visible with "Linked, but this
  knowledge base could not be read — so what is in it is unknown."
- **Chat composer**: a knowledge pill naming the bases the conversation is grounded on (only
  bases whose `usage_contexts` include `direct_chat`; no pill at all when `/api/kb` failed).
- **Routine builder**: step **"To knowledge base"** (`knowledge_write`) — sections
  *Where it goes* / *What to save* (Text, Title, **Source reference**) / *Advanced*
  (near-duplicate strategy: Keep what is there · Merge into one · Replace it · Add it anyway).
- Legacy agent-designer knowledge panel (`components/knowledge/KBIngestPanel.jsx`) still
  offers paste-text, URL, sitemap, file upload, n8n and Google Drive ingest against the older
  `/api/kb/:id/ingest/*` routes.

---

## 3. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Knowledge base (KB)** | A named collection the AI may quote from. It has an owner, optionally an organisation, an audience, a category, and a set of sources. |
| **Source** | *Where content comes from*: uploaded files, a pasted snippet, a web page or site, a table, a meeting tag, a routine that writes into the base, (soon) a Nextcloud folder. Eight kinds exist in code: `text`, `upload`, `webpage`, `datatable`, `meeting_tag`, `automation`, `nextcloud_folder`, `legacy`. |
| **Document** | One item produced by a source: one file, one page, one meeting, one table row (or a block of rows), one routine write. It keeps its id across refreshes, which is what keeps citations alive. |
| **Chunk** | A slice of a document (≈800 tokens with 150 tokens of overlap) that gets embedded and searched. Studio deliberately never shows chunk counts. |
| **Refresh mode** | How a source keeps itself current: manual, on a schedule, on change, after every meeting, or live. Which modes are allowed depends on the kind. |
| **Refresh (the engine)** | A diff, not a re-ingest: new → ingest, changed → re-ingest under the same id, gone → remove, unchanged → nothing. |
| **Freshness verdict** | The overview's right-hand cell, three tones only (`TONE.OK` / `IDLE` / `PROBLEM`). Priority: *problem* ("empty, but in use" — empty **and** used by something) beats *promise* ("refreshes on its own") beats *fact* ("updated 2 min ago"). There is **no failure tone**: a refresh that keeps erroring leaves the fact standing still and reports itself on the source row instead. |
| **Audience (who may see it)** | `is_published` + `shared_groups`: enforced by the server on every read, on every surface. |
| **Surface / usage context** | `usage_contexts` = which pickers offer the base (Agents / Chat / Routines). It is **not** access control, and unticking one does not detach what is already attached. |
| **Citation** | The chip under an answer naming the document, and — when known — the page, row range or meeting date. A chip with no page is normal, not broken. |
| **Privacy Shield statuses** | `pii_status` is four-valued: `none` (checked, clean), `found`, `redacted` (personal data was replaced *before* storage — irreversible), `unscanned` (could not be checked; shown as "not checked"). |
| **Duplicate vs overlap** | Identical content inside the same source → status `duplicate`. Near-identical content in *another* source → ingested anyway and annotated "overlaps another source". |
| **System-managed KB** | A base owned by Bee Flow (`source_kind = 'system_managed'`); readable by authenticated users, read-only for everyone including super admins. |
| **Personal vs organisation base** | A base with `organization_id = null` cannot be shared at all; it can be moved into an org once, never back. |
| **Test question** | A one-shot ask against a single base: no conversation, no tools, no memory — its purpose is checking *retrieval*, not the wording of the answer. |

---

## 4. End-to-end workflows (as a user clicks)

### A. Create a knowledge base and upload files
1. Sidebar → **Studio** → **Knowledge** (or go to `/app/studio/knowledge`).
2. Click **+ New knowledge base**. A base called "New knowledge base" is created and opened on
   the **Sources** tab.
3. Click the title in the header and type the real name (e.g. "Inkoopvoorwaarden"), Enter.
4. Open the **Settings** tab, fill **What is in it** with one sentence an agent can read, and
   click away (it saves on blur). Return to **Sources**.
5. In **Add a source**, click **Upload files** → **Choose files**, pick up to 20 files of
   20 MB or less.
6. The files land in an **"Uploaded files"** source (the oldest upload source is reused, never
   a second one). Click that row to open it.
7. Watch the rows flip from **processing** to **processed** / **shielded** (the list polls
   every 3 s). Check the **Skipped** chip for anything that failed and read its reason in the
   "What the AI took from it" column.

### B. Add a web page / whole site and give it a schedule
1. On the base's **Sources** tab, click **Web page / URL** in **Add a source**.
2. Type the address (must start with `http://` or `https://`).
3. Tick **Follow links on the same site** and set **At most this many pages** (default 50,
   max 500) if you want the whole site.
4. Click **Add source**. The entry page is fetched immediately; the rest of the crawl is left
   to the refresh engine.
5. Open the row's **⋯ → Refresh schedule…**, choose **On a schedule**, then a preset
   (e.g. **Every Monday at 06:00**). The footer confirms the time zone.
6. The Refresh column now reads "on a schedule" and the base's freshness cell can promise it.
7. To check it now: **⋯ → Refresh now** (this only sets the source due; the engine picks it up
   within a minute).

### C. Test retrieval before pointing an agent at it
1. Open the base → **Test question** tab (or use the card on the right of **Sources**).
2. Type a question a colleague would really ask ("How long is a quote valid?") → **Ask**.
3. Read the **citation chips first** — they arrive before the answer. Are these the documents
   you expected?
4. Expand **"Passages found (n)"** and compare the bars against each other (there is no
   percentage on purpose).
5. If you get *"Nothing in this knowledge base matched that question"*, that is a retrieval
   result: add or narrow the source, or rephrase the question the way users will.

### D. Attach the base to an agent and share it with the right people
1. Open the base → **Settings**.
2. Under **Where it can be used**, make sure **Agents** is ticked.
3. Under **Who may see and use it**, choose **Entire organisation** or pick the groups. (A
   personal base must first be moved with **Move to my organisation**.)
4. Go to Studio → Agents → the agent → tab **Can use** → **Knowledge** card → **+ Link** →
   *From Studio › Knowledge bases* → tick the base.
5. Save the agent, then ask it the same question you used in the test question — the answer
   should carry the same citations.
6. Back in the base, the **Used by** tab now lists the agent, and the overview row shows a
   "1 agent" pill instead of "used by nothing".

### E. Put a table in a knowledge base
1. Base → **Sources** → **Add a source** → **Table**.
2. **Which table?** pick one you can read (only tables you may open are offered).
3. **Which columns** — untick everything nobody would ask about; the hint warns that extra
   columns dilute the ones that answer questions.
4. **Which column names the row** — choose the human label (article name, customer name).
5. Read the consequence line, then click **Add this table**.
6. Open the new source's **⋯ → Refresh schedule…** and choose **Live — always current** (a new
   source starts on **Only when I ask**).
7. In the Sources list the row now reads "columns … · N rows" and its Last-updated cell says
   **"always current"**.

### F. Let a routine fill the base
1. Base → **Sources** → **Add a source** → **Let an automation fill it** → read the panel →
   **Open Routines**.
2. In the routine builder add the step **To knowledge base**.
3. *Where it goes*: pick the knowledge base.
4. *What to save*: **Text** (usually `{{steps.ai_1.output.text}}`), **Title**, and a
   **Source reference** that is stable per subject (e.g. `ticket:{{trigger.output.id}}`) so
   the next run replaces the document instead of adding another.
5. *Advanced*: pick the near-duplicate strategy if needed.
6. Save the routine. Go back to the base's **Sources** tab: a source named after the routine
   appears immediately (before the first run), and the automation panel lists it with
   "no run yet".
7. After the first run the row shows "filled by an automation · N documents".

---

## 5. Defaults, limits and numbers

Upload / paste / crawl (server `routes/knowledgeBases/sources.js`, mirrored in
`AddSourcePanel.jsx`):
- **20 files per upload**, **20 MB per file** (413 `file_too_large`, 400 `too_many_files`).
- Pasted text: **min 3 characters**, **max 500,000 characters** (400 `text_too_long`).
- Crawl: UI default **50 pages**, hard cap **500** (server clamps).
- Document lists: default page **50**, max **200** per request; the Source detail UI pages at
  **50** and polls every **3 s** while anything is processing.
- Source name and document title are truncated at **200 characters**.

Refresh engine (`server/jobs/kbSourceRefresh.js`, `server/core/kb/sources/index.js`):
- Tick every **60 s**, first tick **50 s** after boot; **20 sources per tick**, **3 at a
  time**, **45 s budget per source**, **500 items per pass**; a source stuck in `refreshing`
  for **15 min** is reaped. Cron granularity is a minute.
- Default cadence when a schedule names none: **24 h**; hard floor **15 min**.
- Document versions pruned to **3 per document / 30 days**.
- Errors widen the gap between attempts (`consecutiveErrors` back-off).

Per-kind refresh modes (`REFRESH_MODES_BY_KIND`):

| Kind | Modes | Adapter default | What a source created in Studio actually gets |
|---|---|---|---|
| `upload` | manual | manual | manual |
| `text` | manual | manual | manual |
| `webpage` | manual, schedule | manual | **manual** |
| `datatable` | manual, schedule, live | live | **manual** (you must pick "Live") |
| `meeting_tag` | manual, after_meeting | after_meeting | **manual** (you must pick it) |
| `nextcloud_folder` | manual, schedule, on_change | — | not creatable yet |
| `automation`, `legacy` | manual | manual | manual |

Source-specific caps:
- Table: **one document per row up to 5,000 rows**, above that rows are grouped **50 per
  document**; **5,000 rows** per pass ungrouped, **50,000** grouped.
- Meeting tag: at most **500 meetings**; fields `summary`, `decisions`, `questions`,
  `actions`, default `summary` + `decisions`; **transcripts are never included**.
- Routine write step: **200,000 characters** of text, title **200 characters**.

Chunking and retrieval (`search-service/app/config.py`,
`server/core/agentRuntime/knowledgeSearch.js`):
- Chunks **800 tokens** with **150 tokens** overlap; embedding model default
  `Qwen/Qwen3-Embedding-4B` (1024 dims), reranker `BAAI/bge-reranker-v2-m3`.
- Search-service defaults: 20 vector + 20 full-text candidates → **5 final**; minimum score
  **0.40**; KB query cache **120 s**.
- Agent path: keeps **3–10 passages**; floor **0.72** when a (calibrated) reranker is
  configured, **0.01** otherwise; Jaccard dedup at **0.85**; per-chunk cap **800 tokens**
  (`KB_PER_CHUNK_TOKENS`), total injection **4,000 tokens** (`KB_INJECT_TOKENS`); greetings
  never trigger a lookup.
- Test question: **8 passages**, question truncated at **2,000 characters**, passage text
  capped at **4,000 characters**.

---

## 6. What happens on failure

- **A file that will not extract** → the document row stays, status **failed** with a
  human reason in the "What the AI took from it" column. (Before the source model such files
  vanished silently — this visibility is the point of the status column.)
- **A file queued but not yet processed** → status **processing** (stored internally as
  `skipped` + reason "Queued for processing"); the list polls until it settles.
- **Identical file already in this source** → status **duplicate**, nothing re-embedded.
- **Near-identical content in another source** → ingested, annotated "overlaps another source".
- **Personal data** → `redacted`/**shielded** (replaced *before* storage — cannot be undone,
  there is no copy of the original), or `found`, or **skipped** when the org's shield says
  block / fail-closed, or **unscanned** + "not checked" when the checker was unavailable or
  the file was too big. Unscanned documents are re-checked on the next refresh.
- **A URL that cannot be fetched** → 400 `url_rejected` ("That address cannot be fetched from
  here.") for private/loopback/metadata addresses and non-HTTP schemes, or 502 `fetch_failed`
  ("That page could not be reached."). Both the immediate fetch and every scheduled refresh go
  through the same SSRF guard, including redirects.
- **A source kind that is not built yet** → 400 `kind_not_available`; the UI disables those
  buttons so you should never see it.
- **Plan cap on sources** → 403 `source_limit_reached` with `limit`, shown as "This knowledge
  base already has the most sources your plan allows ({limit})." (Today every tier is
  uncapped, see §7.)
- **A source refresh that dies mid-pass** → the row is reaped after 15 minutes and retried;
  errors bump `consecutiveErrors`, which widens the retry gap, and the source row carries the
  error.
- **A whole pass that runs out of time** → what is done is kept, the source stays due and the
  next tick continues.
- **Categories / usage summary / suggestions failing** → chrome only: chips or pills go
  missing, the list still renders. A sources failure does not blank the base header or the
  other tabs.
- **A retrieval failure during the test question** → 502 "Could not search this knowledge base
  right now." — distinct from the (successful) "Nothing … matched that question."
- **Deleting a base that things depend on** → the danger zone shows what would break, and says
  when the list is incomplete ("{kinds} could not be checked").
- **A person without access asking an agent** → the agent answers *without* that base. Never
  an error, never a leak.

---

## 7. Permission and licence gates

- Frontend: every management affordance is behind `hasPermission('manage_knowledge')`
  (`canManage` in `KnowledgeStudio/index.jsx`). Without it the Studio is read-only: no
  create button, no ⋯ menus, no add-source forms (buttons disabled with "You need
  "manage knowledge" to add a source."), no rename, no danger zone.
- Backend: `requireAuth` on every route (session cookie; 401 `Not authenticated` otherwise)
  plus `requirePermission('manage_knowledge')` on every mutation (403
  `Permission 'manage_knowledge' required`). Reads are additionally filtered by
  `canAccessKB`; mutations by `canManageKB` (owner, or same-org holder of
  `manage_knowledge`/org admin) and `blockIfSystemKB` (403 "System-managed knowledge bases are
  read-only").
- `server/config/orgRoles.json`: `manage_knowledge` is granted to **org_admin**,
  **agent_admin** and **agent_editor**. **member** does *not* have it (members can read bases
  shared with them and use them in chat, but cannot create or edit).
- Special cases: only the **owner** may move a personal base into an organisation (403
  otherwise); publishing (`PATCH /:id/publish`) is allowed for the owner and otherwise needs
  same-org `manage_knowledge`; a base with no organisation cannot be published at all.
- Licence: `server/license/featureMap.js` records `/api/kb` as
  *"Knowledge base is community-tier; max_kb_sources limit enforces caps"* — there is **no
  `requireLicenseFeature` on the KB routes**. The only licence lever is the limit
  `max_kb_sources`, which in `server/license/tiers.js` is **-1 (uncapped) on community,
  enterprise and full** today. If the licence store cannot be reached the code falls back to
  the *community* limit, never to "unlimited".
- Mutations are also blocked when the caller's organisation is suspended/archived
  (`requireActiveOrgForMutations`); reads pass through.

---

## 8. How it connects to the rest of the product

- **Agents** — `config.knowledge_base_ids`; surface `agent`. Agent-level switches
  `strictKnowledge` ("only answer from knowledge") and `includeSourceReferences` (citations in
  the answer) live in the agent, not in the base.
- **Direct chat** — surface `direct_chat`; the composer pill names the grounded bases; access
  is re-evaluated server-side on every message.
- **Routines** — surface `ai_step` for grounding an AI step, and the **To knowledge base**
  (`knowledge_write`) step for writing. A write step creates/renames an `automation` source at
  save time; removing the step renames the source rather than deleting its documents. A dry run
  writes nothing. Secrets are stripped before anything is written.
- **Datatables** — a `datatable` source; the table's **Used by** then names the knowledge base,
  and deleting the table asks first.
- **Meeting notes / transcriptions** — a `meeting_tag` source pulls the summary fields of every
  meeting carrying a tag; a single transcript line can also be filed as a `text` source that
  stays linked to that meeting.
- **Privacy Shield / DLP** — `core/kb/ingestPrivacy.js` runs the same scanner as the chat
  attachment path, with the token map thrown away; the org setting is
  `privacy_scan_knowledge_bases`.
- **Search-service** — does the chunking, embedding and hybrid search; the reranker service
  calibrates scores.
- **Notebooks / web pages / support** — auto-created bases (`source_kind` `webpage_auto`,
  `notebook_auto`) exist but are hidden from the Studio list unless `?includeAuto=1`.
- **Mobile + marketplace** read the same `/api/kb` rows (snake_case fields are kept for them).

---

## 9. Common mistakes

1. **Confusing "Where it can be used" with "Who may see it."** Unticking *Agents* only removes
   the base from pickers; already-attached agents keep it, and nobody loses read access.
2. **Expecting a new source to refresh itself.** Every source created in the Studio starts on
   **Only when I ask** — a table is not live and a meeting tag does not follow meetings until
   you open **Refresh schedule…** and pick the mode.
3. **Expecting "Refresh now" to work instantly.** It only marks the source due; the engine
   runs every 60 s, 20 sources per tick.
4. **Expecting a whole-site crawl to appear immediately.** Only the entry page is fetched when
   the source is created; the rest arrives on the first refresh pass (max 500 pages, 500 items
   per pass).
5. **Building a personal base and then trying to share it.** Publishing is refused; you must
   **Move to my organisation** first, which is one-way and hands admins management rights.
6. **Ticking every column of a table.** The form warns that each extra column dilutes the ones
   that answer questions — and row-level permissions of the table do *not* follow the rows into
   the base.
7. **Assuming a meeting-notes source respects the meeting's own sharing.** It does not: whoever
   may see the knowledge base can read those summaries.
8. **Treating "shielded" as reversible.** The redacted text *is* what is stored; re-indexing
   will not bring the original back.
9. **Reading "used by nothing" as fact while the usage summary has not loaded.** The cell stays
   empty when unknown — an empty cell and the dashed pill mean different things.
10. **Writing working notes from a routine.** Whatever `knowledge_write` stores is quoted back
    as fact with a citation; and without a **Source reference** every run adds another
    document.
11. **Deleting a source to "clean up".** Its documents leave the base with it (the originals
    stay where they were), and any citation pointing at them dies.
12. **Reading the overview's "N sources" as gospel.** `GET /api/kb` returns document counts but
    no source count in the code as it stands (the decorator that adds `sourceCount` is not
    wired into the list route), so the meta line can read "0 sources" for a base that has
    several. The **Sources** tab (`GET /api/kb/:id/sources`) is the reliable count.
13. **Trusting an empty Test question result on an install without a calibrated reranker.**
    `quickKBSearch` applies a hard 0.72 floor, while the agent path drops its floor to 0.01
    when no reranker is configured — so the test card can say "nothing matched" where an agent
    would still find passages.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

**Procurement — "Inkoopvoorwaarden & leveranciers"**
Sandra (inkoop, role *Agent Editor*) creates the base **Inkoopvoorwaarden**, uploads the
general terms, three supplier framework agreements and the ISO certificate (5 PDFs, all under
20 MB). She adds a **Table** source on the datatable *Leveranciers* with the columns
`Leverancier, Contactpersoon, Levertijd, Prijsafspraak`, names rows by `Leverancier`, and sets
that source to **Live — always current**. She adds a **Web page / URL** source for the
supplier's public terms page with **Follow links on the same site**, max 20 pages, on **Every
Monday at 06:00**. Test question: *"Wat is de levertijd van Bakker Staal?"* — the chips must
name the table row, not the PDF. Then she links the base to the agent *Inkoopassistent* and
shares it with the group *Inkoop*. Teaching points: live table vs scheduled page, column
selection, citations naming a row.

**HR — "Personeelshandboek"**
Mark (HR, *Agent Admin*) creates **Personeelshandboek**, uploads the handbook, the leave policy
and the expenses scheme. Two documents come back **shielded** because the expenses scheme
contained names and IBANs — he reads the shield banner and accepts that the agent knows the
terms, not the colleague. One scan comes back **not checked** (the guard was busy); he presses
**Refresh now** on that source the next day and the badge is gone. He adds a **Paste text**
source "Veelgestelde vragen HR" with the ten questions the HR mailbox gets weekly. Audience:
**Entire organisation**; surfaces: **Agents** + **Chat**, *Routines* off. He verifies with the
test question *"Hoeveel vakantiedagen bouw ik op?"* and checks that the citation points at the
leave policy and not at an old memo. Teaching points: Privacy Shield statuses, audience vs
surface, why a base everyone can query must not contain a payroll export.

**Sales — "Offertes & klantafspraken"**
Ilse (sales) creates **Offertes & klantafspraken**. She adds a **Meeting notes** source on the
tag `sales` with **Summary** and **Decisions** ticked (transcripts are never included), reads
the consequence line, and sets the mode to **After every meeting**. She adds a routine
*Weekly deal digest* with a **To knowledge base** step writing the weekly summary with source
reference `deal:{{trigger.output.id}}` so each deal keeps one document instead of fifty. The
base's **Sources** list shows the routine as an automation source with "no run yet" before
Monday. Audience: group *Sales*. Test question: *"Wat hebben we met Jansen BV afgesproken over
levertermijn?"*, and the citation chip shows the meeting date. Teaching points: the meeting
source widens who can read a summary; source references stop document sprawl; a routine source
appears before its first run.

---

## 11. List/read API endpoints a "did the learner do it?" check can call

All under `/api/kb` (router `server/routes/knowledgeBases.js`). Auth for every one below is
`requireAuth` = an authenticated **session cookie** (401 `{"error":"Not authenticated"}`
otherwise). Reads need no permission beyond visibility (`canAccessKB`); 403 `Access denied`
when the base is not visible, 404 when it does not exist.

| Method + path | What it returns |
|---|---|
| `GET /api/kb` | **Array** of KB rows the caller can see. Row = the `knowledge_bases` row: `id`, `name`, `description`, **`tenant_id` (the owner's user id)**, `organization_id`, `category_id`, `icon`, `is_published`, `shared_groups`, `usage_contexts`, `source_kind` (`manual` unless `?includeAuto=1`), `system_slug`, `last_content_at`, `created_at`, `updated_at`, plus aggregates `document_count`, `document_count_all`, `total_chunks`. Query: `?context=agent|direct_chat|ai_step`, `?includeAuto=1`. |
| `GET /api/kb/published` | Same shape, only `is_published = true`. |
| `GET /api/kb/:id` | One KB + `documents` (projected, **no bodies**) + `total_chunks`, `document_count`, `document_count_all`, `documentCount`, `totalChunks`, `sourceCount`, `lastContentAt`. Owner = `tenant_id`. |
| `GET /api/kb/categories` | Array of `{id, organization_id, name, icon, color}`. |
| `GET /api/kb/:id/sources` | `{ sources: [...], totals: {...} }`. Source row: `id`, `kind`, `name`, `config` (allow-listed per kind), `refreshMode`, `refreshLabelKey`, `refreshCron`, `refreshTz`, `supportsModes`, `nextRefreshAt`, `lastRefreshAt`, `status`, `error`, `consecutiveErrors`, `documentCount`, `processedCount`, `redactedCount`, `skippedCount`, `errorCount`, `duplicateCount`, `piiFoundCount`, `totalChunks`, **`createdBy: {id, name}`**, `createdAt`, `updatedAt`. `totals` = `sourceCount`, `autoRefreshCount`, `errorSourceCount` + the summed counters. |
| `GET /api/kb/:id/sources/:sid/documents` | `{ documents, total, limit, offset }`; `?limit` (default 50, max 200), `?offset`, `?status=processed,redacted`, `?pii=found`, `?q=`. Document row: `id`, `title`, `source_type`, `source_uri`, `chunk_count`, `status`, `status_reason`, `source_id`, `size_bytes`, `page_count`, `sheet_count`, `mime`, `extract_summary`, `pii_status`, `pii_categories`, `overlaps_document_id`, **`created_by`**, `created_at`, `updated_at`, `source_modified_at`, `external_id`. Never `original_content`. |
| `GET /api/kb/:id/sources/:sid/documents/:docId` | `{ document }` — same projection, 404 when the doc is not in that source. |
| `GET /api/kb/:id/documents` | `{ documents, total, limit, offset }` KB-wide, same filters plus `sourceId`, `sourceType`, and the email filters `sender`/`threadId`/`hasAttachment`/`dateFrom`/`dateTo`. |
| `GET /api/kb/:id/documents/:docId/content` | `{ document: {id,title,source_type,source_uri,status,chunk_count,page_count}, content, remote_only }` — the only route that returns a body. |
| `GET /api/kb/:id/documents/:docId/chunks` | The document's chunks (admin/debug/mobile; Studio never calls it). |
| `GET /api/kb/:id/usage` | `{ usage: [{kind, role, title, ownerId, foreign?}], unchecked: [kinds] }` — what depends on this base. Rows the asker may not see keep their kind/role but lose the title. |
| `GET /api/kb/usage-summary` | `{ summary: { <kbId>: { counts: {agent: n, …}, partial: [] } } }` for every base the caller can see. |
| `GET /api/kb/suggestions` | `{ suggestions: [{kbId, kbName, agentId, agentName, score}] }`. |
| `GET /api/kb/favorites` | The caller's favourite KB ids. |
| `GET /api/kb/system` | System-managed bases available to the caller. |
| `GET /api/kb/:id/threads`, `GET /api/kb/:id/threads/:threadId/documents` | Email-thread grouping for mail-sourced documents. |

Useful verification recipes:
- *"Did they create a base named X?"* → `GET /api/kb`, match `name`, and `tenant_id` against
  the learner's user id.
- *"Did they add a source of kind Y?"* → `GET /api/kb/:id/sources`, look for
  `kind === 'webpage'|'upload'|'text'|'datatable'|'meeting_tag'` and `createdBy.id`.
- *"Did they schedule it?"* → same row: `refreshMode !== 'manual'` (+ `refreshCron`,
  `nextRefreshAt`).
- *"Did the files actually process?"* → `GET /api/kb/:id/sources/:sid/documents?status=processed,redacted`
  and compare `total` with the source's `documentCount`.
- *"Did they share it?"* → `GET /api/kb/:id`: `is_published` / `shared_groups` /
  `organization_id`.
- *"Did they attach it to an agent?"* → `GET /api/kb/:id/usage` (rows with `kind: 'agent'`), or
  `GET /api/agents/:id` and check `config.knowledge_base_ids`.

Non-read routes that exist (for completeness, not for verification): `POST /api/kb`,
`PATCH /api/kb/:id`, `PATCH /api/kb/:id/publish`, `DELETE /api/kb/:id`,
`POST /api/kb/:id/duplicate?withSources=1`, `POST /api/kb/:id/ask` (SSE),
`POST|DELETE /api/kb/categories[/:id]`, `POST /api/kb/:id/sources`,
`POST /api/kb/:id/sources/:sid/files`, `PATCH|DELETE /api/kb/:id/sources/:sid`,
`POST /api/kb/:id/sources/:sid/refresh`, `POST /api/kb/:id/documents/bulk-delete`,
`DELETE /api/kb/:id/documents/:docId`, `POST /api/kb/search`, `POST /api/kb/:id/reindex`,
`POST /api/kb/:id/ingest/{text,file,url,sitemap,n8n}`, `PUT|DELETE /api/kb/:id/favorite`.
