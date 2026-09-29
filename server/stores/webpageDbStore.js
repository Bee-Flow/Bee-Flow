// @typecheck
/**
 * Webpage DB Store — per-webpage SQLite database engine. Config wrapper over
 * stores/lib/sqliteBlobEngine (the studio-app store was forked from this file;
 * the shared engine now owns the single hardened implementation).
 *
 * Each webpage has at most one SQLite database file (`data.db`) stored as a
 * blob in RustFS at the same prefix as the script files. The engine owns the
 * live better-sqlite3 handles, LRU eviction, and the debounced sha256-gated
 * flush back to RustFS + webpages.db_sha256/db_size metadata.
 *
 * Authorization is the caller's responsibility — this module never reaches
 * back to req.session. The userId argument is treated as a trust boundary:
 * the caller must have already verified the user owns the webpage. The engine
 * refuses to serve a cached handle to a different userId.
 */

const path = require('path');
const os = require('os');

const storageStore = require('./storageStore');
const { run } = require('../db');
const { createSqliteBlobEngine } = require('./lib/sqliteBlobEngine');

const engine = createSqliteBlobEngine({
    workDir: process.env.WEBPAGE_DB_WORK_DIR || path.join(os.tmpdir(), 'beeflow-webpage-dbs'),
    // 'db' is the storage slot for the current data.db blob (absorbs the old
    // module-level DB_SLOT constant).
    buildKey: (userId, webpageId) => storageStore.buildWebpageKey(userId, webpageId, 'db'),
    metaTable: 'webpages',
    logPrefix: 'WebpageDB',
    entityLabel: 'Webpage DB',
    storage: storageStore,
    runQuery: run,
});

module.exports = {
    query: engine.query,
    exec: engine.exec,
    batch: engine.batch,
    schema: engine.schema,
    reset: engine.reset,
    flush: engine.flush,
    invalidate: engine.invalidate,
    closeAll: engine.closeAll,
    // Test-only
    _handles: engine._handles,
    _normalizeParams: engine._normalizeParams,
};
