# Task `kits-and-doubles`: the test kits know two editions; doubles go by name

Core test files that fail with every module hidden, for a reason that sits in a KIT or in how a
test installs its double. The measured list is `failing-core-tests.txt` beside this file; yours
are the ones named below, plus any other file of that list whose first error turns out to be
one of these causes (say which).

## 1. `testUtils/stubRequire.js`: a stub follows the lookup

`installResolveStub(map)` mirrors a stub into the feature-module registry only when the request
matches `FEATURE_KEY` (`integrations|services|automation|agents|projects|appStudio`). The core
now looks up names under `stores/`, `core/`, `auth/`, `compliance/`, `learning/`, `routes/`,
`usecases/`, `workers/`, `jobs/`, so a test that stubs `'../stores/coworkStore'` gets the real
module through `optionalFeatureModule('stores/coworkStore')`.

Make the mirror exact instead of pattern-based: a request is mirrored when the tree path it
names is a REGISTERED or PROVIDED feature-module name (the provides files:
`modules/firstParty/moduleState.js` `providerOf('featureModules', name)`, or
`core/featureModules.js` `hasFeatureModule`), whatever its top directory. Resolve the request
against the requiring test's directory as today's regex implies (read how callers pass keys;
`stubRequire.test.js` documents it). Restore puts back the previous getter, as today. Then
remove the hand-registered duplicates that round 1 added next to an `installResolveStub` call
where the kit now does it (grep `registerFeatureModules(` in `*.test.js`): only where the same
object is registered under the same name; leave tests that use their own
`Module._resolveFilename` hook alone.

## 2. Tests whose double must be registered by name

`auth/accountProvisioning.test.js`, `auth/decryptAudit.test.js`, `auth/oauth/shared.test.js`,
`stores/usageStore.characterisation.test.js`, `stores/usageStore.rating.pg.test.js`,
`stores/skillStore.managed.test.js`, `stores/skillStore.structured.test.js`,
`stores/sharedGroups.failClosed.test.js`, `stores/agent/conversationStatePort.test.js`,
`boot/schemaLedger.integration.test.js`.
For each: run it in core mode, read the first error. If the code under test now looks the
module up by name and the test's double sits on a require string, register the same double by
name (README, point 4). If instead the test needs real module code, it is a split or a module
test: settle it by the phase 1.4 rules and say so.

## 3. Whole-tree kits that hide module roots in core mode

- `testUtils/mountRowsText.js` `defaultMountParts()` lists `firstParty/*.mounts.js` with
  `listTreeDir`, which leaves out hidden roots; `auth/accessRegistry.sweep.test.js` then sees
  595 routes instead of about 1300 and calls the open-route exemptions stale. A sweep guards
  the repository, not one edition: list the parts over every root, hidden or not
  (`testUtils/serverTree.js` does this for source files; reuse it).
- `auth/accessRegistry.drift.test.js`: its route-walk child loads the real app. With the last
  boot-path edges gone the app loads in core mode; make the test hold for the routes that are
  mounted, using `testUtils/absentModuleRoutes.js` (new in round 1; the route contract test and
  the tenant matrix use it) for routes whose module is not loaded.
- `routes.contract.test.js` and `tenantIsolation.matrix.test.js`: built for core mode in round 1,
  blocked then by edges that are gone now. Run both with `--hide-modules all`, settle what is left.
- `testUtils/nlCatalogueChecks.js` reads the in-process English dictionary and requires every
  catalogue of the boot ladder; four tests fail on it in core mode
  (`migrations/add-nl-notebooks-as-documents-translations.test.js`,
  `add-nl-collaboration-wave2-editor-versions-translations.test.js`,
  `add-nl-collaboration-wave2-documents-compliance-translations.test.js`,
  `add-nl-spreadsheet-documents-translations.test.js`). Take the dictionary and the other
  catalogues from `i18n/defaults/treeI18n.testkit.js` (`english()`, `catalogues(bootList)`), which
  reads every root.
- `migrateDb.integration.test.js`: its ladder list must leave out the names
  `boot/migrationLadder.js` `absentModule` reports, as `boot/nlTranslations.test.js` does.

## What must hold

Every test you touch is green in full mode with unchanged assertions; the files above are green
with `--hide-modules all` or reported with their first error. No production file changes in
this task except none: if a test can only pass with a production change, report it.

## 4. Two files keep the event loop open in core mode

`run-tests.mjs --scope core --hide-modules all` reports, in two runs out of two:

    HUNG  stores/storeWrites.atomic.pg.test.js — still running after 180s
    HUNG  jobs/memoryRetentionEnforcer.test.js — still running after 180s

(and once `projects/accountContentErasure.pg.test.js`). They are not hung with every module
present. A likely cause: with a module absent, `moduleForDataDuty` asks the schema ledger
through the real `db` facade (`modules/firstParty/moduleData.js` `defaultLedgerQuery`), which
opens a pool the test never closes, where with the module loaded the registry answered and no
query ran. Find the real cause (`node --test` the file with `BEEFLOW_HIDE_MODULES=all` and the two
preloads, see what handle is left: `process._getActiveHandles()` in an `after`). If it is the
ledger: a hermetic test gives the guard a ledger double
(`_setModuleDataDepsForTests({ ledgerQuery: () => null })`, restored in `after`), a test with a
database closes what it opened. If the cause is in production code (a pool or timer that
nothing can close), report it with the file and line; do not add an exit.
