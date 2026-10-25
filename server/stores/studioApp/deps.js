// @typecheck strict
/**
 * stores/studioApp/deps.js — what the studio-app modules get from the barrel
 * instead of requiring it themselves: the db handle, the logger, and the
 * collaborators the store always required lazily (per-app database, storage,
 * automation-usage index, managed-write guard, project membership, engine
 * flag, the column migrations).
 *
 * stores/studioAppStore.js installs them before it loads any studioApp
 * module, with the same require strings from the same place as before the
 * split, so a test that intercepts '../db', './storageStore' or
 * '../auth/projectAccess' by request string still reaches every query and
 * call, and the lazy requires stay lazy and stay out of the import graph of
 * these modules (scc-ratchet). Load the store through stores/studioAppStore,
 * never a studioApp module on its own.
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
        throw new Error(`stores/studioApp: '${name}' is not installed; load the store through stores/studioAppStore`);
    }
    return installed[name];
}

module.exports = { install, dep };
