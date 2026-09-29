// @typecheck
// Extra files (multi-file webpages): mime/text classification, path
// validation, the RustFS reads/writes under the `extras/` prefix, and the
// `webpage_extra_files` CRUD that mirrors them.

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const storageStore = require('../storageStore');
const { initDB } = require('./schema');
const { sha256 } = require('./shared');

// ── Extra-files (multi-file) RustFS helpers ────────────────────────
//
// Extra files live at `users/{userId}/webpages/{webpageId}/extras/{path}`.
// The path is the user-facing relative path (e.g. "components/header.html",
// "assets/logo.svg"). RustFS S3 supports slashes in keys natively.

const TEXT_MIME_PREFIXES = ['text/', 'application/javascript', 'application/json', 'application/xml', 'image/svg+xml'];
const TEXT_EXTENSIONS = new Set([
    'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'txt', 'md', 'svg', 'xml', 'csv', 'tsv', 'yaml', 'yml',
    // React/TS source — full-tier & react-mui projects author these as extras
    'jsx', 'ts', 'tsx', 'mts', 'cts', 'scss', 'less', 'env',
]);

function isTextFile(mime, ext) {
    if (mime && TEXT_MIME_PREFIXES.some(p => mime.startsWith(p))) return true;
    if (ext && TEXT_EXTENSIONS.has(ext.toLowerCase())) return true;
    return false;
}

function guessMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = {
        html: 'text/html; charset=utf-8',
        htm: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8',
        js: 'application/javascript; charset=utf-8',
        mjs: 'application/javascript; charset=utf-8',
        cjs: 'application/javascript; charset=utf-8',
        jsx: 'text/jsx; charset=utf-8',
        ts: 'application/typescript; charset=utf-8',
        tsx: 'text/tsx; charset=utf-8',
        mts: 'application/typescript; charset=utf-8',
        cts: 'application/typescript; charset=utf-8',
        scss: 'text/x-scss; charset=utf-8',
        less: 'text/x-less; charset=utf-8',
        env: 'text/plain; charset=utf-8',
        json: 'application/json; charset=utf-8',
        txt: 'text/plain; charset=utf-8',
        md: 'text/markdown; charset=utf-8',
        svg: 'image/svg+xml; charset=utf-8',
        xml: 'application/xml; charset=utf-8',
        csv: 'text/csv; charset=utf-8',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        otf: 'font/otf',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        webm: 'video/webm',
        pdf: 'application/pdf',
    };
    return { mime: map[ext] || 'application/octet-stream', ext };
}

/**
 * Path validation: allow nested folders, reject path traversal, leading /,
 * empty segments, or anything weird. Reserved names are blocked because
 * they collide with the primary slots' filenames.
 */
const RESERVED_PATHS = new Set(['index.html', 'style.css', 'script.js']);
function validateExtraPath(path) {
    if (typeof path !== 'string' || !path.trim()) return 'path is required';
    if (path.length > 240) return 'path is too long';
    if (path.startsWith('/') || path.startsWith('\\')) return 'path must be relative (no leading slash)';
    if (path.includes('..')) return 'path may not contain ".."';
    if (/^\s|\s$/.test(path)) return 'path may not start or end with whitespace';
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) return 'path is empty';
    for (const s of segs) {
        if (!s || s === '.' || s === '..') return `invalid path segment "${s}"`;
        if (!/^[A-Za-z0-9_.\- @]+$/.test(s)) return `path segment "${s}" contains unsupported characters`;
    }
    if (RESERVED_PATHS.has(path)) return `"${path}" is a primary slot — use webpage_file_write({file:"${path === 'index.html' ? 'html' : path === 'style.css' ? 'css' : 'js'}", ...}) instead`;
    return null;
}

function extraKey(userId, webpageId, path) {
    return `users/${userId}/webpages/${webpageId}/extras/${path}`;
}

async function readExtra(userId, webpageId, path) {
    if (!storageStore.isAvailable()) return null;
    try {
        const { stream } = await storageStore.streamFile(extraKey(userId, webpageId, path));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

async function writeExtra(userId, webpageId, path, content, mimeType) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist extra files');
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    await storageStore.uploadFile(extraKey(userId, webpageId, path), buf, mimeType);
    return { sha: sha256(buf.toString('utf8')), size: buf.length };
}

async function deleteExtra(userId, webpageId, path) {
    if (!storageStore.isAvailable()) return;
    try { await storageStore.deleteFile(extraKey(userId, webpageId, path)); } catch (_) { /* ignore */ }
}

// ── Extra-files DB CRUD ───────────────────────────────────────────

async function listExtraFiles(webpageId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM webpage_extra_files WHERE webpage_id = $1 ORDER BY path ASC`,
        [webpageId]
    );
    return rows.map(mapExtraFileRow);
}

async function getExtraFile(webpageId, path) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM webpage_extra_files WHERE webpage_id = $1 AND path = $2`,
        [webpageId, path]
    );
    return r ? mapExtraFileRow(r) : null;
}

/**
 * Upsert a single extra file. Writes bytes to RustFS and metadata to DB.
 */
async function upsertExtraFile({ webpageId, userId, path, content }) {
    await initDB();
    const validation = validateExtraPath(path);
    if (validation) throw new Error(validation);

    const { mime, ext } = guessMime(path);
    const isText = isTextFile(mime, ext);
    const { sha, size } = await writeExtra(userId, webpageId, path, content, mime);

    const existing = await getExtraFile(webpageId, path);
    if (existing) {
        await run(
            `UPDATE webpage_extra_files SET mime_type = $1, is_text = $2, sha256 = $3, size = $4, updated_at = NOW()
             WHERE webpage_id = $5 AND path = $6`,
            [mime, isText, sha, size, webpageId, path]
        );
        return { ...existing, mimeType: mime, isText, sha256: sha, size, updatedAt: new Date().toISOString() };
    }

    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpage_extra_files (id, webpage_id, path, mime_type, is_text, sha256, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, webpageId, path, mime, isText, sha, size]
    );
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return { id, webpageId, path, mimeType: mime, isText, sha256: sha, size };
}

/**
 * Upsert a BINARY extra file (uploaded image / font / audio / etc).
 *
 * Unlike upsertExtraFile (which coerces content to UTF-8 text and derives the
 * mime from the path), this takes raw bytes + an explicit mime, computes the
 * sha over the bytes (not a lossy utf8 round-trip), and forces is_text=false.
 * Used by the asset-upload route (POST /api/webpages/:id/assets).
 */
async function upsertBinaryExtraFile({ webpageId, userId, path, buffer, mimeType }) {
    await initDB();
    const validation = validateExtraPath(path);
    if (validation) throw new Error(validation);
    if (!Buffer.isBuffer(buffer)) throw new Error('buffer is required');
    if (!storageStore.isAvailable()) throw new Error('RustFS not configured — cannot persist assets');

    const guessed = guessMime(path);
    const mime = mimeType || guessed.mime;
    const isText = false;

    await storageStore.uploadFile(extraKey(userId, webpageId, path), buffer, mime);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const size = buffer.length;

    const existing = await getExtraFile(webpageId, path);
    if (existing) {
        await run(
            `UPDATE webpage_extra_files SET mime_type = $1, is_text = $2, sha256 = $3, size = $4, updated_at = NOW()
             WHERE webpage_id = $5 AND path = $6`,
            [mime, isText, sha, size, webpageId, path]
        );
        return { ...existing, mimeType: mime, isText, sha256: sha, size, updatedAt: new Date().toISOString() };
    }

    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpage_extra_files (id, webpage_id, path, mime_type, is_text, sha256, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, webpageId, path, mime, isText, sha, size]
    );
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return { id, webpageId, path, mimeType: mime, isText, sha256: sha, size };
}

async function deleteExtraFile({ webpageId, userId, path }) {
    await initDB();
    const existing = await getExtraFile(webpageId, path);
    if (!existing) return false;
    await run('DELETE FROM webpage_extra_files WHERE webpage_id = $1 AND path = $2', [webpageId, path]);
    await deleteExtra(userId, webpageId, path);
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return true;
}

/**
 * Read a single extra file's content. Returns { meta, text? , bytes? } where
 * `text` is set for text files and `bytes` (Buffer) for binary. Returns null
 * when the file doesn't exist.
 */
async function readExtraFile({ webpageId, userId, path }) {
    const meta = await getExtraFile(webpageId, path);
    if (!meta) return null;
    const buf = await readExtra(userId, webpageId, path);
    if (!buf) return { meta, text: '', bytes: Buffer.alloc(0) };
    return meta.isText
        ? { meta, text: buf.toString('utf8'), bytes: buf }
        : { meta, bytes: buf };
}

function mapExtraFileRow(r) {
    return {
        id: r.id,
        webpageId: r.webpage_id,
        path: r.path,
        mimeType: r.mime_type,
        isText: r.is_text === true || r.is_text === 't',
        sha256: r.sha256 || '',
        size: parseInt(r.size) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    isTextFile,
    guessMime,
    validateExtraPath,
    extraKey,
    readExtra,
    writeExtra,
    deleteExtra,
    listExtraFiles,
    getExtraFile,
    upsertExtraFile,
    upsertBinaryExtraFile,
    deleteExtraFile,
    readExtraFile,
    mapExtraFileRow,
};
