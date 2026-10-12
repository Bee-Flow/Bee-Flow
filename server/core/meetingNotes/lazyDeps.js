// @typecheck
/**
 * A module's collaborators, loaded on first use and swappable in tests.
 *
 *   const { deps, init } = lazyDeps({
 *       configStore: () => require('../../stores/configStore'),
 *   });
 *   await deps.configStore.getConfig(key);
 *
 * `init(overrides)` replaces the named collaborators (and resets the rest to
 * the real ones). A key that is overridden is never loaded, so a test does not
 * drag in the database or the Graph client it stubbed out. This is the seam
 * the module-mock ratchet asks for instead of require-cache tricks.
 *
 * @template {Record<string, () => any>} L
 * @param {L} loaders
 * @returns {{ deps: { [K in keyof L]: ReturnType<L[K]> }, init: (overrides?: Partial<{ [K in keyof L]: ReturnType<L[K]> }>) => void }}
 */
function lazyDeps(loaders) {
    /** @type {Record<string, any>} */
    let overrides = {};
    /** @type {Record<string, any>} */
    const cache = {};
    const deps = /** @type {any} */ (new Proxy({}, {
        get(_target, key) {
            const name = String(key);
            if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
            if (!Object.prototype.hasOwnProperty.call(loaders, name)) return undefined;
            if (!Object.prototype.hasOwnProperty.call(cache, name)) cache[name] = loaders[name]();
            return cache[name];
        },
    }));
    return {
        deps,
        init(next = {}) { overrides = { ...next }; },
    };
}

module.exports = { lazyDeps };
