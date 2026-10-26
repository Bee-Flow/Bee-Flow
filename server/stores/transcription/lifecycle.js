// @typecheck strict
/**
 * A note's lifecycle outside its content: the reaper for stuck runs, the
 * publish toggle, and the delete with its audio cleanup (local file and the
 * durable object-storage copy).
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../../db');
const log = require('../../telemetry/log');
const { initDB } = require('./schema');

// Saved audio lives under server/data/uploads (audio/ + saved-recordings/).
// Deletion only ever unlinks files inside this root — never arbitrary paths.
const UPLOADS_ROOT = path.resolve(__dirname, '../../data/uploads');

/**
 * Reap async-upload notes stuck in 'processing' — e.g. if the server restarted
 * mid-job (the background pipeline is in-process, so it dies with the process).
 * Flips rows processing for longer than `stuckMinutes` to 'failed' so the UI
 * stops spinning and the note can be reprocessed from its saved audio. Mirrors
 * notebookStore.timeoutStuckSources. Called opportunistically from the list route.
 */
async function timeoutStuckTranscriptions({ stuckMinutes = 180 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE transcriptions
            SET status = 'failed', updated_at = NOW()
          WHERE status = 'processing'
            AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')`,
        [stuckMinutes]
    );
    return rowCount || 0;
}

/**
 * Toggle publish state and shared groups for a transcription. Owner-only.
 * Mirrors `knowledgeBases.setPublished`.
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
             -- COALESCE, never overwrite: a note already belonging to an org
             -- must not be moved into the publisher's current one.
             organization_id = COALESCE(organization_id, $5),
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [id, ownerId, !!isPublished, groupsJson, orgId]
    );
    return rowCount > 0;
}

/**
 * @param {string} id
 * @param {string} userId
 */
async function deleteTranscription(id, userId) {
    await initDB();
    const { rowCount, rows } = await run(
        'DELETE FROM transcriptions WHERE id = $1 AND user_id = $2 RETURNING audio_path, audio_storage_key',
        [id, userId]
    );
    // Best-effort cleanup of the saved audio file — a deleted note must not
    // leave its recording orphaned on disk. Only unlink paths that resolve
    // inside the uploads root; anything else stays untouched.
    const audioPath = rows?.[0]?.audio_path;
    if (rowCount > 0 && audioPath) {
        const resolved = path.resolve(audioPath);
        if (resolved.startsWith(UPLOADS_ROOT + path.sep)) {
            try {
                await fs.promises.unlink(resolved);
            } catch (e) {
                if (e.code !== 'ENOENT') log.warn(`[TranscriptionStore] Could not delete audio for ${id}: ${/** @type {Error} */ (e).message}`);
            }
        }
    }
    // The DURABLE copy matters more than the local one: audio_path is
    // ephemeral per replica, so on the SaaS the object-storage copy is
    // usually the only one that still exists. Deleting only the local file
    // left every deleted note's recording behind in RustFS/S3 forever —
    // an erasure-request (GDPR Art. 17) hole, not just wasted storage.
    const storageKey = rows?.[0]?.audio_storage_key;
    if (rowCount > 0 && storageKey) {
        try {
            const storageStore = require('../storageStore');
            if (storageStore.isAvailable()) {
                await storageStore.deleteFile(storageKey);
                log.info(`[TranscriptionStore] Deleted durable audio ${storageKey} for ${id}`);
            }
        } catch (e) {
            log.warn(`[TranscriptionStore] Could not delete durable audio for ${id}: ${/** @type {Error} */ (e).message}`);
        }
    }
    return rowCount > 0;
}

module.exports = { timeoutStuckTranscriptions, setPublished, deleteTranscription };

/**
 * @typedef {Object} TimeoutStuckTranscriptionsArgs
 * @property {number} [stuckMinutes]
 */
