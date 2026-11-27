# Work list: data-duties

Generated from `node scripts/module-boundary.mjs --list` and the core-mode run of the core tests.

## Core -> module import edges (26 in 14 files)

- `jobs/memoryRetentionEnforcer.js`
  - line 59 -> `stores/complianceStore.js` (compliance)
- `jobs/platformRetention.js`
  - line 100 -> `stores/studioAppData/actionRuns.mts` (apps)
  - line 102 -> `stores/studioAppData/runLogStore.mts` (apps)
  - line 108 -> `stores/studioAppData/webhookTriggers.mts` (apps)
  - line 110 -> `stores/automationStore/webhookDeliveries.js` (automation)
  - line 178 -> `stores/studioAppData/runPolicy.mts` (apps)
- `projects/accountContentErasure.js`
  - line 26 -> `stores/transcriptionStore.js` (meetingNotes)
  - line 39 -> `stores/transcriptionStore.js` (meetingNotes)
  - line 75 -> `stores/webpageStore.js` (webpages)
  - line 91 -> `stores/studioAppStore.js` (apps)
  - line 170 -> `core/meetingNotes/teamsAppImport/settings.mts` (meetingNotes)
- `reset-nc.js`
  - line 7 -> `jobs/datatableChangePorts.js` (datatables)
- `stores/agent/agentSync.js`
  - line 19 -> `stores/githubSyncStore.js` (int_saas)
- `stores/encryptionBackfill.js`
  - line 126 -> `stores/transcriptCrypto.js` (meetingNotes)
  - line 433 -> `stores/transcriptCrypto.js` (meetingNotes)
- `stores/integrationActivityStore.js`
  - line 177 -> `compliance/events.js` (compliance)
- `stores/lib/sheetCrypto.js`
  - line 102 -> `stores/datatableDbStore.js` (datatables)
  - line 115 -> `stores/datatableDbStore.js` (datatables)
- `stores/skillStore.js`
  - line 80 -> `stores/githubSyncStore.js` (int_saas)
- `stores/suggestionFeedbackStore.js`
  - line 95 -> `automation/patterns/templating.js` (automation)
- `stores/usageStore.js`
  - line 40 -> `workers/paygDrain.js` (billing_stripe)
- `stores/user/organizations.js`
  - line 504 -> `stores/datatableDbStore.js` (datatables)
- `stores/user/projectErasure.js`
  - line 50 -> `stores/complianceStore.js` (compliance)
- `stores/user/usersDeleteSteps.js`
  - line 314 -> `stores/datatableDbStore.js` (datatables)
  - line 341 -> `stores/datatableDbStore.js` (datatables)
  - line 374 -> `stores/datatableStore.js` (datatables)

## Core test files that fail with every module hidden (29)

- `jobs/platformRetention.test.js`
- `stores/adoption/areas.test.js`
- `stores/adoption/groups.test.js`
- `stores/adoption/people.test.js`
- `stores/adoption/studio.test.js`
- `stores/adoption/studioItems.test.js`
- `stores/adoption/summary.test.js`
- `stores/agent/conversationStatePort.test.js`
- `stores/blueprint/releases.test.js`
- `stores/document/solutionTemplates.test.js`
- `stores/documentSharing.pg.test.js`
- `stores/encryptionBackfill.test.js`
- `stores/lib/pgAppEngine.isolation.test.js`
- `stores/lib/pgAppEngine.test.js`
- `stores/memoryQueries.pg.test.js`
- `stores/memoryStore.clear.pg.test.js`
- `stores/notebookStore.project.pg.test.js`
- `stores/sharedGroups.failClosed.test.js`
- `stores/skillStore.managed.test.js`
- `stores/skillStore.structured.test.js`
- `stores/suggestionFeedbackStore.test.js`
- `stores/usageStore.characterisation.test.js`
- `stores/usageStore.rating.pg.test.js`
- `stores/user/projectErasure.test.js`
- `stores/user/userSecretKeys.test.js`
- `stores/user/users.suggestionErasure.test.js`
- `stores/user/usersDelete.characterisation.pg.test.js`
- `stores/user/usersDelete.test.js`
- `stores/userStore.credentialCleanup.test.js`
