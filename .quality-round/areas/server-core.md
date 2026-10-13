# Area: server-core

## Non-test source files > 600 lines (lines, path) — data/templates/fixtures already excluded
    1488 server/core/kb/localKBIngest.js
    1454 server/modules/packageLoader.js
    1434 server/core/automationRunner/execution.js
    1406 server/auth/permissions.js
    1314 server/core/automationRunner/execAi.js
    1305 server/core/integrations/integrationTools.js
    1287 server/core/providers/claude.js
    1267 server/core/meetingNotes/summaryHelpers.js
    1217 server/auth/connectorBootstrap.js
    1134 server/core/agentRuntime/toolRoundExecutor.js
    1126 server/index.js
    1122 server/core/kb/kbIngestionHelpers.js
    1111 server/core/dataEngine/queryCompiler.js
    1070 server/core/automationRunner/safety.js
    1029 server/core/providers/google.js
    1018 server/auth/encryption.js
    1014 server/core/webpages/webpageBindings.js
    1008 server/utils/emailService.js
     955 server/core/aiTaskRunner.js
     948 server/core/dataEngine/sources/spreadsheetFile/link.js
     937 server/core/providers/local.js
     920 server/core/webpages/bfElements.js
     915 server/core/documents/deckModel.js
     903 server/core/integrations/ncScopeGuard.js
     892 server/core/dataEngine/sources/spreadsheetFile/writeThrough.js
     865 server/core/customIntegrations/validateCustomIntegration.js
     860 server/auth/opaqueRoutes.js
     839 server/auth/admin/userRoutes.js
     827 server/core/providers/openai.js
     825 server/core/dlp/dlpRunner.js
     819 server/boot/startupTasks.js
     813 server/core/tools/datatableTools.js
     800 server/core/automationRunner/execOutbound.js
     799 server/core/automationRunner/httpCache.js
     792 server/core/tools/toolDispatcher.js
     789 server/auth/oauth/providerCallbackRoutes.js
     777 server/auth/admin/featureAccessRoutes.js
     769 server/core/automationRunner/aiStepAgent.js
     768 server/license/index.js
     767 server/core/entitlements/entitlements.js
     764 server/core/llm/modelCosts.js
     723 server/core/collab/lifecycle.js
     717 server/auth/connectorJwt.js
     714 server/core/entitlements/betaFeatures.js
     713 server/core/llm/providerConfig.js
     705 server/auth/admin/groupRoleRoutes.js
     701 server/core/automationRunner/runDag.js
     696 server/core/dlp/attachmentScanner.js
     695 server/core/llm/llmClient.js
     694 server/core/tools/sessionSkillRuntime.js
     689 server/auth/loginThrottle.js
     675 server/core/meetingNotes/actionItems.js
     669 server/auth/routeSurfaceSweep.js
     663 server/core/providers/mistral.js
     661 server/core/customIntegrations/mcpLibrary/service.js
     660 server/auth/accountProvisioning.js
     659 server/core/dataEngine/sources/spreadsheetFile/providers/googleDrive.js
     658 server/core/documents/deckThemeOptions.js
     649 server/core/dataEngine/sources/spreadsheetFile/providers/oneDrive.js
     645 server/core/providers/base.js
     645 server/core/meetingNotes/meetingUsage.js
     643 server/core/dataEngine/dataModel/migrationPlan.js
     630 server/core/http/egressCapture.js
     628 server/core/llm/modelResolver.js
     625 server/core/automationRunner/partialRuns.js
     622 server/core/agentRuntime/knowledgeSearch.js
     620 server/core/integrations/integrationToolMap.js
     612 server/core/automationRunner/approvalLifecycle.js
     609 server/core/kb/sources/datatable.js
     607 server/core/privacy/orgShield.js
     604 server/auth/admin/orgRoutes.js

## Production clones involving this area (dup lines, fileA:line, fileB:line), largest first, max 80
231	components/webpage-to-markdown/index.js:2	server/utils/htmlToMarkdown.js:2
137	agent-hub/src/utils/emojiCatalog.js:15	server/core/cms/emojiCatalog.js:19
37	agent-hub/src/utils/scheduleNextRun.js:16	server/utils/scheduleNextRun.js:6
36	server/core/kb/notebookKnowledgeSearch.js:196	server/core/webpages/webpageKnowledgeSearch.js:95
33	agent-hub/src/components/admin/Studio/Datatables/datatableDisplay.js:149	server/core/dataEngine/dataModel/datatableDraft.js:98
31	agent-hub/src/editor/serialization/mdToAst.js:145	server/core/markdown/editorSerialization.cjs:742
30	server/core/aiTaskRunner.js:612	server/core/aiTaskRunner.js:895
29	server/core/dataEngine/dataModel/migrationPlan.js:218	server/core/dataEngine/dataModel/migrationPlan.js:258
28	server/appStudio/aiRuntime.js:545	server/core/cms/cmsExportBundle.js:144
27	agent-hub/src/editor/serialization/mdToAst.js:119	server/core/markdown/editorSerialization.cjs:720
27	server/core/kb/notebookKnowledgeSearch.js:55	server/core/webpages/webpageKnowledgeSearch.js:26
27	server/db.js:373	server/modules/hostApi.js:171
26	server/core/agentRuntime/ruleAttribution.js:329	server/core/kb/extractSummary.js:63
26	server/core/cms/componentManager.js:117	server/core/cms/componentManager.js:226
25	agent-hub/src/utils/scheduleNextRun.js:105	server/utils/scheduleNextRun.js:51
25	server/core/embed/cpuEmbed.js:69	server/core/rerank/cpuCrossEncoder.js:80
25	server/core/embed/cpuEmbed.js:69	server/core/voice/localWhisper.js:93
25	server/core/kb/notebookKnowledgeSearch.js:145	server/core/webpages/webpageKnowledgeSearch.js:57
24	agent-hub/src/editor/serialization/util.js:126	server/core/markdown/editorSerialization.cjs:203
24	server/core/agentRuntime/ruleAttribution.js:331	server/services/supportClassifier.js:29
24	server/core/agentRuntime/testSandbox.js:108	server/core/agentRuntime/testSuggest.js:116
23	server/auth/encryption.js:280	server/auth/encryption.js:567
23	server/core/automationRunner/execAi.js:103	server/core/automationRunner/execOutbound.js:601
22	server/automation/builderTools/suggestedPatch.js:35	server/core/llm/toolCallHygiene.js:16
22	server/core/kb/notebookKnowledgeSearch.js:124	server/core/webpages/webpageKnowledgeSearch.js:37
22	server/core/providers/google.js:531	server/core/providers/google.js:592
21	agent-hub/src/editor/engine/formula.js:286	server/core/markdown/editorSerialization.cjs:561
21	agent-hub/src/editor/engine/tables.js:38	server/core/markdown/editorSerialization.cjs:253
21	agent-hub/src/editor/serialization/mdToAst.js:46	server/core/markdown/editorSerialization.cjs:643
21	server/auth/connectorSig.js:32	server/routes/automation/events.js:190
21	server/auth/oauth/ssoConfigRoutes.js:102	server/auth/oauth/ssoConfigRoutes.js:280
21	server/core/meetingNotes/gmeetAutoImport.js:114	server/core/meetingNotes/talkAutoRecord.js:87
21	server/core/meetingNotes/meetingUsage.js:609	server/core/webpages/webpageUsage.js:336
21	server/modules/packageLoader.js:776	server/modules/packageLoader.js:986
20	agent-hub/src/components/admin/org/people/orgMembership.js:49	server/auth/orgMembership.js:51
20	server/auth/connectorSig.js:33	server/routes/webhooks/ncEvents.js:71
20	server/core/http/sseHelpers.js:170	server/routes/ai/directChat/shared.js:18
20	server/core/kb/kbUsage.js:35	server/core/meetingNotes/meetingUsage.js:101
20	server/core/meetingNotes/gmeetAutoImport.js:401	server/core/meetingNotes/teamsAutoImport.js:282
19	agent-hub/src/components/admin/org/people/orgMembership.js:31	server/auth/orgMembership.js:32
19	server/core/agentRuntime/attachmentProcessor.js:131	server/routes/ai/directChat/attachmentIntake.js:120
19	server/core/agentRuntime/chatWithAgent.js:269	server/core/agentRuntime/toolRoundExecutor.js:555
19	server/core/automationRunner/execPrivacy.js:50	server/core/automationRunner/execPrivacy.js:194
18	nextcloud-connector/src/automationEventsWebhook.js:48	server/auth/mcpToken.js:45
18	server/automation/stepContract.js:19	server/core/kb/automationKbCheck.js:42
18	server/core/agentRuntime/finalizeTurn.js:308	server/core/agentRuntime/guardrailHardBlock.js:33
18	server/core/automationRunner/execAi.js:1008	server/core/automationRunner/execData.js:505
18	server/core/dataEngine/sources/nextcloudTable/link.js:312	server/core/dataEngine/sources/spreadsheetFile/link.js:644
18	server/core/integrations/ncScope.js:149	server/core/integrations/ncScope.js:277
18	server/core/kb/sources/text.js:27	server/core/kb/sources/upload.js:54
18	server/core/meetingNotes/gmeetNotesSettings.js:124	server/core/meetingNotes/teamsNotesSettings.js:116
17	agent-hub/src/editor/serialization/mdToAst.js:15	server/core/markdown/editorSerialization.cjs:590
17	server/auth/oauth/nextcloudLegacyRoutes.js:208	server/auth/oauth/providerCallbackRoutes.js:766
17	server/automation/flowletAgent.js:225	server/core/automationRunner/execAi.js:1067
17	server/core/agentRuntime/finalizeTurn.js:168	server/routes/ai/directChat/finalizeTurn.js:318
17	server/core/providers/base.js:124	server/core/providers/base.js:286
16	agent-hub/src/components/admin/product-website/localeMerge.js:68	server/core/cms/cmsTranslate.js:122
16	agent-hub/src/editor/engine/formula.js:70	server/core/markdown/editorSerialization.cjs:312
16	agent-hub/src/editor/serialization/htmlToAst.js:36	server/core/markdown/editorSerialization.cjs:1457
16	agent-hub/src/utils/cmsPublicRouting.js:23	server/core/seo/publicPath.js:21
16	server/auth/loginAudit.js:185	server/auth/loginAudit.js:210
16	server/core/agentRuntime/attachmentProcessor.js:156	server/routes/ai/directChat/attachmentIntake.js:146
16	server/core/agentRuntime/attachmentProcessor.js:176	server/routes/ai/directChat/attachmentIntake.js:168
16	server/core/dataEngine/sources/spreadsheetFile/providers/googleDrive.js:59	server/core/dataEngine/sources/spreadsheetFile/providers/oneDrive.js:63
16	server/core/dataEngine/sources/spreadsheetFile/providers/googleDrive.js:643	server/core/dataEngine/sources/spreadsheetFile/providers/oneDrive.js:633
16	server/core/integrations/integrationTools.js:185	server/core/integrations/integrationTools.js:1197
16	server/core/llm/providerConfig.js:84	server/core/llm/providerConfig.js:106
16	server/core/meetingNotes/gmeetAutoImport.js:73	server/core/meetingNotes/teamsAutoImport.js:73
16	server/core/meetingNotes/gmeetAutoImport.js:141	server/core/meetingNotes/talkAutoRecord.js:114
16	server/core/providers/claudeModels.js:510	server/core/providers/openaiModels.js:482
15	agent-hub/src/components/admin/product-website/translatable.js:15	server/core/cms/cmsTranslate.js:26
15	agent-hub/src/editor/serialization/mdToAst.js:175	server/core/markdown/editorSerialization.cjs:771
15	server/appStudio/actionExecutor/documentStep.js:56	server/core/automationRunner/execFillDocument.js:103
15	server/core/documents/deckChart.js:182	server/core/documents/deckModel.js:155
15	server/core/embed/cpuEmbed.js:38	server/core/rerank/cpuCrossEncoder.js:49
14	agent-hub/src/editor/engine/formula.js:207	server/core/markdown/editorSerialization.cjs:481
14	agent-hub/src/editor/serialization/htmlToAst.js:22	server/core/markdown/editorSerialization.cjs:1446
14	server/auth/admin/featureAccessRoutes.js:181	server/auth/admin/featureAccessRoutes.js:202
14	server/auth/admin/featureAccessRoutes.js:498	server/auth/admin/featureAccessRoutes.js:638
14	server/auth/admin/userRoutes.js:317	server/auth/admin/userRoutes.js:451
