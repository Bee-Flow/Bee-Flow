// @typecheck strict
/**
 * stores/memoryDeps.js — the dependencies of the split memory modules that sit
 * in the server's large import cycle: memoryCrypto, memoryIndex, the embed
 * provider target, and the store's one schema-init memo (initDB).
 *
 * stores/memoryStore.js installs them before it loads any of its sibling
 * modules (memorySchema, memoryEmbedding, memoryCrud, memoryReads,
 * memorySimilarity, memoryRecall, memoryStats). The barrel already sat in that
 * cycle; injecting through here keeps the split-out modules out of it
 * (scc-ratchet), the same way stores/notebook/deps.js does. Load the store
 * through stores/memoryStore, never one of those modules on its own.
 */

/** @type {Record<string, any>} */
const installed = {};

/** @param {Record<string, any>} deps */
function install(deps) {
    Object.assign(installed, deps);
}

/**
 * @param {string} name
 * @returns {any}
 */
function dep(name) {
    if (!(name in installed)) {
        throw new Error(`stores/memory: '${name}' is not installed; load the store through stores/memoryStore`);
    }
    return installed[name];
}

module.exports = { install, dep };
