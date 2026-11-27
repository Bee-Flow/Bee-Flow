// @typecheck strict
/**
 * The store schemas and loose migrations of the module "support" (part of
 * firstParty/support.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES and boot/bootMigrations.js
 * LOOSE_MIGRATIONS; their order stays the core's (modules/firstParty/order.json).
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // Support studio stores own DDL (threads/messages/audit-log + connected
    // mailboxes incl. the new shared_groups ACL column). Without these a
    // standalone `npm run db:migrate` would not bring the support schema current.
    { name: 'supportStore', file: './stores/supportStore' },
    { name: 'supportInboxStore', file: './stores/supportInboxStore' },
];

/** @type {string[]} */
const migrations = [
    // Backfills support_audit_log from the legacy support_thread_events.
    'support-audit-log-backfill-2026-06',
];

module.exports = { stores, migrations };
