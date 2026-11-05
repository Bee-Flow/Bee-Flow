// @typecheck strict
/**
 * A dependency object whose modules are required on first touch: the shape
 * the Studio aggregates (routes/studio/shared.js) and the adoption store
 * (stores/adoption/shared.js) build their injectable dependencies from, so a
 * router or a store can be constructed with test doubles and still require
 * nothing at module load in production.
 */

'use strict';

/**
 * @template {Record<string, () => any>} L
 * @param {L} loaders  name → require thunk
 * @returns {{ [K in keyof L]: ReturnType<L[K]> }}
 */
function makeLazyDeps(loaders) {
    /** @type {Record<string, any>} */
    const memo = {};
    const deps = {};
    for (const [name, load] of Object.entries(loaders)) {
        Object.defineProperty(deps, name, {
            enumerable: true,
            get() { if (!(name in memo)) memo[name] = load(); return memo[name]; },
        });
    }
    return /** @type {{ [K in keyof L]: ReturnType<L[K]> }} */ (deps);
}

module.exports = { makeLazyDeps };
