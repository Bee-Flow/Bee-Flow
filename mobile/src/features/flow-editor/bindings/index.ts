/**
 * The flow editor's binding layer: what a step can bind to (the variable
 * picker's groups), how a legacy path is named (pills, previews), and the
 * auto-mapper. Ports of agent-hub's `Builder/mapping/*` and
 * `utils/bindingHelpers.js`, each pinned by a lockstep test beside it; none of
 * them renders, fetches or holds state. Walking, shapes, labels and the v2
 * mapping are the shared core's (`@/shared/mapping`); the ports of the web's
 * list, mismatch, key-path and value-builder helpers are gone with it.
 *
 * The types here are a READ view of a definition (types.ts): model/types.ts's
 * strict FlowDefinition goes in without a cast.
 */

export * from './types';
export * from './json';
// The runtime's own walkers, from the shared mapping core.
export { walkPath, walkRelativePath } from '@/shared/mapping';
export {
    AUTOCOMPLETE_ROOTS, bindingFromInput, detectTemplate, formatPathForInsert, getAutocompleteToken, getAutocompleteTokenFromPrefix,
    inputFromBinding, insertAtSelection, isCleanPath, previewValue, replaceRange, suggestKeyFromPath, TEMPLATE_RE,
    type BindingMode, type PrefixToken, type TextEdit,
} from './bindingHelpers';
export * from './conditionText';
export * from './dataPath';
export * from './refTokens';
export * from './boundPaths';
export * from './fieldKinds';
export * from './filterFields';
export * from './partitionInputs';
export * from './realOutputs';
export * from './upstream';
export * from './autoMap';
export * from './autoMapIteration';
export * from './autoMapStep';
export * from './autoMapInsert';
// The Builder/flow helpers only this layer reads.
export { dateInputPatch, datetimeTargetColumn, isDateTimeListMode, splitWildcardPath } from './flowDeps/datetimeTarget';
export { getLayerContract } from './flowDeps/flowletScope';
export { pickSourceById, pickSourcesSync, resetPickSources, setPickSources, type PickSource } from './flowDeps/pickSources';
export * from './flowDeps/privacyModel';
export { applyOpsToSampleRow, columnsAfterOps } from './flowDeps/setOperations';
export { paramsToSchema, schemaToParams } from './flowDeps/triggerSchemaUtils';
