/**
 * Shared mapping core — the one implementation of how a step input finds its
 * value: path grammar, walking, binding resolution and the design-time checks
 * on a binding (validate.mjs). Beside the four frozen legacy kinds it holds
 * the v2 mapping: pick and compose bindings (intent.mjs: what is asked for;
 * walk.mjs, fit.mjs, render.mjs: how the run carries it out), the shape and
 * slot of a value (shape.mjs, slots.mjs), where each step type keeps its
 * values (sites.mjs) and the per-item repeat (repeat.mjs). The automation runtime
 * loads it through server/automation/bind.js (a CommonJS facade, like
 * automation/expr.js); agent-hub (`@shared/mapping`) and mobile
 * (src/shared/mapping) load their generated copies, so a preview in either
 * resolves a path exactly as the run does.
 *
 * Source of truth: server/shared/mapping/. The copies in
 * agent-hub/src/shared/mapping/ and mobile/src/shared/mapping/vendor/ are
 * written by `npm run gen:shared`; never edit them. Zero dependencies: the
 * expression engine and the number/date readers are injected (see
 * resolve.mjs). corpus.mjs pins the legacy behaviour, and the v2 kinds, on
 * every runtime.
 */
export {
    REF_RE,
    cloneLiteral,
    tokenizePath,
    resolveTokens,
    walkPath,
    walkRelativePath,
    interpolateTemplate,
} from './legacy.mjs';
export { createResolver, createLegacyResolver } from './resolve.mjs';
export {
    WILD, isWild, parseLegacyPath, formatPath, formatSegment, lastSegment, repairLegacyPath, sameSource, isPrefix,
} from './source.mjs';
export {
    RUNTIME_ROOTS, TRIGGER_RUN_KEYS, templatePaths, closestName, checkRefPath, validateBinding,
    SOURCE_ROOTS, sourceProblems, pickProblems, composeProblems, isPick, isCompose, describeSource, mappingIssues,
} from './validate.mjs';
export {
    REFUSED_KEYS, MAX_JSON_TEXT, walk, walkMany, walkSource, sourceBase, isMany, manyItems, plain, parseJsonText,
} from './walk.mjs';
export { SHAPES, shapeOf, shapeOfSchema } from './shape.mjs';
export { SLOT_KINDS, STEP_SLOTS, slotShape } from './slots.mjs';
export { COMMON_SITES, STEP_SITES, fieldValue, textSitesOf, stepBindingSites } from './sites.mjs';
export {
    TAKES, AS, JOINS, MAPPING_VERSION, defaultIntent, optionsFor, sourceFromPath, normalizePick,
} from './intent.mjs';
export { applyTake, castAs, fit } from './fit.mjs';
export { inlineText, renderText, renderCompose } from './render.mjs';
export {
    REPEAT_DEFAULT_MAX, REPEAT_MAX, mapStepPicks, toggleRepeat, toggleRepeatOff, rebaseLoopRefs,
} from './repeat.mjs';

// ── Sources (M3): fields, labels and upstream discovery as SourceNodes ──
export {
    MAX_DEPTH, fieldsFromSample, textChildren, sampleFromSchema, overlayReal, deepOverlay, hasPath,
    previewOf, isPlaceholder,
} from './fields.mjs';
export { humanizeKey, labelParts, labelText } from './label.mjs';
export {
    collectUpstream, computeUpstreamGroups, computeLoopBodyGroups, buildToolOutputMap, wrapGroupForEach,
    describeNode, describeNodeIn, describeLoopBody, DESCRIBED_TYPES,
    seg, sampleToFields, resolveElementSample, elementFieldOptions, collectArrayPaths, samplePlaceholderFor,
    overlayGroupWithReal, triggerMetaSample, describeTriggerMeta, inferLoopItemSample, suggestItemVar,
    pickSample, leadSkillId, DEFAULT_ENV, resolveEnv,
} from './upstream/index.mjs';
// A legacy binding shown as a pick (liftLegacy; null means "Formula"), and a
// pick written for the places that only hold the legacy spelling (lowerPick).
export { liftLegacy, legacyPathOf, lowerPick } from './upgrade.mjs';
