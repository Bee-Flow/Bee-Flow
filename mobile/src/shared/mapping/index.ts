/**
 * The shared mapping core on the phone: how a step input finds its value
 * (path grammar, the walker, the four legacy binding kinds).
 *
 * `vendor/` is server/shared/mapping VERBATIM, written by `npm run gen:shared`
 * (scripts/gen-shared-mirror.mjs) beside agent-hub's copy; Metro cannot import
 * from server/ or agent-hub/. mappingVendor.lockstep.test.ts fails the moment
 * a copy differs by a byte. Never edit the files in vendor/.
 *
 * The server runs automations with this same code (automation/bind.js), so a
 * preview here resolves a path exactly as the run will; corpus.test.ts holds
 * the phone to the server's recorded results. `createLegacyResolver` takes
 * the expression engine as an argument: pass `evaluate` from '@/shared/expr'.
 */

export {
    REF_RE,
    WILD,
    cloneLiteral,
    createLegacyResolver,
    formatPath,
    interpolateTemplate,
    isWild,
    lastSegment,
    parseLegacyPath,
    resolveTokens,
    tokenizePath,
    walkPath,
    walkRelativePath,
} from './vendor/index.mjs';
export type {
    LegacyResolver,
    LegacyToken,
    ResolveOptions,
    Source,
    SourceSegment,
    TemplateOptions,
    WildSegment,
} from './vendor/index.mjs';
