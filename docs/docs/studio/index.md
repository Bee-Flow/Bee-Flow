---
title: Studio
---

# Studio

Studio is where you **build** the things your organisation then uses: agents, skills,
knowledge bases, automations, tables, apps, webpages, forms and the Solutions that
bundle them — plus the log of everything they did.

URL inside Bee Flow: `/app/studio`, and every section has its own address underneath it
(`/app/studio/<section>`).

## Studio navigation

Studio's navigation is a **rail** that replaces the app sidebar while you are on
`/app/studio*`. Its rows are grouped under four headings, in this order, and each
section declares which group it belongs to:

```
Studio
├── Build            what you build, wire together and ship
│   ├── Automations
│   ├── Datatables
│   ├── Webpages
│   ├── Apps
│   └── Forms
├── AI               what the assistant knows and can do
│   ├── Agents
│   ├── Skills
│   ├── Knowledge
│   └── Meeting Notes
├── Bundle           how the pieces ship together
│   ├── Solutions
│   └── Runs & log
└── Modules          installed add-ons
    └── (whatever is installed)

Approvals            its own row under the groups, not inside one
```

**Modules is the fourth group and the fallback.** An installed add-on can inject its own
Studio section at runtime; anything that does not name a group lands here, so a module
can never quietly fall out of the navigation while staying routable. A module *may*
declare `build`, `ai` or `bundle` to file itself under a first-party heading instead.

**Approvals** is deliberately not one of the grouped rows. It is a member act rather
than a building block, and the rail carries it as a separate row beneath the groups —
with a badge only while something is actually waiting, so an empty queue says nothing
rather than "0".

## What's in Studio

Twelve sections, in rail order. A few share a docs page with a neighbour or
have none of their own yet; those link to the closest page.

<div className="bf-grid">

-    [Automations](../features/automations.md)

    Multi-step automations that run for you — on a schedule, on an event, or when someone asks.

-    [Datatables](datatables.md)

    Rows your automations keep between runs — shared, typed, and with a "Used by" list.

-    [Webpages](webpages.md)

    Describe a page in chat, refine it, choose who may see it, publish.

-    [App Studio](apps.md)

    Full-stack AI app builder — the AI designs the data model, seeds data, wires components and roles; publish to your org or groups.

-    [Forms](forms.md)

    Every form published in the organisation: is it live, is anything coming in, which automation is behind it.

-    [Agents](agent-designer.md)

    Create and manage your agents — name, model, prompt, tools, knowledge, sharing. The [wizard](agent-wizard.md) is the guided way in.

-    [Skills](skills.md)

    Reusable agent skills — drop into any agent for instant capability.

-    [Knowledge](knowledge-bases.md)

    Knowledge bases your AI can search: add sources, attach them to agents and chats.

-    [Meeting Notes](../features/meeting-notes-voiceprints.md)

    Transcripts, speakers and actions.

-    [Solutions](solutions.md)

    Bundle automations, apps and webpages into one installable Blueprint.

-    [Runs & log](runs.md)

    Every time an automation fired, and what happened.

-    [Approvals](approvals.md)

    Requests waiting on a person, and every past decision. Its own row beneath the groups.

</div>

Automations answer to `/app/studio/automations`; the older `/app/studio/automations` and
`/app/studio/ai-tasks` addresses still resolve there, and the legacy standalone page at
`/app/automations` still opens the same builder.

### Nearby, but not Studio sections

Two pages are often thought of as Studio and are not — they have their own top-level
addresses:

- [Components](components.md) — AI-built UI components, at `/app/components`
  (Enterprise, `component_designer`).
- [Templates](templates.md) — your own Word (`.docx`) templates with `{{parameter}}`
  placeholders that the AI fills in, at `/app/templates`. Not agent templates: there is no
  agent recipe gallery in the product.

## What a row looks like when you cannot use it

Three mechanisms decide whether you see a section: the client-side gate on the row, the
middleware on the server route, and your organisation role. The rule between them:

- **A permission gate hides the row.** Someone who may not manage agents should not be
  shown a door that leads nowhere.
- **A licence or capability gate shows the row disabled, with a one-line hint** — either
  *"Not switched on for your organisation — ask an admin"* or *"Available on a higher
  plan"*. A Community organisation should learn that App Studio exists rather than never
  hear of it.
- **The server stays the authority either way.** The rail's own numbers come from one
  aggregate endpoint that simply *omits* a count you are not entitled to see — it never
  refuses as a whole, because a refusal would itself be an answer about your plan.

Studio also lands on the first section that is **not** locked, so a locked row is a
signpost rather than a door you keep walking into.

## Permissions

There is no separate "Studio policy" screen. What governs Studio is the combination of:

- **Your licence tier**, per feature. Automations, Datatables, Forms, Runs & log, Skills
  and Knowledge are in the free Community core; Approvals, Webpages, App Studio,
  Solutions, Meeting Notes and Components are Enterprise. See
  [Licensing → Tiers](../licensing/tiers.md).
- **Your organisation role** and the permissions on it — `manage_agents`,
  `manage_skills`, `manage_knowledge`, `manage_automations`, `manage_datatables`,
  `use_datatables`. Roles are configured under **Admin → Users and groups**.
- **Per-object sharing**, which each section owns: a datatable's read/write axes, a
  webpage's audience, an agent's publish state.

## Marketplaces

One marketplace ships in the product today: **Modules → Marketplace**
(`/app/admin/modules`, super-admin only), which installs add-ons. An installed module
may bring its own Studio section, which lands in the **Modules** group of the rail.

Inside Studio, **Solutions → Catalogue** lists the Blueprints you can install into this
organisation; installing one creates a copy you can edit freely.

The **Agents** row in the app sidebar is your organisation's own agent gallery — the
agents people here published — not a public marketplace.

## Where to next

- [Studio → Knowledge bases](knowledge-bases.md) — connecting sources to agents.
- [Features → Automations](../features/automations.md) — scheduled and event-driven
  automations.
- [Licensing → Tiers](../licensing/tiers.md) — which sections your plan unlocks.
