// @typecheck strict
'use strict';
/**
 * The `config` table behind the REAL stores/configStore, for a test of code
 * that reads configuration (modelResolver, llmClient, providerConfig, the PII
 * gate, ...) and must not need Postgres.
 *
 * The seam is the pool object `db.js` already shares, the one
 * testUtils/routeHarness.js `recordDb()` records and testUtils/pglitePool.js
 * answers; nothing is put in the module cache, so the store runs its own code:
 * its JSON parsing, its cache, `getSecret`'s envelope handling.
 *
 *   const config = useConfigRows();                      // BEFORE the first require
 *   const { resolveModelForTierName } = require('./modelResolver');
 *   test.after(config.restore);
 *   test.beforeEach(config.reset);
 *
 *   config.rows.chat_model_tiers = { fast: { modelId: 'm' } };   // a row
 *   config.failOn('chat_model_tiers');                            // that key's query throws
 *
 * `rows` maps a key to the value as the code would have passed it to
 * setConfig (objects are stored as JSON, anything else as text); a key that is
 * not there has no row. Changing `rows` drops configStore's 60 s cache, so
 * the next read sees it. Writes (INSERT/UPDATE/DELETE) are recorded in
 * `writes` and otherwise ignored.
 */

const MISSING = Object.freeze({ rows: [], rowCount: 0 });

/** @param {unknown} value */
const encode = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));

function useConfigRows() {
    const db = require('../db');
    const saved = { query: db.pool.query, connect: db.pool.connect };
    /** @type {string[]} keys read from the table (a cache hit is not a read) */
    const reads = [];
    /** @type {Record<string, unknown>} */
    const table = {};
    /** @type {string | null} */
    let failing = null;
    /** @param {string} key */
    function read(key) {
        if (failing === key) throw new Error('database is down');
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    }
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    const writes = [];

    /**
     * @param {unknown} sql
     * @param {unknown} [params]
     */
    async function query(sql, params) {
        const text = typeof sql === 'string' ? sql : String(/** @type {any} */ (sql)?.text || '');
        const values = Array.isArray(params) ? params : [];
        if (/^\s*SELECT\s+value\s+FROM\s+config\s+WHERE\s+key\s*=\s*\$1/i.test(text)) {
            const key = String(values[0]);
            reads.push(key);
            const value = read(key);
            return value === undefined ? MISSING : { rows: [{ value: encode(value) }], rowCount: 1 };
        }
        if (/^\s*SELECT\s+key,\s*value\s+FROM\s+config\s+WHERE\s+key\s*=\s*ANY/i.test(text)) {
            const rows = [];
            for (const key of /** @type {string[]} */ (values[0] || [])) {
                reads.push(key);
                const value = read(key);
                if (value !== undefined) rows.push({ key, value: encode(value) });
            }
            return { rows, rowCount: rows.length };
        }
        if (/^\s*SELECT\s+key,\s*value\s+FROM\s+config\s*$/i.test(text)) {
            const all = Object.keys(table).map((key) => ({ key, value: encode(table[key]) }));
            return { rows: all, rowCount: all.length };
        }
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)) writes.push({ sql: text, params: values });
        return MISSING;
    }
    db.pool.query = /** @type {any} */ (query);
    db.pool.connect = /** @type {any} */ (async () => ({ query, release() {} }));
    // After the pool is ours: configStore runs a re-encryption scan when it loads.
    const { _applyInvalidation } = require('../stores/configStore');

    const flush = () => _applyInvalidation('');
    const rows = new Proxy(table, {
        set(_t, key, value) { table[/** @type {string} */ (key)] = value; flush(); return true; },
        deleteProperty(_t, key) { delete table[/** @type {string} */ (key)]; flush(); return true; },
    });

    let restored = false;
    return {
        rows,
        reads,
        writes,
        /** The query for this key fails, as it does when the database is down; null clears it. */
        failOn(/** @type {string | null} */ key) { failing = key; flush(); },
        /** Back to an empty table, nothing failing, nothing recorded. */
        reset() { for (const k of Object.keys(table)) delete table[k]; failing = null; reads.length = 0; writes.length = 0; flush(); },
        restore() {
            if (restored) return;
            restored = true;
            db.pool.query = saved.query;
            db.pool.connect = saved.connect;
            _applyInvalidation('');
        },
    };
}

module.exports = { useConfigRows };
