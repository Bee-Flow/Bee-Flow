# Work list: chat-runtime

Generated from `node scripts/module-boundary.mjs --list` and the core-mode run of the core tests.

## Core -> module import edges (40 in 20 files)

- `core/agentRuntime/chatStream/skillActivation.js`
  - line 19 -> `core/cowork/runActivity.mts` (cowork)
- `core/agentRuntime/contextBuilder.js`
  - line 6 -> `core/cowork/runActivity.mts` (cowork)
  - line 18 -> `core/webpages/sidePanelWebpageContext.js` (webpages)
- `core/agentRuntime/finalizeTurn.js`
  - line 115 -> `core/cowork/habits/habitSignals.mts` (cowork)
- `core/agentRuntime/toolRound/parseAndGate.js`
  - line 17 -> `core/cowork/runActivity.mts` (cowork)
- `core/agentRuntime/toolRound/results.js`
  - line 22 -> `core/cowork/runActivity.mts` (cowork)
- `core/agentRuntime/toolStackAssembly.js`
  - line 32 -> `core/cowork/runActivity.mts` (cowork)
  - line 33 -> `core/cowork/reviewTool.mts` (cowork)
  - line 34 -> `core/cowork/outcomeTool.mts` (cowork)
  - line 211 -> `core/cowork/runActivity.mts` (cowork)
- `core/projectContent/projectFeed.runs.js`
  - line 85 -> `stores/automationStore.js` (automation)
  - line 159 -> `core/runEventBus.js` (automation)
- `core/tools/builtinToolFamilies.js`
  - line 53 -> `core/cowork/reviewTool.mts` (cowork)
  - line 60 -> `core/cowork/runActivity.mts` (cowork)
  - line 62 -> `core/cowork/outcomeTool.mts` (cowork)
  - line 165 -> `stores/coworkStore.js` (cowork)
  - line 214 -> `core/tools/datatableTools.js` (datatables)
  - line 230 -> `core/tools/datatableTools.js` (datatables)
- `core/tools/skillInjection.js`
  - line 451 -> `stores/automationStore.js` (automation)
- `routes/agents/conversations.js`
  - line 159 -> `integrations/workspaceTools.js` (notebooks)
  - line 187 -> `integrations/workspaceTools.js` (notebooks)
- `routes/agents/publishVersion.js`
  - line 139 -> `compliance/events.js` (compliance)
- `routes/agents/published.js`
  - line 299 -> `compliance/events.js` (compliance)
- `routes/agents/wizard.js`
  - line 632 -> `stores/coworkStore.js` (cowork)
- `routes/ai/directChat/conversationRoutes.js`
  - line 380 -> `integrations/workspaceTools.js` (notebooks)
  - line 402 -> `integrations/workspaceTools.js` (notebooks)
- `routes/ai/directChat/promptContext.js`
  - line 266 -> `core/webpages/sidePanelWebpageContext.js` (webpages)
- `routes/ai/directChat/toolLoopSetup.js`
  - line 14 -> `integrations/workspaceTools.js` (notebooks)
- `routes/ai/directChat/toolStackAssembly.js`
  - line 13 -> `integrations/workspaceTools.js` (notebooks)
  - line 14 -> `integrations/webpageBuilderTools.js` (webpages)
  - line 16 -> `integrations/webpageDbTools.js` (webpages)
- `usecases/agents/agentPersonaWrite.js`
  - line 49 -> `stores/automationStore.js` (automation)
  - line 54 -> `automation/agentCallableTools.js` (automation)
  - line 89 -> `stores/automationStore.js` (automation)
  - line 92 -> `automation/agentBinding.js` (automation)
- `usecases/ai/directChat/toolExecSteps.js`
  - line 17 -> `integrations/webpageBuilderTools.js` (webpages)
  - line 19 -> `integrations/webpageDbTools.js` (webpages)
  - line 20 -> `integrations/webpagePlanTool.js` (webpages)
- `usecases/skills/automationLink.js`
  - line 31 -> `stores/automationStore.js` (automation)
  - line 33 -> `automation/access.js` (automation)

## featureModule() lookups of module files, by name (5): make them optionalFeatureModule

- `core/tools/toolDispatcher.js:115` -> `automation/agentCallableTools.js` (automation)
- `core/tools/toolDispatcher.js:127` -> `automation/agentCallableTools.js` (automation)
- `core/agentRuntime/chatStream/turnLoop.js:86` -> `integrations/workspaceTools.js` (notebooks)
- `core/documents/sheetAssist/sheetAssistant.js:160` -> `projects/chatModel.js` (projects)
- `integrations/templateFillTools.mts:271` -> `projects/documentFiling.mts` (projects)

## Core test files that fail with every module hidden (31)

- `core/agentRuntime/chatStream.coworkRun.test.js`
- `core/agentRuntime/chatStream.turnLifecycle.test.js`
- `core/agentRuntime/chatStream/skillActivation.test.js`
- `core/agentRuntime/chatStream/turnPreflight.signals.test.js`
- `core/agentRuntime/contextBuilder.test.js`
- `core/agentRuntime/testChat.runtime.test.js`
- `core/agentRuntime/testSandbox.test.js`
- `core/agentRuntime/toolPolicy/mailAccess.test.js`
- `core/agentRuntime/toolPolicy/mailRun.test.js`
- `core/agentRuntime/toolRound/parseAndGate.outsideText.test.js`
- `core/agentRuntime/toolRoundExecutor.confirm.test.js`
- `core/agentRuntime/toolRoundExecutor.gateOrder.test.js`
- `core/agentRuntime/toolRoundExecutor.kbScanning.test.js`
- `core/agentRuntime/toolRoundExecutor.persistRoundTrip.test.js`
- `core/agentRuntime/toolStackAssembly.lateTools.test.js`
- `core/agentRuntime/toolStackAssembly.sandbox.test.js`
- `core/agentRuntime/toolStackAssembly.visitor.test.js`
- `core/llm/llmClient.forcedTool.test.js`
- `core/projectContent/projectFeed.runs.test.js`
- `core/tools/skillInjection.structured.test.js`
- `core/tools/toolDispatcher.agentCall.test.js`
- `core/tools/toolDispatcher.coworkReview.test.js`
- `core/tools/toolDispatcher.datatableIdentity.test.js`
- `core/tools/toolDispatcher.ncScope.test.js`
- `routes/agents/chat.incognito.test.js`
- `routes/agents/crud.categoriesOrgScope.test.js`
- `routes/agents/crud.tools.test.js`
- `routes/agents/published.orgScope.test.js`
- `routes/ai/directChat/streamTurn.incognito.test.js`
- `routes/ai/directChat/streamTurn.validation.test.js`
- `routes/ai/directChat/toolStackAssembly.readUrl.test.js`
