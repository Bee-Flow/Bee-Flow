# Task `core-mode-behaviour`: what the core still does for a module that is not there

Round 1 cut the imports. These are places where the core, with a module absent, still does or
says something on that module's behalf. Each is small; settle each by the rules (ownership, a
lookup by name, the README's point 5 for a module's part of core logic), keep present identical.

1. **`automation/toolRegistry.js` `INLINE_TOOL_APPS`** names the notebooks module's `workspace`
   app (`../integrations/workspaceTools`). In core mode `loadTools` warns
   `[toolRegistry] Failed to load workspace` and the tool picker and the attribution index still
   list a Notebooks app with no tools. Find every entry of that list (and of the lists beside
   it) whose module file is not core's; an entry of an absent module must not be listed. Keep
   the order of the list for the entries that are present. (`toolRegistry.test.js` was split
   in round 1: `toolRegistry.notebooks.test.js`.)
2. **`migrations/add-nl-compliance-center-translations.js`** computes `SAME_AS_ENGLISH` against
   `require('../i18n/defaults/en').GUI_DEFAULTS` while it loads. With the compliance namespace
   absent nothing is "the same as English", so the core ladder seeds about 1,450 `compliance.*`
   Dutch strings into an installation without compliance. Find every core-owned catalogue under
   `migrations/` that does this or otherwise seeds keys of a namespace whose module is absent
   (`server/i18n/defaults/en/index.js` knows which namespaces are present;
   `i18n/defaults/treeI18n.testkit.js` reads every root for tests). A catalogue whose keys are
   all one module's is given to that module (round 1 did 23; the report listed these as still
   core-owned: add-nl-app-studio-builder, add-nl-app-archive-import (apps); add-nl-builder-redesign,
   add-nl-builder-values, add-nl-hardcoded-automation-builder-2026-10, add-nl-table-nodes,
   add-nl-topic-rules, add-nl-forms-style, add-nl-forms-validation (automation); add-nl-cms-redirects,
   add-nl-cms-share-image, add-nl-hardcoded-website-admin (cms); add-nl-datatables-nextcloud,
   add-nl-datatables-spreadsheets (datatables); add-nl-project-tasks (projects)): check each,
   mind catalogues that require another at load. A MIXED catalogue stays core and seeds only
   the keys whose namespace is present: say how (the seeding function is shared; one place).
   With every module present the seeded rows are identical: prove it with the migration tests
   and `boot/composition.migrations.characterisation.test.js` (golden unchanged, except the
   `nlTranslations` owners record in `modules/firstParty/migrationOwners.json`, which you extend).
3. **`GET /ai/user-settings`** (`routes/ai/config/userSettings.js`) answers `hasAfasConfig`,
   `hasNmbrsConfig`, `hasNmbrsSubscriptionKey`, `hasNmbrsClient`, `hasVplanConfig`,
   `hasFirebirdConfig`, `hasFrappeCrmConfig`, the 2BA status and `hasScalewayBillingConfig` from
   stored secrets, whether or not the module is there. The POST side moved to the modules in
   round 1 (`usecases/ai/config/erpNlSettingsFields.js`, `scalewayBillingFields.js`, looked up by
   name). Do the same for the read side: each module's flags come from a function of that
   module (`readStatus(getSecret, userId)` beside its fields), spread into the answer in today's
   key order; an absent module contributes no flag. The file has a 469-line ceiling and is at
   about 430. The API reference lists response shapes only where a schema exists: run
   `npm run lint:api-reference` and say whether it moved. Put the tests of the read side in a
   new test file: `routes/ai/config/userSettings.validation.test.js` is being split by task
   `splits-routes` in parallel, do not edit it.
4. **`core/packaging`, `projects/chatModel.js`, `projects/completeness.js`**: round 1 reported that
   `projects/chatModel.js` needs only core files (model resolver, aiAgent, prompt classifier)
   and that `projects/completeness.js` holds two core-shaped helpers (`deepLinkFor` / `DEEP_LINK`,
   `emptyKnowledgeBaseFinding`). Check what each requires. Where a file (or, for completeness.js,
   a part that you move cut and paste into a new core file which the module file then requires)
   is really core, give it to the core in `scripts/module-map.json`, so the sheet assistant and
   the knowledge-base attention rule work without the projects module. Say what works in core
   mode afterwards that answered 409 or "gated" before.
5. **`usecases/ai/directChat/systemPrompt.js`** names tools in a static prompt (`set_ai_task`,
   ElevenLabs) that are not offered when their module is absent. Do NOT change the prompt:
   report the exact lines and which module each named tool belongs to. Changing a system
   prompt touches prompt caching and is the driver's decision.

For each item report: what you changed, what the core does now with the module absent, and the
test that shows it (a core-mode test where one can exist).
