# Area: server-domain

## Non-test source files > 600 lines (lines, path) — data/templates/fixtures already excluded
    1582 server/automation/builderTools/schemas.js
    1581 server/projects/packaging/install.js
    1389 server/appStudio/templates.js
    1368 server/automation/triggerBus.js
    1297 server/automation/builderTools/stepEditing.js
    1287 server/appStudio/fileIntake.js
    1248 server/services/stripeService.js
    1171 server/appStudio/builderTools/schemas.js
    1148 server/integrations/transcriptionTools.js
    1133 server/automation/builderPrompt.js
    1128 server/services/documentRenderer.js
    1111 server/appStudio/connectors.js
    1070 server/automation/approvalService.js
    1061 server/integrations/officegen.js
    1050 server/integrations/gmailTools.js
    1039 server/appStudio/validate/actions.js
     995 server/integrations/n8nWorkflowTools.js
     974 server/automation/builderPrompt/fewShotExamples.js
    923 nextcloud-connector/src/bootstrap.js
     922 server/appStudio/builderTools/dataTools.js
     895 server/integrations/vplanTools.js
     855 server/appStudio/connectorSync.js
     809 server/automation/outputSchemas.js
     800 server/projects/packaging/scrub.js
     780 server/integrations/nextcloudTalkTools.js
     778 server/projects/chatAssistant.js
     760 server/appStudio/connectorSchema.js
     759 server/playbooks/phases/compliancePhase.js
     757 server/services/guardInstaller.js
     754 server/integrations/gammaTools.js
     748 server/appStudio/actionExecutor/aiSteps.js
     742 server/integrations/youtrackTools.js
     742 server/appStudio/builderPrompt.js
     742 server/appStudio/aiRuntime.js
     733 server/projects/packaging/capture.js
     733 server/appStudio/componentSpecs/actionSpecs.js
     732 server/appStudio/templateCapture.js
     731 server/compliance/iso/policySeeds.js
     731 server/automation/validate/graph.js
     730 server/integrations/workspaceTools.js
     727 server/services/webpageBfTable.js
     718 server/compliance/runner.js
     716 server/appStudio/builderPrompt/catalogRender.js
     684 server/integrations/nextcloudDeckTools.js
     684 server/appStudio/validate.js
     681 server/appStudio/validate/nodes.js
     677 server/playbooks/recipeDoc.js
     676 server/integrations/nextcloudClient.js
    675 nextcloud-connector/src/setup.js
     675 server/automation/portability.js
     670 server/integrations/nmbrsTools.js
     670 server/integrations/nextcloudTablesTools.js
     663 server/integrations/customIntegrationRunner.js
     659 server/integrations/driveTools.js
     655 server/automation/templates.js
     654 server/automation/builderTools/refCheck.js
    641 nextcloud-connector/src/studioAppMenus.js
     640 server/projects/stages/prepare.js
     640 server/projects/packaging/releaseNotes.js
     633 server/automation/builderTools.js
     632 server/automation/suggestions.js
     630 server/services/githubSyncService.js
     630 server/automation/validate/constants.js
     630 server/appStudio/dataModel/connectorValidate.js
     623 server/projects/packaging/upgrade.js
     623 server/automation/bind.js
     617 server/compliance/dsr/discovery.js
     611 server/cms/mcp/dispatch.js
     607 server/services/supportAiResponder.js
     605 server/integrations/outlookTools.js

## Production clones involving this area (dup lines, fileA:line, fileB:line), largest first, max 80
131	agent-hub/src/utils/buildWebpagePreview.js:82	server/services/reactBundleServer.js:32
92	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:99	server/appStudio/definitionOps.js:61
70	agent-hub/src/utils/composeWebpageDocument.js:140	server/services/webpagePreviewBridges.js:23
58	agent-hub/src/components/admin/Studio/AppStudio/runtime/appDesignPresets.js:7	server/appStudio/appDesignPresets.js:22
54	agent-hub/src/utils/composeWebpageDocument.js:87	server/services/webpageDraftDocument.js:44
51	hub-module-sdk/modules/security_scan/server/src/scanRunner.service.js:196	server/services/pwtRunner.js:289
48	hub-module-sdk/modules/security_scan/frontend/vite.config.js:1	hub-module-sdk/template/frontend/vite.config.js:1
44	hub-module-sdk/modules/security_scan/test/hostMock.js:12	hub-module-sdk/template/test/hostMock.js:37
40	agent-hub/src/utils/composeWebpageDocument.js:390	server/services/webpagePreviewBridges.js:263
36	agent-hub/src/components/admin/Studio/AppStudio/inspector/styleKnobMeta.js:18	server/appStudio/componentSpecs/styleKnobs.js:38
35	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:352	server/appStudio/definitionOps.js:260
34	agent-hub/src/components/admin/Studio/AppStudio/runtime/appVariables.js:48	server/appStudio/componentSpecs/variables.js:84
34	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:37	server/appStudio/definitionOps.js:20
34	server/automation/builderTools/schemas.js:292	server/automation/builderTools/schemas.js:1023
34	server/integrations/officegen.js:323	server/services/documentRenderer.js:169
32	server/integrations/afasTools.js:223	server/integrations/nmbrsTools.js:299
32	server/integrations/afasTools.js:223	server/integrations/vplanTools.js:400
31	agent-hub/src/components/licensing/ModelTierSelector.jsx:220	hub-module-sdk/modules/security_scan/frontend/src/ModelTierSelector.jsx:148
31	hub-module-sdk/modules/security_scan/server/src/scanRunner.service.js:124	server/services/pwtRunner.js:140
29	hub-module-sdk/modules/security_scan/server/src/scanRunner.service.js:568	hub-module-sdk/modules/security_scan/server/src/scanRunner.service.js:660
29	server/automation/triggerBus.js:421	server/automation/triggerBus.js:552
28	server/appStudio/aiRuntime.js:545	server/core/cms/cmsExportBundle.js:144
27	agent-hub/src/utils/buildWebpagePreview.js:220	server/services/reactBundleServer.js:148
27	server/appStudio/appDryRun.js:145	server/appStudio/appDryRun.js:184
27	server/appStudio/componentSpecs/analyticsSpecs.js:20	server/appStudio/componentSpecs/recordListSpecs.js:18
27	server/appStudio/componentSpecs/analyticsSpecs.js:86	server/appStudio/componentSpecs/recordListSpecs.js:50
27	server/appStudio/mcpBuilder.js:117	server/automation/mcpBuilder.js:125
27	server/appStudio/templates/appQuoteIntake.js:2122	server/appStudio/templates/appQuoteIntake.js:2154
27	server/automation/triggerBus.js:500	server/automation/triggerBus.js:599
27	server/services/documentRenderer.js:884	server/services/documentRenderer.js:1079
26	agent-hub/src/components/automation/Builder/flow/settings/formState.js:1291	server/automation/builderTools/stepBuilders/outboundSteps.js:72
26	server/appStudio/appPortability.js:118	server/appStudio/templatePortability.js:84
26	server/integrations/nextcloudDeckTools.js:337	server/integrations/nextcloudNotesTools.js:160
25	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:930	server/appStudio/definitionOps.js:442
25	server/appStudio/actionExecutor/fileStep.js:171	server/appStudio/actionExecutor/shared.js:193
25	server/automation/portability.js:62	server/automation/stepContract.js:19
24	agent-hub/src/components/automation/Builder/flow/flowOrder.js:23	server/automation/datatableUsage.js:94
24	agent-hub/src/components/automation/Builder/flow/flowOrder.js:48	server/automation/datatableUsage.js:116
24	server/compliance/checks/iso27001/a8-28-secure-coding.js:22	server/compliance/checks/iso27001/a8-4-source-protection.js:24
24	server/core/agentRuntime/ruleAttribution.js:331	server/services/supportClassifier.js:29
24	server/integrations/nextcloudClient.js:547	server/integrations/nextcloudClient.js:585
23	hub-module-sdk/modules/security_scan/server/src/scanRunner.service.js:78	server/services/webpageRuntimeManager.js:108
23	server/appStudio/actionExecutor/documentStep.js:142	server/appStudio/actionExecutor/fileStep.js:189
23	server/appStudio/templates/appAiActRegister.js:1550	server/appStudio/templates/appKnowledgeGovernance.js:2284
23	server/compliance/checks/iso27001/a8-28-secure-coding.js:22	server/compliance/checks/iso27001/a8-8-vuln-mgmt.js:27
23	server/integrations/googleClient.js:54	server/integrations/msGraphClient.js:89
23	server/integrations/nextcloudCalendarTools.js:302	server/integrations/nextcloudContactsTools.js:276
23	server/integrations/nextcloudCalendarTools.js:302	server/integrations/nextcloudTasksTools.js:270
23	server/jobs/opsMetricsPush.js:81	server/jobs/usageOpenObservePush.js:137
23	server/projects/packaging/capture.js:52	server/projects/packaging/upgrade.js:173
22	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:739	server/appStudio/definitionOps.js:348
22	agent-hub/src/components/automation/Builder/flow/flowletScope.js:100	server/automation/flowletAgent.js:87
22	server/appStudio/appDryRun.js:150	server/appStudio/appDryRun.js:203
22	server/appStudio/builderTools/schemas.js:553	server/automation/builderTools/schemas.js:891
22	server/appStudio/mcpBuilder.js:352	server/automation/mcpBuilder.js:422
22	server/automation/builderTools/suggestedPatch.js:35	server/core/llm/toolCallHygiene.js:16
22	server/automation/datatableUsage.js:130	server/automation/fieldDiff.js:138
22	server/integrations/nextcloudFormsTools.js:136	server/integrations/nextcloudTeamsTools.js:167
21	agent-hub/src/utils/composeWebpageDocument.js:461	server/services/webpageDraftDocument.js:97
21	server/appStudio/actionExecutor/shared.js:21	server/appStudio/stepDataSource.js:58
21	server/appStudio/componentSpecs/analyticsSpecs.js:93	server/appStudio/componentSpecs/recordListSpecs.js:53
21	server/appStudio/validate.js:106	server/appStudio/validate.js:126
21	server/automation/triggerSources/declared/google-calendar.js:33	server/automation/triggerSources/declared/google-calendar.js:74
21	server/compliance/checks/iso27001/a8-13-backups.js:35	server/compliance/checks/iso27001/a8-20-network-exposure.js:31
21	server/compliance/checks/iso27001/a8-28-secure-coding.js:22	server/compliance/checks/iso27001/a8-32-change-management.js:25
21	server/integrations/driveTools.js:60	server/integrations/oneDriveTools.js:60
21	server/integrations/githubTools.js:121	server/services/githubSyncService.js:25
21	server/projects/summary.js:73	server/routes/projects/stages/stageRoutes.js:201
20	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:201	server/appStudio/definitionOps.js:163
20	agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js:785	server/appStudio/definitionOps.js:373
20	agent-hub/src/components/licensing/ModelTierSelector.jsx:154	hub-module-sdk/modules/security_scan/frontend/src/ModelTierSelector.jsx:89
20	server/appStudio/templates/appAiActRegister.js:164	server/appStudio/templates/appKnowledgeGovernance.js:214
20	server/appStudio/templates/appAiActRegister.js:164	server/appStudio/templates/appMeetingDossier.js:206
20	server/appStudio/templates/appQuoteIntake.js:1103	server/appStudio/templates/appSupportDesk.js:546
20	server/automation/triggerSources/declared/google-sheets.js:86	server/automation/triggerSources/declared/google-slides.js:21
20	server/integrations/gmailTools.js:594	server/integrations/gmailTools.js:1017
20	server/projects/stages/plan.js:131	server/projects/stages/prepare.js:127
19	agent-hub/src/demo/fixtures/appStudio.js:107	server/appStudio/templates.js:704
19	hub-module-sdk/modules/security_scan/test/hostMock.js:78	hub-module-sdk/template/test/hostMock.js:112
19	nextcloud-connector/src/automationEventsWebhook.js:318	nextcloud-connector/src/eventsWebhook.js:65
