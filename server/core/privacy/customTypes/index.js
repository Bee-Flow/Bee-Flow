// @typecheck
'use strict';
/**
 * "Your own data": org-defined kinds of sensitive data for the Privacy Shield.
 *
 * The public surface other modules build on (the test bench in
 * core/privacy/customData and routes/orgCustomData.js among them). Pinned in
 * the feature contract; everything else in this directory is internal.
 *
 *   validateTypeSpec(type, { orgId, existingTypes })  → { ok, normalized, errors }
 *   reservedTokenKeys()                               → Set<string>
 *   compileTypes(types)                               → Compiled (never throws)
 *   matchNode(text, compiledOrTypes)                  → { spans, partial, timedOut, … }
 *   migrateLegacyTerms(orgId, customSensitiveTerms)   → Type[]
 *   probeGuard(texts, labelSet, { priority })         → Promise<{ candidates }>
 *   isCustomTypeId(id)                                → boolean
 */

const { isCustomTypeId, newTypeId, legacyTypeId } = require('./ids');
const { validateTypeSpec, validateTypeList, reservedTokenKeys, specDigest, typesDigest, LIMITS, TOKEN_KEY_RE, LEGACY_TOKEN_KEY } = require('./spec');
const { compileTypes } = require('./compile');
const { matchNode } = require('./nodeMatch');
const { migrateLegacyTerms, buildLegacyMirror } = require('./migrate');
const { probeGuard } = require('./probe');
const { scanCategoriesFor, withBuiltinDefault, hasCustomIds } = require('./plan');
const { FEATURE, hasCustomDataFeature } = require('./resolve');
const registry = require('./registry');

module.exports = {
    // contract
    validateTypeSpec,
    reservedTokenKeys,
    compileTypes,
    matchNode,
    migrateLegacyTerms,
    probeGuard,
    isCustomTypeId,
    // also useful to callers
    validateTypeList,
    newTypeId,
    legacyTypeId,
    specDigest,
    typesDigest,
    buildLegacyMirror,
    scanCategoriesFor,
    withBuiltinDefault,
    hasCustomIds,
    hasCustomDataFeature,
    displayNameFor: registry.displayNameFor,
    tokenKeyFor: registry.tokenKeyFor,
    LIMITS,
    TOKEN_KEY_RE,
    LEGACY_TOKEN_KEY,
    FEATURE,
};
