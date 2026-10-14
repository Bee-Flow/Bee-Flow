// @typecheck
/**
 * stores/notebook/deps.js — the dependencies of the notebook modules that sit
 * in the server's large import cycle: documentCrypto and the db handle it
 * wraps (every row read is opened the same way in every module),
 * documentSharing, and the lazily resolved projectRole and sharing/file
 * re-encryption helpers.
 *
 * stores/notebookStore.js installs them before it loads any notebook module.
 * The barrel already sat in that cycle; injecting through here keeps the
 * split-out modules out of it (scc-ratchet), the same way the triggerBus
 * split passes its cycle-bound pieces in. Load the store through
 * stores/notebookStore, never a notebook module on its own.
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
        throw new Error(`stores/notebook: '${name}' is not installed; load the store through stores/notebookStore`);
    }
    return installed[name];
}

module.exports = { install, dep };
