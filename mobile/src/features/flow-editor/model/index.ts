/**
 * The flow editor's pure model: the definition's types, graph surgery,
 * the node catalogue and step picker, the Condition node, validation issues,
 * summaries, layout and undo history. Every module is a port of the web
 * builder (agent-hub/src/components/automation/Builder) pinned by a lockstep
 * test beside it; none of them renders, fetches or holds state.
 */

export * from './types';
export { asDefinition, emptyGraph, isBlankDefinition, normalizeDefinitionShape } from './normalize';
export {
    branchFromHandle, copyExtraEdgeKeys, edgeIdentity, edgeKey, matchesEdgeIdentity, PORT, removeEdgesByIdentity, spliceStepIntoEdge,
    type SpliceSpec,
} from './branchEdges';
export {
    applyDeleteNodes, applyDetachNode, applyDuplicateNode, applyPatchStep, bridgeEdges, canDeleteNode, canDetachNode, canDuplicateNode,
} from './nodeOps';
export { addedNodeId, applyAddNode, buildStepFromPayload, createsCycle, type AddNodeOptions, type BuiltTrigger, type StepPayload } from './addNode';
export { collectIds, newStepId, uniqueStepId } from './ids';
export { flowOrder, flowPosition, stepNumbers, type FlowPosition } from './flowOrder';
export { isTerminalStep, isTerminalStepType, TERMINAL_STEP_TYPES } from './terminalSteps';
export { LOOP_ENTRY_ID, loopBodyEdges, orderLoopBody } from './loopBodyEdges';
export {
    defaultFormDeclaration, defaultFormEndingDeclaration, defaultFormPageDeclaration, THEME_PRESETS, themePresetLabel, type ThemePreset,
} from './formDefaults';
export { FORM_PAGE_NAMES } from './scaffolds';
export * from './route/routeModel';
export { reconcileRouteEdges } from './route/routeEdges';
export { mergeStepPatchIntoDefinition, reconcileSwitchEdges, uniqueCaseName } from './route/switchCaseOps';
export * from './route/conditionModel';
export { parseExprToRows } from './route/conditionParse';
export {
    buildIssuesByStep, humanizeIssueText, matchValidationToStep, resolveOwningStepId, sectionForIssue, sectionsWithErrors, TAXONOMY,
    type InlineScope, type StepIssues,
} from './issues';
export * from './nodeDefs';
export * from './triggerLabels';
export * from './stepDisplayName';
export * from './waitDuration';
export * from './schedule';
export * from './nodeSummaries';
export * from './flattenStep';
export {
    actionDisplayLabel, buildStepLabelMap, buildStepTypeMap, describeRuleExpr, humanizeExpression, humanizeFieldKey, humanizeFieldTail, humanizeToolName, ruleSentence,
} from './displayHelpers';
export * from './familyStyle';
export { DEFAULT_DIMS, DEFAULT_SPACING, graphNodes, graphPositions, isFinitePos, runDagre, type Dims, type Spacing } from './layout';
export { ARRANGE_MODES, arrangeDefinition, seedPositions, type ArrangeMode, type ArrangeOptions } from './arrange';
export { DEFAULT_COLUMNS, ROW_GAP, rowLayoutPositions } from './rows';
export { PORT_PAD, PORT_PITCH, TOOL_ROW_EXTRA_H, toolLayoutHeights } from './geometry';
export { attachTool, detachTool, toolStateOf, type ToolState } from './aiTools';
export * from './history';
export * from './flowlets';
export * from './palette';
