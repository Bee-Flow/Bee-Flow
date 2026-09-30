/**
 * Pure upstream-variable discovery for the flow editor — the entry point, as
 * agent-hub `Builder/mapping/upstream/index.js` is on the web:
 *
 *   graphWalk        backward BFS over the edges: WHICH nodes are upstream
 *   groups           the walk turned into variable groups (and the loop-body variant)
 *   describeNode     one node's `type` → its describer
 *   sampleFields     sample → bindable fields, and path escaping
 *   realOverlay      a node's real (pinned / last-run) output folded into its group
 *   triggers, formAnswers, loops, aiSteps, actionSteps, documentSteps,
 *   collectionSteps, parseJsonStep, controlFlowSteps, dataSteps — the describers
 */

export { collectUpstream } from './graphWalk';
export { buildToolOutputMap, computeLoopBodyGroups, computeUpstreamGroups } from './groups';
export { describeNode, DESCRIBED_TYPES } from './describeNode';
export { collectArrayPaths, elementFieldOptions, resolveElementSample, sampleToFields, seg } from './sampleFields';
export { overlayGroupWithReal } from './realOverlay';
export { describeTriggerMeta, triggerMetaSample } from './triggers';
export { inferLoopItemSample, suggestItemVar } from './loops';
