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

**Phase 1, the core does not import its modules (steps 1.4 and 1.5, round 1).**
- No core-owned server file imports a module-owned file: `node scripts/module-boundary.mjs` says
  0 edges and 0 by-name lookups of the old kind, and its budget file is empty, so a new edge
  fails `check:fast`. The core asks a module for a file by name (`optionalFeatureModule`; the
  registry holds 118 names, 34 before the step) and takes "absent" for an answer.
- Data duties (erasing, pruning, re-encrypting a module's data) go through
  `modules/firstParty/moduleData.js`: never skipped in silence; with the module's data in the
  database but not its code, an erasure refuses (`phase1.4/data-duties-design.md`, "As built").
- A lookup's answer does not depend on the entry point of the process: the registry fills
  itself on its first miss.
- With every module hidden the server migrates an empty database and reaches `/api/ready`.
- An independent review of the round (nine reviewers, a sceptic per finding): 13 findings
  confirmed, none in erasure or access control; `round2/review-fixes.md` holds them.

**Phase 2, the web client's baseline (steps 2.0 and 2.1).**
- Ten GUI inventory tests with goldens (`agent-hub/src/**/**.inventory.test.ts`): every route,
  sidebar row, Studio section, admin and settings tab, organisation section, lazy slot,
  composer row and provider around the app, with position, label key, icon, gate and owning
  module. Any change to the web client must leave them unchanged.
- `scripts/web-build-sources.mjs --check .claude/handoff/core-modules/web/build-sources.txt`: the
  5,415 source modules of the full build; `web/build-by-module.md` says how the build falls
  apart per module today.
- The mobile lockstep tests find web files by tree path over every root.
- No screenshots yet: this environment has no Docker. `scripts/gui-screenshots.mjs` walks the
  110 addresses of the goldens against a running stack.

## Measured

| What | Now | At the start of the split |
|---|---|---|
| Core -> module import edges (server) | 0 (budget 0) | 640 |
| Core test files green with every module hidden | 1,551 of 1,600 (49 fail: `round2/failing-core-tests.txt`) | 1,444 of 1,660 |
| Full server suite, every module | green: 4,080 files, 42,413 tests | green |
| Core SQL that names a module's table | 76 references in 21 core files (`round2/module-sql-hits.txt`) | not measured |
| Core -> module imports (agent-hub) | 369 (172 static in 107 files, 196 lazy of which 144 i18n chunks) | same |

## Checked by hand against a real Postgres (16, empty databases)

At commit b123f953 and again at fa2bdcf1:

| Check | Outcome |
|---|---|
| `npm run db:migrate` on an empty database, every module present | exit 0; the schema dump is identical to the one `main` produces (280 tables, 0 differing lines), the same 264 ledger names, the same row count in every table, the same `config` content |
| `node index.js` on that database | `/api/ready` 200 after 9 s, module routes mounted (401 without a session), SIGTERM: drained, exit 0 |
| `BEEFLOW_HIDE_MODULES=all npm run db:migrate` on an empty database | exit 0, no error line; 138 tables |
| `BEEFLOW_HIDE_MODULES=all node index.js` | `/api/ready` 200 after 5 s; `/api/automation`, `/api/datatables`, `/api/cowork` 404; `/api/kb` 401; SIGTERM: exit 0 |
| `BEEFLOW_EDITION=core node index.js` on the full schema | `/api/ready` 200 after 8 s |

Found on `main` as well, not caused by the split: on an empty database the automation store runs
four `datatable-*` migrations before the `datatables` table exists ("relation "datatables" does
not exist", four error lines); the second `db:migrate` applies them, which is why CI runs it twice.

Known with every module hidden, round 2 settles them: the retention pass logs
`[monitoringRetention] chat signals purge error: 42P01` (it joins a compliance table), and the
first DELETE of an agent, a knowledge base or a skill answers "still in use, could not check
apps, automations, ..." because the usage scans count a missing module table as unchecked.

## Next

1. **Round 2 on the server** (`round2/`: the rules, ten task briefs, the lists): the edition
   switch for all 23 modules, capabilities of an absent module out of the projection, the
   core's SQL on module tables into the modules, the 49 failing core tests, what the core still
   does for an absent module, a CI job that holds the core start, the review's findings. Every
   branch is reviewed by a second agent and each serious finding checked by a third.
2. **First test version**: a dev image of this branch, run with `BEEFLOW_EDITION=core` and with
   `BEEFLOW_MODULES=<a few>`.
3. **The web client** (phase 2): a design panel is comparing three designs; then the module
   contributions, the 172 static imports, a core build and core test run.
4. The three pilot modules move into `modules/<id>/`.

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
  (erasure, retention, re-encryption) still reach its data when its code is in the tree and
  the database holds its schema: `phase1.4/data-duties-design.md`.
- A composition and its parts load nothing at require time but the loader's own files
  (`modules/firstParty/partLog.js` for the log): every test process lists and registers the
  modules in its preload. `modules/firstParty/compositions.test.js` holds it.
- Whole-tree guard tests read the source of every root, hidden or not: they guard the
  repository, not one edition.
- `BEEFLOW_EDITION=core` means the core and no first-party module (round 2). Today's
  documentation counts integrations, datatables, the CMS and Stripe billing as core; an
  installation that sets it must list them in `BEEFLOW_MODULES` to keep them. To be said in
  the release notes, and confirmed by the owner before this branch merges.
- Marking AI-generated documents (AI Act Art. 50(2)) is the compliance module's: its setting
  lives in that module's table. Without the module, downloads are not marked. On `main` an
  edition without compliance still marked them. Put to the owner.
- The readiness sentinel names four core tables (`knowledge_bases` where `automations` stood).
- A lookup while a file loads is allowed in a route file that must build a schema or a router
  at load (`routes/ai/config/userSettings.js`, `integrations.js`): the registry fills itself.
- Three behaviour changes, each deliberate and in its commit message: the compliance jobs,
  the Stripe webhook-secret check and the CMS image-variant backfill start fail-soft (a throw
  is logged instead of ending the phase); module job rows start after the core jobs of their
  phase; a throw in the webpage proxy's after-listen wiring fails that module instead of the
  listen callback.

## Follow-ups

- `hasSchemaOf` reads the schema ledger only. With `BEEFLOW_DDL_LEDGER=off`, or on a database
  whose module stores last ran before the ledger existed, a module's data reads as "no schema"
  and an erasure without the module's code would skip instead of refuse. Fall back to the
  existence of the module's tables once round 2 records which table is whose.
- Two files keep the event loop open with every module hidden
  (`stores/storeWrites.atomic.pg.test.js`, `jobs/memoryRetentionEnforcer.test.js`): round 2, kits.
- The web client's full typecheck and lint were not run on the merged baseline (out of memory
  on the shared machine while agents ran); run them before the first web change merges.
- This machine kills `tsc` when several workers typecheck at once (a memory limit of the
  process group): keep at most four building workers, and re-run a typecheck that "stopped
  before checking".

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
