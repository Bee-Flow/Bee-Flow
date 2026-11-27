# Task `capabilities`: an absent module offers nothing

## Why

With `BEEFLOW_EDITION=core` (or a module's files not there) the server no longer mounts a
module's routes. The web and mobile clients decide what to show from the capability projection
(`server/core/entitlements/`, served by the entitlement routes). For the ten catalog modules an
unavailable module's capabilities already leave that projection (`modules/catalog.js`
`capabilityIds`, `capabilityRegistry.js` `moduleCapabilityMap`, and what reads `cap.moduleId`).
For the other thirteen first-party modules nothing does: a core installation would still offer
Google, AFAS, datatables, the CMS, MCP server tokens, Stripe billing and so on, and every click
would end in a 404.

## What to deliver

1. **Find out first, and report it**: how exactly a catalog module's capabilities are removed
   when it is unavailable (which function, at which point of the entitlement resolve), and
   which capability ids, integration descriptors and licence features belong to each of the
   thirteen non-catalog modules: datatables, cowork, cms, templates, playbooks, sanctions,
   billing_stripe, mcp_server, custom_integrations, int_google, int_microsoft, int_nextcloud,
   int_erp_nl, int_saas. Ownership of a file: `node scripts/module-map.mjs --owner server/<path>`;
   `--list <id>` lists a module's files. A capability belongs to a module when the code that
   implements it is that module's.
2. **Declare them with the module**: each first-party module names its capability ids in its
   composition (a new optional key of the composition, e.g. `capabilities: string[]` in
   `firstParty/<id>.js` via `withParts`, validated in `modules/firstParty/contract.js`; or a key of
   `<id>.provides.json` if that fits the loader better: decide and say why). For the ten catalog
   modules the catalog's `capabilityIds` stay the source; a test holds the two against each
   other so a capability is never claimed twice.
3. **Drop them when the module is absent**: where the projection is built, a capability whose
   first-party module is absent (the loader's state, `modules/firstParty/moduleState.js`
   `moduleStateOf`) is left out, the same way an unavailable catalog module's are. A FAILED
   module is not absent: follow what the catalog path does for a module that is installed but
   broken, and say what that is.
4. **With every module present the projection is byte-identical.** Do not stamp `moduleId` (or
   any new field) on descriptors of the thirteen: the admin pages group and label by it. Prove
   it: record the full projection (every descriptor, as the entitlement routes serialise it,
   for an org admin and for a plain member) before your change and after, and compare. Add that
   as a characterisation test with a golden if none covers it yet
   (`UPDATE_GOLDEN=1` convention, see `boot/compositionGolden.testkit.js`).

## Care

This is the entitlement layer: a mistake here widens what a user may do. The change may only
ever REMOVE capabilities, and only for a module that is absent. `core/entitlements/` is the
platform layer: it may not require `core/featureModules.js`; `modules/firstParty/moduleState.js`
and `moduleData.js` are allowed. Read `server/layering.test.js` before adding a require.

## Check and report

- `cd server && node scripts/run-tests.mjs --files <every test under core/entitlements and the entitlement routes>` in full mode.
- The same projection with `BEEFLOW_EDITION=core` (see task `editions`: until that lands the
  thirteen still load under an edition; use `BEEFLOW_HIDE_MODULES=all` to make them absent) and
  list what is left: it should read as chat, knowledge, memory, agents and the platform. Report
  every capability that is left and looks like a module's, with the file that implements it.
- `npm run lint:api-reference`, `lint:routes-contract`: unchanged.

## Out of scope

`agent-hub/` and `mobile/` (they read the projection; nothing there changes), the catalog's
`MODULES`, licence verification.
