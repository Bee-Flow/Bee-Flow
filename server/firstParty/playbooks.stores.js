// @typecheck strict
/**
 * The store schemas of the module "playbooks" (part of firstParty/playbooks.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * storeModules.js STORE_MODULES; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // Studio Playbooks — phased AI builds (table → automation → fill → app → approvals).
    { name: 'playbookStore', file: './stores/playbookStore' },
];

module.exports = { stores };
