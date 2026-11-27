# Task `editions`: the edition switch covers every first-party module

## Why

`BEEFLOW_EDITION=core` and `BEEFLOW_MODULES=a,b` (`server/modules/catalog.js`,
`availableByEdition`) are how an installation chooses its modules. Today they reach only the ten
ids of the catalog; the other thirteen first-party modules (datatables, cowork, cms, templates,
playbooks, sanctions, billing_stripe, mcp_server, custom_integrations, int_google,
int_microsoft, int_nextcloud, int_erp_nl, int_saas) always load. The product decision is: the
core is chat, knowledge base, memory and agents; everything else is a module. So
`BEEFLOW_EDITION=core` must load no first-party module at all, and
`BEEFLOW_MODULES=learning,support,int_google` must mean the core plus exactly those.
`BEEFLOW_HIDE_MODULES` is a development switch that needs the checkout; an image can only use
the edition.

## The rule (build exactly this)

With neither variable set, every module is available: nothing changes.

Otherwise a first-party module M is available when

1. M is listed in `BEEFLOW_MODULES`; or
2. M has no row of its own in the catalog (it has no switch of its own on the admin Modules
   page) AND a module that is available `requires` M, directly or through other such modules.
   Example: `BEEFLOW_MODULES=automation,approvals` (the documented example) keeps working,
   because automation requires datatables, which has no catalog row and so comes along.

A module WITH a catalog row is available only when listed, as today
(`catalog.isModuleAvailable`): its gates (`requireModule`) and its capability projection read
the catalog, and they must agree with the loader. So `BEEFLOW_MODULES=cowork` alone leaves cowork
absent ("it requires "automation", which is not available in this edition"): say that in the log.
`uses` never pulls a module in.

Do NOT add rows to the catalog's `MODULES`: the admin Modules page must show what it shows
today. (Catalog rows for the thirteen come later, with the web client.)

## Where

- `server/modules/firstParty/loaderRules.js`: the rule as a pure function, e.g.
  `availableIds(ids, requiresOf, { listed, hasOwnSwitch, full })` returning a Set, with tests in
  `loaderRules.test.js` (cycle-free by the existing check; an unknown id in BEEFLOW_MODULES is
  ignored with one warning naming it and the known ids).
- `server/modules/firstParty/loader.js`: use it where `isAvailable` is asked today (`readComposition`
  / `settle`). The file has a 400-line ceiling and is at 396: put the logic in loaderRules.js.
  The `deps.catalog` seam of `load()` must keep working for the existing tests; extend it with
  what you need (`availableByEdition`, `getModule`), defaulting to the real catalog.
- One `log.info` line at load when an edition is in force:
  `[modules] edition: core + automation, datatables (comes with automation); left out: apps, ...`.
- `server/modules/firstParty/loader.test.js` and `compositions.test.js`: the latter has
  `loadRealTree()`, a clean child process on the real tree; add editions there:
  `BEEFLOW_EDITION=core` -> all 23 absent; `BEEFLOW_MODULES=automation,approvals` -> automation and
  datatables loaded, the other 21 absent; `BEEFLOW_MODULES=learning,support,int_google` -> those
  three; `BEEFLOW_MODULES=cowork` -> all absent.
- `.env.example` (the "Edition" block) and `docs/docs/self-hosting/env.md`: the new meaning, the
  full list of ids (from `scripts/module-map.json`, 23), the "comes along" rule in one sentence,
  and a short note for an installation that already sets `BEEFLOW_EDITION=core`: integrations,
  datatables, the CMS and Stripe billing were part of "core" before and are modules now; list
  them in `BEEFLOW_MODULES` to keep them. Plain language, no dashes as punctuation.
  Check `npm run lint:env-inventory-ratchet` and the docs lints in `check:fast`.

## Check by hand and report what you saw

A Postgres 16 runs on 127.0.0.1:5544 (user `beeflow`, trust auth). Create your own databases
(`psql -h 127.0.0.1 -p 5544 -U beeflow -d postgres -c "create database r2_ed_core"`), names
starting with `r2_ed_`. Environment for both commands:
`NODE_ENV=production OTEL_ENABLED=false SESSION_SECRET=local-boot-check-secret-value-0123456789 MASTER_ENCRYPTION_KEY=local-boot-check-secret-value-0123456789 CORE_DATABASE_URL=postgresql://beeflow@127.0.0.1:5544/<db>`

1. `BEEFLOW_EDITION=core node migrateDb.js` on an empty database: exit 0, and the table list
   equals the one `BEEFLOW_HIDE_MODULES=all node migrateDb.js` gives on another empty database
   (138 tables). Report any difference: a table created with the edition but not with hiding is
   a core file creating a module's table, or the reverse.
2. `BEEFLOW_EDITION=core PORT=3520 node index.js`: `/api/ready` 200, `/api/datatables` and
   `/api/automation` 404, SIGTERM exits 0. Then the same with
   `BEEFLOW_MODULES=learning,support,int_google` on a third database.
3. Neither variable set, a fourth empty database: `node migrateDb.js` gives 280 tables.

## Out of scope

The web client, catalog rows, capability projection (task `capabilities`), anything under
`agent-hub/`.
