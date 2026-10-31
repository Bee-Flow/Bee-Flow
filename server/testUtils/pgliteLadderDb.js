// @typecheck strict
/**
 * The WHOLE schema on a PGlite, behind the real db.js facade, for a test that
 * needs every table the product creates — not one store's DDL.
 *
 * migrateDb.integration.test.js proves the boot ladder (runMigrations) itself
 * on this same mock; this helper is that mock as a reusable seam, so a test
 * about what exists in the full schema (the account-erasure footprint) can run
 * the ladder once and then ask information_schema.
 *
 *   const { rawQuery, runLadder, close } = usePgliteLadder();
 *   before(async () => { await runLadder(); });
 *   after(close);
 *
 * Must be called BEFORE anything requires `db.js` (the mock replaces the
 * module in require.cache), which is why it is a function and not a side
 * effect of the require.
 */

'use strict';

const path = require('node:path');
const Module = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('./pglitePool');
const { bestEffort } = require('../utils/bestEffort');

const SERVER = path.join(__dirname, '..');

/**
 * @param {string} absId
 * @param {Record<string, unknown>} exportsObj
 */
function mock(absId, exportsObj) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exportsObj;
    m.loaded = true;
    require.cache[p] = m;
}

function usePgliteLadder() {
    // supportInboxStore refuses to initialise without the key that encrypts
    // mailbox OAuth tokens; the ladder runs it, so a test key is supplied.
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-session-secret-0123456789abcdef';

    const pg = new PGlite();
    const pgQuery = pgliteQuery(pg);
    /** @param {string} sql @param {unknown[]} [params] */
    const rawQuery = (sql, params) => pgQuery(sql, params);
    const client = { query: rawQuery, release: () => {} };

    mock(path.join(SERVER, 'db.js'), {
        pool: { query: rawQuery, connect: async () => client, end: async () => {} },
        run: rawQuery,
        getOne: async (/** @type {string} */ sql, /** @type {unknown[] | undefined} */ params) => (await rawQuery(sql, params)).rows[0] || null,
        getAll: async (/** @type {string} */ sql, /** @type {unknown[] | undefined} */ params) => (await rawQuery(sql, params)).rows,
        exec: (/** @type {string} */ sql) => rawQuery(sql, []),
        getClient: async () => client,
        withTransaction: async (/** @type {(c: typeof client) => Promise<unknown>} */ fn) => {
            await client.query('BEGIN');
            try {
                const out = await fn(client);
                await client.query('COMMIT');
                return out;
            } catch (e) {
                await client.query('ROLLBACK').catch((err) => bestEffort('testUtils/pgliteLadderDb:rollback', err)); // already aborted
                throw e;
            }
        },
        makeStoreInit: (/** @type {string} */ _tag, /** @type {() => Promise<unknown>} */ schemaFn) => {
            /** @type {Promise<unknown> | null} */
            let promise = null;
            return function ensureInit() {
                if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
                return promise;
            };
        },
        getRedis: () => null,
        redisHealthy: () => false,
        disconnectRedis: async () => {},
        getPoolStats: () => ({}),
        isSqlStateError: (/** @type {{ code?: unknown } | null | undefined} */ e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
    });

    const quiet = /** @type {Console} */ (/** @type {unknown} */ ({ log: () => {}, warn: () => {}, error: () => {} }));

    /** Run the real boot ladder once; throws when any rung fails. */
    async function runLadder() {
        const { runMigrations } = require('../migrateDb');
        const report = await runMigrations({ log: quiet });
        if (report.failed.length) {
            throw new Error('ladder failed: ' + report.failed.map((/** @type {{ name: string, error: string }} */ f) => `${f.name}: ${f.error}`).join('; '));
        }
        return report;
    }

    return { pg, rawQuery, runLadder, close: () => pg.close() };
}

module.exports = { usePgliteLadder };
