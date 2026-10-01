/**
 * Shared mapping core — the one implementation of how a step input finds its
 * value: path grammar, walking, binding resolution and the design-time checks
 * on a binding (validate.mjs). The automation runtime
 * loads it through server/automation/bind.js (a CommonJS facade, like
 * automation/expr.js); agent-hub (`@shared/mapping`) and mobile
 * (src/shared/mapping) load their generated copies, so a preview in either
 * resolves a path exactly as the run does.
 *
 * Source of truth: server/shared/mapping/. The copies in
 * agent-hub/src/shared/mapping/ and mobile/src/shared/mapping/vendor/ are
 * written by `npm run gen:shared`; never edit them. Zero dependencies: the
 * expression engine is injected (see resolve.mjs). corpus.mjs pins the legacy
 * behaviour on every runtime.
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
export { createLegacyResolver } from './resolve.mjs';
export {
    WILD, isWild, parseLegacyPath, formatPath, formatSegment, lastSegment, repairLegacyPath,
} from './source.mjs';
export {
    RUNTIME_ROOTS, TRIGGER_RUN_KEYS, templatePaths, closestName, checkRefPath, validateBinding,
} from './validate.mjs';

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
