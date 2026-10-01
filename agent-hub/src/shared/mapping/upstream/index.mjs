/**
 * Upstream discovery: which values earlier steps hand the step being edited,
 * as SourceNodes. Moved out of agent-hub's Builder/mapping/upstream so the
 * builder, its auto-mapper and the phone's flow editor describe a step the
 * same way; each client binds its own hooks (env.mjs) once.
 *
 *   graphWalk.mjs         backward BFS over the edges: WHICH nodes are upstream
 *   groups.mjs            the walk turned into variable groups (and the loop-body variant)
 *   describeNode.mjs      one node's `type` → its describer
 *   sampleFields.mjs      the field helpers the describers share, and path escaping
 *   realOverlay.mjs       a node's real (pinned / last-run) output folded into its group
 *   env.mjs               what the describers need from the client they run in
 *
 *   triggers.mjs          the trigger payload group and the "Trigger info" group
 *   formAnswers.mjs       what an answered form field looks like (trigger AND form page)
 *   loops.mjs             Loop / "Each item" / forEach, and the element-shape inference
 *   aiSteps.mjs           the steps whose shape the author declares (AI step, Extract data)
 *   actionSteps.mjs       integration / HTTP / code / notification / the privacy steps
 *   documentSteps.mjs     the steps that produce a file
 *   collectionSteps.mjs   the list nodes and their `{ items, count }` wrapper
 *   controlFlowSteps.mjs  condition / switch / wait / approval / flowlet call
 *   dataSteps.mjs         datatable and knowledge-base steps
 */
export { collectUpstream } from './graphWalk.mjs';
export { computeUpstreamGroups, computeLoopBodyGroups, buildToolOutputMap, wrapGroupForEach } from './groups.mjs';
export { describeNode, describeNodeIn, describeLoopBody, DESCRIBED_TYPES } from './describeNode.mjs';
export {
    seg, sampleToFields, resolveElementSample, elementFieldOptions, collectArrayPaths, samplePlaceholderFor,
} from './sampleFields.mjs';
export { overlayGroupWithReal } from './realOverlay.mjs';
export { triggerMetaSample, describeTriggerMeta } from './triggers.mjs';
export { inferLoopItemSample, suggestItemVar, runsPerItem } from './loops.mjs';
export { pickSample } from './formAnswers.mjs';
export { leadSkillId } from './aiSteps.mjs';
export { DEFAULT_ENV, resolveEnv } from './env.mjs';
