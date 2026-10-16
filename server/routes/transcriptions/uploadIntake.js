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

// Every engine the pipeline knows how to drive. A request may name one of
// these; anything else is rejected rather than silently falling through to the
// configured default (which made a typo look like it had been honoured).
const KNOWN_PROVIDERS = ['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote', 'local'];

/**
 * Which engines this workspace lets a user pick per upload.
 *
 * Admins set `transcription_providers_allowed` (an array). Unset means "any
 * known engine", which is the historical behaviour — narrowing it is opt-in so
 * an upgrade never breaks the "Switch engine & retry" button. The configured
 * default is always allowed, and `local` additionally requires
 * `local_whisper_enabled`.
 */
async function resolveAllowedProviders(localEnabled) {
    const configured = await configStore.getConfig('transcription_provider') || 'voxtral';
    const raw = await configStore.getConfig('transcription_providers_allowed');
    let allowed = Array.isArray(raw) && raw.length
        ? raw.map(p => String(p).trim().toLowerCase()).filter(p => KNOWN_PROVIDERS.includes(p))
        : [...KNOWN_PROVIDERS];
    if (!allowed.includes(configured)) allowed.push(configured);
    if (!localEnabled) allowed = allowed.filter(p => p !== 'local');
    return allowed;
}

/**
 * File the new note into a project, when one was asked for. Checked BEFORE
 * anything is saved or transcribed: a refusal here must cost nothing and leave
 * nothing behind.
 * @returns {Promise<{ projectId: string|null, refusal?: { status: number, body: object } }>}
 */
async function resolveProjectFiling(req, userId, userOrgId) {
    if (!req.body.projectId) return { projectId: null };
    const dropUpload = () => { try { fs.unlinkSync(req.file.path); } catch (_) { /* multer's temp file may already be gone */ } };
    let target;
    try {
        // nosemgrep: ajinabraham.njsscan.traversal.resolve_path_traversal.join_resolve_path_traversal -- meetingFiling.resolve is the project access check, not path.resolve; no file path is built
        target = await meetingFiling.resolve(userId, userOrgId, req.body.projectId);
    } catch (err) {
        // The access check could not be answered: refuse, never file blind.
        dropUpload();
        log.error('[Transcriptions] project access check failed:', err.message);
        throw new HttpError(503, 'project_check_unavailable', 'Could not check access to that project. Try again in a moment.');
    }
    if (!target.ok) {
        dropUpload();
        return { projectId: null, refusal: { status: target.status, body: { error: target.error, code: target.code } } };
    }
    return { projectId: target.projectId };
}

/**
 * Provider precedence:
 *   1. Per-upload `provider` form field, only when the admin allows it
 *      (`resolveAllowedProviders`). Picks from the upload modal in the UI.
 *   2. Server-side default `transcription_provider` config.
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
            if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
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
        log.error('[Transcriptions] Could not persist audio up front:', copyErr.message);
        savedAudioPath = '';
    }
    // Durable copy in object storage (RustFS/S3) when available, so a later
    // "Re-transcribe" survives pod restarts / lands on any replica. Self-host
    // without object storage keeps only the local copy on its persistent disk.
    const { savedAudioKey, persistSavedAudioToStorage } = require('../../core/meetingNotes/savedAudioStore');
    // Reads from the copy we just made and lets the buffer go immediately
    // afterwards, instead of holding the upload for the whole pipeline.
    const persisted = await persistSavedAudioToStorage(
        savedAudioKey(savedBase),
        await fs.promises.readFile(savedAudioPath || file.path),
        savedExt,
    );
    const audioStorageKey = persisted.ok ? persisted.key : null;
    if (!persisted.ok && persisted.reason !== 'not_configured') {
        // Deliberately not fatal: the note and its transcript are still
        // worth having, and the backfill job will retry from the local file
        // while this pod still holds it. But it must be loud — on a deploy
        // with no persistent volume this is the window in which a recording
        // can be lost for good.
        log.error(`[Transcriptions] No durable audio copy for upload "${fileName}" (${persisted.reason}) — queued for repair`);
    }
    return { savedAudioPath, audioStorageKey };
}

module.exports = { resolveProjectFiling, resolveUploadProvider, persistUploadAudio };
