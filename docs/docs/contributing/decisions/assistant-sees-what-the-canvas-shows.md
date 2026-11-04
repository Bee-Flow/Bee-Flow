---
title: "0014: The assistant sees what the canvas shows"
description: Why the automation builder's assistant is told every step type, app action, building block and connected tool the canvas offers the person, in the canvas's own words, on every model band, and why the vocabulary is rendered from one table that tests hold against the batch types.
---

# 0014: The assistant sees what the canvas shows

**Status:** accepted, in effect. **Code:** `server/automation/builderTools/stepTypeTable.js`
(one row per step type: `authoring`, `family`, `userLabel`),
`server/automation/builderPrompt/stepFamilies.js` (the "What you can build" block, both
prompt variants), `server/automation/builderCatalog.js` and
`server/automation/builderPrompt/catalogRender.js` (the catalogue rows, the tools without a
registry entry included), `server/automation/builderTools/schemaProjection.js` (the small
band's batch types), `server/automation/builderPrompt/lastTestRun.mts` (the "Last test run"
block). **Enforced by:** `server/automation/builderPrompt.menuCoverage.test.js`,
`server/automation/builderPrompt/catalogRender.test.js`,
`server/automation/builderPrompt/stepFamilies.test.js`,
`server/automation/builderTools/promptCatalogSync.test.js`.

## Context

The person and the assistant work on the same automation from two sides: the person
through the canvas (the ribbon, the palette, the inspector), the assistant through its
prompt and its tools. When the two show different things, the person asks for a step they
can see on the ribbon and hears that it is not possible.

They had drifted apart in four ways:

- **Tools that were resolved but not shown.** Tools from MCP servers, the organisation's
  custom integrations, automations that agents may call and Step tools were in the set the
  assistant could run, but the catalogue rendered only the apps of the tool registry, and
  inspecting one of them returned no inputs.
- **Building blocks.** The canvas offers the workspace's shared steps under *My building
  blocks*; for the assistant the step type was canvas-only, so it sent the person back to
  the canvas.
- **The small model band.** The prompt of the fast tier and local models had no step menu
  and a batch tool that took nine of the step types, and it told the model that the rest
  was not on its menu.
- **Words.** The prompt named steps by their runtime type (`approval`, `datatable`), the
  ribbon by their label (*Ask someone to approve*, grouped under *People*), so the
  assistant could not answer in the words on the person's screen.

Nothing failed when they drifted: a new step type, a new kind of tool or a smaller tool
menu went unnoticed until a person ran into it.

## Decision

- **One table, every band.** `stepTypeTable.js` holds, per step type, whether the builder
  can author it (`batch`, `canvas_only`), the ribbon group it sits in (`family`) and the
  palette's word for it (`userLabel`). `stepFamilies.js` renders it as the "What you can
  build" block, grouped by ribbon tab in tab order, with the runtime type in brackets. Both
  prompt variants open with it, right after the role line. The compact variant adds the
  fields of each batch entry, because the small band has no single-step tool whose schema
  would teach them. A canvas-only type is listed as canvas-only.
- **The small band can author every batch type.** Its batch tool takes the same types as
  the frontier band's.
- **Every runnable tool is a catalogue row.** A tool the assistant may run and that has no
  registry app is rendered under its group (*MCP · server*, *Custom integrations*,
  *Agent-callable automations*, *Step tools*) with its input count, and inspecting it
  answers its real input schema.
- **Building blocks are authorable.** A shared step is added with a `call_block` step,
  from the same list the canvas palette shows.
- **Connected apps only.** An app the person may use but has not connected is not named
  to the assistant. When no connected app can do something, the assistant says so and asks
  which app to use. The hand-over names an unconnected app only when the automation
  already uses it.
- **What a test run showed is kept.** The field names and shapes each step returned in the
  last test run (never values, at most 4 KB) are kept in the builder session and replayed
  as the "Last test run" block of the next turn's late message.

## Consequences

- A new step type is a row in `stepTypeTable.js` with a `family`, a `userLabel`, a line
  in `WHEN` and, for a batch type, its entry in `SPEC`. Without them the tests below fail.
- The block sits at the front of the system prompt, which is the front of the prompt
  cache. Changing a line rebuilds every cached prompt once; that cost is accepted rather
  than placing the vocabulary after the catalogue.
- The small band's prompt is longer by one compact line per step type.
- The global trigger catalogue left the `builder_propose_trigger` description: the
  per-user *App events* block carries the providers this person can use, so the
  catalogue is sent once.
- The assistant cannot suggest an app the person has not connected. That is deliberate:
  the list of apps a person could connect says nothing they asked about, and naming them
  would lead the assistant to build on apps that do not run.

## The check that enforces it

- `server/automation/builderPrompt.menuCoverage.test.js`: every batch step type is named in
  every prompt variant (full and lean, both menus, both catalogue placements, code steps on
  and off), every type a person can meet on the canvas is named, canvas-only ones as such,
  and the block comes first after the role line.
- `server/automation/builderPrompt/catalogRender.test.js`: "every tool in
  catalog.toolNames is named in renderCatalogSlim", the tools without a registry entry
  render under their group, and `builder_inspect_tool` answers the real inputs of an MCP,
  custom and Step tool.
- `server/automation/builderPrompt/stepFamilies.test.js`: the `SPEC` keys are exactly the
  batch types and each key is one the builder takes; the groups are the ribbon tabs in tab
  order; every type a person can meet has a `WHEN` line.
- `server/automation/builderTools/promptCatalogSync.test.js`: the trigger providers the
  prompt describes each have a section in the per-user lines, and the events and filters
  it names exist in the trigger sources.
