# Trigger sources — how an integration declares its own events

An `app_event` trigger exists because some integration says it does. There is no
central list to edit: drop a declaration next to your integration and the
provider appears in the automation builder, gated on whether the user actually has
that integration.

**You often don't need a file at all.** Any enabled integration exposing a
read-only tool that takes no arguments and returns a collection is offered
automatically as "when the result of this changes" — see
[Auto-derived sources](#auto-derived-sources). Write a declaration when you want
precise event names, real output fields, or a delivery mode other than polling.

## Where a declaration lives

| Integration kind | Put the file here |
|---|---|
| First-party (Gmail, Sheets, Nextcloud…) | `automation/triggerSources/declared/<provider>.js` |
| Bundled MCP server | `mcpServers/<id>/events.js` — CommonJS, beside the ESM `index.mjs` |
| Remote MCP / org custom integration | call `registerTriggerSource(decl, { orgId })` at runtime |

Both directories are swept at boot. Export either `TRIGGER_SOURCES` (an array)
or `TRIGGER_SOURCE` (one object).

## The shape

```js
module.exports = { TRIGGER_SOURCES: [{
    id: 'acme',                    // → trigger.appEvent.provider. IMMUTABLE once shipped.
    label: 'Acme',
    order: 100,                    // built-ins hold 10–80; declare 100+ so the
                                   // builder's default provider never moves
    defaultEvent: 'widget.changed',
    availability: { kind: 'tools', apps: ['acme'] },   // | { kind: 'mcp', serverId }
                                                      // | { kind: 'check', check }
    events: [{
        id: 'widget.changed',      // → trigger.appEvent.event. IMMUTABLE.
        label: 'Widget changed',

        // What downstream steps can bind to (trigger.output.*). Every field
        // needs a sample — that is what the variable picker shows before the
        // automation has ever run.
        fields: ['sku', 'state', 'changedKeys', 'previous', 'current', 'changedAt'],
        sample: { sku: 'W-1', state: 'running', /* … */ },

        // Who an inbound event may reach. No default on purpose: an unscoped
        // event is dropped rather than fanned out across tenants.
        scope: 'user',             // | 'org'

        source: {
            kind: 'poll_diff',
            tool: 'acme_list_widgets',       // any name executeTool() understands
            args: { limit: 100 },            // STATIC in v1 — no per-subscription values
            requiresIntegration: 'acme',     // re-checked on every poll
            itemsPath: 'widgets',            // '' for a root-level array
            idPath: 'sku',                   // stable identity of one item
            changePaths: ['state'],          // what counts as "changed"
            emitOnAppear: false,             // fire for items seen for the first time
            firstRun: 'anchor',              // record state, emit nothing
            minIntervalMs: 300_000,
            maxItemsPerTick: 25,
            maxTrackedItems: 100,
            trackValues: true,               // keeps `previous` exact; ≤100 items
            emit: { mode: 'item', map: { sku: 'sku', state: 'state' }, includeChanges: true },
        },
    }],
}]};
```

`changePaths` also accepts `{ path, keyBy, pick }`, which turns an unordered
array into a keyed map before hashing — so a provider re-ordering its rows is
not a change, and `changedKeys` can name what actually moved. Tuya's data points
use this (`mcpServers/tuya/events.js`).

## What you get for free

Polling and de-duplication, a cursor with a 32 KB budget, first-run anchoring
(activating an automation never fires once per pre-existing item), a per-pass call
cache keyed by user, per-event minimum intervals, the generic filter matcher
plus the `any`/`none`/`expr`/`age` DSL, failure escalation, and the builder's
provider/event dropdowns and variable picker.

## What is deliberately not supported yet

- **Push.** `source.kind: 'push'` is reserved but has no generic ingest route;
  such events report as not deliverable. The existing push providers
  (Microsoft Graph, Nextcloud connector, GitHub) each have a bespoke,
  individually-authenticated route in `routes/automation/events.js`.
- **Per-subscription arguments.** They would defeat the cross-subscription poll
  cache and open an injection surface into tool arguments.
- **Cursor/token feeds.** Append-only sources with a monotonic id want a
  `poll_cursor` kind. Add it when a second integration needs it — Gmail,
  Calendar and Nextcloud keep their hand-written pollers because those encode
  real recovery logic (stale `historyId`, 410-Gone `syncToken`) that a generic
  runtime should not try to express.

## Auto-derived sources

`autoDerive.js` synthesises providers from the caller's own resolved tool set, so
enabling an integration is enough to get a trigger. A tool qualifies when it:

- returns a **collection** (an explicit `list`/`search`/`recent`/`feed`/`history`
  verb, or a plural name), and
- takes **no required arguments** — we have to be able to call it blind, and
- is **read-only**. First-party tools are judged by `sideEffectMap`, which is
  curated and fail-closed. MCP tools cannot be: that map lists none of them, so
  every MCP tool would read as side-effecting. They are judged by name instead —
  a read verb is required and any write verb disqualifies.

Three deliberate refusals, each of which would otherwise produce a trigger that
lists but never fires:

| Refused | Why |
|---|---|
| An integration that ships a declaration | The real one wins; no vaguer duplicate. |
| An MCP server whose id has more than one token | Tool names are sanitised (`[^A-Za-z0-9_]→_`), so `my-server` and `my_server` both arrive as `mcp_my_server_…` and the capability cannot be read back. Ship a manifest for these. |
| A response with nothing list-shaped | Raised as a subscription failure rather than silently polling forever. |

The event id encodes the tool (`auto.<tool>.changed`), which is what lets the
polling tick rebuild the whole spec from a subscription row — no user, no
catalog. The item shape is inferred from each response (first array of objects,
the most plausible id field, every other scalar as a change field), and the raw
item travels as `trigger.output.item` because nothing declared its fields; the
builder's run-data overlay fills the picker in after one test run.

Listing costs nothing: no polling happens until an automation using one is activated,
and derived sources poll at most every 15 minutes.

## Rules the validator enforces

Every declaration is validated on the way in and rejected whole if it carries an
error — a half-valid event would be offered in the builder and never fire. It
checks that every declared field has a sample, that `defaultEvent` is one of the
listed events, that ids are unique and well-formed, that all events of a
provider agree on `scope`, and that the source names a producer that exists.

Run the suite with:

```bash
cd server && node --test automation/triggerSources/validate.test.js \
  automation/triggerSources/registry.test.js \
  automation/triggerSources/pollDiff.test.js \
  automation/triggerSources/declared.google.test.js
```
