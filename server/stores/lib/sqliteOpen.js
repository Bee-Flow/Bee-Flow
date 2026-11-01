// @typecheck strict
'use strict';

/**
 * Opens a page database file the way every connection of the SQLite-blob
 * engine must, in the main process (the handle the flusher owns) and in the
 * statement process (./sqliteStatementChild.js) alike:
 *
 *   journal_mode = DELETE  keeps the database one self-contained file at rest
 *                          (no -wal/-shm sidecars to upload);
 *   foreign_keys = ON      the page's own constraints hold;
 *   max_page_count         a ceiling on the file: a statement that would grow
 *                          a page database past it fails with SQLITE_FULL
 *                          instead of filling the disk the whole fleet shares.
 *
 * The ceiling is SQLITE_MAX_PAGE_COUNT pages (SQLite's default page is 4 KiB,
 * so the default of 262144 is 1 GiB); 0 means unlimited. The blob is loaded
 * whole into memory on a cold open, which is the real reason a page database
 * must stay bounded.
 */

const Database = require('better-sqlite3');
const log = require('../../telemetry/log');

const DEFAULT_MAX_PAGE_COUNT = 262_144;

/** The configured ceiling in pages; 0 = unlimited. */
function maxPageCount() {
    const raw = process.env.SQLITE_MAX_PAGE_COUNT;
    if (raw === undefined || raw === '') return DEFAULT_MAX_PAGE_COUNT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_MAX_PAGE_COUNT;
}

/**
 * @param {string} localPath
 */
function openPageDatabase(localPath) {
    const db = new Database(localPath);
    try { db.pragma('journal_mode = DELETE'); } catch (_) { log.warn('could not set journal_mode', _); }
    try { db.pragma('foreign_keys = ON'); } catch (_) { log.warn('could not enable foreign_keys', _); }
    const pages = maxPageCount();
    if (pages > 0) {
        try { db.pragma(`max_page_count = ${pages}`); } catch (_) { log.warn('could not set max_page_count', _); }
    }
    return db;
}

module.exports = { openPageDatabase, maxPageCount, DEFAULT_MAX_PAGE_COUNT };
