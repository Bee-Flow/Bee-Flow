// @typecheck strict
/**
 * One receiver for the public images under data/uploads (user avatars, org
 * logos): the type comes from the file's bytes, the stored extension from
 * that type, never from the client's file name.
 *
 * `receiveImage({ field, allow, name })` runs uploadGuard (size cap, declared
 * MIME allow-list, magic-byte sniff, SVG sanitising) and then writes the
 * accepted buffer to UPLOADS_DIR as `<name(req)>.<ext>`. The route reads
 * `req.file.filename` exactly as it did with multer's disk storage.
 *
 * `INLINE_UPLOAD_EXTS` is the set of extensions the /uploads mount renders
 * inline; everything else downloads (boot/staticAssets.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { uploadGuard } = require('./uploadGuard');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

/** The canonical MIME of an accepted image → the one extension it is stored under. */
const IMAGE_EXT = Object.freeze({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
});

/** Extensions served inline from /uploads. '.jpeg' covers files older uploads wrote. */
const INLINE_UPLOAD_EXTS = new Set([...Object.values(IMAGE_EXT), '.jpeg']);

/**
 * @param {{ field: string, allow: readonly string[], maxBytes?: number, name: (req: import('express').Request) => string }} opts
 */
function receiveImage({ field, allow, maxBytes = 2 * 1024 * 1024, name }) {
    const guard = uploadGuard({ maxBytes, allow, field });
    return function receiveImageMiddleware(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) {
        // The guard answers every refusal itself (400/413/415) and calls next()
        // only for an accepted, sniffed (and for SVG, sanitised) buffer.
        guard(req, res, () => {
            const file = req.file;
            if (!file) return next();
            const ext = IMAGE_EXT[/** @type {keyof typeof IMAGE_EXT} */ (String(file.mimetype || '').toLowerCase())];
            if (!ext) return res.status(415).json({ error: `File type "${file.mimetype || 'unknown'}" is not allowed` });
            const filename = `${name(req)}${ext}`;
            fs.mkdir(UPLOADS_DIR, { recursive: true }, (mkErr) => {
                if (mkErr) return next(mkErr);
                fs.writeFile(path.join(UPLOADS_DIR, filename), file.buffer, (writeErr) => {
                    if (writeErr) return next(writeErr);
                    file.filename = filename;
                    file.destination = UPLOADS_DIR;
                    file.path = path.join(UPLOADS_DIR, filename);
                    next();
                });
            });
        });
    };
}

module.exports = { receiveImage, IMAGE_EXT, INLINE_UPLOAD_EXTS, UPLOADS_DIR };
