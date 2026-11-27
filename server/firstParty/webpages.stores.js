// @typecheck strict
/**
 * The store schemas and loose migrations of the module "webpages" (part of
 * firstParty/webpages.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES and boot/bootMigrations.js
 * LOOSE_MIGRATIONS; their order stays the core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    { name: 'webpageSchema', file: './stores/webpage/schema' },
    { name: 'webpagePublicShareStore', file: './stores/webpagePublicShareStore' },
];

/** @type {string[]} */
const migrations = [
    // W2: webpages.published_version_id + webpage_versions.source, plus a
    // snapshot+pointer for every page that WAS published. Without this backfill
    // the read path falls back for those pages to the LIVE row — org readers
    // then see work that the owner never published.
    'webpage-published-version-2026-09',
];

module.exports = { stores, migrations };
