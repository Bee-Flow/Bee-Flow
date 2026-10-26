// @typecheck strict
/**
 * stores/lib/ddlLedgerTable.js — the schema ledger's table: `schema_migrations`,
 * shared with the boot ladder (boot/bootMigrations.js), plus the two DDL
 * columns the store schemas add (ddl_statements, ddl_tables). Creating it,
 * reading one unit's entry and recording it. The rules of what is skipped live
 * in ddlLedger.js.
 */

'use strict';

const log = require('../../telemetry/log');
const { statementKey, relationsIn } = require('./ddlStatements');

const LEDGER_TABLE = 'schema_migrations';

/** @typedef {(sql: string, params?: unknown[]) => Promise<{ rows?: any[] } | undefined>} LedgerQuery */

/** @type {Promise<void> | null} */
let _bootstrapping = null;

/**
 * Create the ledger table, or give an older one the two DDL columns. Shared
 * with boot/bootMigrations.js, which owns the same table for the migrations.
 * In-process concurrent callers share one attempt; it is not memoised beyond
 * that, so a test that swaps the database gets a table in the new one.
 *
 * @param {LedgerQuery} query
 */
function ensureLedgerTable(query) {
    if (!_bootstrapping) {
        _bootstrapping = (async () => {
            await query(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                checksum TEXT NOT NULL,
                ddl_statements TEXT[],
                ddl_tables JSONB
            )`);
            // A table from before the store schemas joined: ADD COLUMN takes a
            // lock even when the column exists, so only when one is missing.
            const have = await query(
                `SELECT count(*)::int AS n FROM pg_attribute
                  WHERE attrelid = to_regclass('${LEDGER_TABLE}')
                    AND attname IN ('ddl_statements', 'ddl_tables') AND NOT attisdropped`);
            if (Number(have?.rows?.[0]?.n) < 2) {
                await query(`ALTER TABLE ${LEDGER_TABLE}
                    ADD COLUMN IF NOT EXISTS ddl_statements TEXT[],
                    ADD COLUMN IF NOT EXISTS ddl_tables JSONB`);
            }
        })().finally(() => { _bootstrapping = null; });
    }
    return _bootstrapping;
}

/**
 * Make sure the ledger table (with its DDL columns) is there before a read or
 * write, with a query that cannot fail. That matters beyond tidiness: on a
 * database with one session (PGlite in the tests) a failing ledger query would
 * land inside another store's open runDdl transaction and abort it. Asked per
 * unit, not memoised: one catalog lookup is cheap, and a memo would be wrong
 * after a test swapped the database underneath the pool.
 *
 * @param {LedgerQuery} query
 */
async function _ensureReady(query) {
    const res = await query(
        `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS t,
                (SELECT count(*)::int FROM pg_attribute
                  WHERE attrelid = to_regclass('${LEDGER_TABLE}')
                    AND attname IN ('ddl_statements', 'ddl_tables') AND NOT attisdropped) AS n`);
    const row = res?.rows?.[0];
    if (!row?.t || Number(row.n) < 2) await ensureLedgerTable(query);
}

/**
 * Run a ledger query once the table is known to be there.
 *
 * @param {LedgerQuery} query
 * @param {string} sql
 * @param {unknown[]} params
 */
async function _ledgerQuery(query, sql, params) {
    await _ensureReady(query);
    return query(sql, params);
}

const LOAD_SQL = `
    SELECT m.ddl_statements AS statements,
           NOT EXISTS (
               SELECT 1 FROM jsonb_each_text(COALESCE(m.ddl_tables, '{}'::jsonb)) t
                WHERE to_regclass(t.key)::oid::text IS DISTINCT FROM t.value
           ) AS intact
      FROM ${LEDGER_TABLE} m
     WHERE m.name = $1`;

/**
 * The statement keys recorded for `unit`, empty when there is no entry or
 * when one of its tables is no longer the table it recorded.
 *
 * @param {LedgerQuery} query
 * @param {string} unit
 * @returns {Promise<Set<string>>}
 */
async function loadUnit(query, unit) {
    const res = await _ledgerQuery(query, LOAD_SQL, [unit]);
    const row = res?.rows?.[0];
    if (!row || !Array.isArray(row.statements)) return new Set();
    if (row.intact === false) {
        log.info(`[DdlLedger] ${unit}: a table it recorded was dropped or replaced since, so its whole schema runs again`);
        return new Set();
    }
    return new Set(row.statements.map(String));
}

const RECORD_SQL = `
    INSERT INTO ${LEDGER_TABLE} (name, checksum, applied_at, ddl_statements, ddl_tables)
    SELECT $1, $2, now(), $3::text[],
           COALESCE((SELECT jsonb_object_agg(t, to_regclass(t)::oid::text) FROM unnest($4::text[]) t), '{}'::jsonb)
    ON CONFLICT (name) DO UPDATE SET
        checksum = EXCLUDED.checksum, applied_at = now(),
        ddl_statements = EXCLUDED.ddl_statements, ddl_tables = EXCLUDED.ddl_tables`;

/**
 * Record what `unit` applied: the statement keys, a checksum over them, and
 * the OID of every relation the statements name.
 *
 * @param {LedgerQuery} query
 * @param {string} unit
 * @param {Map<string, string>} applied  key -> statement text
 */
async function recordUnit(query, unit, applied) {
    const keys = [...applied.keys()].sort();
    const checksum = statementKey(keys.join('\n'));
    const tables = relationsIn(applied.values());
    await _ledgerQuery(query, RECORD_SQL, [unit, checksum, keys, tables]);
}

module.exports = { LEDGER_TABLE, ensureLedgerTable, loadUnit, recordUnit };
