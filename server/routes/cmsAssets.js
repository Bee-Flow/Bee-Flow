/**
 * CMS assets: the admin uploader (images, SVG after sanitising, WebVTT
 * captions), the read-only asset library for the reuse picker, and the public
 * asset stream (byte ranges, scriptable types forced to download).
 *
 * Extracted verbatim from routes/cms.js, which still owns the router and the
 * upload rate limiter. The clip uploader (video with sound) is routes/cmsMedia.js.
 */

const multer = require('multer');
const path = require('path');
const { HttpError } = require('../core/http/errors');
const storageStore = require('../stores/storageStore');
const { sanitizeSvg } = require('../utils/svgSanitizer');
const cmsMedia = require('./cmsMedia');
const { UPLOAD_MIME_WHITELIST, IMAGE_MAX_BYTES } = require('../core/cms/uploadPolicy');
const { parseRangeHeader } = require('../core/http/httpRange');

// Accepted MIME types for the CMS uploader live in core/cms/uploadPolicy.js
// (shared with the CMS MCP server's upload URLs). Images cover the regular
// hero/feature/logo case; image/gif + image/apng + image/webp cover animated
// graphics; video/mp4 + video/webm cover the "silent loop" video kind used by
// Media + Text. Anything outside the list is rejected as 400 by the wrapper
// middleware below (NOT 500 — fileFilter errors used to bubble up uncaught and
// surface as a generic Internal Server Error).
//
// SVG is accepted, but only after server-side sanitization (see
// handleUpload below). The asset endpoint serves the cleaned bytes
// inline with a strict CSP; unsanitized legacy SVGs are still
// force-downloaded by the isScriptableMime branch.

const upload = multer({
    storage: multer.memoryStorage(),
    // 25 MB ceiling — high enough for short demo-loop MP4s / animated GIFs
    // (the typical sim.ai-style screen recording is well under this), low
    // enough that we don't silently accept multi-hundred-MB uploads.
    limits: { fileSize: IMAGE_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        if (UPLOAD_MIME_WHITELIST.has(file.mimetype) || cmsMedia.isVttFile(file)) cb(null, true);
        else cb(new Error(`Unsupported file type: ${file.mimetype}`));
    },
});

// Wrap upload.single('file') so multer errors (LIMIT_FILE_SIZE, fileFilter
// rejections) come back as 400 with a useful message instead of the
// default 500 the upstream client sees today.
function uploadFile(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'File too large (max 25 MB)'
            : (err.message || 'Upload rejected');
        res.status(400).json({ error: message });
    });
}

async function handleUpload(req, res) {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!storageStore.isAvailable()) throw new HttpError(503, 'storage_unavailable', 'Storage unavailable');

    const ext = path.extname(req.file.originalname || '').toLowerCase() || '';
    const safeBase = (req.file.originalname || 'upload')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.[^.]+$/, '');
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase}${ext}`;
    const key = `cms/${filename}`;

    // SVGs are sanitized server-side (script / on*= / external href
    // stripped). Only the cleaned bytes ever reach storage, and we
    // tag the object as `sanitized` so the asset endpoint knows it
    // can serve it inline instead of force-downloading. A bad SVG
    // (parse fails, no <svg> root) returns 400 here.
    let body = req.file.buffer;
    let metadata = null;
    let contentType = req.file.mimetype;
    // Captions (.vtt): browsers label them '', text/plain or octet-stream, so
    // the extension and the content decide. Stored as text/vtt.
    if (!UPLOAD_MIME_WHITELIST.has(req.file.mimetype)) {
        if (!cmsMedia.isVttFile(req.file) || !cmsMedia.isValidVtt(req.file.buffer)) {
            return res.status(400).json({ error: 'Invalid captions file (a WebVTT file under 1 MB that starts with WEBVTT)' });
        }
        contentType = 'text/vtt';
    } else if (req.file.mimetype === 'image/svg+xml') {
        const clean = sanitizeSvg(req.file.buffer);
        if (!clean) return res.status(400).json({ error: 'Invalid or unsafe SVG' });
        body = clean;
        metadata = { sanitized: '1' };
    }

    await storageStore.uploadFile(key, body, contentType, metadata);

    const url = `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;
    res.json({ success: true, key, url });
}

// ── Asset library (read-only) ────────────────────────────────────
//
// GET /api/cms/admin/assets — lists previously uploaded CMS assets for
// the admin asset-reuse picker. Same org-wide bucket prefix the upload
// handler writes to ('cms/<Date.now()>-…'). storageStore.listKeys()
// requires S3 (it throws in the local-fs fallback and during a storage
// outage) — degrade to { assets: [], unavailable: true } so the picker
// can hide its entry point instead of erroring.

const ASSET_LIST_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|vtt)$/i;
const ASSET_LIST_MAX = 500;

async function listAssetsHandler(req, res) {
    try {
        const keys = await storageStore.listKeys('cms/');
        const assets = keys
            .filter((k) => ASSET_LIST_EXT_RE.test(k))
            // Keys embed their upload timestamp (cms/<Date.now()>-…), so a
            // numeric-aware descending sort is newest-first.
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .slice(0, ASSET_LIST_MAX)
            .map((key) => ({
                key,
                url: `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`,
            }));
        res.json({ assets });
    } catch (err) {
        // Local-fs mode or storage outage — not an error for the picker.
        res.json({ assets: [], unavailable: true });
    }
}

// MIME types that browsers would happily execute as script in the page
// origin if served inline. The upload whitelist already blocks new
// SVG/HTML uploads, but pre-existing assets and any future expansion of
// the whitelist must NOT be able to surprise us — so we force-download
// these by setting Content-Disposition: attachment regardless of what
// the storage layer reports.
const SCRIPTABLE_MIME_PREFIXES = ['image/svg', 'text/html', 'text/xml', 'application/xhtml', 'application/xml'];
function isScriptableMime(mime) {
    if (typeof mime !== 'string') return false;
    const lower = mime.toLowerCase();
    return SCRIPTABLE_MIME_PREFIXES.some(p => lower.startsWith(p));
}
async function serveAsset(req, res) {
    try {
        const key = req.params[0];
        if (!key.startsWith('cms/')) return res.status(404).json({ error: 'Not found' });
        if (!storageStore.isAvailable()) throw new HttpError(503, 'storage_unavailable', 'Storage unavailable');

        // Byte ranges: <video> seeking needs them and Safari/iOS will not start
        // a media resource that does not advertise them. The total size is
        // needed first to answer a suffix range or a 416.
        res.setHeader('Accept-Ranges', 'bytes');
        let range = null;
        let total = 0;
        if (req.headers.range) {
            const head = await storageStore.headFile(key);
            total = Number(head.contentLength) || 0;
            range = parseRangeHeader(req.headers.range, total);
            if (range && range.invalid) {
                res.setHeader('Content-Range', `bytes */${total}`);
                return res.status(416).end();
            }
        }

        const { stream, contentType: storedType, contentLength, metadata } = await storageStore.streamFile(key, { range });
        // Captions are always served as UTF-8 WebVTT, whatever the object
        // metadata says.
        const isVtt = key.toLowerCase().endsWith('.vtt');
        const contentType = isVtt ? 'text/vtt; charset=utf-8' : storedType;
        const sanitized = metadata && (metadata.sanitized === '1' || metadata.Sanitized === '1');

        // Defense in depth: if the stored Content-Type would execute in
        // the browser when served inline (SVG, HTML, XML), force the
        // browser to download it — UNLESS it's a sanitized SVG, in which
        // case we serve it inline with a strict CSP that blocks scripts
        // and external network fetches even if the sanitizer ever
        // misses something. Legacy SVGs without the `sanitized` flag
        // still force-download.
        if (isScriptableMime(contentType)) {
            if (sanitized && /^image\/svg/i.test(contentType)) {
                res.setHeader('Content-Type', 'image/svg+xml');
                res.setHeader('Content-Security-Policy',
                    "default-src 'none'; style-src 'unsafe-inline'");
                res.setHeader('X-Content-Type-Options', 'nosniff');
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Disposition', 'attachment');
                res.setHeader('X-Content-Type-Options', 'nosniff');
            }
        } else {
            res.setHeader('Content-Type', contentType);
            if (isVtt) res.setHeader('X-Content-Type-Options', 'nosniff');
        }
        if (range) {
            res.status(206);
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
        }
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        stream.pipe(res);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        throw err;
    }
}

module.exports = {
    uploadFile,
    handleUpload,
    listAssetsHandler,
    isScriptableMime,
    serveAsset,
};
