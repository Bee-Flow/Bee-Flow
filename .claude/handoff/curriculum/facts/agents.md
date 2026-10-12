# Fact sheet — Agents (Studio → Agents), audience: builder

Source of truth: the repo root on branch `claude/builder-redesign-fase-1-6sun0h`, read 2026-09-14.
Frontend: `agent-hub/src/components/agents/**`, `agent-hub/src/components/admin/Studio/**`.
Backend: `server/routes/agents/**`, `server/stores/agent/**`, `server/core/agentRuntime/**`.
All quoted UI strings are the real English defaults from `agent-hub/src/i18n/en-defaults.js`
(the server mirror is `server/i18n/defaults/en.js`). The product ships Dutch too; a learner
on a Dutch UI sees the Dutch translation of exactly these keys.

**The area exists and is large and mature.** ~10,900 lines of route code in
`server/routes/agents/` alone, ~9,600 lines of editor code under
`agent-hub/src/components/agents/AgentWizard/`, plus a card-grid overview, a test-set
runner, a usage ("Used by") scanner and a two-verb publish model. One caveat at the end
(§13) about a Role-tab redesign that is built and tested but **not yet mounted**.

---

## 1. What the feature is for

An **agent** is a named, reusable chat persona with its own instructions, its own knowledge,
its own tools and its own audience. The overview screen states the purpose in one line:

> "An agent answers in your words, from the knowledge and tools you give it. Open one to
> change what it knows and what it may do." (`agent_studio.intro`)

A builder creates an agent so that colleagues (or an anonymous visitor via an embed, or a
automation, or an app screen) can ask it questions and get answers grounded in company material
instead of the model's memory. Agents are the *thing other Studio features point at*: a
scheduled automation runs "through" an agent, a support inbox drafts with an agent, an app
block calls an agent, a Cowork schedule has an agent on the other end.

---

## 2. Where it lives

| What | Where |
|---|---|
| Menu | left rail → **Studio** → **Agents** (`studio.tab.agents` = "Agents", description `studio.tab.agents_desc` = "Create and manage your agents", icon = lucide `Bot`) |
| URL (list) | `/app/studio/agents` |
| URL (one agent) | `/app/studio/agents/<agentId>` — bookmarkable, deep-linkable |
| Registry entry | `agent-hub/src/components/admin/Studio/studioApps.jsx` line ~287, `id: 'agents'`, `kind: 'agent'`, `category: 'ai'`, **`gate: () => true`** (no licence gate on the section) |
| Root component | `agent-hub/src/components/agents/AgentStudio/index.jsx` |
| Consumer side | the chat shell "Agent Store" (`AgentMarketplace.jsx`, `store.title` = "Agents") and the agent picker in Agent Hub |
| API mount | `app.use('/agents', agentsRouter)` in `server/index.js:563` — so paths are `/agents/...` (the frontend prefixes `API_BASE`) |

A deliberate routing quirk: `/app/studio` with **no** segment lands on Studio **Start**;
`/app/studio/<unknown>` falls back to **Agents** (`studioRoutes.js` `sectionFromRaw`).

---

## 3. Screens, with real labels

### 3.1 Studio → Agents — the overview (card grid)

`AgentStudio/index.jsx` mode `idle` → `AgentStudio/AgentOverview.jsx`.
Loads `GET /agents/all?usage=1` (`GET /agents/system` in system mode).

- Title: **"Agents"** (`agent_studio.title`), or **"System Agents"** (`agent_studio.title_system`).
- Intro line: "An agent answers in your words, from the knowledge and tools you give it.
  Open one to change what it knows and what it may do."
- Primary button: **"New agent"** (`agent_studio.new_agent`) with a `+` icon. Only rendered
  when the viewer has `manage_agents`.
- Category filter chips, `aria-label` **"Filter by category"**: **"All"** + one chip per
  category that actually has an agent + **"No category"**. Each chip carries a count.
  A chip is only drawn for a category that has agents (`categoryChipsOf`).
- Search box: placeholder **"Search an agent…"** (`agent_studio.search_short`),
  `aria-label` **"Search agents by name, purpose or category"**.
- Loading: spinner with screen-reader text **"Loading agents"**.
- Error: **"Failed to load agents"** + **"Retry"**.
- Empty state: title **"No agents yet"**, body **"An agent answers questions in your own
  words, using the knowledge and tools you give it."**, action **"New agent"**.
- No search hit: **"No agent matches that."**
- Each **AgentCard** shows avatar, name, description, category, and a footer built by
  `AgentStudio/cardFooter.js` out of facts the server supplied:
  - `v{version}` chip when `published_version > 0` (`agent_studio.card.version`);
  - **"Answers from memory — connect a knowledge base"** (`agent_studio.card.ungrounded`) —
    server-computed `grounding` from `core/agentRuntime/agentGrounding.js`, the *same*
    function Studio Start's "Needs attention" uses, so the two screens can't disagree;
  - counts: "{n} conversations", "{n} knowledge bases", "{n} skills", "{n} tools",
    "at least {n} tools", "also in {items}" with "{n} automations / {n} apps / {n} webpages /
    {n} scheduled tasks / {n} Cowork schedules / {n} support inboxes";
  - **"Only you"** (`agent_studio.card.only_you`) — only claimed when
    `othersConversationCount === 0`, i.e. proven, never guessed;
  - unreadable variants that refuse to claim a zero: **"Configuration could not be read"**,
    **"Tools could not be read"**, **"The conversation count could not be read"**,
    **"Category unavailable"**, **"could not check: {kinds}"**, **"Edit rights unknown"**.
  - A trash icon appears only when the row's `can_edit === true` **and** the screen was
    given a delete handler.

### 3.2 "Create with AI" landing (wizard)

`AgentStudio/index.jsx` mode `wizard` → `AgentWizard/index.jsx`.
A thin bar on top of it carries **"Back to Agents"** (left) and **"Create empty agent"**
(right) — added because the landing itself draws no way out.

- Bee Flow logo, heading **"Create a new agent"** (`agent_wizard.title`).
- One prompt textarea, placeholder: *"Build an agent that answers questions in Slack and
  other chats based on the documentation I provide."* (`agent_wizard.placeholder_initial`).
  Enter submits; Shift+Enter newlines.
- A **model-tier selector** sits inside the input (defaults to tier `fast`).
- Below: **"Or start from a template"** with three rows:
  - **Teamchat Q&A** — "Answer questions in team chat using your documentation"
  - **Morning Planner** — "Plan my day from my calendar, tasks and open threads"
  - **Bug Triage** — "Score incoming bugs, set priorities and log them in the team tracker"

What actually happens on submit (`submitPromptInstant`): the wizard immediately
`POST /agents` a placeholder named **"Untitled agent"** with an empty config, then hands the
typed sentence to the editor as `initialRefinement`. So **an agent row exists before the AI
has written anything.** There is no longer a "review the plan, then build" stage.

### 3.3 The agent editor (BuilderSplit) — the main screen

`AgentWizard/BuilderSplit.jsx` (1,447 lines) + `builderSplit/*`. Full-screen, three parts:
a 48px header, an identity hero, a tab body, and a resizable AI chat rail on the right.

**Header** (`builderSplit/AgentEditorHeader.jsx`, shared `StudioSectionHeader`):

- back arrow, label **"Back to Agents"**;
- 28px tile showing the agent's **avatar** (emoji or uploaded image), falling back to a bot glyph;
- the agent **name**, click-to-rename (not a button in read-only);
- status chip **"Saved · v{version}"** (`agent_studio.header.saved_version`) — only when
  `published_version > 0`; there is deliberately no "v0";
- live save indicator: **"Saving…" / "Saved" / "Save failed" / "retry"**;
- the four tabs (see below) with counts;
- the **visibility capsule** — "Publish to…" popover: **"Personal"** ("Only you can access"),
  **"Entire organisation"** ("All members can access"), **"Or specific groups"**,
  **"No groups in this organisation yet."**, **"Choose Personal to stop sharing"**,
  **"Web embed is on — manage it in Behavior."** Widening the audience asks first:
  **"Share more widely?"** / "Everyone in your organisation will be able to see and use
  “{name}”." / **"Share"** / **"Keep as is"**;
- primary action, three cases:
  - read-only → nothing;
  - unsaved draft (no id) → **"Save"** / **"Saving…"**;
  - saved agent → a LIVE/DRAFT status pill whose action is **"Publish"** (never published) or
    **"Publish new version"** (already live);
- read-only chip: **"Read-only — you don't have permission to edit this agent."**

**Hero** (`builderSplit/AgentHero.jsx`), directly under the header:

- 56px avatar tile with a pencil badge (opens the AvatarPicker: **"Avatar"**, **"Upload
  image"**, **"Remove"**, error **"Image must be under 512KB"**);
- name field, placeholder **"Agent name"**;
- category tag (`CategoryField variant="tag"`), unreadable → **"Category unavailable"**;
- description textarea with counter **"{count}/300 · Shown in the agent picker"** — hard
  clamped at **300 characters** client-side;
- two read-only chips: **"Model tier"** (gauge icon, e.g. "Fast") and **"Answers in"**
  (languages icon, from `persona.language`). A chip that can't be justified isn't drawn.

**Tabs** (`AGENT_TAB_IDS`, artboard order, "Used by" always last):

| id | label | icon | count badge |
|---|---|---|---|
| `role` | **"Role"** | UserRound | — |
| `can-use` | **"Can use"** | Wrench | knowledge + skills + apps |
| `test` | **"Test"** | FlaskConical | — |
| `used-by` | **"Used by"** | Link2 | number of consumer rows |

A count that could not be read renders **nothing**, never a `0` (`countOrNothing`).

**Tab "Role"** (`builderSplit/BuilderConfigPanel.jsx` — what ships today):

- a model-tier selector;
- action pills with counts: **"Browse apps"**, **"Upload files"**, **"Skills"**, and (when
  the agent is saved and `agent_routines` is allowed) **"Routines"**;
- a gear button opening **"Advanced settings"**;
- the instructions block: **"Instructions"**, placeholder *"Give your agent instructions on
  how it should behave."*, hint **"Click to edit"**;
- **"Add description & category"** / **"Hide details"** with **"Role description"**
  ("A short description of what this agent does. Shown to users in the agent picker."),
  **"Category"**, **"New category"**, **"Create"**, **"Manage categories"**, **"Rename"**.

**Tab "Can use"** — three cards:

1. **Knowledge** — "Where it looks before it answers".
   Rows for knowledge bases ("{n} documents", "updated {when}") and datatable grants
   ("live", "only the asker's own rows" / "all rows", "reads, does not write").
   Empty: **"Nothing linked yet — this agent answers from its instructions alone."**
   Over-limit: "{n} more tables are stored but the agent never reads them — a run honours
   the first 25."
   Tip card: **"Meeting notes can add themselves"** / "Give a knowledge base a meeting tag
   and every note carrying that tag becomes knowledge on its own — no upload, no copy." /
   **"Set the tag"**.
2. **Skills** — "The working methods it follows". Rows show "{n} steps", "{n} rules",
   "also used by {n} other agents". Empty: **"No skills attached yet — the agent works from
   its instructions alone."**
3. **Tools** — "What it may do in other apps". Per app: "{granted} of {count} actions",
   **"Nothing switched on"**, **"+{n} more"**, **"Choose actions for this app"**.
   Two switches per app:
   - *whose connection*: **"As: the person asking"** ("Everyone uses their own connection."),
     **"As: you"** ("Everyone borrows your connection — never for actions that send."),
     **"As: Bee Flow"** ("This app uses no personal connection.");
   - *when this app is used*: **"Direct"** vs **"Confirm first"**, with the lock
     **"This app can send, so a person always confirms first."**
   Empty: **"No apps switched on yet — this agent answers, it does not act."**
   Band **"Automations as a tool"** lists granted automations ("asks for", "required",
   "This automation has no agent trigger, so the agent is never offered it.").

   The **tool chooser** behind "Choose actions": title **"Choose apps & actions"**, search
   **"Search apps and actions"**, filters **"All" / "Reads" / "Writes" / "Sends"**,
   **"Switch all on" / "Switch all off"**, footer **"Apply changes"** / **"Nothing to
   change"**, and on the first curation the warning: *"This is the first time you limit this
   agent: from now on it gets only what is ticked here, and actions that send always ask a
   person first."*

**Tab "Test"** (`tests/TestSetCard.jsx`, `useAgentTests.js`):

- Card **"Test set"** — "Questions this agent should keep answering well".
- Empty: **"No questions yet — turn an answer you liked into the first one."**
- Buttons **"Run"**, running **"Running… {done} of {total}"**, score
  **"{passed} of {total} passed"**, **"Earlier runs"**, **"View"**,
  **"Only the last {count} runs are kept."**, **"Not run yet"**.
- Test fields: **"Question"**, **"Name (optional)"**, **"Must get across"** ("One per line.
  A paraphrase counts — this one is judged by an AI, not matched word for word."),
  **"Must never say"** ("One per line, matched word for word. Nothing is proposed here — a
  prohibition is a rule you write."), **"Should use these tools"**, **"Anything else"**.
- From a chat turn: **"This conversation as a test"**, **"Turn this answer into a test"**,
  **"An AI read that answer and proposed what this test should expect. Read it before you
  save — it becomes what the test guards."**, **"Save as test"**, and provenance chips
  **"AI wrote this"** / **"Judged"**.
- Version honesty: **"This answer came from the published agent, not from your draft."**,
  **"Live is v{version}, with {count} unpublished changes."**, **"about v{version}"**,
  **"{count} unpublished changes since"**.
- On an unsaved draft the tab shows an empty state instead: **"Test questions land here"** /
  "Ask this agent a set of questions and see what it answers before anyone else does."

**Tab "Used by"** (`shared/UsedByTab`, fed by `GET /agents/:id/usage`):

- Empty: **"Nothing uses this agent yet."**
- Failure: **"Could not load who uses this agent, so nothing is claimed here."** + **"Retry"**
  (the empty sentence is *not* drawn on a failure).
- Rows owned by someone else come back **counted but not named** (`title: null,
  foreign: true`).

**AI refine rail** (right side, `builderSplit/BuilderChatPanel.jsx`, hidden in read-only):

- Empty state **"Refine this agent with AI"** / "Tell me what to change — I'll update the
  instructions, knowledge, or behaviour."
- Suggested prompts: **"Make the tone more friendly"**, **"Add a step to summarise the result
  at the end"**, **"Always answer in Dutch unless asked otherwise"**.
- Input placeholder **"Ask me to change anything about this agent"**, **"Send"**,
  **"Updating…"**.
- After a change, a **"Done"** card lists exactly what moved: "Rewrote the instructions",
  "Renamed the agent", "Updated the description", "Changed the avatar", "Changed the model",
  "Turned on {n} apps", "Attached {n} skills", "Added {n} knowledge bases", …, or
  **"Nothing changed — the agent already worked that way."** With **"Undo"** /
  **"Undone"** / **"Undo unavailable — no restore point was saved"** /
  **"Undo unavailable — a newer change came after this one"**, plus **"Test with a question"**
  and the standing disclaimer **"AI can make mistakes. Please verify important information."**

**Advanced settings drawer** (`pickers/AdvancedDrawer.jsx`, 400px, right slide-in):

- **"Behavior"** — **"Allow copying"**, **"Disable integrations & web search"**
  ("Block all integration tools and web search for this agent."), **"Memory"** /
  **"Memory · on"** ("…this agent saves memories to its own private bucket — not your
  general memory."), **"Also read from your general memory"**.
- **"Embed & bubble"** — **"Web embed"** ("Public standalone chat page for embedding."),
  **"Public URL"**, **"Iframe snippet"**, **"Bubble color"**, **"Position"**, **"Icon"**,
  **"Copy"/"Copied"**, **"Save the agent first to get the embed URL."** Turning it on asks:
  **"Make this agent public?"** — *"Anyone who knows the URL will be able to chat with this
  agent without an account. The agent will run with its full configuration: system prompt,
  attached skills, and knowledge bases."* → **"Enable public access"**.
- **"Version History"** (only on a saved agent) — restore an earlier snapshot.
- **"Compliance"** — the AI-Act ladder block for this agent.

**Conflict modal** (two tabs / two people): **"This agent changed elsewhere"** —
"Someone (or another tab) saved this agent since you opened it. Choose how to continue:" →
**"Load latest"** (discards your unsaved edits) or **"Keep mine"** (overwrite).

### 3.4 Delete dialog (from the overview card)

Stage 1: **"Delete agent"** / *"Delete agent "{name}"? This cannot be undone."* /
**"Cancel"** / **"Delete"**. Cmd/Ctrl+Enter confirms, Escape cancels.

Stage 2 (after a 409), two different headings:
- **"This agent is still in use"** + *"Deleting it does not stop the things below. They keep
  running without this agent — without its knowledge, its tools and its guardrails."*
- **"Could not check what uses this agent"** + *"The check did not finish, so what still uses
  this agent is unknown. Deleting now is a decision made without that answer."*
Button becomes **"Delete anyway"** (re-sends with `?confirm=1`).

### 3.5 The consumer side (for context)

Agent Store / picker (`AgentMarketplace.jsx`): **"Agents"**, "{visible} of {total} agents",
**"Search agents..."**, tabs **"Popular" / "Last Used" / "Favorites" / "All"**,
**"Agent Editor"**, **"No agents found"** / "Try adjusting your search or filters." /
**"Clear filters"**. The card subtitle there is the agent's `description` — which is why the
hero counter says "Shown in the agent picker". The Android app shows the same field as the
row subtitle.

---

## 4. Concepts a learner must understand

| Term | Plain-language definition |
|---|---|
| **Agent** | A saved chat personality: a name, an avatar, instructions, a model tier, linked knowledge, attached skills, granted app actions and an audience. Row in the `agents` table. |
| **Concept (draft) vs live** | Editing always writes the *concept*. Once you have published a version, the runtime serves `published_config` / `published_system_prompt` instead, and your edits reach nobody until the next "Publish new version". Before the first publish-version the runtime just follows the concept. |
| **Two publish verbs** | **Audience** = who may see/chat with it (`PATCH /agents/:id/publish`, the visibility capsule). **Content** = which configuration actually runs (`POST /agents/:id/publish-version`, the Publish button). They are different buttons on purpose. |
| **`unpublishedChanges`** | `rev − published_rev`: how many saves your draft is ahead of what people are getting. Shown as "{n} unpublished changes since". Zero until the first publish-version. |
| **Persona** | The structured role stored in `agents.persona`: `who`, `tone.chips` + `tone.text`, `does[]`, `doesNot[]`, `unknown.mode`, `language`, plus `mode: 'fields' | 'free'`. The server renders it into the system prompt (`core/agentRuntime/personaPrompt.js`). |
| **Fields mode vs free mode** | In *fields* mode the structured fields are the source and the prompt is generated from them. In *free* mode one block of text **is** the prompt and the fields only describe it; getting back to fields is an explicit AI parse (`POST /agents/:id/persona/parse`), never a silent back-translation. |
| **`unknown.mode`** | What the agent does outside its knowledge: `honest` ("Say honestly that it does not know"), `web` ("Search the web" — needs the web-search app switched on), `handoff` ("Hand it to a person" — starts an automation you pick). |
| **Grounding** | Whether the agent has anything to look in (a knowledge base or a datatable grant). No → "Answers from memory — connect a knowledge base". Unreadable → say nothing. One function, three readers. |
| **Knowledge base (KB)** | A document collection the agent searches before answering. Linked by id in `config.knowledge_base_ids`. |
| **Strict knowledge** | "Only answer from the knowledge base" — refuses questions the linked documents don't cover. A datatable grant alone does **not** count as knowledge for this. |
| **Skill** | A reusable working method (steps/rules, optionally linked to an automation) attached to the agent via `config.attachedSkillIds`. |
| **Tool / action** | One callable operation inside an app (e.g. "send a Gmail message"). `config.tools[appId].actions` is the allow-list. |
| **Curation rule (critical)** | An app that is **not mentioned** in `config.tools` keeps its **whole** toolbelt. Switching an app off means writing `{ actions: [] }`, not deleting the key. Building the map from only the ticked apps silently re-grants everything you unticked. |
| **`confirm`** | `direct` = the agent just does it; `ask` = a person confirms first. Anything that *sends* is locked to `ask`. |
| **`actAs`** | Whose connection the app uses: `viewer` (everyone their own) or `owner` (everyone borrows yours — never for sending actions). Unknown is not "platform". |
| **Datatable grant** | `config.tools.datatables[tableId] = { scope: 'own'|'all', columns }`. Read-only, enforced at both ends of `datatable_query`. |
| **Test set** | Questions plus expectations (`must mention` / `must never say` / expected tools / notes) stored on the agent, replayed through the real runtime in a sandbox and graded by the fast tier. |
| **Test sandbox** | A run only ever *removes* capability: nothing is written to a conversation (`ephemeral`), everything that sends is dropped, automations are dropped, and confirm-tools are dropped (`testSandbox: true`, `unattended: true`, `autoSend: false`). |
| **"Test as · group X"** | Replays the set with the knowledge a member of one group would have. Refused rather than downgraded if the group can't be resolved; the score is **not stored**. |
| **Used by** | Everything that would break if the agent disappeared: scheduled tasks, Cowork schedules, support inboxes, automations, apps, webpages — plus other people's conversations. |
| **`can_edit`** | The server's own per-agent verdict, attached to every row, so the client renders read-only editors from the same rule the API enforces. |
| **Embed** | A public standalone chat page for one agent. Needs `is_published` **and** `embed_enabled`. Anyone with the URL chats without an account. |

---

## 5. End-to-end workflows (exactly as a user clicks)

### W1 — Create an agent with AI, then publish it (the happy path)

1. Left rail → **Studio** → **Agents**.
2. Click **New agent** (top right).
3. The "Create a new agent" landing opens. Type one sentence describing the agent, e.g.
   *"Answer purchasing questions from our supplier contracts and the price list."*
   (or click one of the three templates).
4. Optionally change the model tier in the input's tier selector (default **Fast**).
5. Press Enter (or the ↑ button). An agent row named **"Untitled agent"** is created and the
   editor opens; the AI starts writing from your sentence.
6. Watch the right rail: when it finishes it shows a **"Done"** card listing what it changed
   ("Rewrote the instructions", "Renamed the agent", …). Read it. If it is wrong, click
   **Undo**.
7. In the hero, fix the **name**, the **avatar** and the **description** (max 300 chars —
   this is what colleagues read in the agent picker).
8. Go to the **Can use** tab. Under **Knowledge**, click **Link** and attach the knowledge
   base with the relevant documents (or use **Upload files** on the Role tab to create one).
9. Under **Tools**, click **Choose actions for this app** for each app it needs, tick only
   the actions it should have, and press **Apply changes**. Note the first-curation warning.
10. Go to the **Test** tab, write two or three questions you know the answer to, press **Run**.
11. Open the **visibility capsule** in the header, choose **Entire organisation** (or pick
    groups), confirm **Share** in the "Share more widely?" dialog.
12. Press **Publish** in the header. The chip becomes **"Saved · v1"** and the button becomes
    **"Publish new version"**.

### W2 — Change a live agent without breaking it

1. Studio → Agents → click the agent's card.
2. Edit whatever you need. The save pill shows **Saving… → Saved**; autosave debounces **700 ms**.
3. Notice the header still says **"Saved · v1"** — your change is **not** live yet.
4. Open the **Test** tab. The tab tells you which agent the last run described:
   "Live is v1, with 3 unpublished changes."
5. Press **Run** and read the score. (Careful: a run exercises the **published** agent, not
   your draft, whenever a published version exists.)
6. Happy → press **"Publish new version"**. The chip becomes "Saved · v2".
7. Unhappy → open **Advanced settings → Version History** and restore an earlier snapshot.

### W3 — Give an agent a tool, safely

1. Open the agent → **Can use** tab → **Tools** card.
2. If the app isn't there yet, use **Browse apps** on the Role tab to switch it on.
3. Click **Choose actions for this app**.
4. Use the **Reads / Writes / Sends** filter to see what each action does.
5. Tick only what the agent needs. Untick everything to switch the app off entirely.
6. Press **Apply changes** — the footer shows "{n} actions added / removed".
7. Back on the card, set **"When this app is used"**: **Direct** or **Confirm first**.
   Sending actions are locked to "Confirm first" and say so.
8. Set **whose connection**: **"As: the person asking"** (default, everyone uses their own)
   or **"As: you"** (only offered if you actually lent a connection for that app).
9. Publish a new version so the grant reaches the people using the agent.

### W4 — Build a test set from a real answer

1. Open the agent → use the **AI refine rail** or the Test tab's chat to ask the agent a
   real question.
2. On the answer, click **"This conversation as a test"**.
3. The dialog **"Turn this answer into a test"** opens; an AI proposes what a good answer
   must get across ("Reading that answer…"). It is a *proposal* — the banner says so.
4. Edit **"Must get across"** (paraphrase counts, AI-judged) and add anything to
   **"Must never say"** (matched word for word — nothing is proposed here).
5. Trim **"Should use these tools"** to the ones you really want to require.
6. Press **Save as test**.
7. Press **Run**. Read **"{passed} of {total} passed"** and the per-row reasons
   ("Did not get across everything this test asks for.", "Did not use: {names}").
8. Open **Earlier runs → View** for history — remember only the last **20** runs are kept.

### W5 — Publish to a specific group only

1. Open the agent → click the **visibility capsule** in the header.
2. The popover says **"Publish to…"** / "Choose who can see this."
3. Pick **"Entire organisation"**, or scroll to **"Or specific groups"** and tick groups.
4. A widening change asks **"Share more widely?"** — press **Share**.
5. To un-share, pick **Personal** ("Choose Personal to stop sharing").
6. Verify on the **Used by** tab: its `audience` says private / groups / organization.
7. Remember: audience ≠ content. If the agent has never had a **Publish**, colleagues get
   nothing even after you share it — the runtime serves the published version once one exists,
   and the *concept* until then.

### W6 — Retire an agent

1. Studio → Agents → hover the card → trash icon (only if you may edit it).
2. Confirm **Delete agent**.
3. If anything still uses it, you get **"This agent is still in use"** with the list
   (automations, apps, webpages, scheduled tasks, Cowork schedules, support inboxes) — other
   people's items are counted but not named.
4. Fix those first (repoint the automation, remove the app block). Re-try the delete.
5. If you truly must, press **"Delete anyway"**. Nothing is scrubbed afterwards: a scheduled
   task loses its agent and starts running as a bare prompt task, and **colleagues'
   conversations with this agent are deleted with it**.

---

## 6. Defaults and limits (the numbers)

| Thing | Value | Source |
|---|---|---|
| Autosave debounce | **700 ms** (`DEBOUNCE_MS`) | `state/useAgentAutosave.js` |
| Description (hero) | **300** characters, hard-clamped | `builderSplit/AgentHero.jsx` |
| Avatar image upload | **< 512 KB** | `agent_wizard.avatar.too_large` |
| Persona `who` | **600** chars | `personaPrompt.js` LIMITS |
| Persona tone free text | **400** chars | idem |
| Persona tone chips | **12** max, **60** chars each ("Twelve tone words is the maximum this agent keeps") | idem |
| Persona bullets (`does` / `doesNot`) | **20** each, **300** chars each ("Twenty lines is the maximum…") | idem |
| Persona free text | **20 000** chars | idem |
| Built-in tone chips | `formal`, `friendly`, `concise`, `amounts in euros`, `Dutch unless asked otherwise` — stored in stable English because they go straight into the prompt | `personaFacts.js` / `personaPrompt.js` |
| Datatable grants honoured per run | **25** (`MAX_DATATABLE_GRANTS`) | `core/agentRuntime/toolPolicy.js:143` |
| Actions listed per app in the catalog | **500** (`MAX_ACTIONS_PER_APP`) | `routes/agents/toolCatalog.js` |
| Tests stored per agent | **100** (`MAX_TESTS_PER_AGENT`) | `core/agentRuntime/testSandbox.js:90` |
| Tests run per press | **25** (`MAX_TESTS_PER_RUN`) | idem:88 |
| Test runs kept per agent | **20** (`TEST_RUNS_KEEP`), older pruned on write | idem:92 |
| Test question length | **2 000** chars; name 120; list items 20 × 200 chars; notes 1 000 | `testSandbox.js` LIMITS |
| Streamed test answer | **8 000** chars; grading ≤ **400** tokens; suggestion ≤ **300** tokens | `routes/agents/tests.js` |
| Rate limit — test edits | **60/min/user** | `routes/agents/tests.js` |
| Rate limit — test runs | **4/min/user** | idem |
| Rate limit — test suggest | **12/min/user** | idem |
| Rate limit — wizard (draft/refine/commit) | **30/min/user** | `routes/agents/wizard.js` |
| Rate limit — chat stream | **60/min/user**; embed metadata **100/min** | `routes/agents/chat.js` |
| Default model tier | **`fast`** (the project convention: `standard` is never used) | `AgentWizard/index.jsx`, `BuilderSplit.jsx` |
| Default bubble colour / position / icon | `#6b7280` / `right` / `💬` | `BuilderSplit.jsx` |
| Default toggles on a new agent | `allowCopy` on, `threads_enabled` on, `workspace_enabled` off, `embed_enabled` off, `memoryEnabled` off, `useGeneralMemory` true when memory is on, `enabledIntegrations: []` | `BuilderSplit.jsx`, `AgentStudio/index.jsx` |
| Agents per organisation | plan field **`max_agents`**; the seeded **Free** plan is `max_users 3, max_agents 1, max_knowledge_sources 5`. Inclusive cap: the (N+1)th create is refused. | `server/seed-plans.js`, `core/entitlements/limits.js` |
| `usage=1` on the list | opt-in; without it the `usage` field is **absent**, not empty | `routes/agents/published.js` |

Legacy quirk worth teaching: `config.enabledIntegrations === null` on an old agent means
"all available are enabled". New agents are created with `[]`.

---

## 7. What happens on failure

The whole area follows one house rule: **unknown is never rendered as zero.**

- **List load fails** → "Failed to load agents" + Retry. The agent list never 500s on a
  degraded stats pass: `stats: null`, `usage: partial` instead.
- **Save conflict (409)** → the "This agent changed elsewhere" modal. No auto-retry: pick
  "Load latest" (discards your edits) or "Keep mine" (re-sends with the server's version as
  the CAS base).
- **Save refused with `code: 'agent_not_editable'` (403)** → the editor flips itself into
  read-only (`forcedReadOnly`) rather than retry-looping.
- **Plan limit hit on create** → `403 { code: 'limit_reached', resource: 'agents' }` →
  **"Plan limit reached"** + **"View plans & upgrade"**.
- **Publish-version on a system/swarm agent** → `409 system_agent_follows_live`
  ("System agents always run their live configuration and cannot be published as a version.")
- **Publish with a stale reference** → re-validated against the **owner**, not the publisher.
  A cross-org KB hard-fails (400); unresolvable skills are **dropped in the published copy
  only** and come back as `warnings`; tool grants are clamped the same way. The concept is
  never rewritten behind the editor's back.
- **Publish response unreadable** → the header version chip stays where it was. No optimistic
  bump — "v?" would claim a publication nobody saw.
- **Test run refusals** (each has its own sentence): no grader model configured, plan has no
  room, workspace/plan check failed, nothing to run, model lookup failed, too many tests,
  result could not be saved ("so this score is not kept"), run stopped part-way
  ("What you see below is what had already been tested").
- **A test run that did not finish is not stored at all** — a partial "3 of 3 green" is the
  most misleading row this table could hold.
- **A "Test as · group" run is never stored** — a deliberately narrowed score is not a verdict.
- **Usage scan degraded** → `unchecked` names every kind it could not answer; the tab says
  "could not check: {kinds}" and the delete guard treats unchecked as *in use*.
- **Delete of something in use** → `409 { code: 'in_use', usage, counts, chat, audience,
  unchecked }`; the second attempt needs `?confirm=1`.
- **KB / skill / catalogue read fails** → "Could not load the knowledge bases…", "Could not
  load the app catalogue…", "Could not check which apps you are allowed to use…". The cards
  never turn a failed read into "nothing linked".
- **Persona unreadable** → "The role of this agent could not be read here, so these fields are
  not shown. That is not the same as the agent having no role."
- **Undo after a refine** → only available if a pre-refine snapshot was actually taken:
  "Undo unavailable — no restore point was saved" / "— a newer change came after this one".
- **Access revoked mid-session** → `POST /agents/:id/chat/stream` re-validates group/org
  membership from the database on *every* message, so a revoked user is cut off without a
  page reload.

---

## 8. Permission and licence gates

**Permissions** (`server/config/orgRoles.json`, checked with `requirePermission(...)` /
`hasPermission(...)` server-side and `hasPermission(...)` / `useCan(...)` client-side):

| Org role | Has `manage_agents`? | Notes |
|---|---|---|
| **Organisation Admin** (`org_admin`) | yes | plus `admin_agents`, `admin_agents_system`, `admin_agents_pipeline` |
| **Agent Admin** (`agent_admin`) | yes | `admin_agents`, `admin_agents_chat`, `admin_agents_pipeline` |
| **Agent Editor** (`agent_editor`) | yes | **cannot modify unpublished drafts owned by others** |
| **Member** | no | may chat with published agents; `use_notebooks`, `use_datatables` only |
| **DPO / ISMS Auditor** | no | compliance/monitoring only |

`manage_agents` guards: `POST /agents`, `PUT /agents/:id`, all category mutations,
`PUT /agents/:id/tools/:componentId/params`, `PUT /agents/:id/transfer`, `GET /agents/all`,
every `/agents/:id/tests*` route, and every `/agents/wizard/*` route.

**`canModifyAgent`** (`routes/agents/crud.js`) is the single authoritative per-agent write
gate, in this order:
1. the **owner** always may (checked first — an owner without `manage_agents` keeps their flows);
2. **super-admin** bypass;
3. everyone else needs `manage_agents` **and** membership of the agent's organisation
   (BFSF-271 closed a cross-org IDOR here);
4. **org-less** agents (system / swarm / personal drafts) are owner-or-super-admin only;
5. an **Agent Editor** may not touch someone else's **unpublished** draft.

**`canReadAgent`**: owner, or `owner_id === 'system'|'swarm'`, or `canSeePublished(agent,
{userId, orgIds, userGroups})`. A read you may not do returns **404**, never 403 — "you may
not" and "it does not exist" must not be distinguishable.

**Licence / entitlement gates:**
- The Agents section itself is **not licence-gated** (`gate: () => true`). Agents are core.
- `useCan('agent_routines')` gates the **Routines** action pill inside the editor.
  `agent_routines` is a **Community** licence feature (`server/license/tiers.js`) and a **GA**
  beta feature (`core/entitlements/betaFeatures.js`); `aiTaskRunner` re-checks the org beta
  before it runs an automation.
- `GET /agents/tool-catalog` deliberately carries its own `requireAuth` (it is a *per-user*
  answer — which apps *you* may use — so it is not in the "metadata, no user data" exemption).
- Quantitative gate: plan `max_agents` via `checkResourceLimits(orgId, 'agents', count)`.
- Writes are blocked entirely for a **suspended/archived org**
  (`requireActiveOrgForMutations()` on the CRUD and publish-version routers); reads still work
  so customers can export.
- Publishing emits `AGENT_PUBLISHED` on the compliance bus (AI-Act Art-50 disclosure, Art-35
  DPIA) instead of waiting for the 6-hour sweep. The **Compliance** section in the Advanced
  drawer is the agent's own AI-Act ladder.

---

## 9. How agents connect to the rest of the product

- **Knowledge Studio** — `config.knowledge_base_ids`. "Upload files" in the editor creates
  documents in a KB immediately (before the agent is saved): *"Files are stored in a knowledge
  base right away — save the agent to keep them linked."*
- **Meeting notes** — a KB with a meeting tag absorbs every note carrying that tag, so the
  agent gains knowledge with no upload.
- **Datatables** — read-only table grants with row scope and column list, enforced by
  `core/tools/datatableTools.js`.
- **Skills Studio** — `config.attachedSkillIds`; a skill can itself be linked to an automation.
- **Automations (automations)** — three separate relationships: (a) an automation *uses* the agent
  (shows up in "Used by"); (b) the agent *calls* an automation as a tool (only automations whose
  trigger is an agent call qualify); (c) the persona's `unknown.mode = 'handoff'` hands the
  question to an automation — checked against the agent's **owner**, not you.
- **Scheduled tasks / Cowork / Support inbox / App Studio / Webpages** — all can bind an agent;
  all six are the `KINDS` the usage scanner checks (`task, cowork, support, automation, app,
  webpage`).
- **Agent Hub chat** — where people actually talk to the agent; also the legacy editor
  (`AgentDesignerPanel` → `AgentEditorUI`) reachable in design mode.
- **Mobile (Expo)** — reads the same `GET /agents/:id` runtime projection, so profile and chat
  agree with the web.
- **Embed / bubble** — `GET /agents/:id/embed` serves a public page for `is_published &&
  embed_enabled` agents; 404 for everything else so IDs can't be enumerated.
- **Studio Start "Needs attention"** — shares `agentGrounding.js` with the card footer.
- **Versions** — `POST /versions/:id/pre-refine` creates the undo point; published versions are
  stored as `kind: 'published'` snapshots and never pruned.
- **Usage / cost** — a test chat writes no conversation row, so it is counted separately
  (`testChats`) and never added to the conversation count.

---

## 10. Common mistakes

1. **Confusing the two publishes.** Sharing with the organisation (capsule) does not ship your
   edits; "Publish new version" does. The header deliberately shows both.
2. **Believing the Test tab tested your draft.** Once a published version exists, a run
   exercises the **published** agent. The tab says so ("This answer came from the published
   agent, not from your draft.") — read it.
3. **Unticking apps by deleting the key.** An app absent from `config.tools` keeps its whole
   toolbelt. Off means `{ actions: [] }`. (This bit the automations section once already: unticking
   every automation handed back *all* of them.)
4. **Opening an old agent's tool chooser and pressing Apply.** A pre-chooser agent opens with
   the chooser expanded to "everything"; if the expansion were skipped the first save would
   silently strip all its tools. Check the delta line before applying.
5. **Assuming "As: you" always applies.** If you never lent a connection for that app it falls
   back: "Saved as “you”, but there is no lent connection for this app — it runs as the person
   asking."
6. **Expecting "Never does" to block anything.** The card says it plainly: *"These lines go into
   the instructions and the model follows them — nothing here blocks the action. What an agent
   truly cannot do is what it was never given."* Remove the tool, or set it to confirm first.
7. **Picking "Search the web" for unknowns without switching on the web-search app.** Then the
   agent still just says it does not know.
8. **Setting both a fixed reply language and the "Dutch unless asked otherwise" tone chip.**
   The UI flags the clash — keep one.
9. **Writing 21 bullets or 13 tone chips.** The server clamps; the client mirrors the clamp so
   you see the refusal *before* saving, not after.
10. **Leaving the description empty.** It is what colleagues read in the agent picker and what
    the Android app shows as the row subtitle.
11. **Deleting an agent to "clean up".** Consumers are not scrubbed; a scheduled task keeps
    running without the agent's knowledge, tools and guardrails, and colleagues' conversations
    are destroyed.
12. **Reading a missing count as zero.** Counts, footers and tabs all render *nothing* when the
    answer is unknown. "Only you" means proven-nobody-else, not "no data".
13. **Turning on the web embed without reading the confirmation.** Anyone with the URL chats
    with the agent's full configuration — prompt, skills and knowledge — without an account.
14. **Renaming instead of merging a category.** Deleting a category in use 409s with a count and
    offers "Remove the category from these agents" or "Move them to" — use that, and note that
    creating a duplicate name just selects the existing one ("Category already exists — selected
    it.").

---

## 11. Three realistic scenarios — Van Dijk Groep (Dutch SME)

### S1 — Procurement: "Inkoopassistent Van Dijk"

Inkoper Marloes has 40 supplier contracts and a quarterly price list in a knowledge base
called *Inkoop – contracten & prijslijst*.

1. Studio → Agents → **New agent** → types: *"Beantwoord vragen over onze leveranciers­contracten
   en prijslijst: levertijden, staffelkortingen, opzegtermijnen. Noem altijd het contract waar
   het antwoord vandaan komt."*
2. Renames it **Inkoopassistent**, avatar 📦, description *"Antwoordt over contracten,
   staffelkortingen en levertijden — met bronvermelding."*
3. **Can use** → Knowledge → links *Inkoop – contracten & prijslijst*, switches on
   **"Include source references"**, and (Role tab) sets **"Only answer from these documents"**.
4. Tools: none — this agent answers, it does not act. The card says so:
   "No apps switched on yet — this agent answers, it does not act."
5. Test set: *"Wat is de opzegtermijn bij Heijmans Staal?"* (must get across: 3 maanden,
   schriftelijk), *"Geldt er staffelkorting boven 500 stuks?"*, *"Wie is onze contactpersoon bij
   Aluro?"* (must never say: a phone number). Runs → 3 of 3 passed.
6. Capsule → specific group **Inkoop**. Then **Publish**. Header: "Saved · v1".
7. Two weeks later the new price list lands. She uploads it to the same KB, tests again,
   presses **Publish new version** → "Saved · v2".

*Teaching value*: strict knowledge, source references, a grounded agent, a narrow audience,
and the difference between changing the KB (instant) and changing the agent (needs a publish).

### S2 — HR: "HR-vraagbaak" with a hand-off

HR-adviseur Pieter wants an agent that answers personnel-handbook questions but never guesses
about individual cases.

1. New agent from the HR handbook KB, tone chips **Friendly** + **Dutch unless asked otherwise**.
2. Role → "If it doesn't know" → **"Hand it to a person"**, picks the automation
   *HR-vraag doorzetten* (which mails the HR mailbox). The card warns that the automation is
   checked against the agent's **owner**, so Pieter must own both.
3. Tools: **none that send.** He switches Gmail off entirely. (Had he granted a send action, the
   card would lock it to **"Confirm first"** — "This app can send, so a person always confirms
   first.")
4. Privacy check, and it is the load-bearing lesson: the hand-off automation may carry only a
   **ticket reference**, never the employee's name, e-mail, or the literal question. The project
   rule is: personal data leaves Bee Flow only by e-mail to the person themselves.
5. Test set includes a deliberately personal question — *"Hoeveel vakantiedagen heb ík nog?"* —
   with **"Must never say"** containing a made-up number, to prove the agent hands off instead
   of inventing.
6. Capsule → **Entire organisation** (confirm "Share more widely?") → **Publish**.

*Teaching value*: `unknown.mode = handoff`, the owner-check trap, the send-lock, and writing a
prohibition test (word-for-word, never AI-proposed).

### S3 — Sales: "Offerte-assistent" with a tool, and a near-miss

Accountmanager Sanne wants an agent that drafts quotation e-mails and logs them.

1. New agent, knowledge: *Sales – productbladen & tarieven*.
2. **Can use → Tools → Choose actions for this app** (Gmail). She filters on **Sends**, sees
   `gmail_send_message`, and ticks only `gmail_create_draft` — the draft action, not the send.
3. She reads the first-curation warning: *"This is the first time you limit this agent: from now
   on it gets only what is ticked here, and actions that send always ask a person first."*
4. She sets **"As: the person asking"** so every colleague drafts from their own mailbox — not
   from hers.
5. She grants the datatable *Offertes 2026* with scope **"only the asker's own rows"**, columns
   limited to klant / product / bedrag / status. The card confirms **"reads, does not write"**.
6. Test run: one question exercises the Gmail draft. The result comes back **blocked** with
   *"A test run never uses {names}, so this could not be checked."* — the sandbox drops
   everything that sends. She learns that tools of this kind are verified in a real chat, not in
   the test set.
7. Capsule → group **Sales** → **Publish**. On the overview her card now reads
   *"12 conversations · 1 knowledge base · 2 tools · also in 1 automation"*.
8. A month later a colleague tries to delete the agent during a clean-up and gets
   **"This agent is still in use"** listing the automation plus a counted-but-unnamed app someone
   else built. He repoints the automation first.

*Teaching value*: per-action curation, `actAs`, datatable row scope, why sending tools are
invisible in a test run, and the delete guard.

---

## 12. List/read API endpoints a "did the learner do it?" check can call

All under the `/agents` mount (`server/index.js:563`); the browser sends the session cookie.
`getEffectiveUserId` turns an anonymous caller into a throw-away guest id, so an unauthenticated
call yields nothing useful rather than an error — **always call these authenticated.**

| Method + path | Auth | What the JSON row contains |
|---|---|---|
| `GET /agents` | session | Array of the caller's **own** agents (`owner_id = you` **or** `owner_id = 'system'`), ordered `updated_at DESC`. Row = the `agents` columns: `id, name, description, system_prompt, model, **owner_id**, is_published, starter_prompts, avatar, threads_enabled, copy_enabled, workspace_enabled, embed_enabled, config (parsed), organization_id, shared_groups (parsed array), category_id, rev, published_version, created_at, updated_at`, plus `tools[]`. `published_config`/`published_system_prompt` are stripped; `persona` is stripped on list reads. |
| `GET /agents/all?usage=1` | session + **`manage_agents`**; filtered to the caller's orgs | Every non-system agent in the org. Same row plus `can_edit` (bool), `grounding` `{hasKnowledgeBase, hasDatatable, verdict}`, `stats` `{conversationCount, userCount, othersConversationCount, lastUsedAt}` or `null`, and — only with `?usage=1` — `usage` `{task, cowork, support, automation, app, webpage, partial}`. **This is the best endpoint for "did they create agent X".** |
| `GET /agents/published` | session (works signed-out; returns nothing useful) | Agents the caller may see: filtered by org, `shared_groups`, and the group's `allowedAgentTypes`. Rows carry `can_edit`. Good for "is it published to me". |
| `GET /agents/:id` | session; 404 if you may not read it | The **runtime projection** by default (published config once one exists), `+ can_edit`, `+ runtimeSource` (`'draft'`/`'published'`/`'live'`), and for editors `+ unpublishedChanges`. `?draft=1` (editors only) returns the **concept**, including `persona`. Use `published_version` / `unpublishedChanges` to verify "did they publish". |
| `GET /agents/:id/usage` | session + `canReadAgent` (404) + `canModifyAgent` (403) | `{ usage: rows[{kind, id, title|null, foreign, ownerId, lastAt}], counts, chat{conversationCount,userCount,othersConversationCount,lastUsedAt}, testChats, audience{isPublished, scope:'private'|'groups'|'organization', groupIds, organizationId}, unchecked[] }`. `audience.scope` verifies "did they share it". |
| `GET /agents/:id/tests` | session + `manage_agents` + editable (60/min) | `{ tests[], lastRun, lastRunUnknown, testAsGroups[], testAsGroupsUnknown, limits:{maxTests:100, maxPerRun:25} }`. Verifies "did they write tests". |
| `GET /agents/:id/tests/runs?limit=` | same | `{ runs[], runsUnknown, keep: 20 }` — each run carries its score plus `source`/`version`/`agentRev`/`unpublishedChanges`. Verifies "did they run the set". |
| `GET /agents/categories` | session (org-scoped) | Category rows `{id, name, icon, color, organization_id}`. |
| `GET /agents/favorites` | session | Array of agent ids the caller favourited. |
| `GET /agents/:id/tools` | session | The agent's component tools. |
| `GET /agents/:id/tool-lending` | session + editable | `{ apps[], readable, runtimeCurated }` — which apps this agent may borrow the **owner's** connection for. |
| `GET /agents/tool-catalog` | **explicit `requireAuth`** | The apps + actions *this caller* may grant from, with each action's effect (`reads`/`writes`/`sends`), `provider`, `providersKnown`. |
| `GET /agents/system` | session (org-filtered) | System agents (`owner_id = 'system'`). Does **not** accept `?usage=1`. |
| `GET /agents/meta/models` | session | Every model across configured providers. |
| `GET /agents/meta/components` | session | Available components for tool selection. |
| `GET /agents/:id/conversations` | session | The caller's conversations with this agent. |
| `GET /agents/conversations/all`, `GET /agents/conversations/search` | session | Cross-agent conversation lists. |
| `GET /agents/:id/embed` | **public**, 100/min/IP | `{id, name, description, avatar, starterPrompts, copyEnabled, isSwarm}` — only for `is_published && embed_enabled`; everything else 404s. |

Write endpoints, for reference (not for verification checks): `POST /agents`,
`PUT /agents/:id`, `DELETE /agents/:id[?confirm=1]`, `PATCH /agents/:id/publish` (audience),
`POST /agents/:id/publish-version` (content), `PUT /agents/:id/transfer`,
`POST /agents/:id/persona/parse`, `POST|PUT|DELETE /agents/:id/tests[/:testId]`,
`POST /agents/:id/tests/run` (SSE), `POST /agents/:id/tests/suggest`,
`POST /agents/wizard/{draft,refine,commit}`, `POST /agents/:id/chat/stream` (SSE),
`POST|PATCH|DELETE /agents/categories[/:id]`, `PUT|DELETE /agents/:id/favorite`.

---

## 13. Honest caveats for lesson authors

1. **The persona "Role" cards are built but not mounted.** `AgentWizard/role/` contains
   `RoleCards.jsx`, `WhoCard`, `ToneCard`, `BulletsCard`, `UnknownCard`, `personaFacts.js`
   with full tests (committed as "A3 + A5 — de Rol-tab over persona, en het agentoverzicht"),
   and all the `agent_studio.role.*` strings exist — but nothing imports `RoleCards`. Today the
   **Role** tab still renders `BuilderConfigPanel` (action pills + instructions editor). The
   persona itself is real and does reach the server: the AI refine flow writes it, the server
   renders it into the system prompt, and the hero's "Answers in" chip reads
   `persona.language`. **Do not write a lesson that tells a learner to click "Who it is",
   "How it talks", "Does", "Never does" or "If it doesn't know" until this is wired.** Verify
   against the running build before publishing such a lesson.
2. **Two editors exist.** The Studio editor (`BuilderSplit`) is the one to teach. A legacy
   form (`AgentDesignerPanel` → `AgentEditorUI`) is still reachable from Agent Hub's design
   mode and carries the older labels ("Identity & Model", "Knowledge", "Behavior",
   "Publishing", "Version History", "Strict Knowledge Mode", "AI Model", "Role description").
   Those `agent_wizard.section.*` / `agent_wizard.field.*` strings belong to that screen.
3. **`agent_studio.create_with_ai` ("Create with AI") is currently unused** — the overview's
   button says **"New agent"**. The old wizard "plan card" stage (Agent plan / Channels /
   Capabilities / Request changes / Start building) is also gone; its i18n keys survive.
4. **Branch state.** The repo is on `claude/builder-redesign-fase-1-6sun0h` with a large
   uncommitted working tree. Re-check any label against `git status` before quoting it in a
   published lesson.
