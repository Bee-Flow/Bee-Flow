# Task `module-sql-duties`: no core file writes a module's table on its own

Read `module-sql-reads.md` beside this file first (the first three paragraphs: what the lists
are, and why). Yours are the WRITES and the one-off code: places where a core-owned file
deletes, prunes, re-encrypts or migrates rows of a table that only a module creates. Read
`../phase1.4/data-duties-design.md` completely, with its "As built" section: the guard exists
(`modules/firstParty/moduleData.js`: `moduleForDataDuty`, `hasSchemaOf`, `ModuleDataPresentError`).

## Your files

- `stores/user/organizations.js`: `eraseOrgDatatables` (round 1: behind `moduleForDataDuty`), and
  line ~492 `automation_folders` in `deleteOrganization`: find every statement in that function
  and its helpers that names a module's table (the scan lists datatable_models,
  automation_datatable_usage, datatable_grants, datatables, automation_folders; read the whole
  function, it deletes from dozens of tables, some named through a list).
- `stores/user/usersDeleteSteps.js`, `stores/user/contentErasure.js` (support_threads at ~144),
  `stores/user/erasureCoverage.js` (the map of tables and columns account erasure covers; it
  names module tables as data), `projects/accountContentErasure.js` (round 1: behind the guard;
  the SQL that selects the rows is still in the core file).
- `stores/agent/agentCrud.js` (automation_agent_bindings at ~368: what deleting an agent does to
  the automation module's bindings).
- `stores/encryptionBackfill.js` (transcriptions), `stores/lib/sheetCrypto.js` (datatables at ~131).
- `jobs/monitoringRetention.js`: `purgeChatSignals` and its `TABLES` list. With every module
  hidden the core boot logs `[monitoringRetention] chat signals purge error: 42P01` on every
  pass. Find which table is missing and whose it is.
- `jobs/platformRetention.js` (round 1 put four lookups behind the guard): check that no
  statement about a module's table runs outside them.
- `migrations/routine-to-automation-2026-10.js` (cowork_schedules, playbooks),
  `migrations/kb-sources-backfill.js` (automations): migrations in the core ladder that touch a
  module's table. `boot/migrationLadder.js` and `modules/firstParty/migrationOwners.json` decide
  who owns a migration; a migration that only makes sense with a module is that module's
  (ownership; round 1 moved 9 loose migrations and 23 catalogues this way), a mixed one keeps
  its core part and skips the module's part when the module's schema is not in this database
  (`hasSchemaOf`). With every module present the ladder and its golden
  (`boot/composition.migrations.characterisation.test.js`) do not change, except the owners record.
- `scripts/research/reseed-fixture-account.js`, `scripts/datatable-orphan-scan.mjs`: operator
  scripts; settle by ownership (their tests follow them).

## The rule for each statement

1. It is the module's own business and the surrounding function is entirely about that module:
   the function moves, cut and paste, into a file the module owns; the core calls it through
   `moduleForDataDuty` (erasure, export, scrub of personal data: `refuse`; retention and
   re-encryption: `warn`, unless a half-done pass would leave data in a worse state than
   refusing, as round 1 decided for `sheetCrypto.transition`).
2. It is one statement among the core's own in a stepwise erasure (deleteOrganization,
   deleteUser): it runs when the module's schema is in this database, loaded or not
   (`hasSchemaOf(moduleId)`), because an edition that leaves a module out must still erase its
   rows; it is skipped when the schema is not there. Never decide by catching 42P01
   (`utils/isMissingTable`): a missing table is then indistinguishable from a typo. Where the
   code already uses `isMissingTable` for a module table, replace it by the schema check and
   keep `isMissingTable` only for the core's own optional tables.
3. The order of the statements with every module present stays exactly as it is:
   `stores/user/usersDelete.characterisation.pg.test.js` records it as a golden, which must not
   change. (Task `splits-stores` adds a second golden for core mode in the same test file: do
   not edit that test file; if your change needs it changed, say so.)

`erasureCoverage.js` is a data structure a test holds against the schema
(`migrateDb.erasure.integration.test.js`, task `splits-stores`): keep one map, and give each
entry of a module's table its module id (a field, or a second map keyed by module: the smaller
change), so both the erasure and the test can tell which entries belong to an absent module.
Derive the module of a table from the store that creates it; `migrationOwners.json` "storeUnits"
records which module owns which store unit.

## Check by hand and report what you saw

A Postgres 16 runs on 127.0.0.1:5544 (user `beeflow`, trust auth); create databases named
`r2_duty_*`. Environment: `NODE_ENV=production OTEL_ENABLED=false SESSION_SECRET=local-boot-check-secret-value-0123456789 MASTER_ENCRYPTION_KEY=local-boot-check-secret-value-0123456789 CORE_DATABASE_URL=postgresql://beeflow@127.0.0.1:5544/<db>`.

1. Core schema (`BEEFLOW_HIDE_MODULES=all node migrateDb.js` on an empty database), then with
   every module hidden: create an organisation and a user through the stores, delete the user,
   delete the organisation. No error, no 42P01 in the log, nothing of a module created.
2. Full schema (no edition), then `BEEFLOW_EDITION=core` for the process that deletes: an
   organisation with one datatable, one automation folder and one meeting note is deleted
   completely; count the rows before and after in the module tables.
3. Start the server with every module hidden for 70 seconds and show that the retention passes
   log no error.

## Report

Every statement of `module-sql-hits.txt` in your files, and every one you found beyond it, as:
file:line, table, module, what it is (erase / prune / re-encrypt / migrate / read), how settled
(moved to the module, runs when the schema is there, already guarded, left with the reason).
