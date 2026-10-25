// @typecheck strict
/**
 * Test preload: fills core's feature registries the way index.js does
 * (boot/featureModules.js, core/featureModules.js), so a test that drives core
 * code reaching a feature module by name finds it. scripts/run-tests.mjs passes
 * it as `--require` to every test file; a test run by hand
 * (`node --test x.test.js`) that needs it requires boot/featureModules.js
 * itself, or runs `node --test --require ./testUtils/registerFeatures.js x.test.js`.
 *
 * Only getters are registered: nothing below loads until a lookup asks for it.
 */

'use strict';

require('../boot/featureModules');
