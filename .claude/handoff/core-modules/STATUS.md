# Status of the core / modules split

Branch `ccr-b6017e12-l1bxyh`. Updated at the end of every batch.

## Done

**Phase 0, foundation (no behaviour change).**
- The resolver (`server/moduleRoots.cjs`, `server/modules/roots/`), loaded first by
  `server/index.js` and `server/migrateDb.js` and passed to every test process through
  `NODE_OPTIONS`; the server refuses to start when a tree path is in two roots.
- The ownership map for `server/` (10,294 files) and `agent-hub/src` (8,578 files).
- `scripts/lib/roots.mjs` and the roots inventory (103 tools still pending).
- The i18n dictionary index reads namespaces over every root; `en-defaults.js` is unchanged.
- Test scope: `run-tests.mjs --scope core|full|<ids>`, `--files`, `--hide-modules`.
- The boundary ratchet (import edges core -> module, lookups by name).
- CI path filters name the module roots, once.
- `modules/` scaffolding, the `node_modules` linker, the dev compose mount.
- Module state and the optional lookups (`optionalFeatureModule` and its two siblings).
- The dress rehearsal (all 23 modules moved at once in a throwaway worktree) and the
  conversions it asked for in production code (48 of 58), in the test kits and in the
  whole-tree guard tests (`server/testUtils/serverTree.js`, `server/utils/treeDir.js`).

**Phase 1, the composition lives in the modules.**
- The loader, its contract and the order index; a composition per module in
  `server/firstParty/` with four part kinds and a provides file (`server/ARCHITECTURE.md`,
  "Composition"):
  - 87 mount rows (`index.js` 740 -> 490 lines), gates in `boot/gates.js`;
  - the registrations (21 of 34 feature modules, 38 of 47 tool families, 49 of 54 toolsets,
    all 17 integration clients, 21 of 23 runner ports), through registration channels;
  - 29 job rows, `afterListen`, and the two halves of the shutdown;
  - 46 of 110 stores and 9 of 36 loose migrations.
- The characterisation tests of the composition pass with their goldens unchanged, except
  the shutdown half of the jobs golden: the module drains and the module closes are now each
  compared as a set (they run concurrently).
- Every module has a register part with a `boot/featureModules` block and a provides file,
  empty where the core asks nothing of it yet.

## Measured

| What | Now | Before |
|---|---|---|
| Core -> module import edges (server) | 339 | 640 |
| Core test files green with all modules hidden | 1,437 of 1,650 (213 fail; list in this directory) | 1,444 of 1,660 |
| Full server suite | green (4,031 files) | green |
| Core -> module static imports (agent-hub) | 173 static, 196 lazy | same |

## Checked by hand against a real Postgres (16, empty databases)

After the composition moved, commit 5a17db8c:

| Check | Outcome |
|---|---|
| `npm run db:migrate` on an empty database, every module present | exit 0, 271 parts; the schema dump is identical to the one `main` produces (280 tables, 554 indexes, 0 differing lines), the same 264 ledger names, the same row count in every table, the same `config` content |
| `node index.js` on that database | `/api/ready` 200 after 10 s, module routes mounted (401 without a session), SIGTERM: drained, exit 0 |
| `BEEFLOW_HIDE_MODULES=all npm run db:migrate` on an empty database | exit 0, 216 parts, no error line; 138 tables |
| `BEEFLOW_HIDE_MODULES=all node index.js` | stops at the first static edge that is left: `routes/ai/config/userSettings.js` requires `integrations/afasTools` ("module "int_erp_nl" is not present"). Step 1.4 removes it; the core boot is the practical measure of that step. |

Found on `main` as well, not caused by the split: on an empty database the automation store runs
four `datatable-*` migrations before the `datatables` table exists ("relation "datatables" does
not exist", four error lines); the second `db:migrate` applies them, which is why CI runs it twice.

## Next

1. **Step 1.4 and 1.5** (`phase1.4/` in this directory: the rules, one work list per source
   area, the design for data duties): settle each remaining edge by ownership or by an
   optional lookup, and make the failing core tests green in core mode.
2. Core start in CI: empty database, `db:migrate` and `node index.js` to `/api/ready` with all
   modules hidden and with `BEEFLOW_EDITION=core`, delete a user and an organisation, the
   core journeys.
3. The same for the web client (phase 2 of the plan), then the three pilot modules.

## Decisions taken along the way

- Composition files start in `server/firstParty/` and move with their module; their tree path
  does not change. (A directory `modules/<id>/server` makes the module count as moved, so
  nothing may be created there before the move.)
- New catalog ids are added only when a module can really be absent: they would show as new
  rows on the admin Modules page.
- A file beside a directory of the same name in another root is a clash only when that
  directory has an entry point (`index.*` or `package.json`).
- A relative request that leaves a module root means the place beside the core root.
- The loader honours the catalog: a module this edition leaves out (`BEEFLOW_EDITION=core`,
  a `BEEFLOW_MODULES` list) is absent, and so is a module that requires it. Before the split
  such a module still loaded and only its gates were closed. Its rows are now not mounted,
  its jobs not started, its stores not initialised and its names not registered. Data duties
  (erasure, retention, re-encryption) must still reach its data when its code is in the tree:
  `phase1.4/data-duties-design.md`. **Until step 1.4 is merged, an edition that leaves modules
  out is narrower than on main (account erasure refuses there). This branch does not merge
  before that is closed.**
- A composition and its parts load nothing at require time but the loader's own files
  (`modules/firstParty/partLog.js` for the log): every test process lists and registers the
  modules in its preload. `modules/firstParty/compositions.test.js` holds it.
- Whole-tree guard tests read the source of every root, hidden or not: they guard the
  repository, not one edition.
- Three behaviour changes, each deliberate and in its commit message: the compliance jobs,
  the Stripe webhook-secret check and the CMS image-variant backfill start fail-soft (a throw
  is logged instead of ending the phase); module job rows start after the core jobs of their
  phase; a throw in the webpage proxy's after-listen wiring fails that module instead of the
  listen callback.

## Follow-ups that are not part of step 1.4

- `journeys/journeyWorld.testkit.js` still hand-copies 13 mounts; build it from the loader.
- `routes/ai.js` builds its own gates object (routes may not require boot); move the platform
  half of `boot/gates.js` where both can reach it.
- NL catalogues stay one core list; a module-owned Dutch catalogue needs its own design.
- `modules/moduleLifecycle.js` still loops over the catalog's `storeModules` (dead in
  production, pinned by two tests).
- The sandbox child of `automation/codeSandboxProcess.js` does not get
  `BEEFLOW_MODULE_ROOTS` / `BEEFLOW_HIDE_MODULES`.
- The preload of every test process now lists the modules (about 70 files, 60 ms).
- A purge for the data of a module that is gone for good.
