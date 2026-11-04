// @typecheck strict
/**
 * A note's lifecycle outside its content: the reaper for stuck runs and the
 * heartbeat that keeps a long run out of it, the publish toggle, and the
 * delete with its audio cleanup (local file and the durable object-storage
 * copy).
 */

const fs = require('fs');
const path = require('path');
const { run, getOne, withTransaction } = require('../../db');
const log = require('../../telemetry/log');
const { HttpError } = require('../../shared/httpErrors');
const { initDB } = require('./schema');

// Saved audio lives under server/data/uploads (audio/ + saved-recordings/).
// Deletion only ever unlinks files inside this root — never arbitrary paths.
const UPLOADS_ROOT = path.resolve(__dirname, '../../data/uploads');

/**
 * How long a note may sit in 'processing' without a sign of life before the
 * reaper calls it dead.
 *
 * It was 180 minutes, and that is shorter than a healthy run is allowed to
 * take: Azure Speech may run up to 4 h (computeAzureTimeouts), pyannote polls
 * up to 2 h, and five LLM passes follow either. A three-hour meeting was
 * marked failed while it was still being transcribed; the upload then flipped
 * it back to completed, and a Retry in between started a second paid run (on
 * the reprocess path the reaped run's result was thrown away for good). The
 * default sits above the largest engine cap plus the LLM passes. A running
 * pipeline also calls heartbeatProcessing() between its phases, so the
 * threshold measures silence, not the length of the meeting.
 *
 * MEETING_NOTES_STUCK_MINUTES overrides it; 0 switches the reaper off.
 */
const DEFAULT_STUCK_MINUTES = 360;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
function stuckMinutesFromEnv(env = process.env) {
    const raw = env.MEETING_NOTES_STUCK_MINUTES;
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_STUCK_MINUTES;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_STUCK_MINUTES;
}

/**
 * What a reaped note says about itself. A failed note carries its reason in
 * `summary` (the upload and reprocess routes write `Transcription failed: …`
 * there, and the list derives failure_reason from it); a note the reaper
 * flipped carries this fixed one (no content, so plaintext is fine).
 */
const REAPED_REASON = 'Transcription failed: processing stopped without finishing (the server may have restarted during the run). Retry to process it again from the saved audio.';

/**
 * Reap async-upload notes stuck in 'processing' — e.g. if the server restarted
 * mid-job (the background pipeline is in-process, so it dies with the process).
 * Flips rows that showed no sign of life for longer than `stuckMinutes` to
 * 'failed' so the UI stops spinning and the note can be reprocessed from its
 * saved audio. Mirrors notebookStore.timeoutStuckSources. Called
 * opportunistically from the list route and by the scheduler.
 *
 * The reason goes into `summary` only when that is empty: a reprocess of a
 * completed note still holds the old summary there, and it must not be
 * overwritten by a status message.
 * @param {TimeoutStuckTranscriptionsArgs} [args]
 */
async function timeoutStuckTranscriptions({ stuckMinutes = stuckMinutesFromEnv() } = {}) {
    if (!(Number(stuckMinutes) > 0)) return 0;
    await initDB();
    const { rowCount } = await run(
        `UPDATE transcriptions
            SET status = 'failed', updated_at = NOW(),
                summary = CASE WHEN COALESCE(summary, '') = '' THEN $2 ELSE summary END
          WHERE status = 'processing'
            AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
        [Math.floor(Number(stuckMinutes)), REAPED_REASON]
    );
    return rowCount || 0;
}

/**
 * A running pipeline's sign of life: moves `updated_at` of a note that is
 * still 'processing', so the reaper measures silence rather than the length
 * of the recording. Call it between phases (after transcription, after
 * diarisation, between the LLM passes).
 *
 * Returns false when the note has left processing (reaped, deleted, or
 * claimed and finished by someone else): the caller has lost its run and can
 * stop spending on it. `updated_at` moving during a run is harmless to its
 * readers: the knowledge-source sweep reads completed notes only, and the
 * artifact merge has its own clock (artifactWindow.js).
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function heartbeatProcessing(id) {
    if (!id) return false;
    await initDB();
    const { rowCount } = await run(
        `UPDATE transcriptions SET updated_at = NOW() WHERE id = $1 AND status = 'processing'`,
        [id]
    );
    return (rowCount || 0) > 0;
}

/**
 * Toggle publish state and shared groups for a transcription. Owner-only.
 * Mirrors `knowledgeBases.setPublished`.
 *
 * Personal (`isPublished` false) means only the owner, so it also clears
 * `shared_with`: the people a Teams or Google Meet import shared the note
 * with because they attended. Nothing else ever writes that column after the
 * insert, so without this the grant could never be revoked: the note read
 * "Personal" while the attendees could still open the transcript and the
 * audio, and filing it into a project stayed refused for good ("already
 * shared another way. Make it personal first"). Publishing to the
 * organisation or to groups leaves those grants alone; it only widens.
 */
/**
 * @param {string|null} [orgId] The owner's org, stamped onto the note when it
 *   does not have one yet. Every org-visibility clause in the read ACL is
 *   `organization_id = ANY(orgIds)`, so publishing a note whose
 *   `organization_id` is NULL set `is_published = true` and changed nothing at
 *   all: the UI reported "shared with the organisation" and no colleague could
 *   ever see it. Notes get a NULL org whenever they were made before the user
 *   joined an org, or by a path that had no org context.
 * @param {string} id
 * @param {string} ownerId
 * @param {boolean | null | undefined} isPublished
 * @param {string[]} sharedGroups
 */
async function setPublished(id, ownerId, isPublished, sharedGroups, orgId = null) {
    await initDB();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    const { rowCount } = await run(
        `UPDATE transcriptions
         SET is_published = $3,
             shared_groups = $4,
             shared_with = CASE WHEN $3::boolean THEN shared_with ELSE '[]'::jsonb END,
             -- COALESCE, never overwrite: a note already belonging to an org
             -- must not be moved into the publisher's current one.
             organization_id = COALESCE(organization_id, $5),
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, ownerId, !!isPublished, groupsJson, orgId]
    );
    return rowCount > 0;
}

/** The refusal when the recording storage cannot remove a note's audio. */
function storageUnavailable() {
    return new HttpError(503, 'recording_storage_unavailable',
        'The recording storage cannot be reached right now, so the recording cannot be removed. Nothing was deleted: try again in a moment.');
}

/**
 * Remove a note's durable recording, strictly. Throws when it cannot be done.
 *
 * The row is the only reference to `audio_storage_key`: the key sits under
 * `saved-recordings/`, outside the `users/<id>/` prefix account erasure
 * sweeps, and no job lists the bucket. So the object has to be gone BEFORE
 * the row is, or a delete during a storage outage (a pod that booted while
 * RustFS was down, the backoff window after a failed connect, a dropped
 * connection after a good one) left the raw meeting audio in the bucket for
 * good while the API reported success: a GDPR Art. 17 hole. A 503 instead
 * keeps the note (deleteTranscription rolls back), and the same delete can
 * simply be retried; account erasure reports the step incomplete.
 * @param {string} id
 * @param {string} storageKey
 */
async function deleteDurableAudio(id, storageKey) {
    const storageStore = require('../storageStore');
    try {
        await storageStore.deleteFile(storageKey);
    } catch (e) {
        log.warn(`[TranscriptionStore] Delete of ${id} refused: durable audio ${storageKey} not removed: ${/** @type {Error} */ (e).message}`);
        throw storageUnavailable();
    }
    log.info(`[TranscriptionStore] Deleted durable audio ${storageKey} for ${id}`);
}

/**
 * Delete a note and its recording. Owner-only.
 *
 * Storage is made available BEFORE the transaction opens: ensureAvailable()
 * may start a full connect, and that must not hold a pooled connection and a
 * row lock. A note with a durable copy is refused with a 503 while storage is
 * down. The row and its durable copy then go in one transaction: the DELETE
 * returns the key (and locks the row, so nothing can write a new key
 * meanwhile), the object is removed, and only then does the delete commit.
 * When the object cannot be removed, deleteDurableAudio throws a 503, the
 * transaction rolls back and the note stays, with the key that locates its
 * recording. The local file goes after the commit and is best-effort:
 * audio_path is per replica, and a leftover there is still inside the uploads
 * root, not an unreachable object.
 * @param {string} id
 * @param {string} userId
 */
async function deleteTranscription(id, userId) {
    await initDB();
    const owned = await getOne('SELECT audio_storage_key FROM transcriptions WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!owned) return false;
    if (owned.audio_storage_key && !(await require('../storageStore').ensureAvailable())) {
        log.warn(`[TranscriptionStore] Delete of ${id} refused: object storage unavailable for ${owned.audio_storage_key}`);
        throw storageUnavailable();
    }
    const removed = await withTransaction(async (client) => {
        const res = await client.query(
            'DELETE FROM transcriptions WHERE id = $1 AND user_id = $2 RETURNING audio_path, audio_storage_key',
            [id, userId]
        );
        if (!res || !((res.rowCount || 0) > 0)) return null;
        const row = res.rows?.[0] || {};
        if (row.audio_storage_key) await deleteDurableAudio(id, row.audio_storage_key);
        return row;
    });
    if (!removed) return false;
    // Best-effort cleanup of the local saved audio file. Only unlink paths
    // that resolve inside the uploads root; anything else stays untouched.
    const audioPath = removed.audio_path;
    if (audioPath) {
        const resolved = path.resolve(audioPath);
        if (resolved.startsWith(UPLOADS_ROOT + path.sep)) {
            try {
                await fs.promises.unlink(resolved);
            } catch (e) {
                if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') log.warn(`[TranscriptionStore] Could not delete audio for ${id}: ${/** @type {Error} */ (e).message}`);
            }
        }
    }
    return true;
}

module.exports = { timeoutStuckTranscriptions, heartbeatProcessing, stuckMinutesFromEnv, DEFAULT_STUCK_MINUTES, REAPED_REASON, setPublished, deleteTranscription };

/**
 * @typedef TimeoutStuckTranscriptionsArgs
 * @property {number} [stuckMinutes]
 */
