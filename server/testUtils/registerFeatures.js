// @typecheck strict
/**
 * Test preload: fills core's feature registries the way index.js does
 * (boot/featureModules.js -> core/featureModules.js, and
 * integrations/integrationClients.js -> core/integrations/integrationClients.js),
 * so a test that drives code reaching a feature module or a provider client by
 * name finds it. scripts/run-tests.mjs passes
 * it as `--require` to every test file; a test run by hand
 * (`node --test x.test.js`) that needs it requires boot/featureModules.js
 * itself, or runs `node --test --require ./testUtils/registerFeatures.js x.test.js`.
 *
 * Only getters are registered: nothing below loads until a lookup asks for it.
 */

'use strict';

// The module-roots resolver first, so the registrations below see every root (and, in core
// mode, not the hidden modules). scripts/run-tests.mjs also passes it through NODE_OPTIONS;
// requiring it twice is harmless.
require('../moduleRoots.cjs');
require('../boot/featureModules');
require('../integrations/integrationClients');
