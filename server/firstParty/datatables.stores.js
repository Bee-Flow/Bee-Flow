// @typecheck strict
/**
 * The store schemas of the module "datatables" (part of firstParty/datatables.js,
 * see modules/firstParty/parts.js). The row was the module's entry of
 * storeModules.js STORE_MODULES; its order stays the core's
 * (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // Org-scoped datatables: the metadata, sharing grants and dependents
    // index. Owns its own DDL, so a standalone db:migrate must create the
    // tables too — otherwise they only appear on first datatable use.
    //
    // MUST stay AFTER automationStore: that store owns the migration ladder,
    // and datatable-schema-rename-2026-09 (which renames every per-tenant
    // Postgres schema) lives in it. Ordered the other way this file would touch
    // datatable rows under the pre-rename names first. The order index
    // (modules/firstParty/order.json) keeps it there although automation
    // requires datatables.
    { name: 'datatableStore', file: './stores/datatableStore' },
];

module.exports = { stores };
