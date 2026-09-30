/**
 * The flow editor's server calls, one function per call, each answer read
 * through a contract reader. Screens do not call these directly: they use
 * the hooks (../hooks), which own the query keys and the invalidation.
 */

export * from './types';
export * from './catalogTypes';
export { flowKeys } from './keys';

export { createFlow, flowPath, getFlowAutomation, isVersionChanged, publishFlow, saveFlow, setFlowActive } from './definition';
export { agentPreviewQuery, getAgentPreview, getCatalog, getFormPickSources, getTableColumns } from './catalog';
export { diffVersions, getVersion, listVersions, restoreVersion } from './versions';
export { dryRun, runStep, type TestRunInput } from './runs';
export {
    diagnoseTrigger,
    getAiActAssessment,
    readAssessment,
    readDiagnosis,
    saveAiActAssessment,
    type AiActAnswers,
    type AiActAnswersBody,
    type AiActAssessment,
    type AiActOutcome,
    type AiActSignals,
    type AiActYesNo,
    type CheckStatus,
    type TriggerCheck,
    type TriggerDiagnosis,
} from './checks';
export { createFromTemplate, exportFlow, getTemplate, importFlow, listTemplates } from './templates';
export {
    createFormLink,
    createWebhook,
    deleteFormLink,
    deleteWebhook,
    listFormLinks,
    listWebhooks,
    rotateFormLink,
    rotateWebhookSecret,
} from './links';
export { createFolder, deleteFolder, listFolders, moveToFolder, updateFolder } from './folders';
export {
    getAiStepKnowledgeBases,
    getApprovalDirectory,
    getPrincipals,
    listHttpConnections,
    lookupKeys,
    readApprovalDirectory,
    readHttpConnections,
    readKnowledgeBaseList,
    readPrincipals,
    type ApprovalDirectory,
    type HttpConnection,
    type NamedRow,
} from './lookups';
export {
    DOCUMENT_TEMPLATE_LIMIT,
    documentKeys,
    getDocumentContract,
    listDocumentTemplates,
    readDocumentContract,
    readDocumentTemplates,
    type DocumentContract,
    type DocumentParameter,
    type DocumentSection,
    type DocumentTemplate,
} from './documents';
export {
    BUILDER_STREAM_PATH,
    builderTurnBody,
    getBuilderSession,
    readBuilderSnapshot,
    type BuilderAddedStep,
    type BuilderMessage,
    type BuilderSnapshot,
    type BuilderTodo,
    type BuilderToolCall,
    type BuilderTurnInput,
    type BuilderValidation,
} from './builder';
export { builderFrames, emptyBuilderTurn, type BuilderFrameCallbacks, type BuilderTurn } from './builderStream';

export { readCatalog, readPickSources } from './catalogReader';
export { readExport, readFlowAutomation, readRestoreResult, readSaveResult, readStepRun, readTestRun } from './readers';
