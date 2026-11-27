# Work list: rest

Generated from `node scripts/module-boundary.mjs --list` and the core-mode run of the core tests.

## Core -> module import edges (0 in 0 files)


## Core test files that fail with every module hidden (67)

- `automation/toolRegistry.test.js`
- `core/automationModel/sideEffectMap.test.js`
- `core/automationRunner/documentMarking.test.js`
- `core/automationRunner/featurePorts.test.js`
- `core/collab/notebookRebase.test.js`
- `core/conversation/incognito.test.js`
- `core/findings/finding.test.js`
- `core/media/ffmpeg.test.js`
- `core/packaging/manifest.test.js`
- `core/packaging/scrub.test.js`
- `core/privacy/customTypes/callSites.test.js`
- `core/providers/claude.repairTurn.test.js`
- `i18n/defaults/en.discovery.test.js`
- `i18n/defaults/en.legal-wording.test.js`
- `i18n/defaults/en.meeting-trigger-scope.test.js`
- `i18n/translate.test.js`
- `jobs/lib/advisoryLockKeys.test.js`
- `mcpServers/tuya/events.test.js`
- `migrations/add-nl-admin-studio-3b-2026-11-translations.test.js`
- `migrations/add-nl-admin-studio-4a-2026-11-translations.test.js`
- `migrations/add-nl-ai-act-register-2026-11-translations.test.js`
- `migrations/add-nl-app-studio-documents-2026-10-translations.test.js`
- `migrations/add-nl-automation-run-access-translations.test.js`
- `migrations/add-nl-automation-testing-cases-translations.test.js`
- `migrations/add-nl-automation-testing-translations.test.js`
- `migrations/add-nl-builder-mapping-translations.test.js`
- `migrations/add-nl-cms-blog-translations.test.js`
- `migrations/add-nl-code-step-translations.test.js`
- `migrations/add-nl-collaboration-wave2-documents-compliance-translations.test.js`
- `migrations/add-nl-collaboration-wave2-editor-versions-translations.test.js`
- `migrations/add-nl-compliance-center-translations.test.js`
- `migrations/add-nl-datatable-quota-translations.test.js`
- `migrations/add-nl-fix-english-2026-10-translations.test.js`
- `migrations/add-nl-flatten-node-translations.test.js`
- `migrations/add-nl-hardcoded-integrations-agents-2026-10-translations.test.js`
- `migrations/add-nl-kb-query-log-translations-2026-11.test.js`
- `migrations/add-nl-learn-content-2026-10-translations.test.js`
- `migrations/add-nl-learning-center-translations.test.js`
- `migrations/add-nl-learning-foundations-translations.test.js`
- `migrations/add-nl-mail-trigger-2026-11-translations.test.js`
- `migrations/add-nl-meeting-import-translations-2026-10.test.js`
- `migrations/add-nl-namespace-files.test.js`
- `migrations/add-nl-notebooks-as-documents-translations.test.js`
- `migrations/add-nl-project-collab-client-translations.test.js`
- `migrations/add-nl-project-collab-translations.test.js`
- `migrations/add-nl-project-golf3-translations.test.js`
- `migrations/add-nl-project-golf4-translations.test.js`
- `migrations/add-nl-project-rail-translations.test.js`
- `migrations/add-nl-project-workspace-translations.test.js`
- `migrations/add-nl-repeating-work-translations.test.js`
- `migrations/add-nl-routines-nodes-translations.test.js`
- `migrations/add-nl-teams-setup-2026-11-translations.test.js`
- `migrations/add-nl-ui-complete-2026-10-translations.test.js`
- `migrations/nlCatalogues.test.js`
- `migrations/rename-routine-i18n-2026-10.test.js`
- `migrations/update-nl-admin-dashboard-2026-11.test.js`
- `migrations/update-nl-automation-wording-2026-11.test.js`
- `migrations/update-nl-compliance-detect-2026-10.test.js`
- `migrations/update-nl-compliance-ui-2026-10.test.js`
- `migrations/update-nl-learn-action-limits-2026-11.test.js`
- `migrations/update-nl-learn-cowork-2026-11.test.js`
- `migrations/update-nl-legal-register-2026-10.test.js`
- `migrations/update-nl-memory-2026-10.test.js`
- `migrations/update-nl-settings-nav-2026-10.test.js`
- `utils/nextcloudErrorClassifier.test.js`
- `utils/stepErrorInfo.test.js`
- `utils/treeDir.test.js`
