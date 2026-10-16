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

const SERVER = path.join(__dirname, '..');

function serverStubber() {
    return (rel, exportsObj) => preloadStubs(require, { [path.join(SERVER, rel)]: exportsObj });
}

module.exports = { serverStubber };
