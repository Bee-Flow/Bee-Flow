// @typecheck strict
/**
 * The store schemas and loose migrations of the module "automation" (part of
 * firstParty/automation.js, see modules/firstParty/parts.js). The rows were the
 * module's entries of storeModules.js STORE_MODULES and boot/bootMigrations.js
 * LOOSE_MIGRATIONS; their order stays the core's (modules/firstParty/order.json),
 * which is how datatableStore keeps coming after automationStore.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').StoreRow[]} */
const stores = [
    // §WS3.5 — automation-feature stores that own DDL (self-init on load). Without
    // these, a standalone `npm run db:migrate` (CI / pre-deploy) did NOT bring the
    // automation schema current — it only worked because the app self-inits on boot.
    { name: 'automationStore', file: './stores/automationStore' },
    // Test data of Automations (test cases and their captured run inputs, golden
    // runs, form scenarios). Foreign keys to `automations` and `automation_runs`,
    // so it comes right after automationStore; its init also awaits that
    // store's, because boot starts every init at once.
    { name: 'automationTestingStore', file: './stores/automationTestingStore' },
    { name: 'automationUsageStore', file: './stores/automationUsageStore' },
];

/** @type {string[]} */
const migrations = [
    // FRM-08: 'filled in by' belongs on a row that stays — a column on
    // automation_runs (90d retention), not on the 8-hour automation_form_sessions.
    'automation-form-submitter-2026-09',
    // Which agents may call an agent_call automation became a table
    // (automation_agent_bindings). Binds an active agent_call automation to the
    // agents its OWNER already chose per agent (config.tools.automations or a
    // persona hand-off); everything else stays unbound, so nothing gets wider.
    // Runs once: the ledger records it, and a marker table written together with
    // the inserts holds even when the ledger replays it (changed checksum,
    // unreadable ledger, --force), so an owner who unlinks an agent later never
    // gets it back. Throws while a table is missing, so the next boot retries.
    'automation-agent-bindings-backfill-2026-10',
];

module.exports = { stores, migrations };
