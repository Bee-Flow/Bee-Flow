'use strict';

// Graph reads can exceed PostgreSQL's idle-in-transaction timeout. Hold a
// session lock on a dedicated connection, without a long open transaction.
async function withAzureSyncLock(fn, pool = require('../db').pool) {
    const client = await pool.connect();
    let locked = false;
    let releaseError;
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('beeflow:azure-directory-sync'))");
        locked = true;
        return await fn();
    } finally {
        if (locked) {
            try { await client.query("SELECT pg_advisory_unlock(hashtext('beeflow:azure-directory-sync'))"); }
            catch (err) { releaseError = err; }
        }
        // Destroy a connection if unlocking failed: never return a held lock
        // to the pool, where unrelated requests could keep it indefinitely.
        client.release(releaseError);
    }
}
module.exports = { withAzureSyncLock };
