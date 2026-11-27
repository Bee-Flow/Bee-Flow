// @typecheck strict
/**
 * A test double for a feature module, registered by NAME: the code under test looks the module
 * up (optionalFeatureModule, moduleData.lookupFeatureModule, moduleForDataDuty), so a double on a
 * require string would never be reached. Registered by name, the double answers with or without
 * the module that provides the name, which makes the "present" path testable in core mode.
 * Nothing here touches the module system: it is the registry's own seam (core/featureModules.js).
 *
 *   t.after(stubFeatureModule('stores/coworkStore', { resumeNeedsReauthForUser: async () => 0 }));
 */

'use strict';

const { registerFeatureModules, _featureModuleGetter, _clearFeatureModulesForTests } = require('../core/featureModules');

/**
 * Register `exportsObj` under `name`; restore() puts the previous getter back (or none).
 * @param {string} name a feature-module name (the tree path of the file, without extension)
 * @param {unknown} exportsObj the double
 * @returns {() => void} restore function (idempotent)
 */
function stubFeatureModule(name, exportsObj) {
    const previous = _featureModuleGetter(name);
    registerFeatureModules({ [name]: () => exportsObj });
    let restored = false;
    return function restore() {
        if (restored) return;
        restored = true;
        if (previous) registerFeatureModules({ [name]: previous });
        else _clearFeatureModulesForTests(name);
    };
}

module.exports = { stubFeatureModule };
