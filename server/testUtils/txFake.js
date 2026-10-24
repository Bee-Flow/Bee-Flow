/**
 * `withTransaction` for a test fake of db.js, built on the fake's own
 * `getClient`: BEGIN, the callback, COMMIT (or ROLLBACK on a throw or on
 * `return rollback(v)`), release. Mirrors db.withTransaction without the pool.
 *
 *   const fakeDb = { getClient, ... };
 *   fakeDb.withTransaction = withTransactionVia(() => fakeDb.getClient());
 */
// What stores/lib/_ddl.js wraps around its statements once the fake offers withTransaction.
const DDL_CONTROL = /^\s*(SELECT pg_advisory_xact_lock|SET LOCAL lock_timeout|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/i;
const log = require('../telemetry/log');
const { TransactionRollback } = require('../txRollback');

function withTransactionVia(getClient) {
    return async (fn) => {
        const raw = await getClient();
        // A hermetic fake has no locks or savepoints; the schema-init DDL takes them
        // inside withTransaction as soon as the fake offers it.
        const client = {
            release: () => raw.release?.(),
            query: (sql, ...rest) => (typeof sql === 'string' && DDL_CONTROL.test(sql)
                ? Promise.resolve({ rows: [], rowCount: 0 })
                : raw.query(sql, ...rest)),
        };
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            if (result instanceof TransactionRollback) {
                await client.query('ROLLBACK');
                return result.value;
            }
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK').catch((err) => log.debug('rollback after a failed callback, the original error is rethrown', err));
            throw e;
        } finally {
            client.release?.();
        }
    };
}

module.exports = { withTransactionVia };
