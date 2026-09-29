// @typecheck
/**
 * Storage Store — S3-compatible client for RustFS object storage,
 * with a local-disk fallback for dev environments without S3 infra.
 *
 * Two modes:
 *   's3'    — full feature set (presigned URLs, bucket listing, copy)
 *   'local' — uploadFile / streamFile / deleteFile only. Suitable for
 *             dev / single-host installs. Files land under
 *             server/data/storage/<key>; content types are persisted
 *             in a sidecar .meta file so streamFile can return the
 *             right MIME without re-guessing.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');
const path = require('path');
const log = require('../telemetry/log');

const BUCKET = process.env.S3_BUCKET || 'beeflow-media';
const DEFAULT_EXPIRY = 3600; // 1 hour

let s3 = null;
let mode = null;          // null until init() runs; then 's3' | 'local'
let localRoot = null;     // absolute path to server/data/storage when mode==='local'

// ── Self-healing connect state ───────────────────────────────────────────────
//
// `init()` used to be a one-shot: a non-404 HeadBucket failure (RustFS simply
// not up yet — compose has no `depends_on: rustfs`, and pod start order in k8s
// is arbitrary) left `mode === null` for the process's ENTIRE life. Every note
// that pod then created got a NULL audio_storage_key, i.e. no durable copy, and
// on a deployment with no persistent volume that means the recording is lost the
// moment the pod goes away. It is not an exotic race: it is one unlucky boot.
let configured = false;   // the RustFS env vars are present → a failure is retryable
let lastError = null;
let nextRetryAt = 0;
let connecting = null;    // in-flight reconnect, so N callers cause 1 attempt

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
let retryDelayMs = RETRY_MIN_MS;
let heartbeat = null;

function scheduleRetry(err) {
    lastError = err ? String(err.message || err) : null;
    // Jitter so a fleet of replicas that all booted into a RustFS outage do not
    // reconnect in lockstep.
    const jitter = Math.floor(retryDelayMs * 0.2 * ((process.pid % 100) / 100));
    nextRetryAt = Date.now() + retryDelayMs + jitter;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
}

function clearRetry() {
    lastError = null;
    nextRetryAt = 0;
    retryDelayMs = RETRY_MIN_MS;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

// Resolve a storage key to its on-disk path while guarding against
// path-traversal. Throws if the resolved path escapes localRoot.
function localPathFor(key, { expectedPrefix = null } = {}) {
    if (!localRoot) throw new Error('StorageStore: local mode not initialized');
    if (typeof key !== 'string' || !key) throw new Error('StorageStore: invalid key');
    // Reject traversal on the KEY itself, not just on the resolved path. Callers
    // authorize with prefix checks like `key.startsWith('users/<id>/')`, which a
    // `..` segment satisfies while resolving somewhere else entirely — the root
    // containment check below would still pass, since the escape lands inside
    // another user's prefix rather than outside localRoot.
    if (key.includes('\\') || key.includes('\0') || key.split('/').some((seg) => seg === '..')) {
        throw new Error('StorageStore: key contains a traversal segment');
    }
    if (expectedPrefix && !key.startsWith(expectedPrefix)) {
        throw new Error('StorageStore: key escapes the expected prefix');
    }
    const resolved = path.resolve(localRoot, key);
    const rootWithSep = localRoot.endsWith(path.sep) ? localRoot : localRoot + path.sep;
    if (resolved !== localRoot && !resolved.startsWith(rootWithSep)) {
        throw new Error('StorageStore: key escapes storage root');
    }
    return resolved;
}

// Minimal extension → MIME map for fallback when no sidecar is present.
// Covers the common image types used by the CMS upload flow.
const MIME_BY_EXT = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.avif': 'image/avif',
};

/**
 * Initialize the S3 client and ensure the bucket exists.
 * Called during server startup; safe to call again (see ensureAvailable).
 */
async function init() {
    const endpoint = process.env.RUSTFS_ENDPOINT;
    const accessKey = process.env.RUSTFS_ACCESS_KEY;
    const secretKey = process.env.RUSTFS_SECRET_KEY;

    configured = !!(endpoint && accessKey && secretKey);

    if (!configured) {
        // Local-disk fallback. Enables uploadFile / streamFile / deleteFile
        // for dev environments where setting up RustFS / S3 isn't worth it.
        // Other features that require presigned URLs or bucket listing stay
        // gated and will throw "local mode doesn't support …" on use.
        //
        // Reached ONLY when the env vars are absent — never as a fallback for a
        // reachability failure. See the note in the catch below.
        try {
            localRoot = path.resolve(__dirname, '..', 'data', 'storage');
            fs.mkdirSync(localRoot, { recursive: true });
            mode = 'local';
            clearRetry();
            log.warn(`[StorageStore] RustFS not configured — using local-disk fallback at ${localRoot}`);
            return true;
        } catch (err) {
            log.error(`[StorageStore] Local fallback init failed: ${err.message}`);
            localRoot = null;
            mode = null;
            return false;
        }
    }

    s3 = new S3Client({
        endpoint,
        region: 'us-east-1', // Required by SDK but ignored by RustFS
        credentials: {
            accessKeyId: accessKey,
            secretAccessKey: secretKey,
        },
        forcePathStyle: true, // Required for non-AWS S3 (RustFS, MinIO)
    });

    // Ensure bucket exists
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
        log.info(`[StorageStore] Bucket "${BUCKET}" exists`);
    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            try {
                log.info(`[StorageStore] Creating bucket "${BUCKET}"...`);
                await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
                log.info(`[StorageStore] Bucket "${BUCKET}" created`);
            } catch (createErr) {
                // Used to escape init() entirely and land in index.js's .catch,
                // leaving `mode` unassigned with nothing scheduled to retry.
                log.error(`[StorageStore] Bucket creation failed: ${createErr.message}`);
                s3 = null;
                // Clear any previously-good mode: a connect that just failed
                // must not keep isAvailable() answering true, or callers write
                // through a client that is gone.
                mode = null;
                scheduleRetry(createErr);
                startHeartbeat();
                return false;
            }
        } else {
            // NOT a silent local fallback, deliberately. `localRoot` resolves to
            // server/data/storage — the same container filesystem that already
            // holds audio_path, and on prod that has no volume behind it. Writing
            // a real-looking key that points at per-pod disk turns a detectable,
            // repairable NULL into an undetectable lie: every repair sweep skips
            // a row whose key is non-null. Staying unavailable is honest, and now
            // it is temporary.
            log.error(`[StorageStore] Failed to check bucket: ${err.name} — ${err.message}`);
            log.error(`[StorageStore] HTTP status: ${err.$metadata?.httpStatusCode}, endpoint: ${endpoint}`);
            s3 = null;
            mode = null;
            scheduleRetry(err);
            startHeartbeat();
            return false;
        }
    }

    mode = 's3';
    clearRetry();
    log.info(`[StorageStore] Connected to RustFS at ${endpoint}`);
    return true;
}

/**
 * Reconnect in the background while storage is configured but down, so a pod
 * that booted during a RustFS outage recovers on its own. Stops on success.
 */
function startHeartbeat() {
    if (heartbeat || !configured) return;
    heartbeat = setInterval(() => { ensureAvailable().catch(() => {}); }, 60_000);
    if (heartbeat.unref) heartbeat.unref();
}

/**
 * Await storage being usable, retrying a failed connect with backoff.
 *
 * Use this anywhere a durable write is about to happen: it means the FIRST
 * request after RustFS comes back succeeds, rather than the second.
 */
async function ensureAvailable() {
    if (mode !== null) return true;
    if (!configured) return false;              // local fallback failed to mkdir; nothing to retry
    if (connecting) return connecting;
    if (Date.now() < nextRetryAt) return false; // inside the backoff window
    connecting = init()
        .catch((err) => { scheduleRetry(err); return false; })
        .finally(() => { connecting = null; });
    return connecting;
}

/**
 * Check if storage is available — true when EITHER S3 is connected OR the
 * local-disk fallback is set up. Callers (e.g. /api/cms/admin/upload) gate
 * on this before accepting uploads.
 *
 * Stays synchronous (it has ~49 call sites) but kicks off a reconnect when
 * storage is configured-but-down, so even a caller that never learns about
 * `ensureAvailable` self-heals one request later.
 */
function isAvailable() {
    if (mode === null && configured && Date.now() >= nextRetryAt && !connecting) {
        ensureAvailable().catch(() => {});
    }
    return mode !== null;
}

/** Diagnostic snapshot — powers the "temporarily unavailable vs gone" UX. */
function getStatus() {
    return { mode, configured, lastError, nextRetryAt };
}

/**
 * Build a storage key with user-scoped prefix.
 * @param {string} userId - User ID for isolation
 * @param {string} category - File category: 'images', 'videos', 'audio', 'uploads', 'avatars'
 * @param {string} filename - The filename
 */
function buildKey(userId, category, filename) {
    if (category === 'avatars') {
        return `shared/avatars/${filename}`;
    }
    return `users/${userId}/${category}/${filename}`;
}

/**
 * Build a deterministic key for a webpage file slot.
 * Used by the Webpages feature to host index.html / style.css / script.js
 * (and their version snapshots) in RustFS at predictable paths.
 *
 * The 'db' slot stores a per-webpage SQLite database alongside the script
 * files — the engine runs server-side; this is just the at-rest blob.
 *
 * @param {string} userId
 * @param {string} webpageId
 * @param {'html'|'css'|'js'|'db'} slot
 * @param {string} [versionId] - when present, returns the version path
 */
function buildWebpageKey(userId, webpageId, slot, versionId = null) {
    const filename =
        slot === 'html' ? 'index.html' :
        slot === 'css'  ? 'style.css'  :
        slot === 'js'   ? 'script.js'  :
        slot === 'db'   ? 'data.db'    :
        null;
    if (!filename) throw new Error(`Unknown webpage slot: ${slot}`);
    const prefix = versionId
        ? `users/${userId}/webpages/${webpageId}/versions/${versionId}`
        : `users/${userId}/webpages/${webpageId}/current`;
    return `${prefix}/${filename}`;
}

/**
 * Build a deterministic key for an App Studio v2 per-app SQLite database.
 * Each app has at most one `data.db` blob (the DATA ENGINE), stored under a
 * per-owner prefix so the RustFS object tree mirrors the ownership model.
 *
 * Mirrors buildWebpageKey's 'db' slot, but for the studio_apps feature. The
 * engine runs server-side (see studioAppDbStore.js) — this is only the at-rest
 * blob path.
 *
 *   studio-apps/{ownerId}/{appId}/data.db
 *
 * @param {string} ownerId
 * @param {string} appId
 */
function buildStudioAppKey(ownerId, appId) {
    if (!ownerId || !appId) throw new Error('buildStudioAppKey requires ownerId and appId');
    return `studio-apps/${ownerId}/${appId}/data.db`;
}

/**
 * Key for one App Studio ATTACHMENT blob (content-addressed by sha256, under
 * the same per-owner prefix as the app's data.db). Single source of truth —
 * used by routes/studioAppFiles.js (upload/stream) and the app-trigger bridge
 * (appStudio/actionExecutor.js) to mint temp download URLs for automations.
 *
 *   studio-apps/{ownerId}/{appId}/attachments/{sha256}
 */
function buildStudioAppAttachmentKey(ownerId, appId, sha256) {
    if (!ownerId || !appId || !sha256) throw new Error('buildStudioAppAttachmentKey requires ownerId, appId and sha256');
    return `studio-apps/${ownerId}/${appId}/attachments/${sha256}`;
}

/**
 * Key for one artifact of an App Studio LARGE DATASET (genome files etc.),
 * under the same per-owner prefix as the app's data.db and attachments.
 * Datasets are NOT attachments: they have their own ledger
 * (stores/datasetFileStore.js), their own quota axis and their own AV story,
 * so they get their own subtree instead of a row in studio_app_attachments.
 *
 *   studio-apps/{ownerId}/{appId}/datasets/{datasetId}/{artifact}
 *
 * @param {string} ownerId
 * @param {string} appId
 * @param {string} datasetId
 * @param {string} artifact - 'raw' | 'data.bgz' | 'index.bin' | 'rsid/NN.bin' (NN = 00..63)
 */
function buildStudioAppDatasetKey(ownerId, appId, datasetId, artifact) {
    if (!ownerId || !appId || !datasetId || !artifact) {
        throw new Error('buildStudioAppDatasetKey requires ownerId, appId, datasetId and artifact');
    }
    if (!/^(raw|data\.bgz|index\.bin|rsid\/(?:[0-5][0-9]|6[0-3])\.bin)$/.test(artifact)) {
        throw new Error(`buildStudioAppDatasetKey: unknown artifact "${artifact}"`);
    }
    return `studio-apps/${ownerId}/${appId}/datasets/${datasetId}/${artifact}`;
}

/**
 * Key for a blob belonging to one automation — content-addressed by sha256,
 * under the automation's owner.
 *
 *   automation-forms/{ownerId}/{automationId}/{sha256}
 *
 * Both directions share the prefix: a file a visitor UPLOADED through a form
 * (routes/automation/formPublic.js) and a document a run GENERATED
 * (core/automationRunner/engine.js). What distinguishes them is which ledger
 * table holds the row, not where the bytes sit — and content-addressing means
 * the same document rendered twice costs one object.
 *
 * The prefix is deliberately absent from tempDownloadUrl's isTempDownloadKey
 * allow-list: nothing here is reachable by a signed URL. Automation blobs are
 * served only through routes that first prove the caller owns the run (or holds
 * the form session that produced it).
 */
function buildAutomationFileKey(ownerId, automationId, sha256) {
    if (!ownerId || !automationId || !sha256) throw new Error('buildAutomationFileKey requires ownerId, automationId and sha256');
    return `automation-forms/${ownerId}/${automationId}/${sha256}`;
}

/**
 * List all keys under a prefix (used to purge a webpage's entire object tree on delete).
 * Returns an array of keys.
 */
async function listKeys(prefix) {
    if (!s3) throw new Error('StorageStore not initialized');
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const keys = [];
    let continuationToken;
    do {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }));
        for (const obj of (r.Contents || [])) keys.push(obj.Key);
        continuationToken = r.IsTruncated ? r.NextContinuationToken : null;
    } while (continuationToken);
    return keys;
}

/**
 * Server-side copy of one object to another key. Used for snapshotting
 * a webpage's "current" trio into a versions/{vid}/ prefix without
 * round-tripping bytes through Node.
 */
async function copyObject(sourceKey, destKey) {
    if (mode === 'local') {
        const src = localPathFor(sourceKey);
        const dst = localPathFor(destKey);
        if (!fs.existsSync(src)) {
            // Mirror the S3 NoSuchKey shape so callers can use the same handling.
            const err = /** @type {Error & {$metadata?: {httpStatusCode: number}}} */ (new Error(`NoSuchKey: ${sourceKey}`));
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        // Carry the content-type and tags sidecars so streamFile returns the
        // same MIME on the copy. Best-effort — missing sidecars are fine.
        for (const ext of ['.meta', '.tags']) {
            if (fs.existsSync(src + ext)) {
                try { fs.copyFileSync(src + ext, dst + ext); } catch (_) { /* ignore */ }
            }
        }
        return;
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { CopyObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `/${BUCKET}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        Key: destKey,
    }));
}

/**
 * Upload a file to RustFS.
 * @param {string} key - S3 object key (use buildKey() to generate)
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type (e.g. 'image/png', 'video/mp4')
 * @param {Object} [metadata] - Optional flat string map persisted alongside
 *   the object. In S3 mode it lands in user-defined metadata (returned by
 *   HEAD/GET as `x-amz-meta-*`). In local mode it's written to a `.tags`
 *   sidecar next to the bytes. Used today to flag SVGs as sanitized.
 * @returns {Promise<{ key: string }>} Uploaded object key
 */
async function uploadFile(key, buffer, contentType, metadata = null) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
        // Sidecar holds the content type so streamFile can return the right
        // MIME without re-guessing from the extension.
        if (contentType) {
            try { fs.writeFileSync(filePath + '.meta', String(contentType), 'utf8'); }
            catch (_) { /* non-fatal — extension fallback covers this */ }
        }
        if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
            try { fs.writeFileSync(filePath + '.tags', JSON.stringify(metadata), 'utf8'); }
            catch (_) { /* non-fatal */ }
        }
        log.info(`[StorageStore:local] Uploaded: ${key} (${(buffer.length / 1024).toFixed(1)} KB)`);
        return { key };
    }
    if (!s3) throw new Error('StorageStore not initialized');

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ...(metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
            ? { Metadata: metadata }
            : {}),
    }));

    log.info(`[StorageStore] Uploaded: ${key} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return { key };
}

// ── Multipart upload ─────────────────────────────────────────────────────────
//
// For objects too large to hold as one Buffer (multi-GB dataset files). The
// caller streams the object in parts; each part IS still a Buffer, but a
// bounded one (the dataset routes use 32 MB parts). Any replica can upload any
// part or complete the upload — the uploadId and part ETags live with the
// caller (the dataset manifest row), not in process state.
//
// Local mode mirrors the S3 contract with `.mpu-<uploadId>/part-NNNNNN` files
// that `complete` concatenates. ETags are md5 hex like S3's, so callers can
// treat both modes identically.

const MPU_PART_DIR = (filePath, uploadId) => `${filePath}.mpu-${uploadId}`;
const MPU_PART_FILE = (dir, partNumber) => path.join(dir, `part-${String(partNumber).padStart(6, '0')}`);

/**
 * Start a multipart upload. @returns {Promise<{ uploadId: string }>}
 */
async function beginMultipartUpload(key, contentType = 'application/octet-stream') {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        const uploadId = require('crypto').randomBytes(16).toString('hex');
        const dir = MPU_PART_DIR(filePath, uploadId);
        fs.mkdirSync(dir, { recursive: true });
        // Content type recorded now so `complete` can write the .meta sidecar
        // even if the process that began the upload is not the one finishing it.
        fs.writeFileSync(path.join(dir, 'content-type'), String(contentType || 'application/octet-stream'), 'utf8');
        return { uploadId };
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { CreateMultipartUploadCommand } = require('@aws-sdk/client-s3');
    const r = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }));
    return { uploadId: r.UploadId };
}

/**
 * Upload one part. Part numbers are 1-based (the S3 rule; local mode enforces
 * the same so the two modes cannot drift). @returns {Promise<{ etag: string }>}
 */
async function uploadPartBuffer(key, uploadId, partNumber, buffer) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
        throw new Error(`uploadPartBuffer: partNumber must be 1..10000, got ${partNumber}`);
    }
    if (!Buffer.isBuffer(buffer)) throw new Error('uploadPartBuffer: buffer required');
    if (mode === 'local') {
        const filePath = localPathFor(key);
        const dir = MPU_PART_DIR(filePath, uploadId);
        if (!fs.existsSync(dir)) throw new Error(`uploadPartBuffer: unknown uploadId for ${key}`);
        fs.writeFileSync(MPU_PART_FILE(dir, partNumber), buffer);
        const etag = require('crypto').createHash('md5').update(buffer).digest('hex');
        return { etag };
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { UploadPartCommand } = require('@aws-sdk/client-s3');
    const r = await s3.send(new UploadPartCommand({
        Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: buffer,
    }));
    return { etag: r.ETag };
}

/**
 * Finish a multipart upload.
 * @param {Array<{partNumber:number, etag:string}>} parts - ALL parts, in order.
 */
async function completeMultipartUpload(key, uploadId, parts) {
    if (!Array.isArray(parts) || parts.length === 0) throw new Error('completeMultipartUpload: parts required');
    if (mode === 'local') {
        const filePath = localPathFor(key);
        const dir = MPU_PART_DIR(filePath, uploadId);
        if (!fs.existsSync(dir)) throw new Error(`completeMultipartUpload: unknown uploadId for ${key}`);
        for (const p of parts) {
            if (!fs.existsSync(MPU_PART_FILE(dir, p.partNumber))) {
                throw new Error(`completeMultipartUpload: missing part ${p.partNumber}`);
            }
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // Streamed concat, not readFileSync-and-append: the assembled object can
        // be tens of GB and must not be materialised (or block the event loop).
        const { pipeline } = require('stream/promises');
        const out = fs.createWriteStream(filePath);
        try {
            const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
            for (const p of ordered) {
                await pipeline(fs.createReadStream(MPU_PART_FILE(dir, p.partNumber)), out, { end: false });
            }
        } finally {
            out.end();
        }
        let contentType = 'application/octet-stream';
        try { contentType = fs.readFileSync(path.join(dir, 'content-type'), 'utf8').trim() || contentType; } catch (_) { /* default */ }
        try { fs.writeFileSync(filePath + '.meta', contentType, 'utf8'); } catch (_) { /* non-fatal */ }
        fs.rmSync(dir, { recursive: true, force: true });
        log.info(`[StorageStore:local] Multipart complete: ${key} (${parts.length} parts)`);
        return { key };
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
    await s3.send(new CompleteMultipartUploadCommand({
        Bucket: BUCKET, Key: key, UploadId: uploadId,
        MultipartUpload: {
            Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber)
                .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
    }));
    log.info(`[StorageStore] Multipart complete: ${key} (${parts.length} parts)`);
    return { key };
}

/** Abort a multipart upload and discard its parts. Never throws on a miss. */
async function abortMultipartUpload(key, uploadId) {
    if (mode === 'local') {
        try {
            const filePath = localPathFor(key);
            fs.rmSync(MPU_PART_DIR(filePath, uploadId), { recursive: true, force: true });
        } catch (_) { /* already gone */ }
        return;
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
    try {
        await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
    } catch (err) {
        if (err?.name !== 'NoSuchUpload' && err?.$metadata?.httpStatusCode !== 404) throw err;
    }
}

/**
 * Generate a presigned download URL for a file.
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL lifetime in seconds (default: 1 hour)
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUrl(key, expiresIn = DEFAULT_EXPIRY) {
    if (mode === 'local') {
        // No signing in local mode — return the proxy URL. Callers that
        // truly need short-lived signed URLs (private buckets, etc.) need
        // S3 mode and should treat this as a soft fallback.
        return buildProxyUrl(key);
    }
    if (!s3) throw new Error('StorageStore not initialized');

    const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }), { expiresIn });

    return url;
}

/**
 * Delete a file from RustFS.
 * @param {string} key - S3 object key
 */
async function deleteFile(key) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        try { fs.unlinkSync(filePath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { fs.unlinkSync(filePath + '.meta'); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(filePath + '.tags'); } catch (_) { /* ignore */ }
        log.info(`[StorageStore:local] Deleted: ${key}`);
        return;
    }
    if (!s3) throw new Error('StorageStore not initialized');

    await s3.send(new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
    }));

    log.info(`[StorageStore] Deleted: ${key}`);
}

/**
 * Stream a file from RustFS.
 * @param {string} key - S3 object key
 * @returns {Promise<{ stream: import('stream').Readable, contentType: string, contentLength: number, totalLength: number, contentRange: string|null, metadata: Object }>}
 *   `metadata` is the same flat string map passed to uploadFile (read back
 *   from S3 user-metadata or the .tags sidecar). Always an object — empty
 *   when nothing was stored.
 */
async function streamFile(key, { range = null } = {}) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                // Surface the same shape S3 throws on miss so the asset
                // route's existing 404 branch catches it.
                const e = new Error(`Object not found: ${key}`);
                e.name = 'NoSuchKey';
                throw e;
            }
            throw err;
        }
        // Sidecar wins; fall back to extension lookup; finally octet-stream.
        let contentType = 'application/octet-stream';
        try {
            const meta = fs.readFileSync(filePath + '.meta', 'utf8').trim();
            if (meta) contentType = meta;
        } catch (_) { /* no sidecar */ }
        if (contentType === 'application/octet-stream') {
            const ext = path.extname(filePath).toLowerCase();
            if (MIME_BY_EXT[ext]) contentType = MIME_BY_EXT[ext];
        }
        let metadata = {};
        try {
            const raw = fs.readFileSync(filePath + '.tags', 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') metadata = parsed;
        } catch (_) { /* no sidecar */ }
        // A byte range makes <audio> seeking work and is what Safari/iOS
        // require before they will start playing a media resource at all.
        const readOpts = range ? { start: range.start, end: range.end } : {};
        const contentLength = range ? (range.end - range.start + 1) : stat.size;
        return {
            stream: fs.createReadStream(filePath, readOpts),
            contentType,
            contentLength,
            totalLength: stat.size,
            contentRange: range ? `bytes ${range.start}-${range.end}/${stat.size}` : null,
            metadata,
        };
    }
    if (!s3) throw new Error('StorageStore not initialized');

    const response = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    }));

    // "bytes 0-99/12345" → 12345. Absent on a non-ranged response, where
    // ContentLength IS the whole object.
    const totalFromRange = response.ContentRange
        ? Number(String(response.ContentRange).split('/').pop())
        : null;
    return {
        stream: response.Body,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength,
        totalLength: Number.isFinite(totalFromRange) ? totalFromRange : response.ContentLength,
        contentRange: response.ContentRange || null,
        metadata: response.Metadata || {},
    };
}

/**
 * Size + content type without transferring the body. Needed to answer a suffix
 * range (`bytes=-500`) and to emit a correct `416 Content-Range: bytes *\/N`.
 */
async function headFile(key) {
    if (mode === 'local') {
        const filePath = localPathFor(key);
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                const e = new Error(`Object not found: ${key}`);
                e.name = 'NoSuchKey';
                throw e;
            }
            throw err;
        }
        let contentType = 'application/octet-stream';
        try {
            const meta = fs.readFileSync(filePath + '.meta', 'utf8').trim();
            if (meta) contentType = meta;
        } catch (_) { /* no sidecar */ }
        if (contentType === 'application/octet-stream') {
            const ext = path.extname(filePath).toLowerCase();
            if (MIME_BY_EXT[ext]) contentType = MIME_BY_EXT[ext];
        }
        return { contentLength: stat.size, contentType };
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const response = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return {
        contentLength: response.ContentLength,
        contentType: response.ContentType || 'application/octet-stream',
    };
}

/**
 * Build a proxy URL for a stored file.
 * @param {string} key - S3 object key
 * @returns {string} Proxy URL path
 */
function buildProxyUrl(key) {
    // Encode each path segment individually so slashes remain real /
    // (avoids %2F issues with nginx proxy and browser URL handling)
    return `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`;
}

module.exports = {
    init,
    isAvailable,
    ensureAvailable,
    getStatus,
    headFile,
    buildKey,
    buildWebpageKey,
    buildStudioAppKey,
    buildStudioAppAttachmentKey,
    buildStudioAppDatasetKey,
    buildAutomationFileKey,
    uploadFile,
    beginMultipartUpload,
    uploadPartBuffer,
    completeMultipartUpload,
    abortMultipartUpload,
    getPresignedUrl,
    streamFile,
    buildProxyUrl,
    deleteFile,
    listKeys,
    copyObject,
    BUCKET,
};
