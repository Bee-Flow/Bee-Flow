---
title: Integrations
---

# Integrations

Bee Flow ships connectors for ~30 external services. Each integration exposes one or more **tools** to the agent — a tool is a typed function call the model can issue.

This page is the catalog. Click into each integration for tool lists, OAuth scopes, env vars, and troubleshooting.

## Catalog

### Nextcloud (11)

Available via the [Nextcloud connector](../connector/index.md). The 11 integrations map 1:1 to `nextcloud-*` tool files in the server.

| Integration | What it does |
|-------------|--------------|
| [Files & WebDAV](nextcloud.md) | List, search, read, upload, share files |
| [Mail](nextcloud-mail.md) | Read, draft, send mail via Nextcloud Mail |
| [Calendar](nextcloud-calendar.md) | List, search, create, update, delete events |
| [Contacts](nextcloud-contacts.md) | Read & search contacts |
| [Deck](nextcloud-deck.md) | Boards, stacks, cards, labels, comments |
| [Talk](nextcloud-talk.md) | Rooms, post messages, react |
| [Notes](nextcloud-notes.md) | Plain-text / Markdown notes |
| [Tasks](nextcloud-tasks.md) | VTODO via CalDAV |
| [Activity](nextcloud-activity.md) | Read-only feed of recent file changes |
| [Notifications](nextcloud-notifications.md) | List & dismiss notifications |
| [User Status](nextcloud-status.md) | Get / set availability + custom message |

### Productivity suites

| Integration | What it does |
|-------------|--------------|
| [Google Workspace](google.md) | Gmail, Calendar, Drive, Docs, Keep, Contacts, Groups |
| [Microsoft 365](microsoft.md) | Outlook (RW + RO), MS Calendar, MS Contacts, OneDrive |

### DevOps / collab

| Integration | What it does |
|-------------|--------------|
| [GitHub](github.md) | Repos, issues, PRs, code search |
| [YouTrack](youtrack.md) | Issue search, create, comment |
| [SignRequest](signrequest.md) | E-signatures |
| [Fireflies](fireflies.md) | Meeting transcripts |
| [Gamma](gamma.md) | AI-generated presentations |

### Business systems

| Integration | What it does |
|-------------|--------------|
| [vPlan](vplan.md) | Read planning, capacity, resources, orders & time tracking (read-only) |

### Social / messaging

| Integration | What it does |
|-------------|--------------|
| [LinkedIn](linkedin.md) | Profile lookup |

### Search & content

| Integration | What it does |
|-------------|--------------|
| [Web search](web-search.md) | Bing or Tavily |
| [Maps](maps.md) | Google Maps |

### AI modules (built-in, no external auth)

| Integration | What it does |
|-------------|--------------|
| [AI modules](ai-modules.md) | Agent Search, Image Gen (Veo), Video Gen, Music, TTS, Transcription |

## Three-layer access control

Integrations are gated at three layers, in order:

```
1. User-level    — has the user connected the OAuth, or supplied an API key?
2. Org-level     — is the integration enabled in the org's enabledIntegrations list?
3. Group-level   — has any of the user's groups disabled it?
```

The rule for level 3 is **enable wins** — a user gets access if **at least one** of their groups still allows it. If every group the user belongs to disables an integration, the integration is denied for that user.

## Auto-enabled apps

These integrations are implicitly available to every user unless explicitly disabled at the org or group level (no opt-in needed):

```
agent-search, workspace, image-gen, music-gen, video-gen, elevenlabs,
google-maps, linkedin, github, google-contacts, google-keep, outlook,
outlook-readonly, ms-calendar, onedrive, ms-contacts, google-groups,
nextcloud, nextcloud-calendar, nextcloud-contacts, nextcloud-deck,
nextcloud-notifications, nextcloud-talk, nextcloud-tasks, nextcloud-notes,
nextcloud-activity, nextcloud-status
```

Some of these still require user OAuth (e.g. Google) — they're "auto-enabled" in the sense that the org/group filter doesn't block them; the per-user authorisation gate is separate.

## How to connect a tool to an agent

Three ways:

1. **All tools** (default for new agents) — agent sees every tool the user has access to.
2. **Per-agent allow-list** — in **Studio → Agent designer**, pick exactly the tools this agent can call.
3. **Per-tool denylist** — block specific tools at the agent level. Useful when you want a customer-support agent that *can't* read Files but *can* read Mail.

## How org admins control access

In **Admin → Nextcloud integrations** (and **Admin → Other integrations**) an admin can:

- Toggle integrations on/off org-wide
- Override per-group (disable specific tools for specific groups)
- Lock per-user override settings (so users can't re-enable disabled tools)

[Read more →](../admin/nc-integrations.md)
