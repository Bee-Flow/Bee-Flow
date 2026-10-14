'use strict';
/**
 * Moved: the route test harness is test-only code and lives in
 * testUtils/routeHarness.js. This re-export keeps the old path working for
 * imports that still use it; new tests require testUtils/routeHarness.
 */
module.exports = require('../../testUtils/routeHarness');
