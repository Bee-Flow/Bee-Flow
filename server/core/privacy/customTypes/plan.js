// @typecheck
'use strict';
/**
 * From a category list to a scan plan, and the list helpers every caller
 * that builds a category list needs.
 *
 * planScan is the fork in detectPii: a list without custom ids returns null
 * and the scan takes today's path, unchanged. A list with custom ids is split
 * into built-in categories (guard), `words`/`pattern` types (Node) and `ai`
 * types (guard, as custom_labels), with the ids nobody can resolve kept
 * aside so the scan can report them degraded.
 */

const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const { isCustomTypeId, sha256 } = require('./ids');
const { specDigest } = require('./spec');
const { compileTypes } = require('./compile');
const registry = require('./registry');

/** @param {unknown} categories */
function hasCustomIds(categories) {
    return Array.isArray(categories) && categories.some(isCustomTypeId);
}

/**
 * Empty-means-all, kept when custom ids join a list. A stored list whose
 * built-in part is empty means "every built-in category" (dlpRunner,
 * validateInputForPii, the guard); with only custom ids left in it, a scan
 * would otherwise run the custom types and nothing else.
 * @param {string[]} list
 * @returns {string[]} the same array when there is nothing to do
 */
function withBuiltinDefault(list) {
    if (!hasCustomIds(list)) return list;
    const builtIns = list.filter(c => !isCustomTypeId(c));
    if (builtIns.length) return list;
    return [...ALL_PII_CATEGORY_IDS, ...new Set(list.filter(isCustomTypeId))];
}

/**
 * Categories for a scan in an org context that used to pass `null` (every
 * built-in): every built-in, plus the org's custom types that are switched on
 * for the AI or blocked for this tool class. `null` when the org has none,
 * which keeps those scans exactly as they were.
 * @param {any} shield  a resolved shield
 * @param {'external'|'internal'|null} [toolClass]  null = both classes
 * @returns {string[]|null}
 */
function scanCategoriesFor(shield, toolClass = null) {
    const detect = Array.isArray(shield?.piiDetectionCategories) ? shield.piiDetectionCategories : [];
    const classes = toolClass ? [toolClass] : ['external', 'internal'];
    const block = classes.flatMap(c => shield?.toolPiiPolicy?.[c]?.blockCategories || []);
    const custom = [...new Set([...detect, ...block].filter(isCustomTypeId))];
    if (!custom.length) return null;
    return [...ALL_PII_CATEGORY_IDS, ...custom];
}

// Combined matchers per set of types, reused while the types do not change.
const COMPILED_MAX = 64;
const _compiled = new Map();
function _compiledFor(types, key) {
    const hit = _compiled.get(key);
    if (hit) { _compiled.delete(key); _compiled.set(key, hit); return hit; }
    const c = compileTypes(types);
    if (_compiled.size >= COMPILED_MAX) _compiled.delete(_compiled.keys().next().value);
    _compiled.set(key, c);
    return c;
}

/**
 * @param {string[]} categories
 * @param {{ customTypes?: any[] }} [opts]  customTypes: resolve ids against
 *   these instead of the registry (the bench and tests)
 * @returns {Promise<null | {
 *   builtIns: string[], ids: string[], unknown: string[], conflicted: string[], nodeTypes: any[], aiTypes: any[],
 *   compiled: any, digest: string, labelFor: (id: string) => string,
 *   methodFor: (id: string) => string|null, orderFor: (id: string) => number }>}
 */
async function planScan(categories, opts = {}) {
    if (!hasCustomIds(categories)) return null;
    const builtIns = categories.filter(c => !isCustomTypeId(c));
    const ids = [...new Set(categories.filter(isCustomTypeId))];

    /** @type {(id: string) => ({ type: any, order: number } | null)} */
    let resolve;
    if (Array.isArray(opts.customTypes)) {
        const byId = new Map();
        opts.customTypes.forEach((t, order) => { if (t && isCustomTypeId(t.id) && !byId.has(t.id)) byId.set(t.id, { type: t, order }); });
        resolve = (id) => byId.get(id) || null;
    } else {
        resolve = (id) => registry.lookup(id);
        // A conflicted id (listed by two orgs) is unresolvable on purpose;
        // re-reading every shield would not change that.
        if (ids.some(id => !registry.lookup(id) && !registry.isConflicted(id))) await registry.refreshAll();
    }

    const unknown = [];
    const conflicted = [];
    const found = [];
    for (const id of ids) {
        const hit = resolve(id);
        if (!hit) { (!opts.customTypes && registry.isConflicted(id) ? conflicted : unknown).push(id); continue; }
        // A type saved red (`status: 'invalid'`) is known and switched off.
        if (hit.type.status === 'invalid') continue;
        found.push(hit);
    }
    found.sort((a, b) => a.order - b.order);
    const types = found.map(f => f.type);
    const nodeTypes = types.filter(t => t.method === 'words' || t.method === 'pattern');
    const aiTypes = types.filter(t => t.method === 'ai');
    // Registry entries carry their digest; types passed in are digested here.
    const digestOf = (hit) => hit.digest || specDigest(hit.type);
    const byId = new Map(found.map(f => [f.type.id, f]));
    const nodeKey = nodeTypes.map(t => digestOf(byId.get(t.id))).join('|');
    const compiled = _compiledFor(nodeTypes, nodeKey);
    const digest = sha256(ids.slice().sort().map((id) => {
        const hit = resolve(id);
        return hit ? `${id}:${digestOf(hit)}:${hit.order}` : `${id}:unknown`;
    }).join(',')).slice(0, 16);

    const typeOf = new Map(found.map(f => [f.type.id, f]));
    return {
        builtIns,
        ids,
        unknown,
        conflicted,
        nodeTypes,
        aiTypes,
        compiled,
        digest,
        labelFor: (id) => typeOf.get(id)?.type?.name || registry.displayNameFor(id),
        methodFor: (id) => typeOf.get(id)?.type?.method || null,
        orderFor: (id) => (typeOf.has(id) ? /** @type {any} */ (typeOf.get(id)).order : Number.MAX_SAFE_INTEGER),
    };
}

function _resetPlanCache() { _compiled.clear(); }

module.exports = { planScan, hasCustomIds, withBuiltinDefault, scanCategoriesFor, _resetPlanCache };
