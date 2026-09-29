---
title: Agent designer
---

# Agent designer

The Agent Designer is the advanced UI for building and editing agents. URL: `/app/agent-designer-advanced`.

For a guided alternative aimed at non-technical creators, use the [Agent Wizard](agent-wizard.md).

![Agent designer](../img/screenshots/studio/agent-designer/)

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Identity   Behaviour   Tools   Knowledge   Sharing   Advanced  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   <fields for the active tab>                  [Test in chat] ▶ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The right-side **Test in chat** pane is always live — every change you save reflects there immediately so you can iterate.

## Tab 1 — Identity

| Field | Notes |
|-------|-------|
| Name | Required. Visible in the picker. |
| Description | One-liner. |
| Avatar | Image upload, emoji, or generated. |
| Category | Picker (Marketing / Engineering / etc.) — affects discoverability in the marketplace. |

## Tab 2 — Behaviour

| Field | Notes |
|-------|-------|
| Model | Specific model ID (e.g. `claude-opus-4-7`) or null = inherit org default. |
| Effort | Low / Medium / High — controls reasoning depth where supported. |
| System prompt | Markdown, can include `{{user_name}}`, `{{org_name}}`, `{{today}}` template variables. |
| Starter prompts | Up to 4 quick-click prompts shown at the top of every empty conversation. |
| Threads enabled | Allow branching. |
| Workspace pane | Auto-open results in the side pane. |
| Copy button | Show "copy reply" buttons next to each message. |

## Tab 3 — Tools

| Setting | Notes |
|---------|-------|
| Tool selection | Check / uncheck individual tools the agent may call. Defaults to "all tools the user has access to". |
| Tool deny-list | Block specific tools even if the user has them. |
| Per-tool prompts | Override the default tool description with your own — useful for guiding the model. |

The list of tools is computed live from the [three-layer access matrix](../integrations/index.md#three-layer-access-control), so the picker only shows tools that would actually be available at runtime.

## Tab 4 — Knowledge

| Field | Notes |
|-------|-------|
| Attached KBs | One or more. Searched automatically when the agent answers. |
| Source references | Show inline citations (off) or as a dedicated card list (on). |
| Auto-search | Search KB on every turn (default), or only when the agent decides to call `kb_search`. |

## Tab 5 — Sharing

| Field | Notes |
|-------|-------|
| Visibility | Just me / Specific groups / Whole org. |
| Shared groups | Multi-select NC / Bee Flow groups. |
| Embed enabled | Allow embedding in an iframe outside Bee Flow. |
| Embed origin allow-list | Comma-separated list of permitted parent origins. |
| Publishable | Allow this agent to be published to the public marketplace. |

## Tab 6 — Advanced

| Field | Notes |
|-------|-------|
| Privacy Shield level | Override the org default for this agent. |
| Moderation | Toggle Azure Content Safety moderation on responses. |
| Web-search guard | Apply PII filter to search results. |
| Memory access | Pull user's memory into context. Default: on. |
| Conversation retention | Default / 30 days / 7 days / no retention. |
| Stop sequences | Custom strings that end generation. |
| Temperature | 0–2. |
| Max output tokens | Default model max, or override. |

## Test in chat

The right-hand pane is a real conversation — except it's scoped to the current draft and isn't saved to the user's history. Switch agents on the left and the test resets.

## Saving + publishing

| Action | What it does |
|--------|--------------|
| Save | Stores the draft. Visible in your library, not yet to others. |
| Publish to org | Visible to whoever you specified in Sharing. |
| Publish to marketplace | Submit for the public marketplace (admin approval if required). |

## Forking

Click **Duplicate** on any agent you can see to create a copy you can edit freely — a way to start from a working agent without touching the original. There is no agent template gallery and no public agent marketplace; the gallery in the product lists your own organisation's agents.

## Memory of agents

Each agent has its own memory store keyed by `(agentId, userId)`. The Memory Extractor system agent populates it with facts the agent has learnt across conversations ("Alice prefers concise replies", "Alice's project is called Helix"). The user manages it under **Settings → Account → Memory**.

## Related pages

- [Agent wizard](agent-wizard.md) — guided creation flow.
- [Skills](skills.md) — reusable methods you attach to an agent.
- [Components](components.md) — pair with custom UI components.
- [Features → Chat & agents](../features/chat.md) — how the runtime uses these settings.
