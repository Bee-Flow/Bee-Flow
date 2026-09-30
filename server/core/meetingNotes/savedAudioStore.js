// @typecheck
/**
 * Durable saved-recording storage.
 *
 * A meeting's audio is copied to the local `data/uploads/saved-recordings`
 * folder so it can be replayed and re-transcribed. On a single-node self-host
 * that folder lives on a persistent disk and is enough. On the multi-replica
 * SaaS (Kubernetes) it is NOT: each pod has its own ephemeral filesystem, so a
 * deploy/restart — or simply a request landing on another replica — makes the
 * file vanish, and "Re-transcribe" then fails with "Saved audio not found".
 *
 * When object storage (RustFS/S3) is configured we ALSO keep a durable copy
 * there and fall back to it. The local copy stays the fast path; object storage
 * is the backstop that makes replay/reprocess survive restarts and replicas.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline: streamPipeline } = require('stream/promises');
const log = require('../../telemetry/log');

const MIME_BY_EXT = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.mp4': 'audio/mp4', '.opus': 'audio/ogg',
};

/** The one place that knows where saved recordings live on this pod. */
const SAVED_RECORDINGS_DIR = path.resolve(__dirname, '../../data/uploads/saved-recordings');

/**
 * Where an incoming recording sits while it is processed: the multer upload,
 * a Nextcloud or Meet download. Scratch, so /tmp and not the data volume: it
 * is deleted when the pipeline ends, an orphan from a crash is gone after a
 * restart instead of piling up on the persistent disk, and a volume the server
 * cannot write (one left root-owned by the old root image) no longer blocks
 * the upload before the RustFS copy is even attempted.
 */
const AUDIO_SCRATCH_DIR = path.join(os.tmpdir(), 'beeflow-audio');

/** Object-storage key for a saved recording, from its local basename. */
function savedAudioKey(basename) {
    return `saved-recordings/${basename}`;
}

/**
 * Content type for an audio file, from its name or storage key.
 *
 * Extension FIRST, deliberately: the key's extension came from the real
 * uploaded filename and is trustworthy, whereas a stored object's reported type
 * may be blank or wrong for anything written before types were set. The old
 * `|| 'audio/mpeg'` default labelled every browser recording (WebM/Opus) as MP3,
 * which browsers refuse to decode.
 */
function contentTypeForAudio(nameOrKey, reported = null) {
    const ext = path.extname(String(nameOrKey || '')).toLowerCase();
    if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
    if (reported && reported !== 'application/octet-stream') return reported;
    return 'application/octet-stream';
}

const PERSIST_ATTEMPTS = 3;
const PERSIST_BACKOFF_MS = [400, 1500];   // total inline budget stays under ~4s

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Persist a saved recording to object storage.
 *
 * This is the ONLY durable copy on a deployment without a persistent volume, so
 * it retries rather than giving up after one attempt, and it reports WHY it
 * failed instead of collapsing everything to `null`. A bare null was
 * indistinguishable from "this install has no object storage", so a transient
 * RustFS blip silently produced a note whose audio could never be recovered.
 *
 * @returns {Promise<{ok: boolean, key: string|null, reason: string, error?: string}>}
 *   reason ∈ 'stored' | 'not_configured' | 'unavailable' | 'failed'
 */
async function persistSavedAudioToStorage(key, buffer, ext) {
    const storageStore = require('../../stores/storageStore');
    // ensureAvailable, not isAvailable: after a RustFS outage this makes the
    // FIRST upload succeed rather than the one after it.
    const available = await storageStore.ensureAvailable();
    if (!available) {
        const { configured } = storageStore.getStatus();
        const reason = configured ? 'unavailable' : 'not_configured';
        if (configured) {
            log.error(`[SavedAudio] DURABLE COPY FAILED for ${key} — object storage unreachable`);
        }
        return { ok: false, key: null, reason };
    }

    const contentType = contentTypeForAudio(key, null) === 'application/octet-stream'
        ? (MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream')
        : contentTypeForAudio(key, null);

    let lastErr = null;
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
        try {
            await storageStore.uploadFile(key, buffer, contentType);
            return { ok: true, key, reason: 'stored' };
        } catch (e) {
            lastErr = e;
            if (attempt < PERSIST_ATTEMPTS) await sleep(PERSIST_BACKOFF_MS[attempt - 1] || 1500);
        }
    }
    // Stable and greppable — this line is the alert for "a meeting was accepted
    // with no durable copy". The backfill job will retry from the local file.
    log.error(`[SavedAudio] DURABLE COPY FAILED for ${key} after ${PERSIST_ATTEMPTS} attempts: ${lastErr?.message}`);
    return { ok: false, key: null, reason: 'failed', error: lastErr?.message };
}

/** Is this path inside the saved-recordings folder we own? */
function insideSavedDir(p) {
    if (!p) return false;
    const resolved = path.resolve(p);
    return resolved.startsWith(SAVED_RECORDINGS_DIR + path.sep);
}

// Writing the fetched object back to local disk turns "every replay re-downloads
// the whole recording" into "one download per pod". Opt-out because the pod's
// ephemeral disk is finite.
const LOCAL_CACHE_ENABLED = process.env.SAVED_AUDIO_LOCAL_CACHE !== 'false';

/**
 * Resolve a note's saved audio to a readable LOCAL file path, preferring the
 * local copy and falling back to the durable object-storage copy.
 *
 * ALWAYS returns an object. A bare `null` could not distinguish "the recording
 * is genuinely gone" from "object storage is having a minute", so the caller had
 * to tell every user to upload the file again — impossible advice for a meeting
 * recorded in the browser, where those bytes existed nowhere else.
 *
 * @param {{audioPath?: string, audioStorageKey?: string}} note
 * @returns {Promise<{path: string|null, cleanup?: () => void, fromStorage?: boolean, cached?: boolean, reason?: string}>}
 *   reason ∈ 'never_durable' (terminal) | 'storage_unavailable' (retryable) | 'fetch_failed' (terminal)
 */
async function resolveSavedAudio({ audioPath, audioStorageKey } = {}) {
    if (audioPath) {
        try {
            await fs.promises.access(audioPath);
            return { path: audioPath, cleanup: () => {}, fromStorage: false, cached: false };
        } catch (_) { /* local copy gone — try object storage */ }
    }
    if (!audioStorageKey) {
        return { path: null, reason: 'never_durable' };
    }

    const storageStore = require('../../stores/storageStore');
    if (!(await storageStore.ensureAvailable())) {
        return { path: null, reason: 'storage_unavailable' };
    }

    // Restore into the note's own local slot when we can, so the next play is
    // served from disk with full Range support.
    const cacheable = LOCAL_CACHE_ENABLED && insideSavedDir(audioPath);
    // Millisecond-only entropy collides: two replicas resolving the same note in
    // the same tick wrote to one path and each unlinked it from under the other.
    const ext = path.extname(audioStorageKey) || '.audio';
    const dest = cacheable
        ? `${audioPath}.${crypto.randomUUID()}.part`
        : path.join(os.tmpdir(), `saved-audio-${crypto.randomUUID()}${ext}`);

    try {
        const { stream } = await storageStore.streamFile(audioStorageKey);
        // `pipeline` destroys both ends on error; the hand-rolled promise left
        // the write stream open and, more importantly, left a partial file
        // behind — a failed fetch leaked a multi-megabyte temp file on every
        // attempt, and reprocess retries in a loop.
        await streamPipeline(stream, fs.createWriteStream(dest));

        if (cacheable) {
            await fs.promises.mkdir(path.dirname(audioPath), { recursive: true });
            // Atomic: a concurrent reader never sees a half-written file.
            await fs.promises.rename(dest, audioPath);
            // 🔴 cleanup MUST be a no-op here. Reprocess calls it unconditionally
            // in its `finally`; deleting would throw away the copy we just
            // restored and put the note straight back into the broken state.
            return { path: audioPath, cleanup: () => {}, fromStorage: true, cached: true };
        }
        return {
            path: dest,
            cleanup: () => { try { fs.unlinkSync(dest); } catch (_) { /* already gone */ } },
            fromStorage: true,
            cached: false,
        };
    } catch (e) {
        try { await fs.promises.unlink(dest); } catch (_) { /* never created */ }
        log.error('[SavedAudio] Object-storage fetch failed:', e.message);
        // A key that exists but will not fetch means RustFS lost the object —
        // terminal, and worth noticing separately from an outage.
        const notFound = e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);
        return { path: null, reason: notFound ? 'fetch_failed' : 'storage_unavailable' };
    }
}

// One repair per basename at a time: twenty Range requests for one recording
// must not become twenty uploads of the same bytes.
const repairsInFlight = new Set();

/**
 * Back-fill the durable copy for a note whose local file is readable but whose
 * `audio_storage_key` is NULL. Fire-and-forget; never blocks a response.
 *
 * @returns {Promise<string|null>} the key when it was stored, else null.
 * @param {{ id?: string, ownerId?: string, audioPath?: string, audioStorageKey?: string }} [opts]
 */
async function repairSavedAudio({ id, ownerId, audioPath, audioStorageKey } = {}) {
    if (!id || !ownerId || !audioPath || audioStorageKey) return null;
    const basename = path.basename(audioPath);
    if (repairsInFlight.has(basename)) return null;
    repairsInFlight.add(basename);
    try {
        const buf = await fs.promises.readFile(audioPath);
        const key = savedAudioKey(basename);
        const res = await persistSavedAudioToStorage(key, buf, path.extname(basename));
        if (!res.ok) return null;
        const transcriptionStore = require('../../stores/transcriptionStore');
        // IfMissing: two replicas can spot the same unstored file; the loser
        // must not overwrite a key that is already good.
        await transcriptionStore.updateTranscription(id, ownerId, { audioStorageKeyIfMissing: key });
        log.info(`[SavedAudio] Repaired durable copy for note ${id} → ${key}`);
        return key;
    } catch (e) {
        log.warn(`[SavedAudio] Repair failed for note ${id}: ${e.message}`);
        return null;
    } finally {
        repairsInFlight.delete(basename);
    }
}

/**
 * Throw away a saved recording that no note will ever point at.
 *
 * The durable copy is made BEFORE the note row exists, so every path that ends
 * without a row — a concurrent ingest winning the `source_uri` race, or the
 * INSERT itself failing — used to leave the local file and the object-storage
 * object behind with nothing referencing them. Nothing cleans those up later:
 * the delete path finds them via the note row, and there is no note row. On a
 * duplicated Meet import that is one full recording orphaned per duplicate.
 */
async function discardSavedAudio({ audioPath = null, audioStorageKey = null } = {}) {
    if (audioPath) {
        try { await fs.promises.unlink(audioPath); }
        catch (e) { if (e.code !== 'ENOENT') log.warn('[SavedAudio] Could not discard local copy:', e.message); }
    }
    if (audioStorageKey) {
        try {
            const storageStore = require('../../stores/storageStore');
            if (storageStore.isAvailable()) await storageStore.deleteFile(audioStorageKey);
        } catch (e) {
            log.warn('[SavedAudio] Could not discard durable copy:', e.message);
        }
    }
}

module.exports = {
    savedAudioKey,
    persistSavedAudioToStorage,
    resolveSavedAudio,
    discardSavedAudio,
    repairSavedAudio,
    contentTypeForAudio,
    SAVED_RECORDINGS_DIR,
    AUDIO_SCRATCH_DIR,
    MIME_BY_EXT,
};
