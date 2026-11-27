// @typecheck strict
/**
 * The store schemas of the module "sanctions" (part of firstParty/sanctions.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * storeModules.js STORE_MODULES; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // The imported public sanctions lists (sanctions_lists, sanctions_entities,
    // sanctions_names): instance-wide, no FKs, filled by jobs/sanctionsListRefresh.mts.
    { name: 'sanctionsStore', file: './stores/sanctionsStore.mts' },
];

module.exports = { stores };
