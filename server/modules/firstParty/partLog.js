// @typecheck strict
/**
 * The server log for a composition part file (firstParty/<id>.<part>.js), loaded on first use.
 *
 * A composition and its parts load in every process that lists the modules: the server, but
 * also the preload of every test process (testUtils/registerFeatures.js). So a part file
 * requires nothing at load but the parts helper, the registration channels and this file:
 * anything else it would pull into the require cache before a test has put its doubles there
 * (modules/firstParty/compositions.test.js holds that). The log is the one thing rows need
 * outside a function body, hence this stand-in; everything else a row requires where it runs.
 */

'use strict';

/** @returns {import('./contract').Log} */
const real = () => require('../../telemetry/log');

/** @type {import('./contract').Log} */
module.exports = {
    info: (...args) => real().info(...args),
    warn: (...args) => real().warn(...args),
    error: (...args) => real().error(...args),
};
