// @typecheck strict
/**
 * The store schemas of the module "custom_integrations" (part of
 * firstParty/custom_integrations.js, see modules/firstParty/parts.js). The row
 * was the module's entry of storeModules.js STORE_MODULES; its order stays the
 * core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'orgCustomIntegrationStore', file: './stores/orgCustomIntegrationStore' },
];

module.exports = { stores };
