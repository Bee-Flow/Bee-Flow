/**
 * Saved-audio backfill — give every meeting note a durable object-storage copy.
 *
 * WHY THIS EXISTS
 * `audio_storage_key` is written once, at note creation. If object storage was
 * unreachable at that moment (a pod that booted during a RustFS restart used to
 * stay "storage unavailable" for its entire life), the note got a NULL key. The
 * local `audio_path` is per-pod and has no volume behind it on the SaaS, so the
 * recording then died with the pod — and re-transcribe answered "Saved audio not
 * found. Cannot reprocess", which for a browser recording is unfixable advice.
 *
 * WHY IT IS DISK-FIRST
 * The obvious implementation — "SELECT notes WHERE audio_storage_key IS NULL" —
 * is close to useless on a multi-replica deploy: a note's local file exists only
 * on the pod that created it, so most rows the query returns are ones this pod
 * cannot help with. Listing our OWN saved-recordings directory and asking the DB
 * about those files is bounded, cheap, and every hit is actionable.
 *
 * This job is the safety net. The primary mechanism is opportunistic repair on
 * the request paths (reprocess and the audio route), which fixes a note the
 * moment anyone touches it on the pod that still holds the file.
 *
 * Files with no matching note row are counted and logged, never deleted —
 * deciding what to do with orphaned recordings is a separate call.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../telemetry/log');

const INTERVAL_MS = Number(process.env.SAVED_AUDIO_BACKFILL_INTERVAL_MS) || 6 * 60 * 60 * 1000;
// Stagger past boot so it never competes with startup work, and so a fleet of
// replicas does not all sweep at once.
const BOOT_DELAY_MS = Number(process.env.SAVED_AUDIO_BACKFILL_BOOT_DELAY_MS) || 3 * 60 * 1000;
const BATCH = Number(process.env.SAVED_AUDIO_BACKFILL_BATCH) || 25;

let timer = null;
let bootTimer = null;

/**
 * One sweep of this pod's saved-recordings directory.
 * @returns {Promise<{scanned, repaired, alreadyDurable, orphans, skipped}>}
 */
async function runOnce({ batch = BATCH, dryRun = false } = {}) {
    const storageStore = require('../stores/storageStore');
    const transcriptionStore = require('../stores/transcriptionStore');
    const { SAVED_RECORDINGS_DIR, repairSavedAudio } = require('../core/meetingNotes/savedAudioStore');

    const result = { scanned: 0, repaired: 0, alreadyDurable: 0, orphans: 0, skipped: 0 };

    // No point reading the directory if we cannot upload anything.
    if (!(await storageStore.ensureAvailable())) {
        result.skipped = 1;
        return result;
    }

    let names;
    try {
        names = await fs.promises.readdir(SAVED_RECORDINGS_DIR);
    } catch (e) {
        if (e.code !== 'ENOENT') log.warn(`[SavedAudioBackfill] cannot read ${SAVED_RECORDINGS_DIR}: ${e.message}`);
        return result;
    }

    // `.part` files are in-flight write-back temporaries from resolveSavedAudio.
    const paths = names
        .filter((n) => !n.endsWith('.part'))
        .map((n) => path.join(SAVED_RECORDINGS_DIR, n));
    result.scanned = paths.length;
    if (!paths.length) return result;

    const rows = await transcriptionStore.getTranscriptionsByAudioPaths(paths);
    const byPath = new Map(rows.map((r) => [r.audio_path, r]));
    result.orphans = paths.filter((p) => !byPath.has(p)).length;

    const needsRepair = rows.filter((r) => !r.audio_storage_key);
    result.alreadyDurable = rows.length - needsRepair.length;

    for (const row of needsRepair.slice(0, batch)) {
        if (dryRun) { result.repaired++; continue; }
        const key = await repairSavedAudio({
            id: row.id,
            ownerId: row.user_id,
            audioPath: row.audio_path,
            audioStorageKey: row.audio_storage_key,
        });
        if (key) result.repaired++;
    }

    // Never silently truncate: say what was left for the next tick.
    if (needsRepair.length > batch) {
        log.info(`[SavedAudioBackfill] ${needsRepair.length - batch} more note(s) still need a durable copy — next tick`);
    }
    if (result.orphans > 0) {
        log.info(`[SavedAudioBackfill] ${result.orphans} recording file(s) have no note row (kept, not deleted)`);
    }
    return result;
}

async function tick() {
    const started = Date.now();
    try {
        const r = await runOnce();
        if (r.repaired > 0) {
            log.info(`[SavedAudioBackfill] repaired ${r.repaired}/${r.scanned} recording(s)`);
        }
        recordRun('ok', Date.now() - started);
    } catch (e) {
        log.error('[SavedAudioBackfill] sweep failed:', e.message);
        recordRun('error', Date.now() - started);
    }
}

function recordRun(status, durationMs) {
    try {
        require('../telemetry/metrics').recordJobRun({ job: 'saved_audio_backfill', status, durationMs });
    } catch (_) { /* telemetry is optional */ }
}

function start() {
    if (timer || bootTimer) return;
    bootTimer = setTimeout(() => {
        bootTimer = null;
        tick();
        timer = setInterval(tick, INTERVAL_MS);
        if (timer.unref) timer.unref();
    }, BOOT_DELAY_MS);
    if (bootTimer.unref) bootTimer.unref();
    log.info(`[SavedAudioBackfill] scheduled (every ${Math.round(INTERVAL_MS / 60000)}min, first run in ${Math.round(BOOT_DELAY_MS / 1000)}s)`);
}

function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

module.exports = { start, stop, runOnce };
