/**
 * Pure upstream-variable discovery for the automation builder — the entry
 * point. Everything here is a re-export; the code lives beside it.
 *
 *   graphWalk.js          backward BFS over the edges: WHICH nodes are upstream
 *   groups.js             the walk turned into variable groups (and the loop-body variant)
 *   describeNode.js       one node's `type` → its describer
 *   sampleFields.js       sample → bindable `{key, path, sample}` fields, and path escaping
 *   realOverlay.js        a node's real (pinned / last-run) output folded into its group
 *
 *   triggers.js           the trigger payload group and the "Trigger info" group
 *   formAnswers.js        what an answered form field looks like (trigger AND form page)
 *   loops.js              Loop / "Each item" / forEach, and the element-shape inference
 *   aiSteps.js            the steps whose shape the author declares (AI step, Extract data)
 *   actionSteps.js        integration / HTTP / code / notification / the privacy steps
 *   documentSteps.js      the steps that produce a file
 *   collectionSteps.js    the list nodes and their `{ items, count }` wrapper
 *   controlFlowSteps.js   condition / switch / wait / approval / flowlet call
 *   dataSteps.js          datatable and knowledge-base steps
 *
 * Kept framework-free so the auto-mapper sees EXACTLY the same candidate paths
 * the user sees in the tree.
 */
export { collectUpstream } from './graphWalk';
export { computeUpstreamGroups, computeLoopBodyGroups, buildToolOutputMap } from './groups';
export { describeNode } from './describeNode';
export { sampleToFields, resolveElementSample, elementFieldOptions, collectArrayPaths } from './sampleFields';
export { overlayGroupWithReal } from './realOverlay';
export { triggerMetaSample, describeTriggerMeta } from './triggers';
export { inferLoopItemSample, suggestItemVar } from './loops';
