// @typecheck strict
/**
 * The store schemas and loose migrations of the module "cms" (part of
 * firstParty/cms.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES and boot/bootMigrations.js
 * LOOSE_MIGRATIONS; their order stays the core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'releaseNotesStore', file: './stores/releaseNotesStore' },
];

/** @type {string[]} */
const migrations = [
    // Website pages: the demo block and /demo links from "routines" to "automations".
    'cms-routine-demo-2026-10',
];

module.exports = { stores, migrations };
