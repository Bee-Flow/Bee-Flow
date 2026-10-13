/**
 * The Google Meet auto-import tick (mounted by ticks.js, which re-exports it).
 *
 * Discovery (calendar scan → seed gmeet_import_jobs) is metadata-only and runs
 * under its own advisory lock so one pod scans per tick; the ingest worker
 * claims jobs via FOR UPDATE SKIP LOCKED, so it runs AFTER the lock is
 * released and on every pod.
 *
 * The lock is NAMED (jobs/lib/namedLock.js), not numbered: it used to be
 * 0xBEEF10A, which is also the ISO evidence collector's key, so each job
 * silently skipped its tick on every pod while the other one held the lock
 * (jobs/isoEvidenceCollector.test.js drives both against one lock table).
 *
 * In its own file, not in ticks.js, so that test can load it with a fake pool
 * through _setDepsForTests: ticks.js pulls in the whole runner at require time.
 */

'use strict';

const { withNamedLock } = require('../../../jobs/lib/namedLock');
const log = require('../../../telemetry/log');

const GMEET_IMPORT_LOCK_NAME = 'beeflow:job:gmeetAutoImportDiscovery';

// Lazily required, as they were inline in ticks.js.
const DEFAULT_DEPS = {
    pool: () => require('../../../db').pool,
    gmeetAutoImport: () => require('../../meetingNotes/gmeetAutoImport'),
};
let _deps = { ...DEFAULT_DEPS };

async function processGmeetAutoImport() {
    const gmeetAutoImport = _deps.gmeetAutoImport();
    try {
        await withNamedLock(_deps.pool(), GMEET_IMPORT_LOCK_NAME, () => gmeetAutoImport.discover());
    } catch (e) {
        log.error('[AutomationRunner] gmeet auto-import discovery error:', e.message);
    }
    try {
        await gmeetAutoImport.processDue();
    } catch (e) {
        log.error('[AutomationRunner] gmeet auto-import ingest error:', e.message);
    }
}

/**
 * Test seam: replace `pool` and/or `gmeetAutoImport` (each a getter); no
 * argument restores the real ones.
 * @param {Partial<typeof DEFAULT_DEPS> | null} [over]
 */
function _setDepsForTests(over = null) {
    _deps = { ...DEFAULT_DEPS, ...(over || {}) };
}

module.exports = { processGmeetAutoImport, GMEET_IMPORT_LOCK_NAME, _setDepsForTests };
