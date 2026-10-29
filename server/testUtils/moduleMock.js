// @typecheck strict
'use strict';

/**
 * Put a double in the require cache for a module, before the module under test
 * is required (the route tests that call handlers directly do this for every
 * store they touch).
 *
 *   mockModule(path.join(SERVER, 'stores/automationStore'), { getAutomation: async () => null });
 */

const Module = require('module');

/**
 * @param {string} absId  an absolute module id (as `require.resolve` takes it)
 * @param {unknown} exports   what the module should export
 */
function mockModule(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

module.exports = { mockModule };
