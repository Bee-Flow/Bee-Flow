/**
 * The shared mapping core on the phone: how a step input finds its value
 * (path grammar, the walker, the four legacy binding kinds).
 *
 * `vendor/` is server/shared/mapping VERBATIM, written by `npm run gen:shared`
 * (scripts/gen-shared-mirror.mjs) beside agent-hub's copy; Metro cannot import
 * from server/ or agent-hub/. mappingVendor.lockstep.test.ts fails the moment
 * a copy differs by a byte. Never edit the files in vendor/.
 *
 * The flow editor reads paths, shapes, labels, the upstream fields and the
 * v2 mapping (picks, composed texts) through this file only: the ports of
 * the web's mapping helpers it used to keep are gone, so the phone and the
 * web cannot drift apart on what a value is or how it is used.
 *
 * The server runs automations with this same code (automation/bind.js), so a
 * preview here resolves a path exactly as the run will; corpus.test.ts holds
 * the phone to the server's recorded results. `createLegacyResolver` takes
 * the expression engine as an argument: pass `evaluate` from '@/shared/expr',
 * or use MAPPING_DEPS below, which also carries the number and date readers.
 */

import { evaluate } from '@/shared/expr';

import type { ParseDeps } from './vendor/index.mjs';

export {
    REF_RE,
    WILD,
    buildToolOutputMap,
    cloneLiteral,
    collectArrayPaths,
    collectUpstream,
    computeLoopBodyGroups,
    computeUpstreamGroups,
    createLegacyResolver,
    describeNode,
    describeTriggerMeta,
    DESCRIBED_TYPES,
    elementFieldOptions,
    fieldsFromSample,
    formatPath,
    humanizeKey,
    inferLoopItemSample,
    interpolateTemplate,
    isWild,
    labelParts,
    lastSegment,
    overlayGroupWithReal,
    parseLegacyPath,
    resolveElementSample,
    resolveEnv,
    resolveTokens,
    sampleToFields,
    seg,
    sourceFromPath,
    suggestItemVar,
    textChildren,
    tokenizePath,
    TRIGGER_RUN_KEYS,
    triggerMetaSample,
    walkPath,
    walkRelativePath,
} from './vendor/index.mjs';
// The one auto-map rule (match.mjs), shared with the web builder and the AI
// builder: which earlier value goes into which empty input.
export { isSecretLikeKey, matchInputs, normalizeKey, sampleType } from './vendor/index.mjs';
export type { MappingSource, MatchCandidate, MatchInput } from './vendor/index.mjs';
// The v2 mapping in the editor (features/flow-editor/valueSlot): what a pick
// is, what it offers, how it previews, and lifting a legacy binding to one.
export {
    AS,
    MAPPING_VERSION,
    createResolver,
    defaultIntent,
    describeSource,
    formatSegment,
    inlineText,
    isCompose,
    isMany,
    isPick,
    liftLegacy,
    manyItems,
    optionsFor,
    pickForLegacyPath,
    renderText,
    sameSource,
    shapeOf,
    slotShape,
    sourceBase,
    walkSource,
} from './vendor/index.mjs';
export type {
    As,
    ComposeBinding,
    Join,
    ParseDeps,
    PickBinding,
    PickIntent,
    PickOption,
    PickPart,
    Shape,
    Slot,
    Take,
} from './vendor/index.mjs';
export type {
    LabelPart,
    LegacyResolver,
    LegacyToken,
    ResolveOptions,
    Source,
    SourceGroup,
    SourceNode,
    SourceSegment,
    TemplateOptions,
    ToolOutputMap,
    UpstreamEnv,
    WildSegment,
} from './vendor/index.mjs';

// The number and date readers (shared/expr/parse.mjs) have no declaration
// file of their own; corpus.test.ts loads them the same way.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parse = require('../expr/vendor/parse.mjs') as ParseDeps;

/**
 * What a resolver or liftLegacy is handed on the phone: the expression
 * engine and the number/date readers, the same pair the server's bind.js
 * passes, so a preview resolves exactly as the run does.
 */
export const MAPPING_DEPS = Object.freeze({ evaluate, parse });
