// @typecheck
/**
 * Co-editing upkeep — materialise, checkpoint and compact the documents
 * people are (or were just) editing together (core/collab).
 *
 * Every pass picks the documents with work (stores/collabDocStore.listWork)
 * and, per document (core/collab/lifecycle.processDoc):
 *
 *   materialise  the current state into the resource's own columns 30 s after
 *                the last edit (and at least every 5 minutes of continuous
 *                typing), so mobile, exports, search and every reader that
 *                does not speak the co-editing protocol stay current;
 *   checkpoint   a version with its contributors and stats, the change-feed
 *                entry, a compliance scan and one `doc.edited` project event,
 *                after 5 minutes idle or every 30 minutes of continuous
 *                editing — once per session, never per keystroke;
 *   compact      fold the update log into a garbage-collected snapshot when it
 *                grew (200 updates / 512 KB) or went idle;
 *   detach       a document whose resource left its project, was deleted, or
 *                whose organisation switched co-editing off is folded back
 *                into the resource.
 *
 * Started unconditionally at boot (no module gate: co-editing is part of
 * projects, and an update log without its compaction only grows).
 *
 * MULTI-POD SAFE: one pod per pass through its own advisory lock. The steps
 * are safe against the request path too: the mirror is written under the
 * document's mirror lease (never an older state over a newer one), a
 * compaction is compare-and-set on the snapshot seq, and a detach fences
 * appends before its final read. A failing document is logged (id only),
 * put off for a while so it cannot crowd out the rest of the list, and the
 * pass moves on.
 */

'use strict';

const { periodicTimer } = require('./lib/periodicTimer');

const COLLAB_COMPACTION_LOCK_KEY = 0xBEEF1C0;
const INTERVAL_MS = 60 * 1000;
const BOOT_DELAY_MS = 60 * 1000;

let _running = false;

// Dependencies resolve lazily, so a test that injects stand-ins through
// _setDeps never loads a store (and never opens a pool).
let _deps = null;
function deps() {
    if (!_deps) {
        const collab = require('../core/collab').instance();
        _deps = {
            pool: require('../db').pool,
            listWork: () => collab.listWork(),
            processDoc: (doc) => collab.processDoc(doc),
            log: require('../telemetry/log'),
        };
    }
    return _deps;
}

/**
 * Test hook: inject every dependency above; pass nothing to restore the real ones.
 * @param {any} [d]
 */
function _setDeps(d) {
    _deps = d || null;
    _running = false;
}

/**
 * One pass over every document with work, under the advisory lock.
 * @returns {Promise<{ skipped?: boolean, processed: number, failed: number }>}
 */
async function runOnce() {
    if (_running) return { skipped: true, processed: 0, failed: 0 };
    _running = true;
    const d = deps();
    let client;
    let acquired = false;
    let processed = 0;
    let failed = 0;
    try {
        client = await d.pool.connect();
        const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [COLLAB_COMPACTION_LOCK_KEY]);
        acquired = !!lock.rows[0]?.locked;
        if (!acquired) return { skipped: true, processed, failed };
        const docs = await d.listWork();
        for (const doc of docs) {
            try {
                await d.processDoc(doc);
                processed += 1;
            } catch (e) {
                failed += 1;
                d.log.warn(`[collabDocCompaction] document ${doc.id} failed: ${/** @type {Error} */ (e).message}`);
            }
        }
        if (failed) d.log.warn(`[collabDocCompaction] ${failed} of ${docs.length} document(s) failed this pass`);
        return { processed, failed };
    } catch (e) {
        d.log.warn('[collabDocCompaction] pass failed:', /** @type {Error} */ (e).message);
        return { processed, failed };
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [COLLAB_COMPACTION_LOCK_KEY]); } catch (_) { /* best effort */ }
            client.release();
        }
        _running = false;
    }
}

/** A pass on a timer; a failing pass is a log line, never an unhandled rejection. @param {string} when */
function pass(when) {
    runOnce().catch((e) => deps().log.warn(`[collabDocCompaction] ${when} pass failed:`, e.message));
}

// The first interval is a minute away, but a pod that just booted should not
// wait for a document someone closed while it was down: hence the boot pass.
const timer = periodicTimer({ bootDelayMs: BOOT_DELAY_MS, intervalMs: INTERVAL_MS, run: pass });

function start() {
    if (!timer.start()) return;
    deps().log.info(`[collabDocCompaction] Started — every ${INTERVAL_MS / 1000} s`);
}

function stop() {
    timer.stop();
}

module.exports = { start, stop, runOnce, COLLAB_COMPACTION_LOCK_KEY, INTERVAL_MS, _setDeps };
