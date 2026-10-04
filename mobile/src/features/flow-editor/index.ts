/**
 * The flow editor: a touch editing environment for an automation's flow, the
 * phone's counterpart of the web builder (agent-hub/src/components/
 * automation/Builder). Import from '@/features/flow-editor', never from its
 * internals — except the feature's own folders, which reach each other
 * through '@/features/flow-editor/<layer>' (ARCHITECTURE.md).
 *
 *   model/      the definition's types and pure graph operations (web ports)
 *   bindings/   what a step can bind to, values and chips (web ports)
 *   formState/  per-type editor drafts and patches (web ports)
 *   api/        the server calls and their contract readers
 *   state/      the draft store: one open automation, undo, autosave
 *   hooks/      what screens use
 *   components/ the build screen's parts (outline, picker, issues, canvas),
 *               its tools (run: test runs and their overlay; ai: the
 *               assistant sheet), the version history and the settings, and
 *               the node editor: its field kit, the variable picker, the
 *               per-type step editors (editors/registry.ts)
 *   screens/    what app/ renders: build, a flowlet, step editor, versions, settings
 */

export * from './hooks';
export { BuildScreen, type BuildScreenProps } from './screens/BuildScreen';
export { FlowletScreen, type FlowletScreenProps } from './screens/FlowletScreen';
// The Forms builder edits page one with the same control the trigger's step editor uses.
export { FormPageEditor, type FormPageEditorProps } from './components/editors/form/FormPageEditor';
export type { FlowDefinition, FormDeclaration, FormField, FormTheme } from './model';
export { NodeEditorScreen, stepEditorHref, type NodeEditorScreenProps } from './screens/NodeEditorScreen';
export { VersionsScreen, type VersionsScreenProps } from './screens/VersionsScreen';
export { FlowSettingsScreen, type FlowSettingsScreenProps } from './screens/FlowSettingsScreen';
export {
    flowKeys,
    type AgentPreview,
    type BuilderMessage,
    type BuilderSnapshot,
    type BuilderTodo,
    type BuilderToolCall,
    type BuilderTurn,
    type BuilderValidation,
    type CatalogActionRow,
    type CatalogAppRow,
    type FlowAutomation,
    type FlowCatalog,
    type FlowExport,
    type FlowFolder,
    type FlowFormLink,
    type FlowIssue,
    type FlowTemplate,
    type FlowTemplateSummary,
    type FlowVersion,
    type FlowVersionDiff,
    type FlowVersionSummary,
    type FlowWebhook,
    type IssueSet,
    type SaveResult,
    type StepRunMode,
    type StepRunResult,
    type TestRunResult,
} from './api';
export {
    ensureDraftSaved,
    newFlowSeed,
    UnsavedDraftError,
    type DraftOp,
    type DraftState,
    type DraftStore,
    type NewFlowKind,
    type SaveError,
    type SaveStatus,
} from './state';
