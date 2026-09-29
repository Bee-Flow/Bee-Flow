// @typecheck
/**
 * Watcher State Store — PostgreSQL-backed state tracking for file watchers
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const initDB = makeStoreInit('WatcherStateStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS watcher_states (
            watcher_id TEXT PRIMARY KEY,
            items_json TEXT NOT NULL,
            last_check TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

/**
 * Get the previous state for a watcher
 * @param {string} watcherId
 * @returns {Promise<{ items: Object, lastCheck: string } | null>}
 */
async function getWatcherState(watcherId) {
    await initDB();
    const row = await getOne('SELECT items_json, last_check FROM watcher_states WHERE watcher_id = $1', [watcherId]);
    if (!row) return null;
    try {
        return {
            items: JSON.parse(row.items_json),
            lastCheck: row.last_check
        };
    } catch (e) {
        log.error('Failed to parse watcher state:', e);
        return null;
    }
}

/**
 * Save the current state for a watcher
 * @param {string} watcherId
 * @param {Object} items
 */
async function saveWatcherState(watcherId, items) {
    await initDB();
    try {
        await run(`
            INSERT INTO watcher_states (watcher_id, items_json, last_check, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT(watcher_id) DO UPDATE SET
                items_json = EXCLUDED.items_json,
                last_check = EXCLUDED.last_check,
                updated_at = NOW()
        `, [watcherId, JSON.stringify(items), new Date().toISOString()]);
    } catch (e) {
        log.error('Failed to save watcher state:', e);
    }
}

/**
 * Delete watcher state
 * @param {string} watcherId
 */
async function deleteWatcherState(watcherId) {
    await initDB();
    await run('DELETE FROM watcher_states WHERE watcher_id = $1', [watcherId]);
}

/**
 * Get all watcher states (for debugging)
 */
async function getAllWatcherStates() {
    await initDB();
    const rows = await getAll('SELECT watcher_id, items_json, last_check, updated_at FROM watcher_states');
    return rows.map(row => ({
        watcherId: row.watcher_id,
        items: JSON.parse(row.items_json),
        lastCheck: row.last_check,
        updatedAt: row.updated_at
    }));
}

module.exports = {
    getWatcherState,
    saveWatcherState,
    deleteWatcherState,
    getAllWatcherStates
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
