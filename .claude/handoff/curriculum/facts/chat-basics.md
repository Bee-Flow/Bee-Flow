# Fact sheet — Chat basics (audience: everyday users)

Status: **the area exists and is the product's main screen.** Everything below was read out of the
working tree on branch `claude/builder-redesign-fase-1-6sun0h` (2026-09-14). UI strings are quoted
from `agent-hub/src/i18n/en-defaults.js` or from the JSX fallback in the component; endpoints were
confirmed in `server/routes/`.

One caveat for lesson authors: `ConversationHeader.jsx` (the redesigned chat header with the
"Privacy Shield on" / knowledge-base pills) exists and is fully built, but **nothing in the app
renders it yet** — the only importer is its own test. The header a learner actually sees today is
the plain toolbar inside `AgentHub/DirectChatView.jsx` / `AgentHub/AgentChatView.jsx`. Do not teach
the header pills as if they were on screen.

---

## 1. What the feature is for

Bee Flow's chat is the everyday front door: you type a question, attach files, and an AI model
answers in a stream. Two flavours share one composer:

- **Direct chat** ("New Chat") — talk to the raw assistant. You pick how hard it should think
  (the tier gauge), what it may reach (apps, web search), and what it should ground its answers
  on (knowledge bases).
- **Agent chat** — talk to a saved agent from the Agents store. The agent carries its own
  instructions, tools and tier; you cannot change the tier per message.

The privacy-product difference from ChatGPT: before your text leaves Bee Flow for a model, the
**Privacy Shield** scans it for personal data and either replaces it with placeholders like
`[email_1]`, refuses to send, or asks you what to do. The real values stay in Bee Flow and are put
back into the answer before you see it.

Key files:
- Screen: `agent-hub/src/AgentHub.jsx`, `agent-hub/src/AgentHub/DirectChatView.jsx`,
  `agent-hub/src/AgentHub/AgentChatView.jsx`
- Composer: `agent-hub/src/components/chat/InputArea.jsx` (1699 lines — the whole composer)
- Tier control: `agent-hub/src/components/licensing/TierSlider.jsx` + `tierMeta.js`
- Claims logic: `agent-hub/src/components/chat/composerClaims.js`,
  `knowledgeBaseClaim.js`, `hooks/useShieldStatus.js`
- Shield review dialog: `agent-hub/src/components/chat/DlpPreviewModal.jsx` +
  `dlpReview/DlpReviewShell.jsx`
- Send engine: `agent-hub/src/hooks/useChatEngine.js` (+ `useChatEngine/sseEvents.js`)
- Backend turn: `server/routes/ai/directChat/streamTurn.js` and its phase files
- Backend CRUD: `server/routes/ai/directChat/conversationRoutes.js`,
  `server/routes/agents/conversations.js`, `server/routes/agents/conversations_meta.js`

---

## 2. Screens, with their real labels

### 2.1 The workspace shell (left sidebar) — `components/shell/Sidebar.jsx`
URL: `/app` (page key `agents`). A direct conversation deep-links to `/app/d/<conversationId>`
(`authedApp/appRoutes.js → parseDirectChatUrl`).

Nav rows (top group), in order:
- **New Chat** (`sidebar.new_chat`, pencil icon) — starts a fresh direct chat
- **Cowork** (`sidebar.cowork`) — with a badge showing active cowork runs
- **Approvals** (`sidebar.approvals`) — only when there are pending approvals
- **Search** (`sidebar.search`) — opens the search overlay
- **Agents** (`sidebar.agents`) — opens the Agents store
- then Studio / Apps / Forms / Notebooks rows depending on licence and Simple Mode

Below that: **Projects** (`sidebar.projects`) with **New Project** (`sidebar.new_project`),
**My Agents** (`sidebar.my_agents`), then the history list headed **Chats** (`sidebar.chats`).

Chat history grouping headers: **Pinned**, **Today**, **Yesterday**, **Last 30 Days**, **Older**
(`sidebar.pinned` / `.today` / `.yesterday` / `.last_30_days` / `.older`).

Empty states: **"No chats yet"** (`sidebar.no_chats_yet`) when a chat surface is selected,
**"Select an agent to begin"** (`sidebar.select_agent_to_begin`) otherwise. A nameless conversation
shows **"Untitled Chat"** (`sidebar.untitled_chat`). Footer reads **"Powered by Bee Flow"**.

Per-conversation ⋯ menu (`sidebar/ConvRow.jsx`): **Pin to top** / **Unpin**, **Rename**,
**Labels** (empty: *"No labels yet"*, plus **New label**), **Remove from project**,
share/unshare thread, **Delete**.

### 2.2 The empty chat ("welcome") — `components/chat/DirectChatWelcome.jsx`
A random greeting from 10 options (`starter.welcome_0..9`): *"Where should we start?"*,
*"How can I help you today?"*, *"What's on your mind?"*, *"Let's build something great."*,
*"Ready to explore?"*, *"What are we working on?"*, *"Ask me anything."*, *"Let's get started."*,
*"How can I assist you?"*, *"Need a hand with something?"*

Under it: the composer, then **3 starter-prompt pills picked at random from a list of 24**
(`utils/prompts.js`, keys `starter.sp_0..23`) — e.g. *"Summarize my latest meeting notes into
action items"*, *"Find the key insights across my knowledge base"*, *"Draft a structured report from
my notes"*, *"Help me get started with Bee Flow"*. Clicking one drops the text into the composer
(it does **not** send).

### 2.3 The chat toolbar above the thread
Direct chat (`DirectChatView.jsx`) renders this bar only while `isMobile || notebooksEnabled ||
!conversationStarted`. It holds: the **Chat ⇄ Cowork** switch in the centre
(`components/cowork/CoworkModeSwitch.jsx`, labels **"Chat"** — hint *"Answers you here, in the
conversation"* — and **"Cowork"** — hint *"Runs on its own — now or on a schedule"*), plus on the
right **📓 Notebook** / **📓 Close** (title *"Open Notebook"* / *"Close Notebook"*) and
**🌐 Webpage** / **🌐 Close** (title *"Open Webpage"* / *"Close Webpage"*).

The Chat/Cowork switch **disappears once the conversation has a message in it** (`locked` prop) —
you settle the mode with your first send.

Agent chat (`AgentChatView.jsx`) shows the agent avatar + name, and a ⋮ menu with
**New Chat**, **Add to favorites** / **Remove from favorites**, and for owners/admins
**Edit Agent** and **Unpublish Agent**.

### 2.4 The composer — `components/chat/InputArea.jsx`
Placeholder text, in priority order:
- replying inside a thread → **"Reply to thread..."**
- a surface that passes its own placeholder (notebook/webpage drawers) → that text
- direct chat → **"Message AI..."**
- agent chat → **"Message {agent name}..."** (fallback name: *"Agent"*)

Around the text box:
- **"+" button** — aria-label/title **"Message tools"** (`ComposerToolsMenu.jsx`). Rows:
  - **Add photos & files** (paperclip)
  - **Create image, music, video** (`chat.composer.tools_media`; the row exists only when at
    least one generator is available). It opens a small flyout of **four named generator
    rows**, each shown only when its own gate passes (`InputArea.jsx`, `showImageGen` /
    `showMusicGen` / `showElevenLabs` / `showVideoGen`):
    - 🍌 **Image Generation** (`chat.composer.media_image`) → panel *Image Generation*
    - 🎹 **Music Generation** (`chat.composer.media_music`) → panel **"Google Music (Lyria)"**
    - 🎵 **ElevenLabs** (literal, not translated) → panel **"ElevenLabs"**
    - 🎬 **Video Generation** (`chat.composer.media_video`) → panel **"Video Generation (Veo)"**

    There are **no tabs**. Image, music and video need the org integration `image-gen` /
    `music-gen` / `video-gen` **and** a stored Google key; ElevenLabs needs the `elevenlabs`
    integration **and** an ElevenLabs key. An agent with `disableExternalTools` hides all
    four. Right-clicking a row dims it (a per-browser mute, `scopedStorage` key
    `disabledMedia`) — a faint row is a local choice, not a missing key. Each panel holds
    *settings*, not a canvas; you still ask for the media in your message.

    > **Correction 2026-09-15.** This sheet said the row's "panel tabs are **Image**,
    > **Music & TTS**, **SFX**". Those three are the *section headings inside the ElevenLabs
    > panel alone* — `MUSIC (WITH VOCALS)`, `TEXT-TO-SPEECH`, `SOUND EFFECTS`
    > (`ElevenLabsSettings.jsx`) — not tabs, and not the media row. The media row itself
    > lists the four generators above, and ElevenLabs is one of them.
  - **Apps** — hint *"What this chat may reach — Drive, Gmail, and the rest"*
  - **Web search** — hint *"Let this turn look things up online"*; when the org forbids search with
    attachments the row is disabled and reads *"Web search disabled by organisation policy (files
    attached)"*
  - **Memory** — *"Saving new memories from this chat"* / *"Memory saving paused"* (only in agent
    chat; in direct chat the memory switch lives inside the tier gauge's panel)
  - **Voice mode** (`beta` badge) — *"Talk with your assistant instead of typing"*
- **Pills** beside the "+": a tier pill (agent chat only — *"The depth this agent runs at"*),
  **Skills** (*"Reusable instruction packs for this chat"*), the knowledge-base pill
  (**"Knowledge"**, or the base's own name when exactly one is attached; title *"Grounded on
  {names}"* / *"What this chat is grounded on"*), and **"{n} sources"** in a notebook.
- **Shield line** (right-hand side, desktop only) — one of five sentences, from
  `composerClaims.SHIELD_LINES`:
  - *"Personal data is replaced before sending"* (green lock)
  - *"Messages holding personal data are blocked"*
  - *"You are asked first when personal data is found"*
  - *"Personal data is checked before sending"*
  - *"Privacy Shield is on, but personal data cannot be checked right now"* (amber, warning icon)
  Nothing at all is shown when the status is unknown or the shield is off.
- **Tier gauge** (direct chat only) — a speedometer; see §3.
- **Mic button** — *"Dictate — speak your instruction"* / *"Stop recording and insert the text"*
- **Send** (↑) — title *"Send message (Enter)"*, aria-label *"Send message"*; turns into
  **"Stop generating"** (■) while an answer streams; when the box is empty and voice chat is
  available it becomes *"Voice Chat (Beta) — talk with your assistant"*.
- **Drag overlay** reads **"Drop files here"**.
- **Footer**: `"AI can make mistakes. Please verify important information."` — prefixed by
  `"Bee Flow runs on your own server."` **only** on a self-hosted install with a signed-in user —
  then `· Shift+Enter for new line` on non-touch desktops.

### 2.5 Knowledge-base picker (composer pill → panel)
Title **"Knowledge bases"**, hint **"Pick one or more to ground this chat."**, search box
placeholder **"Search…"**. Empty: **"No knowledge bases available. Create one in the Knowledge Bases
section."**; filtered to nothing: **"No matches."** Rows show a visibility chip — **Personal**,
**Org**, **1 group** / **{n} groups** — and a size chip — **Empty** / **1 doc** / **{n} docs**.
Footer buttons: **Clear**, **Saving…**, **Done**.
Failure texts (real strings, all "nothing was changed"): *"Some of those knowledge bases are not
available to you. Nothing was changed."*, *"A chat can use at most 50 knowledge bases."*,
*"Only the owner can change what this chat is grounded on."*, *"This chat is no longer available."*,
*"This server cannot store knowledge bases on a chat yet."*, *"That change could not be saved.
Nothing was changed."*

### 2.6 Privacy Shield review dialog (before sending)
Shown when the org's shield action is **ask** and the detector found something.
Rich version (`dlpReview/DlpReviewShell.jsx`), title **"Check this before it goes to the AI"**
(for a file: **"Check this attachment before it goes to the AI"**), subtitle **"This prompt will be
sent to <provider>"** with an **external** badge. Your text is rendered with the findings
highlighted; each highlight carries a confidence label — **Marked by you**, **Custom rule**,
**High confidence**, **Possible match**, **Low confidence**. Summary bar: **"{n} detected"**,
**"{auto} detected · {manual} added by you"**, or **"No personal data detected. Do you see something
anyway? Select it below."** Hint: **"Tip: select text above to mark something the detector missed."**
Selecting text offers **Mark as personal data** / **Unmark**.
Checkbox: **"Remember my choice for this conversation"**.
Buttons: **Block**, **Send anyway** (tooltip *"Send the prompt unchanged"*), and
**Redact and send** (or plain **Send** when nothing is marked).
Older servers fall back to a flat list titled **"Sensitive content detected"** with a
**"Detected items"** section and `pii` / `custom` source chips.

### 2.7 Under a sent message
- A lock badge, **"{n} items redacted"**, tooltip *"This message contained sensitive data — only
  placeholders were sent to the AI."* Expanding gives the **Privacy protection** panel with
  **Detected:** categories, **Sent to <provider>**, a **Token mapping** section behind
  **Click to reveal**, and the explainer *"The AI only saw placeholders like [email_1]. Real values
  were restored in the reply before you saw it."*
- When a scan could not finish: **"Scan incomplete"** — *"Some uploaded content could not be scanned
  and was sent to the AI unredacted."*, plus per-file *"Scanned {x} of {y} pages"*.
- When nothing was found: **"Scanned for personal data — nothing found."** with a **scanned** chip.

### 2.8 Under an answer
**Copy**, **Copy as Markdown**, **Export as PDF** (behind *"More export options"*), **Good
response** / **Bad response**, **Retry response**, **Retry with different model**, **Edit message**
(→ **Save & Regenerate** / **Cancel**), and a collapsible **"How I got this answer"** showing
**"{n} tools · {s}s"**, **"Auto → {tier}"**, **"{n} sources"** and the thinking steps
(**"Thought for {duration}"**, **"Skip to answer"**).
While streaming, phase lines appear: *"Selecting best model…"*, *"Using {model}"*,
*"Loading tools…"*, *"Recalling memory…"*, *"Searching knowledge base…"*,
*"Reading attachment {name}…"*, *"Compacting conversation…"*, *"Preparing context…"*,
*"Validating input…"*, *"Protecting your data…"*, *"Thinking…"*.

### 2.9 Search overlay — `components/shell/SearchOverlay.jsx`
Dialog aria-label **"Search conversations"**; input placeholder **"Search conversations and
messages…"**. Filter row: **All / Agents / Direct**, an agent dropdown (**All agents**), a date
dropdown (**Any time / Last 7 days / Last 30 days / Last 90 days**), and a sort toggle
(**Relevance / Date**). Empty states: **"Search your conversations"** — *"Find messages across agent
chats and direct conversations."*; no hits: **"No matches for \"{q}\""** with *"Try removing some
filters or changing your query."* and a **Reset filters** button. Before typing, a **Recent
searches** row of chips. Footer counts **"{n} results"**.

### 2.10 Agents store — `components/agents/AgentMarketplace.jsx`
Title **"Agents"**, subtitle **"{visible} of {total} agents"**, search **"Search agents..."**,
tabs **Popular / Last Used / Favorites / All**, plus **Advanced**. Empty: **"No agents found"** —
*"Try adjusting your search or filters."* with **Clear filters**.

---

## 3. Concepts a learner must understand

**Direct chat vs agent chat.** Direct chat = the bare assistant, you choose the depth per message.
Agent chat = a saved assistant with fixed instructions and a fixed tier. The sidebar's "New Chat"
always starts a direct chat.

**Tier ("how deep should this answer go").** Bee Flow does not ask you to pick a model; it asks you
to pick a *depth*. On a default install `fast`, `thinking` and `pro` all point at the **same model**
and differ only in the reasoning effort configured for them (low / medium / xhigh). The composer
control is a slider with a speedometer, not a menu. Built-in labels (`licensing/tierMeta.js`):
- **Auto** — *"Optimal choice"*; the server classifies your message and picks. No needle on the
  gauge — an "A" instead.
- **Fast** — *"Quick answers"*
- **Think** — *"Complex problems"*
- **Deep Thinking** — *"Advanced reasoning"* (the stored key is the legacy `pro`)
- **Flow** (`standard`) — *"Multi-stage orchestration"*, beta
- **Swarm** — *"Parallel agents, synthesised answer"*, beta
- **Write** (`writer`) — *"Long-form content"*
Only Auto / Fast / Think / Deep Thinking sit on the slider (`DEPTH_TIER_KEYS`); Flow, Swarm, Write
and custom tiers are *kinds* of work and render as pills under it. Project convention (memory):
**`fast` is the default tier and `standard` is never used** for ordinary work.

**Privacy Shield.** The scan that runs on your text before it goes to a model. Four possible
actions, resolved per org (or per user for account-holders with no org):
`redact` (replace with placeholders), `block` (refuse to send), `ask` (show you the review dialog),
or off. The status endpoint `/api/privacy/shield-status` returns `enabled`, `source`
(`org` / `personal` / `platform` / `off`), `action`, `failMode` and `guardReachable`.
**The one rule the UI obeys:** a claim is only made when `enabled && guardReachable`. A shield that
is switched on while the PII Guard is unreachable scans nothing, and the UI says so in amber rather
than showing a green lock.

**Tokenisation / placeholders.** Redaction does not delete — it swaps. `Jan de Vries` becomes
`[person_1]`, an address becomes `[address_1]`. The model answers about the placeholder; Bee Flow
puts the real value back before you read the reply. The mapping lives in the token vault, per
conversation.

**Fail-closed vs fail-open.** If the detector is down, a `fail_closed` org refuses to send at all
("Privacy protection is temporarily unavailable, so your message was not sent."). A `fail_open` org
sends unredacted and marks the message **Scan incomplete**.

**Grounding / knowledge bases.** Attaching a knowledge base to a chat means every turn searches it.
Attaching is a **read grant**, so the server re-checks every id on every read and every turn — a base
that was unpublished after you attached it silently drops out of the pill and out of the search.
Max 50 per conversation.

**Memory.** Separate from the conversation: facts the assistant saves about you across chats. The
**Memory** toggle only stops *writing*; existing memories are still read into the prompt.

**Context / compaction.** Long conversations get folded. Lossless context editing (Anthropic's
`context_management`) runs by default; the lossy local summariser
(`server/core/llm/compaction.js`) is **opt-in per org, default OFF** since 2026-08-20 — the org
setting is called **Conversation Memory** (`settings.ai_context`). When a fold happens the thread
shows **"Earlier messages were summarised"**.

**Simple Mode.** A per-user preference (Settings → **Enable Simple Mode**) described as *"Show only
New Chat, Search, Agents and your chat history. Hides Studio, Meeting Notes, Notebooks, Webpages and
other settings."* It also strips the composer down to attachments + web search, hides the tier
slider, pills, skills, apps and voice, and pins the tier to `auto`. **It is forced on for every
screen narrower than 768px**, regardless of the stored preference.

**Cowork.** The other thing the composer can do: instead of answering here, it creates something
that runs on its own (now or on a schedule). The mode is locked after the first message.

---

## 4. End-to-end workflows (exactly as a user clicks)

### W1 — Ask a first question and read the answer
1. Open `/app`. The sidebar shows **New Chat** at the top.
2. Click **New Chat**. The greeting appears (e.g. *"How can I help you today?"*) with three starter
   pills under the composer.
3. Click into the box (**"Message AI..."**) and type the question.
4. Optional: click the gauge next to **Send** and drag the slider from **Fast** to **Think**.
5. Press **Enter** (Shift+Enter makes a new line; on a phone Enter makes a new line and you tap ↑).
6. The answer streams; phase lines like *"Using {model}"* and *"Thinking…"* appear above it.
7. Press the ■ (**Stop generating**) button if you want to cut it short.
8. The conversation appears in the sidebar under **Today** with an auto-generated title.

### W2 — Attach a document and ask about it
1. In an open chat, click **+** → **Add photos & files** (or drag the file onto the composer —
   the overlay reads **"Drop files here"** — or paste it with Ctrl+V).
2. The file appears as a chip above the box with its size; ✕ (**Remove attachment**) takes it off.
3. Type the instruction ("Summarise the payment terms").
4. Press **Enter**. A *"Reading attachment {name}…"* phase line appears.
5. If the org shield is set to **ask** and the file holds personal data, the dialog
   **"Check this attachment before it goes to the AI"** opens — see W3.
6. The answer streams; a lock badge under **your** message shows **"{n} items redacted"** if
   anything was replaced.

### W3 — Handle the Privacy Shield review
1. You press Enter; instead of an answer the dialog **"Check this before it goes to the AI"** opens
   and the stream is paused.
2. Read the subtitle: **"This prompt will be sent to <provider>"** + the **external** badge.
3. The highlighted spans are what the detector found; each hover shows **High confidence** /
   **Possible match** / **Marked by you**.
4. Optional: select any text the detector missed and click **Mark as personal data**.
5. Optional: tick **"Remember my choice for this conversation"**.
6. Click one of: **Block** (nothing is sent; the bubble reads *"Prompt blocked by you."*),
   **Send anyway** (unchanged text leaves Bee Flow), or **Redact and send** (placeholders go out).
7. Do it within **60 seconds** — the decision expires and the message is refused with
   *"Blocked: DLP decision timed out."*

### W4 — Ground a chat on a knowledge base
1. In a direct chat, click the **Knowledge** pill in the composer toolbar.
2. Panel **"Knowledge bases"** opens — *"Pick one or more to ground this chat."*
3. Type in **"Search…"** to filter; tick the bases you want (each row shows **Org** / **Personal** /
   **{n} groups** and **{n} docs**).
4. The panel shows **Saving…** while the server confirms — the tick only lands once it does.
5. Click **Done**. The pill now shows the base's name (one base) or **Knowledge** with a count.
6. Ask your question. A *"Searching knowledge base…"* line appears and the answer carries
   **"{n} sources from {docs}"** chips.

### W5 — Find an old conversation
1. Click **Search** in the sidebar (or the magnifier).
2. Type at least **2 characters** into **"Search conversations and messages…"** — the search fires
   300 ms after you stop typing.
3. Narrow with the chips: **All / Agents / Direct**, an agent, **Last 30 days**, **Relevance** or
   **Date**.
4. Arrow-key down the list and press Enter, or click a row; the conversation opens in the chat pane.
5. Nothing found → **"No matches for \"…\""** with **Reset filters**.

### W6 — Rename, pin and clean up
1. Hover the conversation in the sidebar and click the ⋯.
2. **Rename** — type a new title inline, Enter to confirm.
3. **Pin to top** — it moves into the **Pinned** group; **Unpin** reverses it.
4. **Labels** → **New label**, pick a colour, apply.
5. **Delete** — the conversation and its messages go.

### W7 — Talk to an agent instead
1. Click **Agents** in the sidebar → the **Agents** store.
2. Search or use the **Popular / Last Used / Favorites / All** tabs; click an agent card.
3. The composer placeholder becomes **"Message {agent name}..."** and the gauge is gone — a pill
   states the depth the agent was saved with.
4. Type and press Enter. Use the ⋮ next to the agent's name for **New Chat** with the same agent.

---

## 5. Defaults and limits (numbers)

| Thing | Value | Where |
|---|---|---|
| Attachment size, client-side | **20 MB** per file; anything bigger is silently skipped (console warning only) | `InputArea.jsx` `processFiles` |
| Request body, server-side | **20 MB** total JSON | `server/index.js` `bodyParser.json({ limit: '20mb' })` |
| Accepted file types (file picker) | `image/*, .pdf, .docx, .csv, .xlsx, .xls, .txt, .md, .json, .js, .jsx, .ts, .tsx, .py, .html, .css` | `InputArea.jsx` `accept=` |
| Image downscale before upload | longest edge **1568 px**, JPEG **q 0.92** | `utils/imageResize.js` |
| Image base64 fallback cap | 300 KB | `directChat/attachmentIntake.js` |
| Composer text box | grows to **180 px**, then scrolls | `InputArea.jsx` |
| Send key | **Enter** on desktop, **Shift+Enter** = newline; on true touch devices Enter is newline and you tap ↑ | `handleKeyDown` |
| Knowledge bases per conversation | **50** (`MAX_ATTACHED_KB_IDS` server, `MAX_ATTACHED_KBS` client) | `core/kb/kbIdList.js` |
| Default tier | **`auto`** (persisted per user in scoped localStorage) | `useModelTierSelection.js` |
| Web search default | **on** (`webSearchEnabled`, per-browser) | `InputArea.jsx` |
| Memory writing default | **on** (`memoryWriteEnabled`, per-browser) | `InputArea.jsx` |
| Compaction (lossy) | **off by default, per-org opt-in** | `core/llm/contextPolicy.js` |
| Privacy Shield review timeout | **60 s** (`DEFAULT_TIMEOUT_MS`) | `core/dlp/decisionQueue.js` |
| Manual "mark as personal data" spans | max **200** per decision | `routes/dlpDecision.js` |
| Dictation | max **120 s** per take; upload cap **25 MB** | `useDictation.js`, `routes/dictate.js` |
| Search | min **2 characters**, **300 ms** debounce, **50** results default / **200** max | `SearchOverlay.jsx`, `conversations_meta.js` |
| "All conversations" listing | **LIMIT 50** | `stores/agent/agentConversations.js` |
| Conversation title | max **500** chars | `routes/agents/conversations.js` |
| Labels | max **50** per conversation, **64** chars each | idem |
| Conversation notebook/workspace | max **10 MB** | idem |
| Starter prompts shown | **3**, drawn at random from **24** | `utils/prompts.js` |
| Simple Mode forced | every viewport **< 768 px** | `AgentHub.jsx`, `useViewport.js` |
| Shield status polling | every **30 s**; guard probe memoised **15 s** process-wide | `useShieldStatus.js`, `privacyShieldStatus.js` |

---

## 6. What happens on failure

- **Model/stream error** → the bubble turns red and reads the server's error; when the turn already
  produced something (a webpage, a notebook) the summary is shown *first*, then the error, so you
  do not retry and duplicate the work. Generic fallback: **"Error generating response."**
- **Stream cut off** → *"⚠️ The response was interrupted before it finished. Any work already
  started (e.g. a webpage or notebook) may have been saved — check the relevant panel, or resend if
  needed."*
- **401/403 mid-conversation** → **"⚠️ Access denied — you no longer have permission to use this
  agent. Please refresh the page."**
- **Usage/subscription limit** → the message footer shows **"Usage limit reached"** (amber) and the
  server text names the cap, e.g. *"You have reached your monthly message limit (…)."*
- **Shield blocked the message** → *"Prompt blocked by data-loss-prevention policy."* /
  *"Prompt blocked by you."* / *"Blocked: DLP decision timed out."*
- **Message too large to scan** → *"This message is too large to scan for personal data, so it was
  not sent. Please split it into smaller parts."*
- **Detector down, fail-closed** → *"Privacy protection is temporarily unavailable, so your message
  was not sent. Please try again in a moment."*
- **Attachment could not be scanned** → *"Attachment held: {file} is too large to fully scan for
  sensitive data. Split it or reduce the page count, then re-upload."* (also timeout and
  "temporarily unavailable" variants)
- **Content-policy violation** → **"Content Policy Violation"** / **"Message Policy Violation"**,
  with *"Sensitive content will be redacted in {n} seconds"* and, for the hard case,
  *"Your message was flagged as \"{violation}\". … Would you like to rephrase your question?"*
- **Knowledge-base change refused** → the panel keeps the old ticks and prints one of the six
  "Nothing was changed." sentences listed in §2.5. Nothing is half-saved.
- **Attachment over 20 MB** → **silently dropped** (console warning only). This is a real UX gap;
  teach learners to check the chip appeared.

---

## 7. Permission and licence gates

**Chatting itself is not gated by a role.** `server/config/orgRoles.json` grants `member` only
`use_notebooks` and `use_datatables`; nothing in the chat send path checks a chat permission. The
gate is authentication: `requireAuth` on `POST /ai/chat/direct/stream` and every conversation route.

What *is* gated, and by what:

| Thing | Gate | Where |
|---|---|---|
| Voice mode | beta feature `voice_chat` + licence feature `voice_chat` + a Mistral key | `routes/ai.js` `requireCapability('voice_chat')`, `betaFeatures.js` |
| Skills pill & picker | beta feature `skills` on the user (`user.betaFeatures.includes('skills')`) | `InputArea.jsx` `canPickSkills`, `requireCapability('skills')` on `/api/skills` |
| Flow tier (`standard`) | beta `flow` **and** beta `skills`, both | `config/modelTiers.js`, `entitlements/userTiers.js` |
| Swarm tier | beta `swarm` + licence feature `swarm` | idem, `requireCapability('swarm')` |
| Knowledge-base **picker** in chat | every signed-in account, in direct chat only (not Simple Mode, not agent chat) and once the KB list has loaded | `InputArea/index.jsx` `canPickKBs` |
| Which tiers a user sees at all | per-group `allowedTiers`; empty/no groups = unrestricted | `GET /ai/config/tiers-for-user` |
| Notebooks panel beside chat | module `notebooks` + `requireCapability('notebooks')` | `server/index.js` |
| Webpage panel beside chat | module `webpages` + `requireCapability('webpages')` | `server/index.js` |
| Projects | module `projects` + `requireCapability('projects')` | `server/index.js` |
| Image / Music / Video generation (three separate rows) | org integration `image-gen` / `music-gen` / `video-gen` **and** a stored Google key, **and** the agent not set to `disableExternalTools` | `InputArea.jsx` `showImageGen`, `showMusicGen`, `showVideoGen` |
| ElevenLabs generation (the fourth row) | org integration `elevenlabs` **and** a stored ElevenLabs key (+ `externalToolsOk`) | `InputArea.jsx` `showElevenLabs` |
| Web search | org integration `agent-search` enabled, search provider not `disabled`, and the agent not configured with `disableExternalTools` | `InputArea.jsx` `canWebSearch` |

**No beta gate on the KB picker:** the former `knowledge_bases_beta` flag is gone. When the
conversation carries bases but the picker is unavailable (Simple Mode, agent chat), users still see
a *statement* pill (deliberate — grounding must never be invisible), but they cannot change it.

---

## 8. How chat connects to the rest of the product

- **Knowledge bases** — attached per conversation; every turn searches them, and the answer carries
  source chips. A chat inside a **project** *also* searches that project's knowledge bases, and the
  composer pill does **not** count those (a documented under-report in `InputArea.jsx`).
- **Skills** — reusable instruction packs; a direct chat on the Flow tier also generates
  *session skills* for itself (`/ai/direct/conversations/:id/session-skills`).
- **Memory** — read into every prompt, written after each turn unless the Memory toggle is off.
- **Notebooks** — the 📓 button opens a notebook beside the conversation; the AI can write into it.
- **Webpages** — the 🌐 button opens a webpage beside the conversation; the AI can edit its files.
- **Apps / integrations** — Drive, Gmail, Calendar, Contacts, Keep, Outlook, OneDrive, LinkedIn,
  GitHub, Gamma, MCP servers; the "Apps" row says what this chat may reach. Attachments can come
  straight from a Google Drive or Gmail picker.
- **Agents** — the Agents store; agent chat is the same composer with the tier fixed.
- **Cowork / Routines** — the Chat⇄Cowork switch turns the same box into a scheduler.
- **Privacy Shield / Compliance** — the shield config lives in org settings (**Privacy Shield**);
  every block, redaction and unicode-smuggling strip is recorded as a guardrail event feeding
  Monitoring and the Compliance Hub.
- **Projects** — a conversation can belong to a project and be shared with project members
  (`shared_scope`); the sidebar's ⋯ offers "Remove from project" and share/unshare.
- **Mobile** — the Expo client talks to the same `/ai/chat/direct/stream`.

---

## 9. Common mistakes

1. **Picking a model instead of a depth.** There is no model dropdown in chat; the gauge names
   tiers. On a default install Fast/Think/Deep Thinking are the *same model* at different effort.
2. **Expecting "Auto" to show which model it used before the answer.** It cannot — the router picks
   while the answer streams. The pill only says *"Auto · Think"* once an answer is back.
3. **Assuming the green lock means the message never leaves the building.** It means personal data
   was *replaced* first. With an external provider the (placeholder) text still goes out.
4. **Trusting the shield line when it is amber.** *"Privacy Shield is on, but personal data cannot
   be checked right now"* means nothing is being scanned.
5. **Clicking "Send anyway" out of habit** in the review dialog — that sends the raw values.
6. **Ticking "Remember my choice for this conversation"** and then forgetting it applies to every
   later message in that thread.
7. **Attaching a 30 MB PDF** and not noticing the chip never appeared (silent drop at 20 MB).
   Also: several 20 MB files in one message will 413 against the server's 20 MB body limit.
8. **Expecting the knowledge-base pill to list a project's bases.** It only counts the
   conversation's own.
9. **Switching Chat → Cowork after the first message.** The switch is gone by then; start a new
   chat.
10. **Assuming Simple Mode is a bug on a phone.** It is forced under 768 px and hides the tier
    slider, pills, skills, apps and voice on purpose.
11. **Typing Enter on a tablet expecting a send.** On true touch devices Enter makes a newline.
12. **Turning off Memory to "forget" something.** That only pauses *writing*; existing memories are
    still read. Delete them in the Memory panel.
13. **Searching with one character.** Search does nothing below 2 characters.
14. **Re-sending after "the response was interrupted".** Check the notebook/webpage panel first —
    the work may already be saved, and a resend duplicates it.

---

## 10. Three scenarios for "Van Dijk Groep" (Dutch SME)

### S1 — Procurement: comparing two supplier quotes
Pieter in inkoop has two PDF quotes for steel profiles. He clicks **New Chat**, drags both PDFs onto
the composer, sets the gauge to **Think**, and types: *"Vergelijk deze twee offertes op prijs per
ton, levertijd en betalingstermijn. Zet het in een tabel en noem het grootste risico per
leverancier."* The quotes contain the contact persons' names and mobile numbers, so the Privacy
Shield dialog opens — **"Check this attachment before it goes to the AI"** — showing
*"3 detected"*. He clicks **Redact and send**. The answer comes back as a table; under his own
message sits **"3 items redacted"**, and expanding **Privacy protection** shows the mapping. He
clicks **Copy as Markdown** and pastes it into the purchasing memo.
*Teaching point:* the model compared `[person_1]`'s quote against `[person_2]`'s and never needed
their names.

### S2 — HR: drafting a vacancy and answering a policy question
Saskia in HR opens **New Chat**, clicks the **Knowledge** pill and ticks **Personeelshandboek**
(**Org**, 42 docs), then **Done**. She asks: *"Wat is onze regeling voor ouderschapsverlof, en
schrijf daarna een vacaturetekst voor een junior werkvoorbereider op basis van het functiehuis."*
A *"Searching knowledge base…"* line runs and the answer carries **"4 sources from
Personeelshandboek"**. She clicks a source chip to see the exact paragraph. Then she pastes a
sickness-report e-mail and asks for a reply; the shield (set to **ask**) flags the employee's name
and BSN. She marks one missed phone number by selecting it and clicking **Mark as personal data**,
ticks **Remember my choice for this conversation**, and clicks **Redact and send**.
*Teaching point:* grounding + review in one conversation; the pill states what the answer is built
on, the badge states what left the building.

### S3 — Sales: a follow-up after a site visit
Ruben komt terug van een bezoek bij een klant. Hij dicteert: he clicks the **mic**, speaks his
notes for 90 seconds (the counter shows `01:30`, capped at 2 minutes), and the transcript lands in
the composer. He clicks **+** → **Web search** to switch it on, and types: *"Maak hier een
bezoekverslag van en een follow-upmail. Zoek ook even op wat dit bedrijf recent heeft aangekondigd."*
He leaves the gauge on **Fast**. The answer streams; **"How I got this answer"** shows
**"2 tools · 6s"** and **Auto → Fast**. He clicks **Retry with different model** once to get a
crisper mail, then pins the conversation (⋯ → **Pin to top**) so it stays above the fold until the
deal closes. Next week he finds it again via **Search** → *"bezoekverslag"* → **Last 7 days**.
*Teaching point:* dictation, web search, the answer trace, and the history hygiene (pin / label /
search) that makes chat usable after week one.

---

## 11. List/read endpoints a "did the learner do it?" check can call

All are session-cookie authenticated (`authFetch` sends the session; the Nextcloud connector JWT
also populates `req.session`). Base path is the API root — the frontend's `API_BASE` — and these
routers are mounted at `/ai` and `/agents` (**not** `/api/ai`).

| Method | Path | Auth | Row/body contains |
|---|---|---|---|
| GET | `/ai/direct/conversations` | `requireAuth` | array of `{ id, title, model_tier, project_id, shared_scope, pinned, labels_json, created_at, updated_at }`, newest first. **No owner field** — the query is scoped to `user_id = session.user.id`. Titles are decrypted server-side. |
| GET | `/ai/direct/conversations/:id` | `requireAuth` | the full row (`SELECT *`, so `user_id`, `project_id`, `crypto_scope`, `pinned`, `labels_json`, timestamps) plus `messages[]` (each `{ role, content, attachments?, … }`), `meta`, decrypted `title`, and `knowledgeBaseIds` re-authorised on every read. 404 if not yours and not shared. |
| GET | `/ai/direct/conversations/:id/session-skills` | `requireAuth` | `{ skills[], activatedSkillIds[], modelTier }` |
| GET | `/ai/direct/conversations/:id/workspace` | `requireAuth` | the conversation's notebook content |
| GET | `/ai/labels` | `requireAuth` | array of `{ id, name, color, created_at }`, scoped to the caller |
| GET | `/ai/config/tiers-for-user?taskType=direct_chat` | `requireAuth` | object keyed by tier id (`auto`, `fast`, `thinking`, `pro`, `custom:…`), each `{ modelId, … }` — i.e. exactly which tiers this user may pick |
| GET | `/ai/user-settings` | `requireAuth` | `{ orgEnabledIntegrations, hasGoogleKey, hasElevenLabsKey, disableSearchOnUpload, searchProvider, … }` |
| GET | `/agents/conversations/all` | session-scoped via `getEffectiveUserId` (**no explicit `requireAuth`** — an unauthenticated caller gets a guest id and an empty list, not a 401) | up to **50** rows `{ id, agent_id, user_id, title, project_id, pinned, labels_json, created_at, updated_at, agent_name, agent_avatar }`. **`user_id` is the owner field.** |
| GET | `/agents/conversations/search?q=…&source=all\|agent\|direct&agentId=&startDate=&endDate=&limit=&offset=` | same session scoping | array of matches, each agent hit tagged `kind: 'agent'`; direct hits carry their own kind. Empty array when `q` is shorter than 2 chars. Response headers `X-Total-Count` and `X-Has-More`. |
| GET | `/agents/:id/conversations` | agent read access (`requireAgentReadAccess`) | `{ id, agent_id, user_id, title, project_id, shared_scope, pinned, labels_json, created_at, updated_at }` for that agent **and that user** |
| GET | `/agents/:id/conversations/:convId` | ownership check (`conversation.user_id !== userId` → 404) | full conversation incl. messages |
| GET | `/api/kb` | `requireAuth` | the knowledge bases this caller may use, each with `id`, `name`, `visibility`/`group_ids`, `document_count`, `usage_contexts` — the list the composer's picker filters |
| GET | `/api/privacy/shield-status` | `requireAuth` | `{ enabled, source, action, failMode, guardReachable, euMode, coworkEnabled }` — booleans and enums only, always 200 |

Mutating endpoints a check might *also* want to observe as evidence (all `requireAuth`):
`POST /ai/chat/direct/stream` (SSE), `PATCH /ai/direct/conversations/:id`
(`{ title?, pinned?, labels?, knowledgeBaseIds? }` — refuses >50 bases and unauthorised ids with
400, non-owner KB writes with 403), `DELETE /ai/direct/conversations/:id`,
`POST|PATCH|DELETE /ai/labels[/:id]`, `POST /api/chat/dlp-decision`
(`{ decisionId, choice: 'redact'|'block'|'allow', rememberForConversation?, manualAdditions? }`).

**Suggested verification recipe for a lesson** ("the learner started a chat and got an answer"):
`GET /ai/direct/conversations` → assert at least one row whose `updated_at` is after the lesson
started; then `GET /ai/direct/conversations/<id>` → assert `messages` contains both a `user` and an
`assistant` entry. For "the learner grounded a chat": same detail call, assert
`knowledgeBaseIds.length > 0`. For "the learner used search": there is no server-side record —
recent searches are stored in the browser (`shell/searchRecents.js`), so that step cannot be
verified from the API.
