// @typecheck strict
/**
 * The store schemas of the module "templates" (part of firstParty/templates.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * storeModules.js STORE_MODULES; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'templateStore', file: './stores/templateStore' },
];

module.exports = { stores };
