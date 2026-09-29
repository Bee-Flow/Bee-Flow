---
title: "Chat & agents"
---

# Chat & agents

The chat surface is the entry point for every Bee Flow interaction. Every conversation runs against an **agent** — a named persona with a system prompt, a model choice, and an explicit set of tools.

## Anatomy of an agent

| Field | Type | Purpose |
|-------|------|---------|
| `name` | text | Human-readable agent name. |
| `description` | text | One-line summary shown in the picker. |
| `avatar` | URL / emoji | Picker icon. |
| `model` | enum / null | Specific model override (e.g. `claude-opus-4-7`). `null` = use the org's default. |
| `system_prompt` | text | The agent's instructions. Markdown supported. |
| `starter_prompts` | array | Up to 4 suggested opening messages users can click. |
| `threads_enabled` | bool | Allow branching conversations into threads. |
| `copy_enabled` | bool | Show "copy reply" buttons. |
| `workspace_enabled` | bool | Open results in the side workspace pane (artifacts). |
| `embed_enabled` | bool | Allow embedding this agent in an iframe outside Bee Flow. |
| `is_published` | bool | Visible in the Marketplace. |
| `category_id` | uuid | Marketplace category. |
| `shared_groups` | array | NC groups that can use this agent. |
| `config.knowledge_base_ids` | array | KBs auto-attached. |
| `config.includeSourceReferences` | bool | Render citations as a separate UI block. |
| `config.llamaGuardEnabled` | bool | Run Azure Content Safety moderation on inputs/outputs (legacy field name; provider is Azure). |
| `config.webSearchGuardEnabled` | bool | Apply PII filter to web-search results before injection. |

Agents live in Postgres (`agents` table). The fields above are exposed in **Studio → Agent designer** ([details](../studio/agent-designer.md)) and in **Studio → Agent wizard** for non-technical creators.

## System starter agents

Every new tenant gets 10 built-in system agents. They're seeded automatically, owned by the special `system` user, and selectively updated when their prompt files change (hash-based detection):

| Agent | Purpose |
|-------|---------|
| **Title Generator** | Generates a short conversation title after the first turn. |
| **Memory Extractor** | Pulls memorable facts out of a conversation for the user's profile memory. |
| **Component Designer** | Designs custom UI components from a description. |
| **PDF Extractor** | Specialised PDF reader; layout-aware extraction. |
| **Prompt Designer** | Helps you write a system prompt for a new agent. |
| **Conversation Starters** | Suggests opening messages for a new agent. |
| **Description Improver** | Polishes agent descriptions before publishing. |
| **Identity Improver** | Iterates on an agent's persona/tone. |
| **OrgIntel Scout** | Gathers public info about an organisation by name. |
| **Regex Generator** | Admin-only — drafts regex patterns for Privacy Shield custom terms. |

These aren't visible to end users in the chat picker by default — they run behind the scenes for system features. Org admins can promote any of them to user-visible by editing in **Studio**.

![Chat empty state with starter prompts](../img/screenshots/features/chat-empty-state/)

## Tool dispatch

When you send a message, the server:

1. Resolves the agent's allowed tool set by combining:
   - Org-level enabled integrations (`enabledIntegrations`)
   - Per-group disable lists ("enable wins")
   - User-level personal overrides
   - The user's OAuth status (Google connected? GitHub connected?)
   - Beta-feature flags
2. Sends the prompt + tool list to the model in the right format (Claude tool-use, OpenAI function-calling, etc.).
3. As the model emits a tool call, the server dispatches it to the correct integration handler in `server/integrations/*.js`.
4. The result is streamed back into the conversation as a `tool_result` event.
5. The model continues its turn with the tool result in context.

This loop continues until the model emits a normal text completion (no further tool calls).

If a round comes back empty — for example a reasoning model that spent its whole output budget on thinking, or a malformed tool call that had to be dropped — the server retries the round once with a targeted nudge. If it still produces nothing, you see a short notice ("The model returned an empty response…") instead of a blank bubble, and provider-side failures are surfaced as errors rather than silence.

## Streaming UX

Replies stream token-by-token over Server-Sent Events. Tool calls also stream — you see "Reading file…" or "Searching mail…" as they happen, not just at the end:

```
event: token
data: {"text": "Looking"}
event: token
data: {"text": " for"}
event: tool_call
data: {"id":"tc_1", "name":"nc_files_search", "args":{"query":"Q3 report"}}
event: tool_result
data: {"id":"tc_1", "result":[{"path":"/Reports/Q3.pdf"}]}
event: token
data: {"text": " I found it..."}
event: done
data: {"messageId":"msg_abc"}
```

See [API → Streaming (SSE)](../api/sse.md) for the full event spec and reconnection rules.

## Tool-call visibility (audit-friendly)

Every tool call shows up inline as a clickable row in the conversation. Click it to expand the full request and response. This makes every action auditable — for compliance you can also export the audit log (Enterprise+).

![Inline tool-call row, expanded](../img/screenshots/features/chat-tool-call/)

## Conversation lifecycle

| State | Trigger |
|-------|---------|
| Created | First user message |
| Active | Agent is generating |
| Completed | Agent emits `done` event |
| Cancelled | User clicks stop, or `/api/chat/:id/cancel` is called |
| Deleted | User clicks delete (soft-delete; purged after 30 days) |

Conversations are stored in Postgres (`conversations`, `messages`, `tool_calls` tables). Retention is org-configurable; the default is "until the user deletes it".

## Threads

If `threads_enabled` is on, any message can be branched into a thread. Threads share the parent's context up to the branch point, then continue independently. Useful for "what if" exploration without polluting the main thread.

## Workspace pane

If `workspace_enabled` is on, certain tool results (rendered HTML, generated images, code artefacts) open in a side pane instead of inline. This keeps the conversation scannable when the agent produces large artefacts.

## Presentations (.pptx)

Ask for "a presentation", "slides" or "a deck" and the assistant calls `create_presentation`: a real PowerPoint file (`.pptx`) in your organisation's document house style — accent colour, font, logo and footer from **Studio → Documents → House style** — that opens in PowerPoint, Keynote, LibreOffice and Nextcloud Office. The model writes the deck as structured slides (title, 3–6 bullets, speaker notes; tables, quotes, two columns and section dividers where the content asks for it) or as a markdown outline (`# ` title, `## ` per slide). The reply ends with a download link; the file lives in your own storage and is served only to you.

- **In Bee Flow, without a download**: every deck is also kept in **Studio → Documents** as a presentation (the reply links it, and the file card under the reply has an *Open* button). It opens as slides beside the chat, where you can edit the outline, change the look and download it again as PowerPoint or PDF; "change the third slide" is `document_read` + `document_edit` on its outline. Pass `saveToLibrary: false` for a throwaway file.
- **In Nextcloud instead**: "save it in Nextcloud under /Presentaties" → `nextcloud_create_presentation` writes the file into Nextcloud Files and answers with an *Open in Nextcloud Office* link (`/f/<fileId>`).
- **Images**: only pictures Bee Flow already holds — the `imageUrl` a `generate_image` call returned, or an inline `data:` URL — are placed on a slide. Remote pictures are never fetched during rendering.
- **Reading decks**: upload a `.pptx` (or point `nextcloud_read_file` at one) and the assistant gets its text slide by slide, speaker notes labelled under each slide, so "summarise per slide" keeps the boundaries.
- **The look**: set once under **Studio → Documents → House style → Presentations** — a style family (*Title band*, *Clean*, *Bold*, *Dark*), deck-specific accent/background/text colours, title and body typefaces, the cover style (accent block, light, split panel), the table style (banded, lines, minimal), where the logo sits, slide numbers and a footer line — with a live preview of the cover and a content slide. Text colours are always derived for contrast, so a letterhead whose ink is near-white never yields a white-on-white deck. Any single deck can override these ("in blue, dark style, Georgia, without the logo") through the tool's `theme` argument (`preset`, `accent`, `background`, `font`, `coverStyle`, `tableStyle`, `logo`, `logoPlacement`, `footerText`).
- **Template deck**: upload a `.pptx` under **House style → Presentations → Template deck** — a conference deck, a client's house deck — whose first two slides carry the design (a cover and a content slide). Its backgrounds and logo go under every presentation; text and chart colours are derived against them, the title band steps back. Per deck: `theme.template: "none"` for plain slides, or (Nextcloud tool / `nextcloudPath`) `templatePath` to build on a `.pptx` in the user's Nextcloud for this deck only.
- **Cards**: three to six `### ` sub-headings on one slide (or `cards: [{title, text, icon?, image?}]`) become titled cards — a row up to three, a grid beyond; two sub-headings stay a two-column slide unless `<!-- layout: cards -->` says otherwise. `### Title {icon: shield}` puts a Lucide icon on the card (about 120 names ship: shield, users, workflow, chart-line, lock, cloud-off, rocket, wifi-off, database, sparkles…), an image line inside the block a picture. KPI tiles take an icon as the fourth field (`2m | Processing | -95% | clock`).
- **Visuals**: a slide can carry a **chart** (column, bar, line, area, pie, donut — from labels and series, or from data rows with the columns auto-detected; a table with `<!-- chart: bar -->` above it becomes one), up to four **KPI tiles** (`stats`: value, label, change), a **timeline** of numbered steps, or an **emphasis style** (`accent` / `dark`) for one slide. Charts land in the `.pptx` as native, editable PowerPoint charts in the deck's palette (six colours derived from the accent, each checked against the slide surface); in the PDF deck they are vector graphics. In a markdown outline they are ```` ```chart ```` and ```` ```stats ```` blocks.
- **AI-content marking**: when the organisation has EU AI Act Art. 50(2) marking switched on, the deck carries the marking line in every slide's footer and the same machine-readable keywords in its file properties that PDFs and Word files get.
- **Caps**: 60 slides, 10 bullets per slide (overflow becomes a continuation slide), 4 MB per image.

## Memory

Per-user memory is automatically populated by the **Memory Extractor** agent — facts like preferred timezone, current project, recurring tasks. The user manages it under **Settings → Account → Memory** (delete individual entries or clear all). Memory is injected into the system prompt for every conversation that opts in.

## Where to next

- [Studio → Agent designer](../studio/agent-designer.md) — build a new agent from scratch.
- [Studio → Agent wizard](../studio/agent-wizard.md) — guided flow for non-technical creators.
- [Knowledge bases](knowledge.md) — attach a document set to an agent.
- [Privacy shield](privacy-shield.md) — what's filtered before the model sees a prompt.
