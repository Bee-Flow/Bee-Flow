// @typecheck
'use strict';
/**
 * Moved: the static route-surface sweep is test-only code and lives in
 * testUtils/routeSurfaceSweep.js. This re-export keeps the old path working
 * for imports that still use it; new code requires testUtils/routeSurfaceSweep.
 */
module.exports = require('../testUtils/routeSurfaceSweep');
