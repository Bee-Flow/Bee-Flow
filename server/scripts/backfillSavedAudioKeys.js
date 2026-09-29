#!/usr/bin/env node
/**
 * Back-fill `audio_storage_key` for meeting notes whose recording is still on
 * THIS pod's disk but has no durable object-storage copy.
 *
 * Background:
 *   `audio_storage_key` was writable only by the INSERT, and object storage was
 *   a one-shot connect at boot — a pod that started while RustFS was restarting
 *   stayed "storage unavailable" for its whole life and gave every note it
 *   created a NULL key. The local `audio_path` has no persistent volume behind
 *   it on the SaaS, so those recordings are one pod restart away from gone, and
 *   re-transcribe answers "Saved audio not found. Cannot reprocess — please
 *   upload again" (impossible advice for a meeting recorded in the browser).
 *
 * Scope guarantees:
 *   - Reads only this pod's saved-recordings directory. It cannot see, and will
 *     not touch, notes whose file lives on another replica.
 *   - Only fills a NULL key (`audioStorageKeyIfMissing`). A note that already
 *     has a durable copy is never rewritten, so it is safe to re-run and safe to
 *     run on several pods at once.
 *   - Owner-scoped: every update passes the note row's own `user_id`.
 *   - Never deletes anything. Recording files with no note row are reported as
 *     orphans and left alone.
 *   - Dry-run by default; --apply required to upload and mutate.
 *
 * Usage:
 *   node server/scripts/backfillSavedAudioKeys.js              # dry-run (default)
 *   node server/scripts/backfillSavedAudioKeys.js --apply
 *   node server/scripts/backfillSavedAudioKeys.js --apply --batch 500
 *
 * Local stack:
 *   docker exec beeflow-server node scripts/backfillSavedAudioKeys.js --apply
 *
 * Production (repeat per server pod — each holds different files):
 *   kubectl -n beeflow get pods -l app=beeflow-server -o name
 *   kubectl -n beeflow exec <pod> -- node scripts/backfillSavedAudioKeys.js --apply
 */

'use strict';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const batchIdx = args.indexOf('--batch');
const batch = batchIdx !== -1 ? Number(args[batchIdx + 1]) : 1000;

async function main() {
    const storageStore = require('../stores/storageStore');
    const { SAVED_RECORDINGS_DIR } = require('../core/meetingNotes/savedAudioStore');
    const { runOnce } = require('../jobs/savedAudioBackfill');

    console.log(`[Backfill] mode: ${apply ? 'APPLY' : 'DRY-RUN'} | dir: ${SAVED_RECORDINGS_DIR} | batch: ${batch}`);

    await storageStore.init();
    if (!(await storageStore.ensureAvailable())) {
        const { configured, lastError } = storageStore.getStatus();
        console.error(configured
            ? `[Backfill] object storage is configured but unreachable (${lastError}) — nothing can be uploaded. Aborting.`
            : '[Backfill] object storage is not configured (RUSTFS_* unset) — nothing to back up to. Aborting.');
        process.exitCode = 1;
        return;
    }

    const r = await runOnce({ batch, dryRun: !apply });

    console.log('');
    console.log(`  recording files on this pod : ${r.scanned}`);
    console.log(`  already durable             : ${r.alreadyDurable}`);
    console.log(`  ${apply ? 'repaired' : 'would repair'}${apply ? '                   ' : '                '}: ${r.repaired}`);
    console.log(`  orphans (no note row, kept) : ${r.orphans}`);
    console.log('');
    if (!apply && r.repaired > 0) {
        console.log('Re-run with --apply to upload these to object storage.');
    }
}

main()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
        console.error('[Backfill] failed:', err.message);
        process.exit(1);
    });
