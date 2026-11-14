// @typecheck strict
/**
 * Transcriptions: intake steps of POST / (upload).
 *
 * What happens before the heavy pipeline starts: which engine the upload may
 * use, whether the target project accepts the note, and the up-front copy of
 * the audio. Extracted from upload.js; each step reads its arguments and
 * returns what it decided, the route owns the HTTP response.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const configStore = require('../../stores/configStore');
const meetingFiling = require('../../projects/meetingFiling');
const { bestEffort, ignoreGone } = require('../../utils/bestEffort');

// Every engine the pipeline knows how to drive, and which of them this
// workspace lets a user pick per upload: the one policy every ingest path
// asks (core/meetingNotes/transcriptionProviderPolicy). A request naming
// anything else is rejected rather than silently falling through to the
// configured default (which made a typo look like it had been honoured).
const { KNOWN_PROVIDERS, resolveAllowedProviders } = require('../../core/meetingNotes/transcriptionProviderPolicy');

/**
 * File the new note into a project, when one was asked for. Checked BEFORE
 * anything is saved or transcribed: a refusal here must cost nothing and leave
 * nothing behind.
 * @param {import('express').Request} req
 * @param {string} userId
 * @param {string | null} userOrgId
 * @returns {Promise<{ projectId: string|null, refusal?: { status: number, body: object } }>}
 */
async function resolveProjectFiling(req, userId, userOrgId) {
    if (!req.body.projectId) return { projectId: null };
    const dropUpload = () => { try { fs.unlinkSync(/** @type {string} */ (/** @type {NonNullable<typeof req.file>} */ (req.file).path)); } catch (err) { bestEffort('routes/transcriptions/uploadIntake:dropUpload', err); /* multer's temp file may already be gone */ } };
    /** @type {Awaited<ReturnType<typeof meetingFiling.resolve>>} */
    let target;
    try {
        // nosemgrep: ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal -- meetingFiling.resolve is the project access check, not path.resolve; no file path is built
        target = await meetingFiling.resolve(userId, userOrgId, req.body.projectId);
    } catch (err) {
        // The access check could not be answered: refuse, never file blind.
        dropUpload();
        log.error('[Transcriptions] project access check failed:', /** @type {Error} */ (err).message);
        throw new HttpError(503, 'project_check_unavailable', 'Could not check access to that project. Try again in a moment.');
    }
    if (!target.ok) {
        dropUpload();
        return { projectId: null, refusal: { status: /** @type {Extract<typeof target, { ok: false }>} */ (target).status, body: { error: /** @type {Extract<typeof target, { ok: false }>} */ (target).error, code: /** @type {Extract<typeof target, { ok: false }>} */ (target).code } } };
    }
    return { projectId: target.projectId };
}

/**
 * Provider precedence:
 *   1. Per-upload `provider` form field, only when the admin allows it
 *      (`resolveAllowedProviders`). Picks from the upload modal in the UI.
 *   2. Server-side default `transcription_provider` config.
 * @param {import('express').Request} req
 * @returns {Promise<{ provider: string, refusal?: object }>} `refusal` is the 403 body.
 */
async function resolveUploadProvider(req) {
    const requestedProvider = (req.body.provider || '').toLowerCase();
    const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
    let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
    if (requestedProvider) {
        // Any authenticated user could override the admin's configured
        // engine from a form field. On this product that is not a
        // preference: it decides which third party the meeting audio is
        // sent to, and an admin who chose the self-hosted WhisperX for
        // exactly that reason had no way to stop a user picking a US cloud.
        const allowed = await resolveAllowedProviders(localEnabled);
        if (!allowed.includes(requestedProvider)) {
            if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) { ignoreGone('routes/transcriptions/uploadIntake:unlinkUpload', _); } }
            return {
                provider,
                refusal: {
                    error: 'That transcription engine is not enabled for this workspace.',
                    code: 'provider_not_allowed',
                    allowed,
                },
            };
        }
        provider = requestedProvider;
    }
    return { provider };
}

/**
 * Save the audio up front (so a crashed/timed-out job can still be
 * reprocessed): a local copy and, when object storage exists, a durable one.
 * @param {{ path: string, originalname?: string }} file
 * @param {string} userId
 * @param {string} fileName
 * @returns {Promise<{ savedAudioPath: string, audioStorageKey: string|null }>}
 */
async function persistUploadAudio(file, userId, fileName) {
    const audioDir = path.resolve(__dirname, '../../data/uploads/saved-recordings');
    if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
    const savedExt = path.extname(file.originalname || '.webm') || '.webm';
    // Same hazard as ingestRecordingCore's copy, same directory: two uploads
    // by one user in the same millisecond used to overwrite each other, so
    // one note's row pointed at the other note's audio.
    const savedBase = `${Date.now()}-${crypto.randomUUID()}-${userId}${savedExt}`;
    let savedAudioPath = path.join(audioDir, savedBase);
    try {
        await fs.promises.copyFile(file.path, savedAudioPath);
    } catch (copyErr) {
        log.error('[Transcriptions] Could not persist audio up front:', /** @type {Error} */ (copyErr).message);
        savedAudioPath = '';
    }
    // Durable copy in object storage (RustFS/S3) when available, so a later
    // "Re-transcribe" survives pod restarts / lands on any replica. Self-host
    // without object storage keeps only the local copy on its persistent disk.
    const { savedAudioKey, persistSavedAudioToStorage } = require('../../core/meetingNotes/savedAudioStore');
    // Streams from the copy we just made in bounded parts, instead of holding
    // the whole upload in memory.
    const persisted = await persistSavedAudioToStorage(
        savedAudioKey(savedBase),
        savedAudioPath || file.path,
        savedExt,
    );
    const audioStorageKey = persisted.ok ? persisted.key : null;
    if (!persisted.ok && persisted.reason !== 'not_configured') {
        // Deliberately not fatal: the note and its transcript are still
        // worth having, and the backfill job will retry from the local file
        // while this pod still holds it. But it must be loud — on a deploy
        // with no persistent volume this is the window in which a recording
        // can be lost for good.
        log.error(`[Transcriptions] No durable audio copy for upload "${log.nameForLog(fileName)}" (${persisted.reason}) — queued for repair`);
    }
    return { savedAudioPath, audioStorageKey };
}

module.exports = { resolveProjectFiling, resolveUploadProvider, persistUploadAudio, resolveAllowedProviders, KNOWN_PROVIDERS };
