# Task `review-fixes`: the confirmed findings of the review of step 1.4

An independent review of the merged step 1.4 work (nine reviewers, each finding then attacked
by a sceptic) confirmed the defects below. Each is small and has a decided fix. Do them all;
keep every change as small as the fix. Files that other workers of this round are editing are
NOT yours: `routes/ai/config/userSettings.js` and its tests, `routes/studio/attention*.js`,
`projects/completeness.js`, `migrateDb.integration.test.js`, `core/featureModules.js`,
`stores/adoption/**`, `stores/agent/agentUsage.js`, `core/kb/kbUsage.js`.

## 1. A new hand-off to an automation is accepted when automation is absent

`usecases/agents/agentPersonaWrite.js` (~line 166): `automationPresent` gates the whole hand-off
block, so with the automation module absent a request that NEWLY selects a hand-off automation
is stored without a warning; the editor then shows a hand-off the runtime never performs. Keeping
an id that was already stored is right (the stored reference stays; nothing is dropped because
a module is away). Accepting a new one is success for something that did not happen.

Fix: compute `newSelection` before the gate. Module absent and the selection is new: push a
warning in the style of the existing "dropped" warning (say that the automation module is not
available) and set `automationId` to null. A stored id stays as it is, unchecked, without a
warning. With the module present nothing changes.
Test: `routes/agents/crud.persona.test.js` ~line 527 ("without the automation module a hand-off
is neither checked nor dropped: the stored id stays") uses `AGENT()` with no stored persona, so
it tests a new selection under a name that says stored. Make it use an agent that already
stores that hand-off for the keep case, and add the new-selection case that expects the drop
and the warning.

## 2. A failed billing module crashes the process from a setImmediate

`auth/accountProvisioning.js` (~667) and `auth/admin/orgRoutes.js` (~547) look a billing_stripe
file up inside a bare `setImmediate` callback. The lookup throws `ModuleFailedError` when the
module failed to load; nothing catches it there, it becomes an uncaughtException, and
`boot/lifecycle.js` exits the process. Before the step a plain require ran in that place.

Fix: inside the callback, a try/catch around the lookup and the call. The catch reports through
what the neighbouring code already uses (`bestEffort('<label>', err)` in orgRoutes;
`log.warn` naming the skipped trial grant in accountProvisioning). Absent (null) stays the quiet
path. Both files have line ceilings in `server/.file-budget.json` and are AT them
(accountProvisioning.js 725, orgRoutes.js: check): the fix must not grow the file; join the
comment into the code line or shorten a neighbouring comment by a line.
Test for each: with a double that throws a `ModuleFailedError` for that name, the callback does
not throw (drive the function, flush `setImmediate`, assert the report was made).

## 3. An assertion on the real GitHub sync store was replaced by a stand-in

`usecases/integrations/orgIntegrationAvailability.test.js` (~261) used to write through the real
`stores/githubSyncStore` and read the result through `resolveOrgIntegrationAvailability`. It now
registers a hand-made stand-in, so nothing checks that the real store's `getOrgSyncConfig`
returns the shape the core reads. Add
`usecases/integrations/orgIntegrationAvailability.int_saas.test.js` holding the ORIGINAL
assertions unchanged (`git show d780d962:server/usecases/integrations/orgIntegrationAvailability.test.js`),
owned by `int_saas` (a glob naming the test file in `scripts/module-map.json`); shared set-up
through a colocated testkit if the two files would otherwise copy it. The core test keeps its
stand-in.

## 4. A test of the absent path that cannot fail

`core/projectContent/projectFeed.runs.test.js` (~178): `_lookup`'s try/catch turns a TypeError from
`null.getAutomation` into the same `{ projectId: null }` the absent branch returns, so the test
passes whether or not the absent branch exists. Make the test see which path ran (for example:
the absent branch does not log; the swallowed TypeError does: assert on the log double), and
check the other "absent" tests added in step 1.4 for the same weakness
(`git diff d780d962..HEAD --stat -- '*.test.js'` lists them; look at the ones that clear a getter
with `_clearFeatureModulesForTests` or register a null getter): fix the ones you can show to be
vacuous, list the ones you checked.

## 5. Core assertions that went to a module with the module's half

Bring back, UNCHANGED, into the core-owned test file the assertions that need no module code;
the module's file keeps the ones that do:

- `i18n/translate.projects.test.js` -> `i18n/translate.test.js`: `normaliseLocale('NL-nl') === 'nl'`,
  `normaliseLocale(undefined) === 'en'`, the unknown key that comes back as the key, and the
  Dutch value through the injected `getStrings` (it needs no English text).
- `core/conversation/incognito.notebooks.test.js` -> `incognito.test.js`: the memory-tools half
  of "the withheld list is exactly the memory tools and the notebook tools". The core asserts
  that every memory tool (`integrations/memoryTools`, core) is withheld; the notebooks file keeps
  the exact-equality assertion over both.
- `utils/nextcloudErrorClassifier.automation.test.js` -> `nextcloudErrorClassifier.test.js`: every
  classifier case has a `message` and a `remediation` (the classifier is core).
- `stores/notebookStore.project.meetingNotes.pg.test.js`: its first half pins core notebookStore
  behaviour (`addSource` stores `sourceRefId` in `notebook_sources.source_ref_id`); only
  `usageForMeeting` is the module's. Split: the core half back into a core-owned
  `stores/notebookStore.project.pg.test.js` (check what that file holds now).

## 6. The Microsoft sign-in test refuses without the meeting notes module

`auth/oauth/ssoConfigRoutes.js` (~388): `POST /auth/providers/microsoft/test` answers 409
`module_absent` when meetingNotes is absent. Sign-in with Microsoft is a core feature; an
installation that uses it without meeting notes should still be able to check what it typed.
With the module absent, answer as the Google branch a few lines above does: a format check of
the configured client id (the `GUID` pattern in `auth/oauth/microsoftConnections.mts`, core) and
tenant, `{ success: true, message: 'Microsoft app registration configured (format valid). The live test of the registration is part of the meeting notes module.' }`,
or 400 with the reason when the format is wrong. With the module present nothing changes.
The route has a zod schema or not: run `npm run lint:api-reference` and `lint:routes-contract`.
Test: a core test of the absent answer (register no double; clear the name if it is registered).

## Gates

Those of `../phase1.4/README.md` and `README.md` beside this file. Every test you touch green in
full mode and, for the core files, with `--hide-modules all`.
