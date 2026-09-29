# Fact sheet — Search & Research (audience: everyday users)

Repo: the repo root · verified against source on 2026-09-14 (branch `claude/builder-redesign-fase-1-6sun0h`).
Everything below was read in the code. Where a label is quoted it is the literal English default string
(`t('key', 'English default')`) from `agent-hub/src/...` or `agent-hub/src/i18n/en-defaults.js`.

---

## 0. Does this area exist? — YES, but it is not one page

There is **no "Research" page, no "Search" menu item, and no `/app/search`**. "Search & research" in Bee Flow is
a set of capabilities that live **inside chat**, plus one document workspace (**Notebooks**).

Verified to exist:

| Surface | Where | Status |
|---|---|---|
| **Web search** (`agent_search` tool) | Chat composer → "+" → **Web search** toggle | Real, on by default |
| **Browse Web** (`browse_web` tool) | No user toggle in the composer — the model calls it; a live browser thumbnail appears in the message | Real |
| **Swarm / "Deep Research"** (`builtin:research_swarm`) | Chat model-tier picker → **Swarm** tier | Real, **beta + licence gated** |
| **Notebooks** (`/app/notebooks`, `/app/notebooks/:id`) | Sidebar → **Notebooks** | Real, **Enterprise licence + `use_notebooks` permission** |
| **Knowledge Bases** (grounding a chat on your own documents) | Chat composer → **Knowledge** pill; sidebar → **Knowledge Bases** | Real |
| **Projects** (`/app/projects`) | Sidebar → **Projects** | Real, but it is a *collaboration* workspace (Chats / Content / Knowledge / Members), **not** a research tool. Enterprise. |
| **Templates** (`/app/templates`) | Sidebar → **Templates** | Real, but it is **document assembly** (.docx with `{{parameters}}` filled by AI), not research. |
| "Deep research report" rendering | Any chat message containing a ```` ```json-research ```` fenced block renders as a rich report (hero / stats / callouts / sources) | Real, but it is a *rendering* feature — no button starts it |

Not found anywhere: a saved-searches list, a research history page, a "citations library", a
`/app/research` route, a Perplexity-style search box.

---

## 1. What the feature is for

Bee Flow is a privacy-first workspace. Its research story has three layers, and a learner must be able to
tell them apart because **they have different privacy consequences**:

1. **Web search** — the assistant types a short query into an outside search engine, gets pages back, and
   cites them. Data leaves the organisation (the query goes to Serper/Google or Bing, or to the self-hosted
   Agent Search service, depending on how the admin configured it).
2. **Browse Web** — the assistant opens an actual headless browser, navigates, clicks, scrolls, reads, and
   answers from what it saw. Used when you already *have* a URL, when a page is JavaScript-rendered, or
   when the URL is a PDF.
3. **Your own documents** — Knowledge Bases (`kb_search`) and Notebook **Sources**. Nothing leaves the box.

Notebooks is the "sit down and write something out of sources" workspace: upload PDFs/URLs/pasted text/meeting
notes on the left, a rich-text document in the middle, an AI chat grounded on those sources on the right.

---

## 2. Screens, with their real labels

### 2.1 Chat composer — the "+" (Message tools) menu
File: `agent-hub/src/components/chat/InputArea.jsx`, `components/chat/ComposerToolsMenu`.

- Menu trigger aria-label: **"Message tools"** (`chat.composer.tools_menu`).
- Rows (group `add`): **"Add photos & files"**, **"Create image, music, video"**.
- Row (group `reach`): **"Apps"** — hint **"What this chat may reach — Drive, Gmail, and the rest"**.
- Row (group `mode`): **"Web search"** (globe icon, a *toggle* with a dot when on).
  - hint when available: **"Let this turn look things up online"**
  - hint + disabled when blocked: **"Web search disabled by organisation policy (files attached)"**
- Row (group `mode`): **"Memory"** — "Saving new memories from this chat" / "Memory saving paused".
- Row (group `mode`, beta): **"Voice mode"**.

The **Web search** row only renders when: the agent does not set `disableExternalTools`, the admin's
`search_provider` is not `disabled`, and the org's integration list includes `agent-search`.

### 2.2 Chat composer — pills beside the box
- **Knowledge** pill (`chat.composer.kb` = "Knowledge"), title **"What this chat is grounded on"** /
  **"Grounded on {names}"**. One attached base is named outright; two or more show the word "Knowledge".
- Picker panel: title **"Knowledge bases"**, hint **"Pick one or more to ground this chat."**,
  search **"Search…"**, empty state **"No knowledge bases available. Create one in the Knowledge Bases section."**,
  no-match **"No matches."**, badges **"Personal"** / **"Org"**.
- Tier pill / tier gauge: **Auto**, **Fast**, **Flow** (beta), **Swarm** (beta), **Think**, **Write**,
  **Deep Thinking**. Swarm's subtitle is **"Parallel agents, synthesised answer"**.

### 2.3 Chat composer — Apps panel
Header **"Apps"**, a counter **"{n}/{m} active"**, hint **"Click to use · Toggle to enable/disable"**,
search **"Search apps..."**, empty **"No apps found"**. One row is **"Web Search"** — description
**"Search the web"**. (See Pitfalls: this toggle does *not* actually switch web search off.)

### 2.4 While the answer is being produced
File: `components/chat/MessageItem/ActivityIndicator.jsx`.
One live line, priority order: running tool → pre-LLM phase → last finished tool → "Thinking…".

- Tool labels come from `utils/helpers.getToolLabel()`. `agent_search` is **not** in `TOOL_NAME_MAP`, so it
  renders as the prettified name **"Agent Search"** with a 🔍; `browse_web` renders as **"Browse Web"**.
- Phase lines (`chat.phase.*`): "Selecting best model…", "Using {model}", **"Loading tools…"**,
  "Recalling memory…", **"Searching knowledge base…"**, "Reading attachment {n}…",
  "Compacting conversation…", "Preparing context…", "Validating input…",
  **"Protecting your data…"**, "Checking tool plan…", "Loading history…", "Thinking…".

### 2.5 Live browser preview (browse_web)
File: `components/chat/MessageItem/BrowserLivePreview.jsx`. A thumbnail strip inside the assistant message,
max width 620 px, refreshed with streamed JPEG frames.
- Header: the URL, or the task, or **"Browsing…"**; when finished a small **"done"**.
- Before the first frame: **"Opening the browser…"**.
- When queued: **"Waiting for an available browser session…"** or
  **"Waiting for an available browser session ({position} ahead)…"**.
- Image alt: **"Live browser preview"**. A footer line shows the current action while running.

### 2.6 "How I got this answer"
File: `components/chat/MessageItem/HowIGotThisAnswer.jsx`. A collapsible strip under the answer.
- Label: **"How I got this answer"**.
- Summary: **"{n} tools"** / "1 tool", optionally **" · {seconds}s"**, and **"Auto → {tier}"** when the
  Auto tier routed the turn.
- Below it, `KbSourcesPanel` lists knowledge-base passages ("Unknown Source", "Chunk {n}", "p. {page}").
- `AnswerChips` shows source chips; the code is explicit that chips are either **recorded** (the server
  wrote an event) or **Judged** (a second model's opinion afterwards) and must never look alike
  (`MessageItem/answerChips.js`). Max 6 chips per grade.

### 2.7 Swarm timeline (beta)
File: `components/chat/MessageItem/SwarmTimeline.jsx`.
- Name: **"Swarm"** (`chat.msg.swarm_default_name`) — the built-in is **"Research Swarm"**.
- Progress: **"Phase {current} of {total} · workers running in parallel"**; when done
  **"Completed {done}/{total} phases"** + optionally **" · {n} worker failures"**.
- Worker rows: **"Working…"**, **" · {n} tool calls"**.
- Phases of the built-in swarm: **"Researching"** (three workers) then **"Writing"** (one writer).

### 2.8 Notebooks overview (`/app/notebooks`)
File: `agent-hub/src/pages/notebooks/overview/*`.
- Title **"Notebooks"**; subtitle **"Upload sources, chat with your documents, and generate content"**.
- Primary button **"New notebook"**; the modal is titled **"New notebook"** with hint
  **"Give it a name to get started"**, field placeholder **"Notebook name…"**, button **"Create notebook"**.
- Toolbar: search **"Search…"**; Sort = **Recent activity** / **Name** / **Created** / **Word count**;
  Filter = **All** / **Pinned** / **Has sources** / **Has chat** / **Empty** / **Processing**.
- Empty states:
  - first run: **"Create your first notebook"** — **"Upload PDFs, documents, and URLs — then chat with your
    sources and generate summaries, briefings, and more."**
  - filtered: **"No matches"** — **"No notebooks match your search or filter. Try different terms, or clear the filter."**
- Drag a file anywhere on the page: **"Drop a file to create a notebook"**; onto a card:
  **"Drop to add to this notebook"**. Toast after: **"Notebook "{name}" created from your file"** / **"Source added"**.
- Card footer counters with titles **Sources**, **Messages**, **Words**, **Updated**, plus
  **"{n} sources processing"** and **"{n} sources failed"** badges. Empty card:
  **"This notebook is empty. Open it to add sources and start writing."**
- Card menu: **Open notebook**, **Open chat**, **Pin**/**Unpin**, **Rename**, **Delete**.
- Delete confirm: **"Delete notebook?"**, buttons **Delete** / **Cancel**.
- Pagination button **"Load more"**.

### 2.9 Notebook workspace (`/app/notebooks/:id`)
Three columns: **Sources** (left drawer) · document editor · **AI Chat** (right drawer).

- Header toggles: **"Toggle Sources"**, **"Toggle AI Chat"**, **"Command palette (⌘K)"** (placeholder
  **"Type a command…"**, empty **"No matching commands"**).
- Save state: **"Saving…"**, **"Saved"**, **"Unsaved changes"**, **"Save failed — retry"**.
- Editor placeholder: **"Start writing, or generate a document from your sources…"**.
- Selection menu: **"Ask AI"** (placeholder "Ask AI about this text..."), **Rewrite**, **Shorten**, **Expand**.
- **Sources** panel header **"Sources"**. Add-source types:
  **File** ("PDF, Word, Excel, CSV…") · **URL** ("Fetch a web page") · **Text** ("Paste any text") ·
  **Notes** ("From a meeting note").
  - Empty: **"Add your first source"** — **"Sources power the AI chat & citations. Drag & drop a file, or pick a type:"**
  - URL panel: **"Add URL"**, input placeholder `https://...`, button **"Add"**.
  - Text panel: **"Paste Text"**, name field **"Name (optional)"**, body **"Paste your text here…"**, button **"Add Text"**.
  - Notes panel: **"Meeting Notes"**, **"Include as source"** → **Full transcript** / **Summary only**,
    search **"Search meeting notes…"**, link **"Capture one now"**.
  - Per-source progress words: **"Queued…"**, **"Reading…"**, **"Fetching…"**, **"Indexing…"**, **"Processing…"**.
  - Per-source badges/actions: **Duplicate** ("Duplicate of an existing source"), **Failed**,
    **Show details**/**Hide details**, **Retry** ("Retry ingestion"), **Cancel** ("Cancel ingestion"),
    **Preview**, **Rename**, **Remove source**, **Select multiple**, **Delete**.
  - Footer: **"All {n} sources ready"** or **"{ready} of {total} ready"**, plus a word total.
  - Preview with nothing to show: **"No preview available for this source."**
- **AI Chat** panel: title **"AI Chat"**, subtitle **"Ask questions about your sources"**,
  empty **"Ask me anything"** — **"I'll use your notebook sources to provide accurate answers with citations."**,
  input **"Ask about your sources..."**, per-answer button **"Insert"** ("Insert into document").
  Locked history banner: **"Chat history is locked — sign in again to continue this conversation."**
- **Export** menu: **"Download as PDF"**, **"Download as Word"**, **"Send for signing"** (SignRequest,
  only when configured), **"Save to Nextcloud"** (only when configured).
- **Version history** (`History` icon): confirm **"Delete this version?"**, errors
  **"Could not load versions."**, **"Could not load this version."**, **"Restore failed. Your content is unchanged — try again."**
- **AI fill** (`notebooks.ai_fill` = "AI fill"): fills every `{{parameter}}` in the document from the
  notebook's sources. Errors: **"No {{parameters}} found in the document to fill."**,
  **"AI Fill returned no content. Please try again."**

### 2.10 Adjacent screens the learner will bump into
- **Templates** (`/app/templates`): header hint **"Upload .docx templates with {{parameters}} for AI to fill"**,
  search **"Search templates..."**, empty **"No templates yet"** / **"No templates found"**,
  per-template button **"Fill with AI"**, then **"Generate Document"** (busy: "Generating..."), plus
  suggested prompts **"Fill all parameters from context"**, **"What parameters need to be filled?"**,
  **"Help me fill this template"**. This is document assembly from meeting notes + KB — *not* web research.
- **Projects** (`/app/projects`): heading **"Projects"**, search **"Search…"**. Detail tabs:
  **General**, **Chats**, **Content**, **Knowledge**, **Members**, **Activity**, **Memory**, **Danger**.
  Roles: **Owner** / **Editor** / **Viewer**. Useful for research only because a project can carry
  knowledge bases and shared chats.
- **Cowork** (sidebar **"Cowork"**, `/api/cowork`): scheduled unattended work. Composer placeholder
  **"Describe the work — Bee Flow runs it and reports back"**, buttons **"Run"** / **"Schedule"**.
  A cowork item's `toolsEnabled` defaults to `['agent_search']` — i.e. **scheduled work has web search on by default**.
- **Admin → Integrations → Search** (super-admin only, `IntegrationsAdminPanel/SearchSection.jsx`):
  provider dropdown **Disabled** / **Azure Bing Search** / **Cloud-only (Serper + provider APIs)** /
  **Self-hosted (Agent Search + Serper)**, plus **"Agent Search Service URL"** and
  **"Agent Search Default Options"** (Default Mode, Include citations, per-mode Max Results / Fetch Top N /
  Max Tokens / Detail Level).
- **Admin → Security → Privacy Shield → Outbound**: **"Protect web searches"** —
  *"Stop search terms that contain personal data from being sent to an outside search engine."*
  (locked note: **"Protecting web searches is an Enterprise feature."**) and
  **"No web search while a file is attached"** — *"When someone attaches a document, do not let the AI search
  the web — so nothing from that document can end up in a search box."*

---

## 3. Concepts a learner must understand

- **Web search (`agent_search`)** — the assistant writes a short Google-style query (2–6 words), an outside
  search engine returns hits, and Bee Flow fetches and summarises the top pages. Two modes: **web** (fetches
  full pages, reranks them, ~2 s, the default) and **web_fast** (snippets only, ~1 s, for a single fact).
- **Detail level** — how much of each page comes back: **basic** (~300 tokens, 3–5 bullets), **detailed**
  (default), **highly_detailed** (~2000+ tokens, for deep reading).
- **Browse Web (`browse_web`)** — a real headless browser the assistant drives step by step: navigate, click,
  type, scroll, follow links, read PDFs. Use when you already have the URL. Slower, capacity-limited, and it
  shows you a live thumbnail.
- **Search vs browse** — the tool descriptions are explicit: *"agent_search is for DISCOVERING pages when you
  don't have a URL"*; if the user pasted a URL, the assistant should open it with browse_web instead.
- **Citations** — the assistant is instructed to cite only URLs that came back in the results and never to
  invent one, to use inline markdown links, and to end with a **Sources** section.
- **Grounding / Knowledge base** — searching *your* documents, not the web (`kb_search`). The Knowledge pill
  says what the chat is grounded on. Grounding is invisible-but-real: if a conversation already has bases
  attached, every turn searches them even for a user who cannot see the picker.
- **Notebook source** — one document, URL, pasted text or meeting note added to a notebook. It is parsed,
  chunked and indexed before the chat can use it; until then its status is *processing*.
- **Swarm / Research Swarm** — one question, three researcher workers in parallel (angles: facts & data;
  context & stakeholders; risks & counterarguments), each with the full chat toolbelt, writing findings into a
  shared **Hive Mind**, then one **Writer** worker synthesises a single answer.
- **Hive Mind** — the shared scratchpad the swarm workers write to; it is persisted on the conversation so a
  follow-up turn in the same chat keeps the earlier findings.
- **Privacy Shield / web-search guard** — an org rule that inspects the *arguments* of an outgoing tool call
  for personal data and refuses the call if a blocked category is found. "Monitor-only" means it is logged but
  allowed.
- **Model tier** — how much thinking the turn gets. Research usually wants **Think**; **Swarm** is a separate
  *kind* of work, not a depth.

---

## 4. End-to-end workflows (click-by-click)

### W1 — Ask a question and get cited web sources
1. Open Bee Flow; the sidebar shows **New Chat** — click it (or pick an existing chat).
2. In the composer click **+** (aria-label "Message tools").
3. Check that **Web search** shows its dot (it is ON by default). If it is off, click it.
4. Close the menu, type the question, press Enter.
5. Watch the line under the message: "Loading tools…" → 🔍 **Agent Search** → "Thinking…".
6. Read the answer; scroll to the **Sources** section at the bottom, and click a link to check it.
7. Expand **How I got this answer** to see how many tools ran and how long they took.

### W2 — Make the assistant read one specific page (or PDF)
1. Copy the URL.
2. In chat, paste it with an instruction, e.g. *"Open this page and summarise the delivery terms."*
3. Send. The assistant should call `browse_web` (not web search) because a URL was given.
4. A thumbnail appears: **"Opening the browser…"**, then live frames, then **done**.
5. If the browser is busy you see **"Waiting for an available browser session ({position} ahead)…"** — wait;
   it queues, it does not fail immediately.
6. The answer ends with **"Pages read:"** and the URLs actually visited, plus the line
   *"Read live via a headless browser. Only the content above was actually on the page(s)."*

### W3 — Build a notebook from sources and write a briefing
1. Sidebar → **Notebooks**.
2. Click **New notebook**, type a name, click **Create notebook** (or just drag a PDF onto the page —
   **"Drop a file to create a notebook"** — which creates a notebook from that file).
3. In the notebook, open the left panel (**Toggle Sources**). Under **Sources** pick a type:
   - **File** → choose PDF/Word/Excel/CSV;
   - **URL** → paste `https://...` and click **Add**;
   - **Text** → paste and click **Add Text**;
   - **Notes** → search **"Search meeting notes…"**, choose **Full transcript** or **Summary only**.
4. Wait for each row to move **Queued… → Reading… → Indexing…** and land on ready; the footer says
   **"All {n} sources ready"**.
5. Open the right panel (**Toggle AI Chat**) and ask in **"Ask about your sources..."**, e.g.
   *"What are the three main risks in these documents?"* Citations appear as chips under the answer.
6. Click **Insert** on a good answer to drop it into the document, or write in the editor yourself.
7. Save is automatic — the header shows **Saved**.
8. **Export** → **Download as PDF** or **Download as Word**.

### W4 — Ground a chat on your own documents instead of the web
1. In chat, click the **Knowledge** pill.
2. In **"Knowledge bases"** ("Pick one or more to ground this chat."), search and tick the bases you want.
3. Close the panel — the pill now names the base, or says **Knowledge** with the names in its tooltip.
4. Ask the question. The activity line shows **"Searching knowledge base…"**.
5. Under the answer, open **How I got this answer** to see which passages were used (chunk, page number).
6. If you also want current outside facts, leave **Web search** on; if you want *only* internal material,
   switch **Web search** off in the **+** menu first.

### W5 — Run a Research Swarm (only if the Swarm beta is enabled)
1. In chat, open the model-tier control beside Send (or the tier pill in agent chat).
2. Choose **Swarm** — *"Parallel agents, synthesised answer"*.
3. Ask an open-ended question ("market scan", "briefing", "what should we know about X").
4. The **Swarm** timeline appears: phase **Researching** with three workers (each showing
   **"Working…"** and **" · {n} tool calls"**), then phase **Writing**.
5. The final answer streams as one ordinary message; worker failures are shown as
   **" · {n} worker failures"** rather than hidden.
6. Follow-up questions in the same chat reuse the stored Hive Mind.

### W6 — Schedule a recurring research digest
1. Either ask in chat — *"every Monday at 8am, search for news about X and send me the top 5 with links"* —
   which makes the assistant call `set_ai_task`, or
2. Sidebar → **Cowork** → composer **"Describe the work — Bee Flow runs it and reports back"** → **Schedule**.
3. The item is created with `toolsEnabled = ['agent_search']` (web search on) and model tier **fast** unless
   you asked for thinking.
4. Results arrive as a notification / in the Cowork item's history.
5. Ceiling: **10 scheduled items per user** by default (`ai_tasks_max_per_user`); over that the assistant
   answers *"Maximum number of cowork items reached (10). ..."*

---

## 5. Defaults and limits (the numbers)

**Web search (`server/integrations/agentSearchTools.js`)**
- Mode: `web` by default. Allowed from the model: `web`, `web_fast` only (`kb`/`auto` are coerced to `web`).
- `max_results`: default **5** in `web` (clamp 1–10); default **10** in `web_fast` (clamp 1–20).
- `fetch_top_n`: forced to **1** in `web_fast`; in `web` the code default is **3**, clamp 1–5.
  (The tool schema text shown to the model says "default 2" — the code says 3. The code wins.)
- `max_tokens_markdown` per result: **2000** (web) / **1500** (web_fast).
- `include_citations`: **true** unless an admin turns it off.
- HTTP timeout to the search service: **30 000 ms**.
- Search-service request caps (`search-service/app/models.py`): `query` 1–2000 chars, `max_results` 1–20,
  `fetch_top_n` 1–10, `max_tokens_markdown` 100–8000.
- KB side of the same service: `top_k_vector` 40, `top_k_fts` 40, `top_k_final` 8, reranker on.

**Browse Web (`server/integrations/browserFetchTools.js`, `server/services/browserAgentDriver.js`)**
- Concurrent browser sessions per server process: **4** (`BROWSER_FETCH_MAX_CONCURRENT`).
- Queue wait before giving up: **45 s** (`BROWSER_FETCH_MAX_QUEUE_WAIT_MS`).
- Steps per browse: default **8**, ceiling **20**.
- Wall clock per browse: **90 s**. Step timeout **15 s**, navigation timeout **25 s**.
- PDF: max **25 MB**, fetch timeout **20 s**.
- Frame throttle for the live preview: **180 ms**.

**Swarm (`server/core/swarms/swarmRuntime.js`, `builtins/researchSwarm.js`)**
- Workers: **3 researchers** (tier `thinking`) + **1 writer** (tier `writer`).
- Tool rounds per worker: **8**. Max tokens per worker: **6000**.

**Notebooks**
- File upload per source: **50 MB**; inline images in the document: **10 MB**.
- Pasted text per source: **500 000 characters** (UI blocks above it).
- A source stuck in *processing* for **10 minutes** is flipped to error with
  *"Ingestion timed out — retry or re-upload."*
- Overview list: page size default **200**, hard cap **200** (`MAX_CARD_LIMIT`); search string capped at 200 chars.
- Generation ("Studio") context gathering: **50 000 chars**, `topK` **25**, `minScore` **0.15**.
- Version history: keep the newest **200** versions; auto-snapshot debounce **5 minutes**.
- Server-side generation types that still work: `summary`, `briefing_doc`, `blog_post`, `faq`, `mind_map`,
  `data_table`. Removed (they 400 now): `studyGuide`, `flashcards`, `quiz`, `audio_overview`.
- Knowledge bases per **project**: capped (`MAX_KB_IDS`, enforced with *"At most {n} knowledge bases per project"*).

**Chat composer**
- **Web search** toggle default: **ON** (stored per user in scoped browser storage as `webSearchEnabled`).
- Cowork/AI-task items: max **10** per user (`ai_tasks_max_per_user`).
- `kb_search` tool: `top_k` default **5**, range 1–10; the prompt tells the model to run **at most 2**
  KB searches per user turn.

---

## 6. What happens on failure

| Situation | What the user sees / what the model is told |
|---|---|
| No search provider configured | The web-search row disappears from the composer; server log says `agent_search NOT registered`. The model simply has no search tool — it will answer from training data unless it says otherwise. |
| Search service unreachable / HTTP error | Tool result: `Search failed: <message>` — the assistant should surface the failure. |
| Search returns **0 results** | Deliberately returned as an *error*, not an empty success: *"Search returned 0 results for "…". … Try a shorter or differently-worded query … Do NOT fabricate sources or article content."* This exists because a "successful empty" result made the model write a polished apology. |
| Web search blocked by org policy (a file is attached, now or earlier in the chat) | The **Web search** row is disabled with **"Web search disabled by organisation policy (files attached)"**, and the tool is stripped from the turn. |
| Personal data in the search query, guard on | The tool call is refused before dispatch. With the guard configured but disabled, it is monitor-only (logged, allowed). A *degraded* PII scan counts as a failed scan, never as clean. |
| Browser at capacity beyond 45 s | *"The browser is at capacity and the wait exceeded 45s — try again shortly, or use agent_search if the content doesn't require a live browser."* |
| Page loads but is unreadable (login wall, CAPTCHA, bot block) | *"The page(s) loaded but produced almost no readable content for this task … Do not fabricate an answer."* |
| Browse hits its time limit | The answer is returned with *"> Note: the browser stopped at its time limit after {n} steps — this may be partial."* |
| No browser backend (Docker unreachable, no `BROWSER_WS_ENDPOINT`) | `browse_web` is not registered at all — the assistant can only search, not open pages. |
| Notebook source fails to ingest | Row turns red with **Failed**, **Show details** reveals the error, **Retry** re-runs ingestion without re-uploading (file/url/text/meeting all supported); after 10 min stuck it auto-fails. |
| Notebook generate with no sources and an empty document | 400 *"Add a source or write something in the document first"*. |
| AI fill with no placeholders | 400 *"No {{parameters}} found in the document"* → toast **"No {{parameters}} found in the document to fill."** |
| Notebook chat history cannot be decrypted | Banner **"Chat history is locked — sign in again to continue this conversation."** (not an empty chat). |
| Swarm tier picked without the beta | 403 *"Swarm Agents beta is not enabled for your organisation."* |
| Swarm tier with no model configured | 400 *"No model is configured for the Swarm tier. Ask an admin to set one in Chat Model Tiers → Swarm (Direct)."* |
| Notebook opened without the licence | The page returns nothing and redirects back to the app (no broken shell that 403s on every call). |

---

## 7. Permission, licence and feature gates

**Permissions (`server/config/orgRoles.json`)**
- `use_notebooks` is granted to: `org_admin`, `agent_admin`, `agent_editor`, **`member`**. (DPO and
  ISMS Auditor do *not* have it.)
- `manage_knowledge` (creating/editing knowledge bases) is granted to `org_admin`, `agent_admin`, `agent_editor` —
  **not** to `member`. An everyday member can *use* KBs shared with them, and create personal ones only if the
  route allows; the sidebar KB entry and the picker still show what they can reach.
- There is **no permission for web search or browse_web** — they are integrations, not permissions.

**Licence features (`server/license/tiers.js`)**
- Community includes `integrations` (which covers `agent-search` and `browser-fetch`), `automations`,
  `agent_routines`, `learning_center`.
- **Enterprise only**: `notebooks`, `projects`, `meeting_notes`, `webpages`, `voice_chat`, `app_studio`,
  `pii_tokenize`, **`web_search_guard`**, `guardrails_dlp`, `compliance_hub_gdpr`, `mcp_marketplace`, …
- So: **web search and Browse Web work on Community; Notebooks, Projects and the web-search PII guard do not.**

**Route-level gates actually seen in code**
- `app.use('/api/notebooks', requireModule('notebooks'), requireCapability('notebooks'), notebookFeatureGate, …)`
  plus `router.use(requirePermission('use_notebooks'))` inside `routes/notebooks.js`, plus a
  `feature_notebooks_enabled` operator config flag.
- `app.use('/api/projects', requireModule('projects'), requireAuthedUser, requireCapability('projects'), projectFeatureGate, …)`
- `router.use('/swarms', requireCapability('swarm'), swarmsRoutes)` in `routes/ai.js`, and the swarm turn
  re-checks `userHasBetaFeature(userId, 'swarm')` before streaming.
- `/api/kb` — `requireAuth` per sub-route + `requireActiveOrgForMutations()` at the router; reads always pass.
- `/api/templates` — `requireAuth` only.
- Notebook tools in chat are only injected when `feature_notebooks_enabled !== false`
  **and** `hasCapability('notebooks')` **and** `hasPermission(userId,'use_notebooks')`; dispatch re-checks.
- Frontend mirrors: `useLicenseContext().hasFeature('notebooks')`, `user.permissions.includes('use_notebooks')`,
  `user.featureFlags.notebooks !== false`, `featureFlags.notebooksMenu !== false` — all four must pass for the
  sidebar **Notebooks** row to render, and the row is hidden in Simple Mode and on mobile.

**Integration availability chain for `agent_search`** (all must hold):
`search_provider !== 'disabled'` → a usable backend (Agent Search URL, or Serper key, or Bing key) →
the org's effective integrations include `agent-search` → the agent does not set `disableExternalTools` →
the user's **Web search** composer toggle is on → org policy does not block it because a file is attached.

---

## 8. How this connects to the rest of the product

- **Chat is the hub.** Web search, Browse Web, knowledge search, notebook writes and the Swarm tier are all
  tools/tiers inside one chat turn.
- **Notebooks ↔ Knowledge Bases**: a notebook's sources are ingested into the KB layer; a notebook can also
  *attach* existing knowledge bases (`knowledgeBaseIds`), and every id is re-authorised at read time.
- **Notebooks ↔ chat**: the assistant can read and write the open notebook document
  (`notebook_read/write/replace/insert`), gated by a deterministic write gate so it cannot write unasked.
- **Notebooks ↔ Meeting Notes**: a meeting transcript or its summary can be added as a source.
- **Notebooks → Export**: PDF, Word, SignRequest (e-signature), Nextcloud.
- **Cowork / AI tasks**: `set_ai_task` turns a research request into a recurring background job whose default
  toolset is web search.
- **Projects**: can carry knowledge bases, shared chats and content; notebooks have a `projectId` column
  (filed notebooks are readable by project members) although the overview list query does not select it.
- **Privacy Shield**: decides whether a search query containing personal data may leave, and whether attaching
  a file disables search for the rest of the conversation.
- **Agents**: an agent can be built with or without web search; `personaPrompt.js` appends `agent-search` to
  `enabledIntegrations` when the persona promises web access.

---

## 9. Common mistakes (teach these)

1. **Toggling "Web Search" in the Apps panel does not switch web search off.** The Apps catalogue entry is
   `web-search` (frontend only); the server gate is `agent-search`, and `agent-search` is in
   `AUTO_ENABLED_APPS`, where the code comment is explicit: *"auto-enabled apps are always on at user level"*.
   The real switch is the **Web search** row in the **+** menu, which strips the `agent_search` tool from the turn.
2. **Pasting a URL and expecting a search.** With a URL in hand the assistant should use **Browse Web**. If it
   searches instead you get a summary of *other* pages. Say "open this page" to steer it.
3. **Long, natural-language queries.** The tool prompt is blunt: write 2–6 words, like Google. A long sentence
   gives worse hits and sometimes zero results.
4. **Reading "0 results" as "nothing exists".** It usually means rate limit, a too-narrow query, or the wrong
   language. Retry with different words or in English.
5. **Attaching a file and then asking for market data.** If the org enabled *"No web search while a file is
   attached"*, web search is off for the rest of that conversation — not just that message.
6. **Asking the notebook chat before the sources are ready.** A source must reach "ready"; while it says
   **Queued… / Reading… / Indexing…** it is not searchable yet.
7. **Expecting notebook chat to browse the web by default.** Notebook chat gets `agent_search` only when a
   search provider is configured; its job is your sources, with `[Source name](url)` citations.
8. **Assuming an agent with "web search" ticked really has it.** `agentGrounding.js` documents that
   `config.enabledIntegrations` is *not* read by the runtime for this: web search depends on the user's app
   list, `AUTO_ENABLED_APPS` and whether a provider is configured at all.
9. **Trusting a chip because it is a chip.** "Judged" chips are a second model's after-the-fact opinion;
   "recorded" chips have an event behind them. The UI keeps them apart on purpose.
10. **Using Swarm for a quick fact.** The manifest says so: *notFor* = "Quick factual questions (use Fast or
    Flow), or short edits." Three thinking-tier workers is expensive and slow for "what's the VAT rate".
11. **Deleting a notebook to clean up.** Deleting cascades its sources; the confirm dialog names the source
    count for a reason.
12. **Expecting `/app/projects` or `/app/templates` to be research tools.** Projects is collaboration;
    Templates is .docx `{{parameter}}` filling.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

### S1 — Procurement: supplier check before signing
Bart (inkoop) has a quote from a new steel supplier.
1. New chat, **+** → confirm **Web search** is on.
2. *"Zoek recente berichten over [leverancier] — faillissement, overnames, leveringsproblemen. Nederlands en Engels."*
3. The assistant runs **Agent Search**; Bart opens the links in the **Sources** section.
4. He pastes the supplier's own terms-and-conditions URL: *"Open deze pagina en vat de leverings- en
   betalingsvoorwaarden samen."* → **Browse Web** thumbnail, answer ends with **"Pages read:"**.
5. He drags the quote PDF into **Notebooks** ("Drop a file to create a notebook"), adds the T&C URL as a
   **URL** source, and asks in **AI Chat**: *"Waar wijkt deze offerte af van onze standaardvoorwaarden?"*
6. **Export** → **Download as Word** for the purchasing file.
   *Privacy note for the lesson:* the supplier's company name is fine in a search box; a named contact person
   is not — that is exactly what **"Protect web searches"** blocks.

### S2 — HR: a policy briefing that must be current *and* internal
Fatima (HR) must update the leave policy after a legal change.
1. She clicks the **Knowledge** pill and attaches **Personeelshandboek** (org KB).
2. She leaves **Web search** on and asks: *"Wat verandert er dit jaar aan het geboorteverlof, en waar botst
   dat met ons handboek?"*
3. The activity line shows **"Searching knowledge base…"** and then **Agent Search**.
4. She opens **How I got this answer** to see which handbook passages were used (page numbers) next to the
   web sources.
5. She creates a notebook **"Verlofbeleid 2026"**, adds the handbook chapter as a **Text** source and the
   government page as a **URL** source, then writes the memo in the editor using **Insert** on the good answers.
6. **Export** → **Download as PDF** for the works council.
   *Teaching point:* never paste an employee's name or BSN into a chat that has web search on.

### S3 — Sales: a weekly market watch that runs itself
Jeroen (sales) wants Monday-morning intelligence on three competitors.
1. In chat: *"Maak elke maandag om 08:00 een overzicht van nieuws over [3 concurrenten] in de Benelux, top 5
   met bronlinks."*
2. The assistant calls `set_ai_task`; the item appears under **Cowork** with web search already enabled and
   a next-run time.
3. Week one, two of five items are irrelevant → he edits the prompt to name the sectors, not just the companies.
4. For the quarterly review he switches the chat tier to **Swarm** and asks for a market scan; the
   **Researching → Writing** timeline runs, and he keeps the synthesised answer.
5. He files the result in a notebook so the next quarter starts from something.
   *Watch-out:* the cap is **10** scheduled items per user; number 11 is refused with a message naming the limit.

---

## 11. List/read API endpoints a "did the learner do it?" check could call

All are `requireAuth` (session cookie) unless noted. Paths are as mounted in `server/index.js` /
`server/routes/ai.js`.

| Method + path | Auth / gates | JSON shape (row fields) |
|---|---|---|
| `GET /api/notebooks` | session + `use_notebooks` permission + `requireModule('notebooks')` + `requireCapability('notebooks')` + `feature_notebooks_enabled` | `{ notebooks: [...], limit, offset, hasMore }`. Row: `id, name, description, type, projectId, organizationId, version, sourceCount, processingCount, failedCount, sourceWordCount, docWordCount, messageCount, preview, pinned, pinnedAt, lastActivityAt, lastActivityKind, createdAt, updatedAt`. **Owner is implicit** — the SQL filters `WHERE n.user_id = $1`; there is no `userId`/`ownerId` field, and `projectId`/`organizationId` are always `null` here because the card query does not select those columns. Query params: `limit` (≤200), `offset`, `search` (≤200 chars), `sort` (`activity|name|created|words`), `filter` (`all|pinned|sources|chat|empty|processing`). |
| `GET /api/notebooks/:id` | same | `{ notebook, sources }` — 404 `{error:'Notebook not found'}` if it is not yours. |
| `GET /api/notebooks/:id/sources` | same | `{ sources: [...] }`. Row: `id, notebookId, type, name, storageKey, fileName, metadata, status, stage, error, wordCount, sortOrder, hasContent, createdAt, updatedAt`. `status` is the check target (`processing` / `ready` / `error`). |
| `GET /api/notebooks/:id/conversation` | same | `{ messages: [...], locked }` — proves the learner actually chatted with their sources. |
| `GET /api/notebooks/:id/versions` | same | version list for the document. |
| `GET /api/kb` | session (+ `requireActiveOrgForMutations` only affects writes) | Array of KB rows: `kb.*` (incl. `id, tenant_id, name, description, organization_id, category_id, icon, source_kind, usage_contexts, system_slug, is_published, shared_groups`) plus `document_count`, `document_count_all`, `total_chunks`. **Owner field = `tenant_id`** (the user id). |
| `GET /api/kb/published` | session | Same rows, filtered to `is_published` and group-accessible. |
| `GET /api/templates` | session | `{ templates: [...] }` — scoped to the caller (`templateStore.getTemplates(userId)`). |
| `GET /api/templates/:id` | session | `{ template }`, 404 if not the caller's. |
| `GET /api/projects` | session + `requireModule('projects')` + `requireCapability('projects')` + `feature_projects_enabled` | Array. Row: `id, name, description, customInstructions, knowledgeBaseIds, color, icon, **ownerId**, organizationId, extractMemories, version, installedFromBlueprintId, installedFromOrgId, installedVersion, permission ('owner'/'editor'/'viewer'), createdAt, updatedAt`. |
| `GET /api/cowork` | session | `{ schedules: [...], maxSchedules }`. Row: `id, **userId**, title, prompt, repeatInterval, daysOfWeek, timeOfDay, nextRunAt, lastRunAt, lastResult, lastStatus, isActive, modelTier, toolsEnabled (defaults `['agent_search']`), enabledApps, maxResultLength, runCount, timezone, agentId, conversationId, createdAt`. Best endpoint for "did they schedule a research digest?". |
| `GET /api/cowork/:id/runs` | session | run history for one scheduled item. |
| `GET /ai/swarms/available` | session + `requireCapability('swarm')` (whole router) | `{ swarms: [...] }` — a 403/404 here is itself the answer "the Swarm beta is off for this org". |
| `GET /ai/user-settings` | session | Includes `searchProvider` (`agent-search`/`node-search`/`bing`/`disabled`), `disableSearchOnUpload`, `enabledApps`, `orgEnabledIntegrations`, `simpleMode`, `learningProgress`, `learningPath`. Use it to check whether web search is even available to this learner before asserting they "forgot" to use it. |

Notes for check authors:
- There is **no endpoint that lists web searches a user ran.** Web-search usage is only observable inside a
  conversation's message/tool history (and in org usage monitoring, which is Enterprise-gated). A "did you
  search the web?" check must therefore look at a chat turn, not at a list route.
- `GET /api/notebooks` is the cleanest verification target for a hands-on Notebooks lesson: non-zero
  `sourceCount` proves a source was added, non-zero `messageCount` proves they chatted with it, and
  `docWordCount` proves they wrote or inserted something.

---

## 12. Source files worth re-reading when updating this sheet

- `server/integrations/agentSearchTools.js` — the `agent_search` tool text, modes, defaults, 0-result handling.
- `server/integrations/browserFetchTools.js` + `server/services/browserAgentDriver.js` — `browse_web`, queue, step caps.
- `server/core/integrations/integrationTools.js` (~lines 320–400) — when the two tools are registered at all.
- `server/routes/ai/directChat/toolStackAssembly.js` — where the composer toggle and the upload policy strip `agent_search`.
- `server/core/agentRuntime/toolRoundExecutor.js` (~lines 255–345) — the PII guard on outgoing tool arguments.
- `server/core/swarms/builtins/researchSwarm.js` + `server/core/swarms/swarmRuntime.js` — the Research Swarm.
- `server/routes/notebooks.js`, `server/stores/notebookStore.js` — notebooks API, limits, card projection.
- `agent-hub/src/components/chat/InputArea.jsx` — composer toggles, pills, gating.
- `agent-hub/src/pages/notebooks/**` — every notebook label quoted above.
- `agent-hub/src/components/chat/MessageItem/{ActivityIndicator,BrowserLivePreview,HowIGotThisAnswer,SwarmTimeline}.jsx`.
- `server/license/tiers.js`, `server/config/orgRoles.json` — the gates.
