# Fact sheet — Personal memory (Bee Flow AI)

Audience: everyday users. Status: **the feature exists and is fully built** (UI + API + background
extraction + retrieval + retention + compliance hooks). Verified against the code on branch
`claude/builder-redesign-fase-1-6sun0h`, 2026-09-14.

Key source files
- Frontend: `agent-hub/src/pages/settings/MemorySection.jsx`,
  `agent-hub/src/components/knowledge/memory/MemoryPanel.jsx`,
  `agent-hub/src/components/knowledge/memory/ImportMemoryModal.jsx`,
  `agent-hub/src/pages/AdvancedSettings.jsx`,
  `agent-hub/src/authedApp/settingsRoutes.js`, `agent-hub/src/pages/settings/settingsNavItems.jsx`,
  `agent-hub/src/components/chat/InputArea.jsx`, `agent-hub/src/components/licensing/TierSlider.jsx`,
  `agent-hub/src/components/projects/ProjectDetailPage.jsx`,
  `agent-hub/src/components/agents/AgentWizard/pickers/BehaviorPicker.jsx`,
  `agent-hub/src/components/automation/Builder/flow/settings/aiStepEditors.jsx`,
  `agent-hub/src/components/admin/ai-config/chatModelTiers/MemoryExtractionModelSection.jsx`,
  `agent-hub/src/i18n/en-defaults.js`
- Backend: `server/routes/memory.js`, `server/stores/memoryStore.js`,
  `server/core/memoryExtractor.js`, `server/agents/memory/extractor.js`,
  `server/core/memory/extractionModel.js`, `server/core/memory/scrubMemoryContext.js`,
  `server/core/agentRuntime/contextEnrichment.js`,
  `server/core/agentRuntime/finalizeTurn.js`, `server/routes/ai/directChat/finalizeTurn.js`,
  `server/integrations/memoryTools.js`, `server/core/automationRunner/execAi.js`,
  `server/jobs/memoryRetentionEnforcer.js`,
  `server/compliance/checks/gdpr/art5-1-e-storage-limitation.js`,
  `server/compliance/dsr/discovery.js`, `server/compliance/dataPortability/exportRegistry.js`,
  `server/stores/user/users.js`

---

## 1. What the feature is for

Memory is Bee Flow's long-term note-to-self about **one user**. While you chat, a small background
model reads the finished exchange and writes down durable facts — "I always want replies in Dutch",
"Karin is our purchasing manager", "we invoice on the 25th". On every later turn, the memories most
relevant to what you just typed are pasted into the system prompt under a heading `## Active Memory`,
so the assistant already knows things you told it weeks ago, in a different conversation, with a
different agent.

The product promise is control: everything remembered is listed on one screen and can be edited,
deleted in bulk, exported as JSON, or wiped. The in-product lesson copy says it plainly
(`learn.using-memory.intro.body`): *"Memory keeps useful facts and preferences across conversations,
so you don't repeat yourself every time … You're always in control: every memory can be reviewed,
edited, or removed."*

Three memory *pools* exist and are kept apart on purpose:

| Pool | Where it lives | Who sees it |
|---|---|---|
| **General (personal) memory** | `user_memories` rows with `agent_id IS NULL`, `project_id IS NULL` | only you |
| **Per-agent memory** | rows with `agent_id = <agent>` — written only when that agent has Memory switched on | you, in chats with that agent |
| **Project memory** | rows with `project_id = <project>` | every member of the project (shared pool) |

---

## 2. Screens, with the real labels

### 2.1 Settings → Memory (`/app/settings/memory`)
Reached by opening Settings and clicking the sidebar row **Memory** (key `settings.memory`;
`agent-hub/src/authedApp/settingsRoutes.js` makes `memory` one of the seven top-level segments:
`preferences, appearance, security, memory, integrations, learning, help_support`). The section is
visible on phones too (it is not in `SETTINGS_DESKTOP_ONLY_TABS`).

Three cards (`MemorySection.jsx`):

1. **MEMORY** (uppercase section header, `settings.memory_title`)
   - Row title **Stored memories** (`settings.memory_stored`), subtitle **"Persisted facts about you,
     your projects, and preferences"** (`settings.memory_desc`), and a big number on the right = the
     `total` from `GET /agents/memory/stats`.
   - Under it, when the count > 0, one chip per type using the labels **Instructions, People,
     Projects, Preferences, Workflows, Facts, Context**, each with its count.
   - Empty state (count = 0): **"No memories yet. As you chat, facts and preferences are
     automatically saved."** (`settings.memory_empty`).
   - Bottom row is a button: **Manage memories** (`settings.memory_manage`) with a chevron. This
     carries `data-tour="memory-manage"` — the anchor the Learning Center lesson points at.
2. **IMPORT MEMORY FROM OTHER AI PROVIDERS** (`settings.memory_import_title`)
   - Body: *"Bring relevant context and data from another AI provider. We'll provide a prompt you can
     use from your other account."*
   - Button **Import**.
3. **ABOUT** (`settings.memory_about_title`)
   - *"Memories help the AI remember facts, preferences, and context from your conversations. They
     persist across sessions for a more personalised experience."*

(These are the English defaults. A Dutch tenant sees the org's own translations, served from the
server language catalogue; the English strings above are the fallback and the canonical wording.)

### 2.2 The Memory panel (opens over Settings after "Manage memories")
`MemoryPanel.jsx`, rendered full-bleed over the settings content (`position:absolute; inset:0`).

- Back arrow, tooltip **"Back to Settings"**.
- Title **Memory** (in a project it reads **Project Memory**). Subtitle is either
  `"<n> memories stored"` or, once you have paged, `"<loaded> of <total> memories loaded"`.
- Top-right buttons: **Select** (toggles to **Cancel**; tooltips *"Select multiple"* /
  *"Exit select mode"*) and **Add Memory** (toggles to **Cancel**).
- Search box placeholder **"Search memories..."**; filter chips **All** plus one icon-chip per type
  showing its count.
- Add form: a row of type buttons — **Instruction, Person, Preference, Workflow, Fact, Context**
  (personal panel) or **Instruction, Project, Fact, Context** (project panel) — a text field
  **"Enter something to remember..."** and a **Save** button. Enter also saves.
- Each memory card: a coloured left border, the type label in small caps (**INSTRUCTION**, **PERSON**,
  …), a relative timestamp, the sentence itself, and on hover **Edit** (pencil) and **Delete** (bin).
  In a project panel a card also shows `• by <display name>`.
- Bulk bar (select mode): **Select All / Deselect All**, **"<n> selected"**, **Delete <n>**.
- Paging: **"Load more (<n> remaining)"**, which becomes **"Loading…"**.
- Footer: **Clear All** (red) and **Export JSON**.
- Empty states: **"No memories yet"** + *"Memories are automatically extracted from conversations.
  Tell your AI about yourself to start building memory!"*; when a filter hides everything:
  **"No memories match your filter"**. Load error: **"Failed to load memories"**.
- Confirm dialogs (native `confirm()`): *"Delete this memory?"*,
  *"Delete N selected memories? This cannot be undone."*, *"Delete ALL memories? This cannot be undone."*

### 2.3 Import memory dialog
`ImportMemoryModal.jsx`. Title **Import memory**.
- Step **1** — *"Copy this prompt into a chat with your other AI provider"* — a read-only textarea
  holding the export prompt, with a **Copy** button that flips to **Copied**.
- Step **2** — *"Paste results below to add to memory"* — textarea placeholder **"Paste your memory
  details here"**, with a live counter **"1,234 / 50,000"**.
- Footer: **Cancel** and **Add to memory** (becomes **Importing…**).
- Result banner: **"Added {count} memories"**, or **"No memories could be extracted from the text."**,
  plus `· N skipped`. On error the server message is shown in a red box. The dialog closes itself
  ~1.8 s after a successful import.

### 2.4 The memory switch in chat
Two places, same setting (`memoryWriteEnabled`, stored per browser in scoped localStorage, default **on**):
- **Direct chat**: a brain icon in the top-right corner of the response-depth (tier) slider panel.
  `title` = *"Memory saving enabled — click to pause"* / *"Memory saving paused — click to resume"*.
- **Agent chat / no slider**: a row in the composer's "+" tools menu labelled **Memory**, hint
  *"Saving new memories from this chat"* / *"Memory saving paused"*.
Turning it off stops **writing** for that session; existing memories are still **read** into the prompt.
While a turn is recalling, the chat status line shows **"Recalling memory…"** (`chat.phase.memory_lookup`).

### 2.5 Project → Memory tab
`ProjectDetailPage.jsx`. Tab label **Memory**. It renders the same panel scoped to the project. A
read-only member sees the note *"You have view-only access to this project, so project memory is
read-only."* and gets no Add/Edit/Delete/Clear controls. In **Project → Settings** there is a
checkbox **Extract Project Memories** — *"Automatically learn and recall facts from conversations
within this project."* (default off).

### 2.6 Agent builder → Memory
`BehaviorPicker.jsx` (behind the Advanced drawer). Toggle **Memory**, help text: *"When on, this agent
saves memories to its own private bucket — not your general memory. Other agents can't see what's
stored here."* When on, a sub-toggle appears: **Also read from your general memory** — *"The agent can
use facts already saved in your general memory (preferences, context). It still only writes to its own
bucket."* New agents are created with `memoryEnabled: false`, `useGeneralMemory` defaults to true.

### 2.7 Routine builder → AI step → Advanced
Field **Personal memory**, checkbox **Use my personal memory**, hint: *"Ground this step in what you
have told the assistant about yourself, your preferences and your contacts. The memories closest to
this step's prompt are added before the model answers. Good for steps that write in your name or
decide on your behalf."* (flag `useMemory`, default off).

### 2.8 Admin → AI configuration → Memory Extraction Model
Card **Memory Extraction Model**: *"Model that reads each finished exchange for facts worth
remembering — a small background call after every reply, thinking off. On a self-hosted single-slot
server pick a tiny model here so extraction never queues in front of the next turn. Defaults to the
Fast tier model when unset."* Selector label **Memory extraction model**, empty value shown as
**"— Use Fast tier model —"**. Config key `memory_extraction_model`.

---

## 3. Concepts a learner must understand

- **Memory** — one short sentence Bee Flow keeps about you, stored as a row in `user_memories`. It is
  *not* your chat history; the chat transcript lives separately.
- **Memory type** — the seven buckets (`server/routes/memory.js`, `MEMORY_TYPES`):
  **Instructions** 📌 *standing instructions (always/never do X)*, **People** 👤, **Projects** 📁,
  **Preferences** ⚙️, **Workflows** 🔄, **Facts** 📋, **Context** 🏢. Type decides how strongly a memory
  competes to be recalled; Instructions always win.
- **Extraction** — the background step after a reply that reads the exchange and proposes memories.
  Runs fire-and-forget; it never delays your answer.
- **Retrieval / recall** — before the model answers, the ~most relevant memories are pasted in as a
  `## Active Memory` block. Instructions appear under *"### Standing instructions from the user"*.
  The block's heading says that no memory, of any type, overrides safety rules, system policy or
  the instructions of the current agent, skill or task (`server/stores/memoryStore.js`,
  `formatMemoriesForPrompt`).
- **Importance** (0–1, default 0.5) — a weight on the row; the stats screen buckets it as
  high (≥0.8) / medium (≥0.5) / low.
- **Superseding** — when a new memory has the same `subject`+`attribute` but a different value, the old
  row is marked `superseded` and points at the new one. You see only the current value.
- **Confirming** — when the same fact is extracted again, no duplicate is created; the existing row's
  `last_confirmed_at` is bumped.
- **Scoping / pools** — personal vs per-agent vs project (see table in §1). Project memory is *shared*.
- **Memory saving paused** — the per-session write switch; reading continues.
- **Scrubbing** — before a memory block reaches the model, the privacy detector replaces recognised
  personal data with generic labels like `[User's email address]` or `[IBAN]`
  (`scrubMemoryContext.js`). The model learns *that* you have an IBAN, not the number.
- **Conversation Memory (org setting)** — a **different** feature: compaction of a long chat
  (`admin.ai_context.*`). It has nothing to do with stored memories. Do not conflate them in lessons.

---

## 4. End-to-end workflows (click by click)

### W1 — See what Bee Flow remembers, and fix one entry
1. Open **Settings** (avatar → Settings, or `/app/settings`).
2. Click **Memory** in the left sidebar.
3. Read the number next to **Stored memories** and the type chips.
4. Click **Manage memories**.
5. Type a word in **Search memories...** (server-side search over content/subject/attribute/value,
   debounced 300 ms).
6. Hover the card you want and click the pencil (**Edit**).
7. Change the sentence; press **Enter** or click **Save** (**Escape**/**Cancel** discards).
8. Click the back arrow (**Back to Settings**) — the count on the card refreshes.

### W2 — Add a standing instruction by hand
1. Settings → **Memory** → **Manage memories**.
2. Click **Add Memory**.
3. Pick the type button **Instruction**.
4. Type the sentence, e.g. *"Always answer in Dutch and keep it under 150 words."*
5. Click **Save**. The card appears at the top of the list immediately.
6. Open any chat and ask something — Instructions are always injected, so the effect is visible on the
   next turn.

### W3 — Let a chat teach it something, then verify
1. Open a chat. Check the brain icon on the response-depth slider is **on**
   (*"Memory saving enabled"*).
2. Write a message of at least ~20 characters that states a durable fact, e.g. *"Our purchasing
   manager is Karin de Wit; she approves everything above €5.000."*
3. Let the assistant answer (its reply must also be ≥20 characters).
4. Wait a few seconds — extraction runs in the background after the reply is saved.
5. Go to Settings → **Memory** → **Manage memories** and click the **People** filter chip.
6. The new card is there, typed **PERSON**. If it is not, the exchange was judged trivial, the
   evidence check failed, or a near-duplicate already existed (see §6).

### W4 — Bulk clean-up
1. Settings → **Memory** → **Manage memories**.
2. Click **Select**.
3. Tick the cards to remove (or **Select All**).
4. Click **Delete N** and confirm *"Delete N selected memories? This cannot be undone."*
5. To start over completely, click **Clear All** in the footer and confirm *"Delete ALL memories?"*.

### W5 — Bring memory over from another AI tool
1. Settings → **Memory** → **Import** (in the *Import memory from other AI providers* card).
2. Click **Copy** to take the ready-made export prompt.
3. Paste that prompt into your other assistant, and copy its bulleted answer.
4. Back in Bee Flow, paste into the **"Paste your memory details here"** box (max **50,000**
   characters shown by the counter).
5. Click **Add to memory**.
6. Read the result: **"Added {count} memories"**. The dialog closes itself; the count on the Memory
   card updates.

### W6 — Take your memory with you (or hand it to a colleague on request)
1. Settings → **Memory** → **Manage memories**.
2. Click **Export JSON** in the footer.
3. The browser saves `memories.json` — `{ exportDate, userId, memories: [...] }`, up to **1000** rows.
   (This route is also the one the compliance screen lists as the portable export for
   *"Assistant memory"*.)

---

## 5. Defaults and limits (the numbers)

Writing / extraction
- Extraction runs after **every** direct-chat and agent-chat reply, in the background.
- It is skipped when: the memory switch is off for the session; a moderation or guardrail violation
  occurred; the message was redacted by the privacy tokeniser (agent runtime); the conversation is
  ephemeral; the agent is embed-enabled (public widget).
- Minimum lengths: user message **≥ 20** chars and assistant reply **≥ 20** chars
  (`core/memoryExtractor.js`); the second extractor needs **≥ 10** chars of user text.
- Input budget per extraction: **8,000** chars of your message + **4,000** chars of the reply
  (`EXTRACTION_MAX_CHARS`).
- Extraction request shape: `maxTokens` **1024**, thinking **off**, timeout **60 s**, temperature
  0.1–0.2. Model = the admin's `memory_extraction_model` if set, otherwise the **Fast** tier
  (last-resort fallback `gemini-2.0-flash-lite`).
- At most **5** memories per extraction; the prompt asks for ≤ **100** characters per memory and
  always in **English**, whatever language you chatted in.
- The evidence-checked extractor additionally drops anything with confidence **< 0.8**, content
  shorter than **5** or longer than **500** chars, anything ending in "?", anything starting with a
  task verb ("create", "fix", "write"…), and anything whose `evidence_quote` is not literally present
  in your message.
- Deduplication: exact match, substring match, or **> 0.8** word-overlap against up to **500**
  existing rows → the existing memory is confirmed instead of duplicated. With `subject`+`attribute`
  set, a changed value **supersedes** the old row.
- `type: 'project'` memories are refused outside a project context (isolation guard).

Reading / recall
- Candidate rows scored per turn: **500** max (`CANDIDATE_LIMIT`), ordered by importance first.
- Budget injected into a chat prompt: **300 tokens** (~1,200 characters). Routine AI steps get **600**;
  the `memory_search` tool works with **1,500** and returns 1–20 rows (default **8**).
- Scoring: type base (**instruction 100, person 80, project 70, preference 60, workflow 60, fact 40,
  context 20**) + semantic similarity ×100 + recency bonus (max 20, −2 per day) + importance ×20.
  A memory needs a score **> 30** to be included — except **instructions, which are always included**.
- Inside a project, up to **15** of your global Instructions/Preferences are merged in on top of the
  project pool ("hybrid retrieval"); other global types stay out.
- Embeddings: configured global provider → in-process CPU embedder (`Xenova/multilingual-e5-small`,
  384-dim) → optional `EMBED_API_URL`. If none works, retrieval falls back to keyword matching.

Panel / API
- Panel page size **50**; server clamps `limit` to **1–200** (default 50).
- Export cap **1000** rows. Import cap **50,000 bytes**, rate-limited to **30 imports per 60 s** per user.
- Import LLM: Fast tier, `maxTokens = min(tier maxTokens ?? 2000, 4000)`, temperature 0.2, no thinking.
- `memory_remember` tool caps: content **200** chars, subject 120, attribute 80, value 200, evidence
  200; importance default **0.6**.
- Manual create default importance **0.5**, default type **fact**.
- Routine "coverage" memories expire after **30 days**.

Retention & deletion
- `memoryRetentionEnforcer` runs **every 24 h** (first sweep 2 minutes after server boot) and flips
  rows whose `expires_at` has passed to `status = 'expired'`.
- The GDPR Art. 5(1)(e) check warns when memories older than the org's **`default_retention_days`
  (default 365)** exist with no `expires_at`, and fails if the sweep has not run in **26 h**.
- Deleting a user deletes all their `user_memories` rows; deleting a project cascades its memories
  (FK `user_memories_project_fk … ON DELETE CASCADE`).
- There is **no quota** on how many memories a user may hold.

---

## 6. What happens on failure

- **Extraction fails** (model down, bad JSON, timeout): logged, the turn is unaffected, no memory is
  written. The core extractor even tries to repair a JSON array truncated mid-way. In agent chat the
  failure is also pushed to the client as a `memory_extraction_failed` event.
- **Nothing was extracted**: normal and silent. Small talk, questions, and task requests are filtered
  out by design — a learner should not read this as a bug.
- **Embedding provider down**: the memory is still stored, just without a vector; retrieval degrades
  to keyword matching for that row. Changing the embedding model changes the vector dimension —
  old memories stay readable but stop ranking against new ones (documented, re-embed is future work).
- **PII scrub unavailable**: fail-open — the memory block goes in unscrubbed (it is the user's own
  data, and the alternative is bricking chat).
- **Memory retrieval throws**: caught; the turn proceeds with no memory block.
- **Panel load fails**: the list shows **"Failed to load memories"**.
- **Import**: empty text → HTTP 400 *"text is required"*; oversize → 400 *"text exceeds 50000 byte
  limit"*; not signed in → 401; over the rate limit → 429; model failure → 500 with the message shown
  in the red box. Rows that fail to insert are counted as `skipped`, the rest still land.
- **Bulk delete** silently skips ids you may not touch and reports only `deleted: <n>`.
- **Project memory as a viewer**: writes return `403 "Editor role required for this project"` /
  `"Access denied"`; the UI hides the buttons so you should not hit this.
- **Guessing a project id**: `GET /agents/memory?projectId=…` returns
  `403 "No access to this project"` without membership.

---

## 7. Permission / licence gates

- **No licence gate.** `server/routes/memory.js` contains no `requireLicenseFeature` / `hasFeature` /
  `requireCapability`, and the router is mounted plainly: `app.use('/agents/memory', memoryRouter)`
  (before `/agents`). Personal memory is part of every edition.
- **No RBAC permission.** `server/config/orgRoles.json` has no memory permission; nothing calls
  `hasPermission` for memory. The Learning Center lesson `using-memory` carries `gate: {}` — visible
  to everyone.
- **The router is deliberately reachable without `requireAuth`.** Documented in the file's SECURITY
  header and pinned by `server/routes/memory.authz.test.js`: guest-chat visitors get memories under an
  opaque `guest_…` cookie id and must be able to see and delete their own. Every call is scoped on
  `getEffectiveUserId(req)` — session user id, else the guest id — and per-row access goes through
  `canAccessMemory`. An anonymous caller only ever touches their own guest bucket.
- **The one exception**: `POST /agents/memory/import` has `requireAuth` **and** a per-user rate limit,
  because it spends LLM tokens.
- **Project memory** is the only role-gated part: reads need project **viewer**, writes need project
  **editor** (`hasProjectRole`). Both checks were bugs at one point, so tests pin them.
- **Tools** `memory_search` / `memory_remember` sit behind the per-user enabled-apps preference for the
  app id `memory`, which is in `AUTO_ENABLED_APPS` and in `ORG_EXEMPT_APPS` — i.e. on by default and
  not subject to an org integration grant, because the data never leaves the instance.

---

## 8. How memory connects to the rest of the product

- **Chat** — reads memory on every turn (`contextEnrichment.resolveMemoryContext`), writes after every
  turn (`finalizeTurn`). Skipped entirely for **embed / public widget agents** so private memories
  cannot leak into a public chat.
- **Agents** — an agent can own a private memory bucket and optionally also read your general memory.
- **Projects** — a shared team pool plus an *Extract Project Memories* switch; project instructions and
  KB search travel in the same prompt assembly.
- **Routines (automations)** — an AI step with **Use my personal memory** is grounded in the *routine
  owner's* memory; routines can also call `memory_search` / `memory_remember`; "routine coverage"
  memories stop a daily digest repeating yesterday's topic (30-day TTL).
- **Privacy Shield / PII** — the read-time scrubber replaces detected personal data with labels before
  the memory block reaches a model. Note the deliberate trade-off recorded in the code: memories are
  stored **un-tokenised** (real values) because a per-conversation token like `[email_1]` would be a
  dead placeholder in another conversation — local storage, not outbound traffic.
- **Compliance / GDPR** — the DSR discovery scan reports the **count** of a person's live memories and
  never their contents (BFSF-441); `GET /agents/memory/export/all` is the registered portable export
  for the kind **"Assistant memory"** and stamps evidence for `DATA_ACT-Art25-exit-procedure`; the
  retention job + Art. 5(1)(e) check watch storage limitation; deleting a user wipes their rows.
- **Learning Center** — lesson **Using memory** (`using-memory`, group "power", ~2 min) navigates to
  `settings/memory` and highlights `[data-tour="memory-manage"]`.
- **Admin AI config** — the Memory Extraction Model selector decides which model does the background
  reading.

---

## 9. Common mistakes

1. **Confusing "Memory" with "Conversation Memory".** The org setting *Conversation Memory*
   (`/api/org-ai-context`) is about compacting a long chat. It neither writes nor reads stored memories.
2. **Expecting instant appearance.** Extraction is fire-and-forget after the reply; refresh the panel
   a few seconds later.
3. **Expecting everything to be remembered.** Questions, task requests ("write me a…"), greetings,
   very short turns and anything the model judged trivial are dropped on purpose. Cap is 5 per turn.
4. **Thinking the pause switch deletes anything.** *Memory saving paused* only stops **writing** for
   that browser/session; existing memories are still recalled.
5. **Assuming the pause switch follows you.** It is stored per browser (scoped localStorage), not on
   the server account — another device starts "on" again.
6. **Typing personal data into a memory on purpose.** Do not store a customer's IBAN, BSN or private
   address as a memory: it is stored literally, and the scrubber only hides it from the model on the
   way out. Store the *rule*, not the person's data.
7. **Using project memory as private notes.** A project's memory pool is shared with every member —
   and any editor can delete it.
8. **Expecting a per-agent memory to show up in general memory.** An agent with its own bucket writes
   only there; the Settings → Memory panel shows the general pool (plus agent rows when opened from a
   specific agent context).
9. **Editing a memory's meaning but leaving its type.** Type drives recall weight — a rule saved as
   *Fact* may never be recalled, while the same sentence as *Instruction* always is.
10. **Writing memories in Dutch and expecting them back verbatim.** The extractor is instructed to
    write memories in **English** regardless of chat language (manually added ones keep your wording).
11. **Clear All as a "refresh".** It is irreversible and empties everything; export first.
12. **Import as a file upload.** It is paste-only, 50,000 characters, and it costs an LLM call.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

### 10.1 Procurement — Bas, inkoper
Bas asks Bee Flow to draft supplier e-mails several times a week. In chat he mentions once:
*"Bij Van Dijk Groep keuren we alles boven €5.000 goed via Karin de Wit; onder dat bedrag mag ik zelf
tekenen."* After the reply, extraction stores a **Person** memory about Karin's role and, because it is
phrased as a rule, an **Instruction** about the €5.000 threshold. Two weeks later he asks for a draft
purchase order of €7.400 and the assistant adds an approval line for Karin without being told.
Bas then opens Settings → **Memory** → **Manage memories**, clicks **Add Memory** → **Instruction**, and
types *"Always ask for a delivery date and payment terms before drafting a PO."* Teaching point:
Instructions are the only type that is injected unconditionally.
*Caution to teach:* he should **not** add supplier bank details as a memory — that is exactly what the
scrubber exists to hide, and it should not be stored in the first place.

### 10.2 HR — Annelies, HR-adviseur
Annelies runs a shared **project** "Onboarding 2026" with two colleagues and ticks **Extract Project
Memories** in the project settings. During project chats the team's conventions are learned:
*"Nieuwe medewerkers krijgen in week 1 een buddy"*, *"Proeftijd is standaard 1 maand"*. Those land in
the **project** pool, visible to all three on the project's **Memory** tab, each card showing
`• by Annelies`. Her personal preference *"houd antwoorden kort en in het Nederlands"* lives in her own
general memory and is still applied inside the project, because Instructions and Preferences are the
only global types merged into a project context (max 15).
*Caution to teach:* candidate names, addresses and sickness details must never become memories — and
a read-only project member sees the pool but gets *"You have view-only access to this project, so
project memory is read-only."*

### 10.3 Sales — Youssef, accountmanager
Youssef is moving from another AI assistant. He opens Settings → **Memory** → **Import**, copies the
prompt, runs it in his old tool, pastes the 40 bullet points back and clicks **Add to memory**:
**"Added 31 memories"**, *· 2 skipped*. He then filters on **Preferences** and edits two that came over
badly. In chat he keeps the brain icon on while prospecting, but before a sensitive conversation about
a customer complaint he clicks it to **Memory saving paused** so nothing from that thread is retained.
At quarter-end he clicks **Export JSON** to keep a copy of what the assistant knows about his accounts.
*Caution to teach:* the pause switch is per browser — on his phone it starts on again.

---

## 11. List/read API endpoints for "did the learner do it?" checks

All under the server origin, mounted at `/agents/memory` (no `/api` prefix — the frontend calls
`${API_BASE}/agents/memory…`). Auth = the ordinary session cookie; the router has **no**
`requireAuth`, but every call is scoped to `getEffectiveUserId(req)`, so a check must run with the
learner's own session or it will read an empty guest bucket. Owner field on every row: **`user_id`**.

| Method | Path | Returns |
|---|---|---|
| GET | `/agents/memory?limit=&offset=&search=&type=` | `{ memories: [row…], total, limit, offset, hasMore }` — the user-global pool (`project_id IS NULL`, `status='active'`), ordered importance desc, updated_at desc. **Best check for "the learner added/edited a memory."** |
| GET | `/agents/memory/stats` | `{ total, typeDistribution: { labels: [type…], data: [count…] }, importanceDistribution: { high, medium, low } }`. **Best check for "memory is no longer empty" / "there is now at least one Instruction."** |
| GET | `/agents/memory/types` | `{ types: [{ id, label, icon, description }] }` — static catalogue of the seven types (no auth needed, no user data). |
| GET | `/agents/memory/:id` | `{ memory: row }`; 404 if unknown, 403 if not yours (`canAccessMemory`, viewer). |
| GET | `/agents/memory?agentId=<id>` | `{ memories: [row…] }`, up to 50 — that agent's bucket plus your global rows (global omitted when the agent has `memoryEnabled && !useGeneralMemory`). |
| GET | `/agents/memory?projectId=<id>` | `{ memories: [row…] }`, up to 50 — the project pool; rows additionally carry `created_by_name` and `created_by_username`. Requires project **viewer**, else `403 {"error":"No access to this project"}`. |
| GET | `/agents/memory/export/all` | `{ exportDate, userId, memories: [row…] }` (max 1000) with `Content-Disposition: attachment; filename=memories.json`. Also stamps a compliance evidence row. |

Row shape (a `SELECT *` of `user_memories`): `id`, **`user_id`** (owner), `agent_id`, `type`,
`content`, `subject`, `attribute`, `value`, `confidence`, `status` (`active` / `superseded` /
`expired`), `superseded_by`, `source_message_id`, `evidence_quote`, `last_confirmed_at`, `summary`,
`importance`, `access_count`, `last_accessed_at`, `created_at`, `updated_at`, `project_id`,
`embedding`, `source_routine_id`, `expires_at`.

Write endpoints (for completeness, not for verification): `POST /agents/memory`,
`PUT /agents/memory/:id`, `DELETE /agents/memory/:id`, `POST /agents/memory/bulk-delete`,
`POST /agents/memory/clear`, `POST /agents/memory/import` (requireAuth + 30/min).
