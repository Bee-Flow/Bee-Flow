/**
 * CMS media helpers: clip uploads (demo videos WITH sound, up to 500 MB) and
 * WebVTT captions validation.
 *
 * Clips are far too big for the memoryStorage uploader that serves images and
 * silent loops (25 MB). They go through multer diskStorage into a private temp
 * directory and are then streamed into storage in bounded parts via the
 * multipart helpers of storageStore, which behave the same in S3 and local
 * mode. The temp file is removed in every outcome.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');

const log = require('../telemetry/log');
const storageStore = require('../stores/storageStore');
const { HttpError, badRequest } = require('../core/http/errors');

const { CLIP_MAX_BYTES, VTT_MAX_BYTES, CLIP_MIME_WHITELIST } = require('../core/cms/uploadPolicy');

const CLIP_PART_BYTES = 16 * 1024 * 1024;
const CLIP_EXT_WHITELIST = new Set(['.mp4', '.webm']);
// Browsers send '' / text/plain / octet-stream for .vtt; the extension and the
// content decide, the declared type only has to be one of the harmless ones.
const VTT_DECLARED_MIME = new Set(['text/vtt', 'text/plain', 'application/octet-stream', '']);

/** @param {string} name */
function extOf(name) {
    return path.extname(name || '').toLowerCase();
}

/** @param {{ mimetype?: string, originalname?: string }} file */
function isVttFile(file) {
    return extOf(file.originalname) === '.vtt' && VTT_DECLARED_MIME.has(String(file.mimetype || '').toLowerCase());
}

/**
 * A WebVTT file starts with "WEBVTT" (a BOM may precede it) followed by end of
 * file, a space, a tab or a line break. It must be valid UTF-8 without NULs.
 * @param {Buffer} buf
 */
function isValidVtt(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > VTT_MAX_BYTES) return false;
    if (buf.includes(0)) return false;
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return false;
    }
    return /^﻿?WEBVTT(?:[ \t\r\n]|$)/.test(text);
}

/** Sniff the container so a renamed file cannot pass as a clip. */
function looksLikeClip(head, ext) {
    if (ext === '.webm') return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
    return head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp';
}

let tmpRoot = null;
function ensureTmpDir() {
    if (!tmpRoot || !fs.existsSync(tmpRoot)) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-cms-clip-'));
    return tmpRoot;
}

const clipUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            try { cb(null, ensureTmpDir()); } catch (e) { cb(e, ''); }
        },
        filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.upload`),
    }),
    limits: { fileSize: CLIP_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        if (CLIP_MIME_WHITELIST.has(file.mimetype) && CLIP_EXT_WHITELIST.has(extOf(file.originalname))) cb(null, true);
        else cb(new Error('Unsupported file type: clips must be MP4 or WebM'));
    },
});

/** multer errors come back as a clean 400 (same style as the image uploader). */
function clipUploadMiddleware(req, res, next) {
    clipUpload.single('file')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'File too large (max 500 MB)'
            : (err.message || 'Upload rejected');
        res.status(400).json({ error: message });
    });
}

/** Stream a finished temp file into storage in bounded parts. */
async function streamIntoStorage(filePath, size, key, contentType) {
    const { uploadId } = await storageStore.beginMultipartUpload(key, contentType);
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const parts = [];
        let offset = 0;
        let partNumber = 1;
        while (offset < size) {
            const len = Math.min(CLIP_PART_BYTES, size - offset);
            const buf = Buffer.allocUnsafe(len);
            let filled = 0;
            while (filled < len) {
                const { bytesRead } = await handle.read(buf, filled, len - filled, offset + filled);
                if (bytesRead === 0) throw new Error('Unexpected end of temp file');
                filled += bytesRead;
            }
            const { etag } = await storageStore.uploadPartBuffer(key, uploadId, partNumber, buf);
            parts.push({ partNumber, etag });
            offset += len;
            partNumber += 1;
        }
        await storageStore.completeMultipartUpload(key, uploadId, parts);
    } catch (err) {
        await storageStore.abortMultipartUpload(key, uploadId).catch(() => {});
        throw err;
    } finally {
        await handle.close().catch(() => {});
    }
}

/** POST /admin/upload-clip handler (after clipUploadMiddleware). */
async function handleClipUpload(req, res) {
    const file = req.file;
    if (!file) throw badRequest('no_file', 'No file provided');
    let result;
    try {
        if (!storageStore.isAvailable()) throw new HttpError(503, 'storage_unavailable', 'Storage unavailable');

        const ext = extOf(file.originalname);
        const head = Buffer.alloc(16);
        const fh = await fs.promises.open(file.path, 'r');
        try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
        if (!file.size || !looksLikeClip(head, ext)) {
            throw badRequest('invalid_clip', 'This file is not a valid MP4 or WebM video');
        }

        const safeBase = (file.originalname || 'clip')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .replace(/\.[^.]+$/, '');
        const key = `cms/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBase}${ext}`;
        await streamIntoStorage(file.path, file.size, key, file.mimetype);

        const url = `/api/cms/asset/${key.split('/').map(encodeURIComponent).join('/')}`;
        result = { success: true, key, url };
    } finally {
        // Before the response goes out, so a caller that gets its answer can
        // rely on the temp file being gone.
        await fs.promises.rm(file.path, { force: true }).catch((e) => log.warn(`[CMS] clip temp cleanup failed: ${e.message}`));
    }
    res.json(result);
}

module.exports = {
    CLIP_MAX_BYTES, VTT_MAX_BYTES, isVttFile, isValidVtt,
    looksLikeClip, streamIntoStorage, extOf,
    clipUploadMiddleware, handleClipUpload,
};
