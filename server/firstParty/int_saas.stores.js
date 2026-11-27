// @typecheck strict
/**
 * The store schemas of the module "int_saas" (part of firstParty/int_saas.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * storeModules.js STORE_MODULES; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'githubSyncStore', file: './stores/githubSyncStore' },
];

module.exports = { stores };
