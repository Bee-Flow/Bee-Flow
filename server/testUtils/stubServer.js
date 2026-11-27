// @typecheck strict
'use strict';

/**
 * Stubbing a server module by its path under server/ (testUtils/stubRequire's
 * preloadStubs, rooted at the server): every importer, whatever relative string
 * it uses, gets the stub. Install before the first require of the code under test.
 *
 *   const mock = serverStubber();
 *   mock('stores/automationStore', { getRun: async () => null });
 */

const path = require('path');
const { preloadStubs } = require('./stubRequire');

// `rel` is a tree path: preloadStubs resolves the absolute path, and the resolver (installed
// here too, for a bare `node --test`) finds it in whichever root holds it after a module moved.
require('../moduleRoots.cjs');

const SERVER = path.join(__dirname, '..');

function serverStubber() {
    return (/** @type {string} */ rel, /** @type {Parameters<typeof preloadStubs>[1][string]} */ exportsObj) => preloadStubs(require, { [path.join(SERVER, rel)]: exportsObj });
}

module.exports = { serverStubber };
