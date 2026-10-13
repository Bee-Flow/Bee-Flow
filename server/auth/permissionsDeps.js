// @typecheck
/**
 * Permissions — the collaborators that sit in the server's big import cycle
 * (stores/userStore, auth/orgScope, auth/orgRolePolicy, auth/microsoftSession,
 * stores/authConfigStore).
 *
 * The auth/permissions*.js modules never require them themselves: the
 * permissions.js barrel owns those require() calls and wires them in here, so
 * none of the split modules joins that cycle and it does not grow
 * (scc-ratchet). The barrel keeps the monolith's timing: userStore and orgScope
 * are required when the barrel loads, the others at call time.
 *
 * Requires nothing.
 */

'use strict';

/** @type {Record<string, () => any>} */
const _wired = Object.create(null);

/**
 * Called once by the permissions.js barrel with { name: () => module }.
 * @param {Record<string, () => any>} getters
 */
function wireDeps(getters) { Object.assign(_wired, getters); }

/**
 * The wired collaborator `name` (its getter called now).
 * @param {string} name
 * @returns {any}
 */
function dep(name) {
    const get = _wired[name];
    if (!get) throw new Error(`permissions dependency not wired: ${name} (import auth/permissions.js, not a split module)`);
    return get();
}

module.exports = { wireDeps, dep };
