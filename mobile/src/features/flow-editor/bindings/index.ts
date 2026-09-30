/**
 * The flow editor's binding layer: what a step can bind to (the variable
 * picker's groups), what a value means (the visual value model, chips,
 * previews), and the auto-mapper. Ports of agent-hub's
 * `Builder/mapping/*` and `utils/bindingHelpers.js`, each pinned by a
 * lockstep test beside it; none of them renders, fetches or holds state.
 *
 * The types here are a READ view of a definition (types.ts): model/types.ts's
 * strict FlowDefinition goes in without a cast.
 */

export * from './types';
export * from './json';
export * from './walkPath';
export {
    AUTOCOMPLETE_ROOTS, bindingFromInput, detectTemplate, formatPathForInsert, getAutocompleteToken, getAutocompleteTokenFromPrefix,
    inputFromBinding, insertAtSelection, isCleanPath, replaceRange, suggestKeyFromPath, TEMPLATE_RE,
    type BindingMode, type PrefixToken, type TextEdit,
} from './bindingHelpers';
export * from './conditionText';
export {
    buildValue, describeDataPath, escapeExprString, isDataPath, parseValue, type DataPathLabel, type ParsedValue, type ValuePart,
} from './valueParts';
export * from './valueTransforms';
export * from './refTokens';
export * from './bindingPreview';
export * from './boundPaths';
export * from './fieldKinds';
export * from './fieldDescription';
export * from './filterFields';
export * from './keyPath';
export * from './listShape';
export * from './mismatch';
export * from './partitionInputs';
export * from './realOutputs';
export * from './upstream';
export * from './autoMap';
export * from './autoMapIteration';
export * from './autoMapStep';
export * from './autoMapInsert';
// The Builder/flow helpers only this layer reads.
export { summariseData, type DataSummary } from './flowDeps/dataSummary';
export { dateInputPatch, datetimeTargetColumn, isDateTimeListMode, splitWildcardPath } from './flowDeps/datetimeTarget';
export { getLayerContract } from './flowDeps/flowletScope';
export { pickSourceById, pickSourcesSync, resetPickSources, setPickSources, type PickSource } from './flowDeps/pickSources';
export * from './flowDeps/privacyModel';
export { applyOpsToSampleRow, columnsAfterOps } from './flowDeps/setOperations';
export { paramsToSchema, schemaToParams } from './flowDeps/triggerSchemaUtils';
