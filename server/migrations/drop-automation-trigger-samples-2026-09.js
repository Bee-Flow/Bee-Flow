#!/usr/bin/env node
/**
 * Migration: drop `automation_trigger_samples` (BFSF-440).
 *
 * automation-extras-2026-06 created it as the home of a "trigger sample vault"
 * (server/automation/sampleVault.js). The vault's four functions were stubs,
 * nothing ever called them, and the module was deleted — a trigger's or a
 * step's pinned sample has always lived on the node itself, as `pinnedOutput`
 * in `automations.definition_json`. The table never had a writer, so there is
 * no data to lose; what it did have was the power to send the next
 * investigation down the wrong storage path.
 *
 * The index (idx_trigger_samples_automation) and the FK added by
 * automation-fk-cascade-2026-06 (fk_trigger_samples_automation) belong to the
 * table and go with it. No CASCADE: nothing may depend on this table, and if
 * something ever did the drop should fail loudly rather than take it along.
 *
 * Registered at the END of the automationStore ladder (stores/automationStore/
 * core.js), the same ladder that used to create the table, so every store init
 * converges on "no table". Both CREATE statements are gone from the older
 * migrations; a replay cannot bring it back.
 *
 * Idempotent: probes first, so a re-run (or an install that never had the
 * table) is a no-op and says so.
 *
 * Manual usage: `node server/migrations/drop-automation-trigger-samples-2026-09.js`
 */

const TABLE = 'automation_trigger_samples';

/**
 * @param {{ db?: { getOne: Function, exec: Function } }} [deps]  the db facade; injected by tests
 * @returns {Promise<{ dropped: boolean }>}
 */
async function up({ db = require('../db') } = {}) {
    const probe = await db.getOne(`SELECT to_regclass('public.${TABLE}') AS oid`);
    if (!probe?.oid) return { dropped: false };
    await db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    console.log(`[Migration] drop-automation-trigger-samples-2026-09: dropped ${TABLE}`);
    return { dropped: true };
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
