---
title: Solutions
---

# Solutions

A Solution is the **builder's view of a project**: the routines, apps and webpages that
work together, how they are wired, and the Blueprint you package them into. It is not a
new kind of object — the same project's *collaboration* side (chats, members, memory)
stays on `/app/projects`, which is where people who **use** a Solution live. Studio is
for whoever **builds** one, which is why the section sits next to Automations, Apps and
Webpages.

URL: `/app/studio/solutions` · one Solution opens at `/app/studio/solutions/:id`.

**Tier:** Enterprise. The section is gated on `projects`, the same entitlement the
server puts in front of `/api/projects`. On Community the row stays visible in the
Studio rail, **disabled with an upgrade hint** — the row is how an organisation learns
Solutions exist. Packaging on top of that is a *second* Enterprise key,
`blueprint_packaging`, enforced on each export/publish route (not router-level:
those routes share a mount with unrelated project routes).

## The overview

Three tabs, plus two create paths.

| Tab | What it lists |
|---|---|
| **From us** | Solutions built here |
| **Installed** | Solutions that came from a Blueprint (badged with a count, but only once the read succeeded) |
| **Catalogue** | Blueprints available to install |

- **New Solution** asks for a name.
- **Install a Blueprint** reads one from a file — the Catalogue tab covers the gallery
  half.

The overview is fed by one request that answers `null` for anything it could not read,
so the screen can tell *"none"* from *"could not find out"*. **A failed read is never
drawn as an empty workspace**: an empty state is only reachable after the read
succeeded, and a partial read says so.

## One Solution

Six tabs:

| Tab | What it holds |
|---|---|
| **Content** | Everything the Solution bundles, grouped, with dependency pills |
| **Check** | The completeness checks, badged with how many findings and whether any of them block |
| **Versions** | The release history — one immutable row per publication |
| **Installs** | Where this Solution's Blueprint has been installed |
| **Flow** | The wiring, and what this Solution depends on outside itself |
| **Overview** | Counts, live runs and recent activity |

The header carries the Solution's name (renameable by its owner or an editor), an audience capsule,
a Blueprint-version chip (`Blueprint v2`), and three actions: **Publish** (primary), **Export**, and
**Open in Projects**.

### The publish gate

**Publish** is shut unless the checks came back and explicitly said nothing blocks.
"Not loaded yet", a server error and a network failure all leave the button disabled
with *"Not while there are things to fix — or while the checks could not be run."* —
an unknown result narrows, it never opens the gate.

Publishing is also owner-only: exporting reads every entity in the Solution, including
other members' apps and routines, so the route is owner-only on top of the licence gate.

### The version chip

The chip says `Blueprint v2`, not "Solution v2", because a Blueprint version is what
the number counts. Versions are numbered per publisher, so when two owners have both exported the
same Solution there is no single answer and **no chip is shown at all**. Nothing is
shown before the first Blueprint either — an invented "v1.0" would be a release nobody
made.

### Updates

When a newer version of the Blueprint a Solution came from exists, a banner appears
above every tab (it is about the Solution, not about whichever tab happens to be open).
Only the owner gets the button to apply it — the same role the route requires. The
"a new version exists" event is a **poke, never the answer**: it carries no version
number and no Blueprint id, and the screen re-reads its own scoped data before it
claims anything.

Install counts and update notices cover **this installation only**. Blueprints are
scoped to the organisation and there is no cross-instance channel.

## Where to next

- [Studio → Apps](apps.md), [Studio → Webpages](webpages.md) — two of the things a
  Solution bundles.
- [Features → Automations](../features/automations.md) — the third.
