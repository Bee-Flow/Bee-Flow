// @typecheck
/**
 * Feature modules: the few feature-owned modules core code calls, looked up by
 * name instead of required.
 *
 * Core may not require a feature (server/ARCHITECTURE.md), yet a chat turn has
 * to reach the workspace tools, a rendered PDF the headless browser, and the
 * tool dispatcher the automation step tools. boot/featureModules.js registers
 * each of those modules here as a GETTER (the module's path relative to
 * server/ is its name) and core asks for it where it needs it:
 *
 *   const { featureModule } = require('../featureModules');
 *   const browserProvider = featureModule('services/browserProvider');
 *
 * The getter is called on every lookup, so the module behind it loads on first
 * use and a test's require.cache stub of it is what a lookup returns. Same
 * shape as core/integrations/integrationClients.js (provider clients) and
 * core/automationRunner/featurePorts.js (the runner's ports); this one is for
 * "the module itself", where there is no narrower port worth naming.
 *
 * index.js loads boot/featureRegistrations.js, which loads the registration. A
 * test that drives a code path through one of these loads
 * boot/featureModules.js itself.
 */

'use strict';

/** name -> () => module */
const getters = new Map();

/** Register (or replace) modules: `{ 'services/browserProvider': () => require(...), ... }`. */
function registerFeatureModules(map) {
    for (const [name, get] of Object.entries(map || {})) {
        if (typeof get !== 'function') throw new TypeError(`registerFeatureModules(${name}): a module is registered as a getter function`);
        getters.set(name, get);
    }
}

/**
 * The module, or a thrown Error naming what was not loaded.
 * @param {string} name
 */
function featureModule(name) {
    const get = getters.get(name);
    if (!get) {
        throw new Error(`feature module "${name}" is not registered (boot/featureModules.js was not loaded)`);
    }
    return get();
}

/**
 * The registered getter (a test seam: testUtils/stubRequire.js swaps it and puts it back).
 * @param {string} name
 */
function _featureModuleGetter(name) {
    return getters.get(name);
}

function hasFeatureModule(name) {
    return getters.has(name);
}

/** Test seam: drop one module, or all of them. */
function _clearFeatureModulesForTests(name) {
    if (name) getters.delete(name);
    else getters.clear();
}

module.exports = { registerFeatureModules, featureModule, hasFeatureModule, _featureModuleGetter, _clearFeatureModulesForTests };
