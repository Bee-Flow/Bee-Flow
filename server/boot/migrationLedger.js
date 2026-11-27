// @typecheck strict
'use strict';
/**
 * The ledger rows of the boot migration ladder (boot/bootMigrations.js): read
 * every recorded entry, record one that succeeded. The table is
 * `schema_migrations`, shared with the store schemas (stores/lib/ddlLedger.js,
 * rows named `store:<tag>`); stores/lib/ddlLedgerTable.js owns its DDL.
 * The database is required on first use, never at load.
 */

const { LEDGER_TABLE, ensureLedgerTable } = require('../stores/lib/ddlLedgerTable');

/**
 * name → {checksum, applied_at} for every recorded entry; creates the table on first use.
 * @returns {Promise<Map<string, { name: string, checksum: string, applied_at: unknown }>>}
 */
async function readLedger() {
    const db = require('../db');
    // One owner of the ledger table's own DDL: the store schemas record in it
    // too (stores/lib/ddlLedger.js, rows named `store:<tag>`).
    await ensureLedgerTable(typeof db.ledgerQuery === 'function' ? db.ledgerQuery : (/** @type {string} */ sql) => db.exec(sql));
    /** @type {Array<{ name: string, checksum: string, applied_at: unknown }>} */
    const rows = await db.getAll(`SELECT name, checksum, applied_at FROM ${LEDGER_TABLE}`);
    return new Map(rows.map((r) => [r.name, r]));
}

/**
 * @param {string} name
 * @param {string} checksum
 */
async function record(name, checksum) {
    await require('../db').run(
        `INSERT INTO ${LEDGER_TABLE} (name, checksum, applied_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
        [name, checksum]);
}

module.exports = { LEDGER_TABLE, readLedger, record };
