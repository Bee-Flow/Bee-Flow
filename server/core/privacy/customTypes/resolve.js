// @typecheck
'use strict';
/**
 * "Your own data" in a stored shield row, read the way the runtime needs it.
 *
 *   deriveCustomState   the org's types: `customDataTypes` when the row has
 *                       it, otherwise migrated on the fly from the old
 *                       `customSensitiveTerms` (deterministic ids, so this
 *                       and the save agree). Memoised per stored row object.
 *   withMigratedIds     the stored category list plus the ids of lazily
 *                       migrated types: a migrated term keeps hiding from
 *                       the AI (it always did), tools stay off.
 *   applyCustomTypes    what resolveOrgShield adds: the licence clamp
 *                       (Community keeps only migrated types), the category
 *                       lists normalised (custom ids only for enforced types;
 *                       empty-means-all kept), the registry synced, and
 *                       `customDataTypes` / `customTypesDigest` on the result.
 *
 * Never mutates the stored row: configStore hands every reader the same
 * cached object.
 */

const { isCustomTypeId } = require('./ids');
const { typesDigest } = require('./spec');
const { migrateLegacyTerms } = require('./migrate');
const { hasCustomIds, withBuiltinDefault } = require('./plan');
const registry = require('./registry');

const FEATURE = 'custom_data_types';

/** @type {WeakMap<object, { orgId: string, types: any[], lazilyMigrated: boolean }>} */
const _derived = new WeakMap();
/** @type {Map<string, { at: number, value: boolean }>} */
const _featureMemo = new Map();
const RUNTIME_FEATURE_CACHE_MS = 60_000;

/**
 * @param {any} shield  the stored row
 * @param {string} orgId
 * @returns {{ types: any[], lazilyMigrated: boolean }}
 */
function deriveCustomState(shield, orgId) {
    if (!shield || typeof shield !== 'object') return { types: [], lazilyMigrated: false };
    const hit = _derived.get(shield);
    if (hit && hit.orgId === orgId) return hit;
    let types;
    let lazilyMigrated = false;
    if (Array.isArray(shield.customDataTypes)) {
        types = shield.customDataTypes.filter(t => t && typeof t === 'object' && isCustomTypeId(t.id));
    } else {
        types = migrateLegacyTerms(orgId, shield.customSensitiveTerms);
        lazilyMigrated = types.length > 0;
    }
    const out = { orgId, types, lazilyMigrated };
    _derived.set(shield, out);
    return out;
}

/**
 * @param {string[]} list  a stored category list
 * @param {{ types: any[], lazilyMigrated: boolean }} state
 */
function withMigratedIds(list, state) {
    const base = Array.isArray(list) ? list : [];
    if (!state.lazilyMigrated) return base;
    const add = state.types.filter(t => t.legacy && !base.includes(t.id)).map(t => t.id);
    return add.length ? [...base, ...add] : base;
}

/** Keep custom ids only when they are in `ids`; the same array when nothing changes. */
function keepKnown(list, ids) {
    if (!hasCustomIds(list)) return list;
    const out = list.filter(c => !isCustomTypeId(c) || ids.has(c));
    return out.length === list.length ? list : out;
}

/**
 * Does the TARGET org have the feature? Never the caller's tier: an admin
 * with a personal Enterprise licence does not unlock a Community org.
 * Fails closed.
 *
 * `cacheMs` (the runtime resolver only): remember the answer that long per
 * org, since resolveOrgShield runs on every request. A change of licence then
 * reaches enforcement within that time; the save route and the bench always
 * ask fresh.
 * @param {string} orgId
 * @param {any} [lic]  the licence module (injected by the route and tests)
 * @param {{ cacheMs?: number }} [opts]
 */
async function hasCustomDataFeature(orgId, lic = null, opts = {}) {
    const cacheMs = Number(opts.cacheMs) || 0;
    if (cacheMs > 0) {
        const hit = _featureMemo.get(orgId);
        if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    }
    let value = false;
    try {
        const l = lic || require('../../../license/index');
        if (typeof l.hasFeature === 'function') value = !!(await l.hasFeature({ organizationId: orgId }, FEATURE));
        else value = !!l.tiers.tierHasFeature(await l.resolveTier({ organizationId: orgId }), FEATURE);
    } catch (_) {
        return false;
    }
    if (cacheMs > 0) _featureMemo.set(orgId, { at: Date.now(), value });
    return value;
}

/**
 * @param {any} resolved  the object resolveOrgShield is building (mutated)
 * @param {any} shield    the stored row (read only)
 * @param {string} orgId
 * @param {{ lic?: any, featureCacheMs?: number }} [opts]
 */
async function applyCustomTypes(resolved, shield, orgId, opts = {}) {
    const state = deriveCustomState(shield, orgId);
    const featureEnabled = state.types.some(t => !t.legacy)
        ? await hasCustomDataFeature(orgId, opts.lic, { cacheMs: opts.featureCacheMs ?? RUNTIME_FEATURE_CACHE_MS })
        : false;
    const enforced = state.types.filter(t => t.status !== 'invalid' && (featureEnabled || t.legacy));
    registry.syncOrg(orgId, enforced);
    const ids = new Set(enforced.map(t => t.id));

    resolved.piiDetectionCategories = withBuiltinDefault(keepKnown(withMigratedIds(resolved.piiDetectionCategories, state), ids));
    const policy = resolved.toolPiiPolicy;
    if (policy && typeof policy === 'object') {
        const ext = keepKnown(policy.external?.blockCategories || [], ids);
        const int = keepKnown(policy.internal?.blockCategories || [], ids);
        if (ext !== (policy.external?.blockCategories || []) || int !== (policy.internal?.blockCategories || [])) {
            resolved.toolPiiPolicy = { external: { blockCategories: ext }, internal: { blockCategories: int } };
        }
    }
    if (Array.isArray(resolved.webSearchGuardPiiCategories)) {
        resolved.webSearchGuardPiiCategories = keepKnown(resolved.webSearchGuardPiiCategories, ids);
    }
    resolved.customDataTypes = enforced;
    resolved.customTypesDigest = typesDigest(enforced);
    return resolved;
}

/** Test seam. */
function _resetFeatureMemo() { _featureMemo.clear(); }

module.exports = {
    FEATURE,
    _resetFeatureMemo,
    deriveCustomState,
    withMigratedIds,
    keepKnown,
    hasCustomDataFeature,
    applyCustomTypes,
};
