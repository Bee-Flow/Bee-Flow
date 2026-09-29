/**
 * The storage envelope for ONE datatable tenant, and the single check that
 * enforces it.
 *
 * ── WHY THESE ARE NOT dataModel/vocabulary's DATA_LIMITS ────────────
 * `DATA_LIMITS.MAX_TABLES_PER_APP` is named, documented and sized for ONE App
 * Studio app. Spending it as a per-organisation cap for datatables meant a
 * shared workspace and a single app answered to the same number for two
 * different questions, and neither could move without moving the other.
 * `MAX_ROWS_PER_APP` and `MAX_DB_BYTES` had the mirror problem: they were
 * declared and inert on this path, so one organisation could grow the shared
 * `beeflow_core` volume without bound — nothing anywhere read `size_bytes`.
 *
 * ── ONE CHECK, TWO CALLERS ──────────────────────────────────────────
 * routes/datatables.js and core/automationRunner/execDatatable.js both call
 * assertDatatableQuota. Two copies of the arithmetic is two things that can
 * disagree about whether a table is full, and the copy that says "no" is the
 * one nobody notices is missing: the row cap was enforced only on the manual
 * HTTP add, so a nightly routine wrote past it for as long as it liked.
 *
 * ── WHAT IS MEASURED, AND HOW FRESH IT IS ───────────────────────────
 * Rows come from `datatables.row_count` — maintained by arithmetic
 * (bumpAfterWrite) so a write never takes a lock, and re-synced against
 * COUNT(*) by jobs/datatableRetention. Bytes come from
 * `datatable_models.size_bytes`, which the same sweep refreshes from the live
 * schema size. Both are therefore approximate between sweeps, and deliberately
 * so: a live COUNT(*) or pg_total_relation_size on every row write would put a
 * full-table scan on the hot path to save a cap from being a few hundred rows
 * out.
 */

'use strict';
const log = require('../../telemetry/log');

/**
 * The envelope. Rows and bytes are per SCOPE (an organisation, or one account's
 * personal tables) because that is the unit of storage: one Postgres schema,
 * one model document, one row in `datatable_models`.
 */
const DATATABLE_LIMITS = Object.freeze({
    MAX_TABLES_PER_SCOPE: 50,
    MAX_ROWS_PER_TABLE: 100_000,
    MAX_ROWS_PER_SCOPE: 500_000,
    MAX_BYTES_PER_SCOPE: 256 * 1024 * 1024,
});

// Log an ops line from here on up, so a tenant that is about to be refused is
// visible BEFORE the refusal lands in somebody's nightly run. A cap that first
// speaks by breaking a working routine is a cap nobody could plan around.
const WARN_FRACTION = 0.9;

/**
 * The frozen quota refusal, copied from routes/studioAppData.js so a client
 * that handles one handles the other:
 *   409 { error, code:'quota_exceeded', limit, used }
 *
 * `errorClass` rides along for the runner, whose on_error branches match on
 * that rather than on an HTTP code — validate/constants.js promises authors a
 * datatable step "fails on … a quota", and until this existed it did not.
 */
function quotaError(message, { limit, used }) {
    const e = new Error(message);
    e.status = 409;
    e.code = 'quota_exceeded';
    e.errorClass = 'datatable_quota';
    e.limit = limit;
    e.used = used;
    return e;
}

function warn(what, used, limit) {
    if (used < limit * WARN_FRACTION) return;
    log.warn(`[datatableLimits] ${what}: ${used} of ${limit} (${Math.round((used / limit) * 100)}%)`);
}

/**
 * Refuse a write that would take a tenant outside its envelope.
 *
 * @param {{kind:'org'|'user', id:string}} scope
 * @param {object}  [opts]
 * @param {object}  [opts.table]      the `datatables` row being written to, for
 *                                    the per-table row cap. Omit for a create.
 * @param {number}  [opts.addRows]    rows this operation would add (0 for an
 *                                    update or a delete — neither can overflow).
 * @param {number}  [opts.addTables]  tables this operation would add.
 * @param {object}  [opts.usage]      pre-read usage, when the caller already
 *                                    holds it under a lock (createDatatable
 *                                    counts tables inside its own transaction,
 *                                    where the model row is FOR UPDATE-held —
 *                                    counting outside it let two replicas both
 *                                    see 49).
 * @throws a 409 quota error; returns the usage it read otherwise.
 */
async function assertDatatableQuota(scope, { table = null, addRows = 0, addTables = 0, usage = null } = {}) {
    // Lazily required: this module has to stay loadable in the runner suites
    // that stub the stores, and datatableStore opens a pg pool at load time.
    const datatableStore = require('../../stores/datatableStore');
    const used = usage || await datatableStore.scopeUsage(scope);

    if (addTables > 0) {
        warn('tables in scope', used.tables, DATATABLE_LIMITS.MAX_TABLES_PER_SCOPE);
        if (used.tables + addTables > DATATABLE_LIMITS.MAX_TABLES_PER_SCOPE) {
            throw quotaError(
                `This workspace already has ${used.tables} datatables (the limit is ${DATATABLE_LIMITS.MAX_TABLES_PER_SCOPE}).`,
                { limit: DATATABLE_LIMITS.MAX_TABLES_PER_SCOPE, used: used.tables },
            );
        }
    }

    if (addRows > 0) {
        const rowsHere = Math.max(0, Number(table?.rowCount) || 0);
        warn(`rows in "${table?.key || table?.id || '?'}"`, rowsHere, DATATABLE_LIMITS.MAX_ROWS_PER_TABLE);
        if (rowsHere + addRows > DATATABLE_LIMITS.MAX_ROWS_PER_TABLE) {
            throw quotaError(
                `The datatable "${table?.name || table?.key || 'this table'}" is full (${DATATABLE_LIMITS.MAX_ROWS_PER_TABLE} rows).`,
                { limit: DATATABLE_LIMITS.MAX_ROWS_PER_TABLE, used: rowsHere },
            );
        }
        warn('rows in scope', used.rows, DATATABLE_LIMITS.MAX_ROWS_PER_SCOPE);
        if (used.rows + addRows > DATATABLE_LIMITS.MAX_ROWS_PER_SCOPE) {
            throw quotaError(
                `This workspace holds ${used.rows} datatable rows (the limit is ${DATATABLE_LIMITS.MAX_ROWS_PER_SCOPE}).`,
                { limit: DATATABLE_LIMITS.MAX_ROWS_PER_SCOPE, used: used.rows },
            );
        }
    }

    // Bytes gate every WRITE, adds included — but never a read or a delete, so
    // emptying a table is how a tenant gets back under the ceiling.
    if (addRows > 0 || addTables > 0) {
        warn('bytes in scope', used.bytes, DATATABLE_LIMITS.MAX_BYTES_PER_SCOPE);
        if (used.bytes >= DATATABLE_LIMITS.MAX_BYTES_PER_SCOPE) {
            throw quotaError(
                `This workspace's datatables have reached their ${Math.round(DATATABLE_LIMITS.MAX_BYTES_PER_SCOPE / (1024 * 1024))} MB storage limit. Delete some rows to make room.`,
                { limit: DATATABLE_LIMITS.MAX_BYTES_PER_SCOPE, used: used.bytes },
            );
        }
    }

    return used;
}

module.exports = {
    DATATABLE_LIMITS,
    assertDatatableQuota,
    quotaError,
    WARN_FRACTION,
};
