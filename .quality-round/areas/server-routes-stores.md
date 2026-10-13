# Area: server-routes-stores

## Non-test source files > 600 lines (lines, path) — data/templates/fixtures already excluded
    1904 server/routes/ai/automationBuilder/chatStream.js
    1600 server/stores/notebookStore.js
    1579 server/stores/studioAppStore.js
    1529 server/stores/blueprintStore.js
    1526 server/stores/projectStore.js
    1505 server/routes/studioApps.js
    1431 server/stores/knowledgeBases.js
    1422 server/routes/ai/notebookChat.js
    1403 server/routes/automation/formPublic.js
    1391 server/stores/memoryStore.js
    1389 server/routes/projects.js
    1378 server/stores/transcriptionStore.js
    1362 server/routes/automation/crud.js
    1352 server/stores/complianceStore.js
    1324 server/routes/notebooks.js
    1314 server/routes/ai/webpageChat.js
    1311 server/stores/usageStore.js
    1276 server/routes/cms.js
    1260 server/stores/studioAppDataStore.js
    1197 server/routes/knowledgeBases/sources.js
    1196 server/routes/supportInbox.js
    1160 server/stores/skillStore.js
    1137 server/routes/agents/crud.js
    1054 server/stores/agent/agentCrud.js
    1016 server/routes/usage.js
    1010 server/stores/automationStore/runs.js
     969 server/routes/studioAppData.js
     942 server/stores/user/users.js
     905 server/routes/agents/tests.js
     904 server/stores/user/schema.js
     903 server/routes/webpagesPreview.js
     894 server/stores/agent/directConversations.js
     893 server/routes/ai/learning.js
     885 server/routes/templates.js
     858 server/routes/support/threads.js
     851 server/routes/cmsAnalytics.js
     798 server/routes/studioDocuments.js
     794 server/routes/automation/webhooksAndRunOps.js
     790 server/routes/projects/packaging.js
     789 server/routes/ai/config/modelTiers.js
     787 server/stores/integrationConnectionStore.js
     786 server/routes/admin/languageRoutes.js
     782 server/stores/documentStore.js
     780 server/routes/studio/attentionChecks.js
     778 server/stores/storageStore.js
     773 server/stores/projectCommentStore.js
     765 server/stores/integrationActivityStore.js
     761 server/routes/publicViewer.js
     756 server/routes/projects/chats.js
     755 server/routes/dsr.js
     729 server/stores/lib/sqliteBlobEngine.js
     726 server/stores/collabDocStore.js
     725 server/routes/ai/cmsBuilder.js
     720 server/routes/ai/directChat/streamTurn.js
     718 server/stores/lib/pgAppEngine.js
     717 server/stores/automationStore/automations.js
     716 server/routes/orgPrivacyShield.js
     709 server/routes/agents/wizard.js
     707 server/routes/ai/config/instanceConfig.js
     706 server/stores/projectChatStore.js
     704 server/routes/agents/chat.js
     703 server/routes/memory.js
     702 server/stores/datatableStore/datatables.js
     696 server/routes/ai/config/integrations.js
     687 server/stores/kbSources.js
     685 server/routes/ai/directChat/attachmentIntake.js
     684 server/stores/configStore.js
     683 server/routes/ai/directChat/finalizeTurn.js
     680 server/stores/encryptionBackfill.js
     679 server/stores/agent/conversationMessages.js
     669 server/stores/agent/agentConversations.js
     669 server/routes/ai/voice.js
     653 server/routes/projects/tasks.js
     643 server/stores/incidentStore.js
     639 server/routes/studioAppsRun.js
     637 server/stores/cms/projects.js
     635 server/routes/support/issueLinks.js
     632 server/routes/studioAppPublic.js
     632 server/routes/automation/runs.js
     628 server/routes/ai/automationBuilder/suggestMappingsVerify.js
     625 server/routes/integrations/connections.js
     619 server/routes/studioAppConnectors.js
     612 server/routes/projects/comments.js
     607 server/stores/projectAiParticipationStore.js
     605 server/stores/coworkStore.js
     603 server/routes/orgIntegrations/builder.js
     602 server/routes/transcriptions/upload.js

## Production clones involving this area (dup lines, fileA:line, fileB:line), largest first, max 80
43	server/routes/agents/crud.js:335	server/routes/agents/crud.js:823
42	server/routes/publicShareBridge.js:176	server/routes/webpagesPreview.js:226
38	server/routes/integrations/gmail.js:34	server/routes/integrations/outlook.js:17
36	server/routes/agents/chat.js:28	server/routes/agents/tests.js:99
36	server/routes/gmeetNotesSettings.js:20	server/routes/guardInstall.js:13
36	server/routes/gmeetNotesSettings.js:20	server/routes/license.js:21
36	server/routes/gmeetNotesSettings.js:20	server/routes/maintenance.js:19
36	server/routes/gmeetNotesSettings.js:20	server/routes/search.js:54
36	server/routes/studioAppDatasets.js:180	server/routes/studioAppFiles.js:119
34	server/routes/agents/chat.js:28	server/routes/agents/conversations_meta.js:14
34	server/routes/agents/chat.js:30	server/routes/agents/published.js:148
34	server/routes/datatablesNextcloud.js:101	server/routes/datatablesSpreadsheets.js:171
34	server/routes/stripe/checkout.js:15	server/routes/stripe/promoCodes.js:13
33	server/routes/stripe/checkout.js:18	server/routes/subscriptions/lifecycle.js:14
32	server/stores/gmeetImportStore.js:155	server/stores/teamsImportStore.js:125
31	server/routes/admin/languageRoutes.js:25	server/routes/admin/modules.js:43
31	server/routes/admin/languageRoutes.js:25	server/routes/admin/ncSync.js:17
31	server/routes/admin/languageRoutes.js:25	server/routes/agents/chat.js:30
31	server/routes/admin/languageRoutes.js:25	server/routes/compliance/isoConnectors.js:25
31	server/routes/datatables/tables.js:140	server/routes/datatables/tables.js:308
31	server/routes/orgAiContext.js:31	server/routes/orgMemory.js:21
31	server/stores/configStore.js:165	server/stores/configStore.js:196
31	server/stores/webpage/extraFiles.js:155	server/stores/webpage/extraFiles.js:198
30	server/routes/admin/languageRoutes.js:26	server/routes/automation/approvals.js:34
30	server/routes/subscriptions/orgSubscriptions.js:10	server/routes/subscriptions/plans.js:7
30	server/stores/agent/agentConversations.js:371	server/stores/agent/directConversations.js:468
29	server/routes/admin/languageRoutes.js:27	server/routes/admin/ncIntegrations.js:26
29	server/routes/admin/languageRoutes.js:27	server/routes/adminLicense.js:48
29	server/routes/admin/languageRoutes.js:27	server/routes/agents/system.js:17
29	server/routes/admin/languageRoutes.js:27	server/routes/compliance/customFrameworks.js:51
29	server/routes/admin/languageRoutes.js:27	server/routes/cowork.js:68
29	server/routes/admin/languageRoutes.js:27	server/routes/integrations/connections.js:60
29	server/routes/admin/languageRoutes.js:27	server/routes/knowledgeBases/search.js:39
29	server/routes/admin/languageRoutes.js:27	server/routes/orgIntegrations/builder.js:69
29	server/routes/admin/languageRoutes.js:27	server/routes/stripe/checkout.js:20
29	server/routes/admin/languageRoutes.js:27	server/routes/support/issueLinks.js:53
29	server/routes/agents/tests.js:98	server/routes/agents/wizard.js:11
29	server/routes/transcriptions/noteActions.js:420	server/routes/webpages/lifecycle.js:68
28	server/routes/orgAiContext.js:31	server/routes/orgIntegrationCache.js:45
28	server/routes/orgAiContext.js:31	server/routes/webpagesPreviewTables.js:83
28	server/routes/subscriptions/plans.js:6	server/routes/subscriptions/platformConfig.js:7
27	server/routes/admin/languageRoutes.js:26	server/routes/transcriptions/schemas.js:21
27	server/routes/integrations/googleWorkspace.js:297	server/routes/integrations/withings.js:246
27	server/routes/studioAppData.js:154	server/routes/studioAppDatasets.js:184
26	server/routes/admin/languageRoutes.js:27	server/routes/datatables/schemas.js:26
26	server/routes/admin/languageRoutes.js:27	server/routes/gmeetNotesSettings.js:22
26	server/routes/admin/languageRoutes.js:27	server/routes/ncScope.js:56
26	server/routes/admin/languageRoutes.js:27	server/routes/webpages/schemas.js:24
26	server/routes/admin/ncIntegrations.js:24	server/routes/agents/persona.js:35
26	server/routes/admin/ncIntegrations.js:24	server/routes/compliance/isoDocs.js:28
26	server/routes/ai/directChat/streamTurn.js:98	server/routes/ai/templateChat.js:171
26	server/routes/webpagesPreview.js:293	server/routes/webpagesPreview.js:478
26	server/stores/storageStore.js:638	server/stores/storageStore.js:710
25	server/routes/notebooks.js:1018	server/routes/notebooks.js:1177
25	server/stores/user/subscriptions.js:363	server/stores/user/subscriptions.js:399
24	server/routes/ai/appStudioBuilder/turnLoop.js:74	server/routes/ai/automationBuilder/chatTurnLoop.js:28
24	server/routes/ai/automationBuilder/chatStream.js:961	server/routes/ai/cmsBuilder.js:370
24	server/routes/ai/templateChat.js:171	server/routes/ai/webpageChat.js:251
24	server/routes/automation/formsAi.js:38	server/routes/skills/ai.js:59
24	server/routes/datatables/schemas.js:29	server/routes/transcriptions/schemas.js:26
24	server/routes/datatables/schemas.js:29	server/routes/webpages/schemas.js:27
23	server/routes/admin/connectorHealth.js:34	server/routes/subscriptions/audit.js:10
23	server/routes/agents/system.js:17	server/routes/automation/webhooksAndRunOps.js:25
23	server/routes/agents/system.js:17	server/routes/icons.js:124
23	server/routes/agents/system.js:17	server/routes/mcpLibrary.js:40
23	server/routes/ai/directChat/conversationRoutes.js:90	server/routes/ai/directChat/conversationRoutes.js:130
23	server/routes/support/threads.js:454	server/routes/support/threads.js:487
22	server/routes/automation/formPublic.js:473	server/routes/automation/formPublic.js:1180
22	server/routes/studioAppData.js:193	server/routes/studioAppPublic.js:227
22	server/routes/studioAppFiles.js:282	server/routes/studioAppPublic.js:572
21	agent-hub/src/components/admin/product-website/localeMerge.js:25	server/stores/cms/shared.js:80
21	server/auth/connectorSig.js:32	server/routes/automation/events.js:190
21	server/projects/summary.js:73	server/routes/projects/stages/stageRoutes.js:201
21	server/routes/admin/connectorHealth.js:70	server/routes/admin/ncSync.js:91
21	server/routes/admin/languageRoutes.js:368	server/routes/admin/languageRoutes.js:483
21	server/routes/agents/system.js:17	server/routes/houseStyles.js:32
21	server/routes/ai/notebookChat.js:382	server/routes/ai/webpageChat.js:326
21	server/routes/mcpAutomations.js:56	server/routes/mcpStudio.js:52
21	server/routes/studio/attention.js:325	server/routes/studio/counts.js:385
20	server/auth/connectorSig.js:33	server/routes/webhooks/ncEvents.js:71
