// @typecheck
/**
 * Late-bound ports: three lower modules call back into a higher one through a
 * setter instead of a require, to keep the import graph acyclic. The higher
 * module registers itself when it loads, but nothing guarantees it loads before
 * the first call. Registering lazy wrappers here, at boot, removes that
 * load-order dependency: the target loads on first use.
 *
 *   core/tools/automationExecutorPort.js   <- core/automationRunner.js
 *   core/privacy/customTypes/registry.js   <- core/privacy/orgShield.js
 *   stores/configStore.js (legacy secrets) <- stores/integrationConnectionStore.js
 */

'use strict';

require('../core/tools/automationExecutorPort')
    .setAutomationExecutor((...args) => require('../core/automationRunner').executeAutomation(...args));
require('../core/privacy/customTypes/registry')
    .setOrgShieldResolver((orgId) => require('../core/privacy/orgShield').resolveOrgShield(orgId));
require('../stores/configStore')
    .setLegacySecretResolver((...args) => require('../stores/integrationConnectionStore').getLegacySecretValue(...args));
