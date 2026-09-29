/**
 * Storage Proxy — Auth-protected file streaming from RustFS
 *
 * GET /api/storage/file/{key...}
 * - Requires authenticated session
 * - Validates user owns the file (key starts with users/{userId}/ or shared/)
 * - Streams file directly from S3 with correct Content-Type
 *
 * GET /api/storage/tmp/:token
 * - No auth required — used by external services (e.g. Azure Whisper batch)
 * - Token is an HMAC-signed, time-limited URL with the key embedded; the
 *   minting and the verification live in utils/tempDownloadUrl.js
 *
 * ── Deliberately NOT behind a zod schema ────────────────────────────────────
 *
 * Neither route takes a body, and neither reads a query value that could fall
 * back to something wider:
 *
 *   - /tmp/:token is fetched by a THIRD PARTY (a transcription batch, a model
 *     provider pulling an image). We mint the URL, but the fetcher owns the
 *     request, and a strict query schema would turn any parameter it appends
 *     into a failed transcription nobody sees. What it reads — `key` and
 *     `expires` — is covered by the HMAC, so every malformed or altered value
 *     already fails CLOSED (400 missing / 403 / 410) in verifyTempSignature,
 *     including a repeated `?key=` (an array is a traversal, so forbidden).
 *   - /file/* reads nothing but its path. The client puts cache-busters
 *     (`?v=`, `?t=`) on URLs like these elsewhere; refusing one here would
 *     break an <img>, not protect a file.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const storageStore = require('../stores/storageStore');
const { hasTraversal, verifyTempSignature } = require('../utils/tempDownloadUrl');

// GET /api/storage/tmp/:token — unauthenticated, HMAC-verified temp download
router.get('/tmp/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const key = req.query.key;
        const expires = parseInt(req.query.expires, 10);

        log.info(`[StorageProxy] Temp download request: key=${key}, UA=${req.get('User-Agent')?.substring(0, 80)}, IP=${req.ip}`);

        const verdict = verifyTempSignature(key, expires, token);
        if (verdict === 'missing') {
            log.warn('[StorageProxy] Temp download: missing parameters');
            return res.status(400).json({ error: 'Missing parameters' });
        }
        if (verdict === 'forbidden') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (verdict === 'expired') {
            log.warn(`[StorageProxy] Temp download: URL expired for key=${key}`);
            return res.status(410).json({ error: 'URL expired' });
        }
        if (verdict !== 'ok') {
            return res.status(403).json({ error: 'Invalid token' });
        }

        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'Storage not available' });
        }

        const { stream, contentType, contentLength } = await storageStore.streamFile(key);

        // Set proper Content-Type (default to octet-stream, not audio/wav which was the old transcription default)
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'no-store');
        // Allow cross-origin image fetching (Azure AI, etc.)
        res.setHeader('Access-Control-Allow-Origin', '*');

        log.info(`[StorageProxy] Serving temp file: key=${key}, type=${contentType}, size=${contentLength || 'unknown'}`);
        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'File not found' });
        }
        log.error('[StorageProxy] Temp download error:', err.message);
        res.status(500).json({ error: 'Failed to retrieve file' });
    }
});

// GET /api/storage/file/* — stream a file from RustFS
router.get('/file/{*fileKey}', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Extract key from the wildcard path (everything after /file/).
        // path-to-regexp v8 returns wildcard params as an array of segments,
        // and the router has ALREADY percent-decoded each one — which is how
        // storageStore.buildProxyUrl encodes them. A second decodeURIComponent
        // here turned the minted URL for `50% off.png` into a URIError (a 500)
        // and looked a name containing `%41` up as `A`, another key.
        const rawKey = req.params.fileKey;
        let key = Array.isArray(rawKey) ? rawKey.join('/') : (rawKey || '');

        // Express wildcard captures often include the leading slash, which breaks prefix checking!
        if (key.startsWith('/')) {
            key = key.substring(1);
        }
        if (!key) {
            return res.status(400).json({ error: 'File key required' });
        }

        // Reject traversal BEFORE the prefix checks below — they are plain
        // string comparisons and would otherwise be satisfied by a key that
        // resolves outside the user's own prefix. See hasTraversal.
        if (hasTraversal(key)) {
            log.warn(`[StorageProxy] Rejected traversal attempt: sessionUserId="${userId}" key="${key}"`);
            return res.status(403).json({ error: 'Access denied' });
        }

        // Security: user can only access their own files or shared assets
        const isOwnFile = key.startsWith(`users/${userId}/`);
        const isSharedFile = key.startsWith('shared/');
        if (!isOwnFile && !isSharedFile) {
            log.warn(`[StorageProxy] Access denied: sessionUserId="${userId}" key="${key}"`);
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'Storage not available' });
        }

        const { stream, contentType, contentLength } = await storageStore.streamFile(key);

        const mime = contentType || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        // These bytes are user-uploaded and `shared/` objects are readable by
        // every authenticated user, so an SVG or HTML object would otherwise
        // execute in this origin. Same policy as the App Studio attachment
        // route (studioAppFiles.js): never sniff, and only render inline the
        // types that are safe to render.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const inline = (/^image\//.test(mime) && mime !== 'image/svg+xml') || mime === 'application/pdf';
        // Attachments carry their file name so a generated .pptx/.docx saves
        // under the name the assistant quoted, not the storage stamp. ASCII
        // only in the plain parameter; the RFC 5987 form carries the rest.
        const base = key.split('/').pop() || '';
        const asciiName = base.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
        res.setHeader('Content-Disposition', inline
            ? 'inline'
            : `attachment; filename="${asciiName || 'download'}"; filename*=UTF-8''${encodeURIComponent(base)}`);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        // Cache for 1 day — files are immutable (unique filenames)
        res.setHeader('Cache-Control', 'private, max-age=86400');

        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'File not found' });
        }
        log.error('[StorageProxy] Error streaming file:', err.message);
        res.status(500).json({ error: 'Failed to retrieve file' });
    }
});

module.exports = router;
