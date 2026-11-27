# Task `splits-routes`: mixed core tests under integrations/, core/integrations/, routes/, shared/

Core test files that fail with every module hidden because part of what they assert is a
module's behaviour. Settle each by the phase 1.4 rules ("The failing core tests of your list"):
a module's test goes to the module; a mixed test is split, the module's assertions moving
UNCHANGED into `<name>.<moduleId>.test.js` owned by the module (a glob naming the test file in
`scripts/module-map.json`), shared set-up into a colocated `<name>.testkit.js`; a test that only
needs its double registered by name gets that (README, point 4).

Your files (and any other file of `failing-core-tests.txt` under these directories):

- `core/integrations/integrationTools.characterisation.test.js`
- `core/integrations/integrationTools.permittedApps.test.js`
- `core/integrations/ncScopeGuard.test.js`
- `integrations/agentSearchTools.test.js`
- `integrations/spreadsheetTools.test.js`
- `integrations/toolFamilies.test.js`
- `integrations/wordDocumentTools.test.js`
- `routes/ai.notebookGate.test.js`
- `routes/ai/config/userSettings.validation.test.js`
- `routes/studio/attention.test.js`
- `routes/studioDocuments/notebooks.test.js`
- `routes/wellKnown.test.js`
- `routes/writeGates.test.js`
- `shared/expr/engine.test.mjs`

Notes on some of them:

- `userSettings.validation.test.js`: the connection settings of AFAS, NMBRS, vPlan, Firebird,
  Frappe CRM and 2BA are fields of module `int_erp_nl` now
  (`usecases/ai/config/erpNlSettingsFields.js`), Scaleway Billing of `int_saas`
  (`scalewayBillingFields.js`); the route asks for them by name while it loads. The assertions
  about those fields are the modules'; the core half keeps every other field and gains one
  test: a body with a field of an absent module is refused (400, the strict schema's unknown
  key), and nothing is written.
- `integrationTools.characterisation.test.js` has a golden: with every module present it must
  not change. For core mode decide between a split per module and a second golden of the core's
  own tools; say which and why.
- `integrations/toolFamilies.test.js` is a test about the composition (each family that is
  registered ...): "when the module is present" is the honest wording there, as in
  `core/integrations/integrationClients.test.js`.
- `shared/expr/engine.test.mjs` runs in three places (server, agent-hub mirror, mobile mirror):
  `npm run lint:shared-mirror` must stay green; if a split touches `server/shared/expr/`, run
  `npm run gen:shared` and commit the copies.

Report, per file: outcome (given-to-module, split, green-in-core-mode, left), the first error it
had, and for a split the names of the new files and how many assertions moved. Report every
place where settling the test needs a production change you did not make.
