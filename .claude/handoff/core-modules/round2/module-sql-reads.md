# Task `module-sql-reads`: a module's part of a core read model lives in the module

The imports are gone, but core-owned files still hold SQL about tables that only a module
creates. `module-tables.txt` beside this file lists those 142 tables (the difference between the
schema with every module and the schema with none). `module-sql-hits.txt` lists the core-owned,
non-test files that name one of them directly after FROM / JOIN / INTO / UPDATE / TABLE (21
files, 76 references; the scan misses table names held in arrays or built from parts, so look
for those in your files too).

With the module absent such a query fails on a missing table (42P01), or worse the file
answers for a module that is not there. With every root physically separate, a module's SQL
belongs in the module's folder. README point 5 is the pattern: each module's part moves, cut
and paste, into a file that module owns; the core asks for the parts by name from a fixed list
in today's order and leaves out the absent ones.

## Your files (the READS)

- `stores/adoption/kinds.js` (16 references, 9 modules) with `stores/adoption/*.js` and
  `routes/usageAdoption*.js`: the adoption read model. Failing core tests that are yours:
  `stores/adoption/{areas,groups,people,studio,studioItems,summary}.test.js`,
  `routes/usageAdoption.authz.test.js`; their kit `stores/adoption/adoption.testkit.js` initialises
  module stores. Read how a kind is declared in kinds.js before you choose the cut: if a kind
  is one self-contained declaration (its SQL, its label, its area), the module's file exports
  its kinds and the core concatenates in today's order.
- `core/kb/kbUsage.js` (automations, studio_apps, webpages, word_templates, support_inboxes; also
  notebooks): who uses a knowledge base, and `scrubReferences` which removes a deleted knowledge
  base from them. The scan is a read; the scrub writes a module's rows: route it through
  `moduleForDataDuty(..., { whenDataPresent: 'warn' })` (it is index maintenance, not erasure of
  personal data) or say why refuse is right. `core/kb/kbUsage.test.js` is yours.
- `stores/agent/agentUsage.js` (ai_tasks, cowork_schedules, support_inboxes, automations,
  studio_apps, webpages) and `stores/skill/usage.js` (automations): who uses an agent or a skill.
- `stores/metricsStore.js` (automation_runs, compliance_settings) and `stores/chatSignalStore.js`
  (compliance_settings).
- `routes/studio/counts.js`, `routes/studio/search.js`: round 1 made the module kinds optional
  through `moduleDep` / `lacksModule` in `routes/studio/shared.js`; the SQL about `automations` and
  `transcriptions` is still in the core file. Check whether it runs only behind the lookup
  (then it is guarded: move it only if the move is a cut and paste) and report.
- `stores/lib/pgAppEngine.js`, `stores/lib/pgAppEnginePartsTx.js` (studio_apps): the engine under
  App Studio's stores. Decide by what requires it: if only apps files do, it is the apps
  module's (ownership, no code change); `stores/lib/pgAppEngine.test.js` and
  `pgAppEngine.isolation.test.js` then follow it (task `splits-stores` names them too: say in
  your report that you settled them).

## Rules for the cut

- The module's file sits at a tree path that names what it is, e.g.
  `stores/adoption/kinds.automation.js`, `core/kb/usage/apps.js`; owned by the module through a
  glob in `scripts/module-map.json`; registered by name (register part, provides file, typedef).
  `stores/` is the platform layer: look up with `modules/firstParty/moduleData.js`
  `lookupFeatureModule` there, `optionalFeatureModule` in `core/` and `routes/`.
- The order of the parts in the core list is today's order of the kinds/sections. With every
  module present the output is identical: the existing tests pass unchanged, and where a test
  compares a whole result (a snapshot, a deepStrictEqual of the full list) it still does.
- A kind of an absent module is LEFT OUT (no key, no row), never zero: a zero says "nothing
  built", an absent key says "not part of this installation". Check how the web client reads
  each response before you drop a key (`agent-hub/src`): if a client crashes on a missing key,
  report it; do not change the client.
- "Absent by edition" (files there, module not loaded) must give the same answer as "files not
  there": the lookup decides, never a try/catch on a missing table.
- Tests: a module's part gets the module's assertions (split as the phase 1.4 rules say); the
  core test covers the core kinds and one case with a double part registered by name.

## Report

Per file: which parts went to which module (file names), the names added, what the core
answers with every module hidden, and the test that shows it. List every reference of
`module-sql-hits.txt` in your files as moved / guarded already / left with the reason.
