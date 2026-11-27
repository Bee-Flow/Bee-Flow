# Status of the core / modules split

Branch `ccr-b6017e12-l1bxyh`. Updated at the end of every batch.

## Done

**Phase 0, foundation (no behaviour change).**
- The resolver (`server/moduleRoots.cjs`, `server/modules/roots/`), loaded first by
  `server/index.js` and `server/migrateDb.js` and passed to every test process through
  `NODE_OPTIONS`; the server refuses to start when a tree path is in two roots.
- The ownership map for `server/` (10,126 files) and `agent-hub/src` (8,578 files).
- `scripts/lib/roots.mjs` and the roots inventory (115 tools still pending).
- The i18n dictionary index reads namespaces over every root; `en-defaults.js` is unchanged.
- Test scope: `run-tests.mjs --scope core|full|<ids>`, `--files`, `--hide-modules`.
- The boundary ratchet: 640 core -> module import edges, 7 lookups by name.
- CI path filters name the module roots, once.
- `modules/` scaffolding, the `node_modules` linker, the dev compose mount.
- Module state and the optional lookups (`optionalFeatureModule` and its two siblings).

**Phase 1, preparation.**
- The first-party loader, its contract, the order index and 23 empty compositions in
  `server/firstParty/`. Nothing is wired to the loader yet.
- Characterisation of today's composition: 166 mounts (3,168 overlapping pairs checked for
  order), 110 stores, 36 + 124 + 4 migrations, the registries, 94 job calls in 16 phases and
  the shutdown order.
- `scripts/module-move.mjs` and the dress rehearsal (5,968 files moved byte-identical; 76 of
  4,008 test files fail after an all-at-once move, each classified).

## Measured baselines

| What | Value |
|---|---|
| Core test files green with all modules hidden | 1,444 of 1,660 (216 fail; list in this directory) |
| Core -> module import edges (server) | 640 |
| Core -> module static imports (agent-hub) | 173 static, 196 lazy |
| Conversions needed before all modules can move | 643 (58 in production code) |

## Next

1. Move the composition rows into the part files, one kind per worker: mounts
   (`index.js`, `routes/ai.js`, `boot/staticAssets.js`), registrations
   (`boot/featureRegistrations.js`, `boot/featureModules.js`, the four registrars in
   `integrations/`), jobs and shutdown (`boot/startupJobs.js`, `boot/lifecycle.js`), stores
   and migrations (`storeModules.js`, `boot/bootMigrations.js`). The characterisation tests
   are the gate.
2. Cut the remaining core -> module edges per module (optional lookups, small registries
   with a safe default), until the boundary ratchet reads zero.
3. Make the 216 failing core tests green in core mode: a test that is really a module test
   gets its module as owner in the map; a real edge is cut; a kit the core needs becomes core.
4. Core start in CI: empty database, `db:migrate` and `node index.js` to `/api/ready` with all
   modules hidden, delete a user and an organisation, the core journeys.
5. The same for the web client (phase 2 of the plan), then the three pilot modules.

## Decisions taken along the way

- Composition files start in `server/firstParty/` and move with their module; their tree path
  does not change. (A directory `modules/<id>/server` makes the module count as moved, so
  nothing may be created there before the move.)
- New catalog ids are added only when a module can really be absent: they would show as new
  rows on the admin Modules page, and phase 0 was to change nothing visible.
- A file beside a directory of the same name in another root is a clash only when that
  directory has an entry point (`index.*` or `package.json`): `routes/ai.js` in the core and
  `routes/ai/learning.js` in a module is the ordinary shape of a split directory.
- A relative request that leaves a module root means the place beside the core root.
