// @typecheck
/**
 * Upload Guard — a hardened multipart upload middleware for App Studio v2
 * attachments (and any other route that accepts a single user file).
 *
 * `uploadGuard({ maxBytes, allow, field })` returns an Express middleware that:
 *   1. Parses ONE file with multer memoryStorage (never touches disk), capping
 *      the size at `maxBytes` → oversize answers 413.
 *   2. Checks the DECLARED MIME is in the allowlist → else 415.
 *   3. SNIFFS the magic bytes and refuses a file whose real type doesn't match
 *      the declared one — the declared Content-Type is attacker-controlled and
 *      is never trusted on its own → mismatch answers 415.
 *   4. For SVG (image/svg+xml) routes the bytes through utils/svgSanitizer;
 *      unsanitizable input is rejected and `req.file.buffer` is REPLACED with
 *      the cleaned bytes (+ `req.file.sanitized = true`).
 *
 * The middleware does NOT scan for malware — that's `scanBuffer` (exported
 * here), called by the route AFTER the guard passes, so the route controls the
 * quarantine flow (upload → scan → link-on-clean / delete-on-dirty). Keeping AV
 * out of the guard lets the route decide what to do with a dirty verdict.
 *
 * Pluggable AV: `scanBuffer(buffer) → { clean, signature? }`. No-op clean in
 * dev; a real scanner is wired via the UPLOAD_AV_HOOK env var (a module path
 * exporting `async scan(buffer) → { clean, signature? }`). The EICAR test
 * string is always caught so the quarantine path is exercisable without infra.
 */

'use strict';

const multer = require('multer');
const {
    CAD_MIME_FAMILIES, CAD_CANONICAL_MIMES, GENERIC_MIMES,
    cadMimeForName, canonicalCadMime, isAsciiDxfHead,
} = require('../utils/cadTypes');
const log = require('../telemetry/log');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

// The default allowlist: images, PDF, CSV/plain text, the common Office
// document types (both OOXML and legacy OLE containers), and the CAD
// interchange formats (STEP / DXF / DWG / IGES — see core/cadTypes.js).
const DEFAULT_ALLOW = Object.freeze([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'text/csv', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   // docx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         // xlsx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'application/msword',              // doc  (OLE)
    'application/vnd.ms-excel',        // xls  (OLE)
    'application/vnd.ms-powerpoint',   // ppt  (OLE)
    ...CAD_CANONICAL_MIMES,            // model/step, image/vnd.dxf, image/vnd.dwg, model/iges
]);

// ── Magic-byte sniffing ─────────────────────────────────────────────
// Each entry: a byte prefix (with `null` = wildcard) → a canonical "family"
// label. ZIP/OLE families cover the container-based Office formats.
function startsWith(buf, sig, offset = 0) {
    // The offset matters: tar's `ustar` marker sits at byte 257, not byte 0.
    // (This function silently ignored a third argument for a while, which made
    // the tar branch below unreachable — same 3-arg shape as appStudio/archive.js.)
    if (buf.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
        if (sig[i] !== null && buf[offset + i] !== sig[i]) return false;
    }
    return true;
}

function sniffFamily(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'empty';
    if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif';            // GIF8
    if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';      // %PDF-
    if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])) return 'zip';           // PK.. (docx/xlsx/pptx)
    if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'; // legacy Office
    // Containers we RECOGNISE. Naming them is the point even where we cannot
    // open them: a .7z that sniffs as 'binary' is indistinguishable from a
    // renamed executable, and the operator is told neither what arrived nor why
    // nothing happened to it.
    if (startsWith(buffer, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
    if (startsWith(buffer, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
    if (startsWith(buffer, [0x1f, 0x8b])) return 'gzip';
    // tar carries no leading signature; its marker sits inside the first header.
    if (startsWith(buffer, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return 'tar';
    // RIFF....WEBP
    if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12 &&
        startsWith(buffer.subarray(8), [0x57, 0x45, 0x42, 0x50])) return 'webp';
    // CAD — BEFORE the svg/text checks: STEP, ASCII DXF and IGES are plain
    // text on the wire and would otherwise sniff 'text'.
    const cad = sniffCadFamily(buffer);
    if (cad) return cad;
    if (looksLikeSvg(buffer)) return 'svg';
    if (isProbablyText(buffer)) return 'text';
    return 'binary';
}

// ── CAD signatures ──────────────────────────────────────────────────
// STEP (ISO 10303-21), DXF (ASCII + binary), DWG and IGES.
const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

function sniffCadFamily(buffer) {
    // Binary DXF: the exact sentinel from the DXF spec.
    if (buffer.length >= DXF_BINARY_SENTINEL.length &&
        buffer.subarray(0, DXF_BINARY_SENTINEL.length).toString('latin1') === DXF_BINARY_SENTINEL) return 'dxf-binary';
    // DWG: 'AC10' + two digits (AC1015 = 2000 … AC1032 = 2018+).
    if (buffer.length >= 6 && /^AC10\d\d$/.test(buffer.subarray(0, 6).toString('latin1'))) return 'dwg';
    // Rhino: a literal banner, from the 3dm spec.
    if (buffer.subarray(0, 24).toString('latin1') === '3D Geometry File Format ') return '3dm';
    // Parasolid transmit (x_t/x_b): the alphabet banner both variants open with.
    if (buffer.subarray(0, 28).toString('latin1') === '**ABCDEFGHIJKLMNOPQRSTUVWXYZ') return 'parasolid';
    // ACIS binary (.sab): a literal banner too.
    if (buffer.subarray(0, 15).toString('latin1') === 'ACIS BinaryFile') return 'sat';
    // Binary STL has NO magic — but it has structure: an 80-byte free header,
    // a uint32 triangle count, then exactly 50 bytes per triangle. The length
    // equation is the signature; random bytes satisfy it with p ≈ 2^-32.
    if (buffer.length >= 84) {
        const triangles = buffer.readUInt32LE(80);
        if (84 + triangles * 50 === buffer.length && triangles > 0) return 'stl';
    }
    const head = buffer.subarray(0, 2048).toString('utf8').replace(/^﻿/, '');
    // STEP part 21: the mandatory opening token, after optional BOM/whitespace.
    if (/^\s*ISO-10303-21;/.test(head)) return 'step';
    // ASCII DXF — the shared rule (cadTypes.isAsciiDxfHead), so the byte
    // verdict here and cadMetadata's reader can never drift apart.
    if (isAsciiDxfHead(head)) return 'dxf';
    if (looksLikeIges(buffer)) return 'iges';
    // ASCII STL: the 'solid <name>' opener plus a facet within the head —
    // 'solid' alone is a common English word in text files.
    if (/^\s*solid[ \t]/.test(head) && head.includes('facet')) return 'stl';
    // ACIS text (.sat): a first line of bare integers (the header record) and
    // the ACIS product id within the head.
    if (/^\s*\d+\s+\d+\s+\d+\s+\d+\s*\r?\n/.test(head) && head.includes('ACIS')) return 'sat';
    return null;
}

// IGES is a fixed 80-column card format: cols 1–72 content, col 73 the section
// letter (S = Start), cols 74–80 a right-aligned sequence number. Pragmatic:
// first line 80±2 chars, an S in the col-73 zone, a trailing digit.
function looksLikeIges(buffer) {
    if (!isProbablyText(buffer)) return false;
    const head = buffer.subarray(0, 256).toString('latin1');
    const nl = head.indexOf('\n');
    if (nl < 0) return false;
    const line = head.slice(0, nl).replace(/\r$/, '');
    if (line.length < 78 || line.length > 82) return false;
    if (!line.slice(71, 74).includes('S')) return false;
    return /\d$/.test(line.trimEnd());
}

function looksLikeSvg(buffer) {
    // Sniff a bounded prefix: optional BOM/whitespace/XML prolog, then <svg.
    const head = buffer.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
    if (head.startsWith('<svg')) return true;
    if (head.startsWith('<?xml') || head.startsWith('<!doctype')) return /<svg[\s>]/.test(head);
    return false;
}

// A byte buffer is "probably text" if it decodes as UTF-8 without control
// characters other than tab/newline/carriage-return (no NULs → not binary).
function isProbablyText(buffer) {
    const n = Math.min(buffer.length, 4096);
    for (let i = 0; i < n; i++) {
        const b = buffer[i];
        if (b === 0) return false;
        if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
    }
    return true;
}

// Which sniffed families satisfy a declared MIME type. Text formats (csv/plain)
// have no reliable magic, so a text-looking buffer satisfies them.
const MIME_FAMILIES = Object.freeze({
    'image/png': ['png'],
    'image/jpeg': ['jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/svg+xml': ['svg'],
    'application/pdf': ['pdf'],
    // text/* is WIDENED with the text-shaped CAD families: a genuine STEP or
    // ASCII DXF declared text/plain used to sniff 'text' and pass — now that
    // those bytes sniff their own family, the widening keeps them passing.
    // Widening only; nothing that passed before starts failing.
    'text/csv': ['text', 'step', 'dxf', 'iges', 'stl', 'sat', 'parasolid'],
    'text/plain': ['text', 'step', 'dxf', 'iges', 'stl', 'sat', 'parasolid'],
    // CAD comes from the shared table (core/cadTypes.js) — one allowlist,
    // three consumers, nothing to drift.
    ...CAD_MIME_FAMILIES,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['zip'],
    'application/msword': ['ole'],
    'application/vnd.ms-excel': ['ole'],
    'application/vnd.ms-powerpoint': ['ole'],
});

function magicMatchesDeclared(declared, buffer) {
    const families = MIME_FAMILIES[declared];
    if (!families) return false; // unknown declared type → cannot vouch for it
    return families.includes(sniffFamily(buffer));
}

// ── AV scanning ─────────────────────────────────────────────────────

// EICAR anti-malware test string — always treated as dirty so the quarantine
// path is testable without a real scanner.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let _avHook = undefined; // undefined = not yet resolved; null = none configured
function resolveAvHook() {
    if (_avHook !== undefined) return _avHook;
    const hookPath = process.env.UPLOAD_AV_HOOK;
    if (!hookPath) { _avHook = null; return _avHook; }
    try {
        const mod = require(hookPath);
        _avHook = (typeof mod === 'function') ? mod : (typeof mod.scan === 'function' ? mod.scan : null);
    } catch (err) {
        log.warn(`[UploadGuard] UPLOAD_AV_HOOK failed to load (${err.message}); scanning is no-op`);
        _avHook = null;
    }
    return _avHook;
}

/**
 * Scan a buffer for malware. Returns { clean, signature? }.
 *   - EICAR is always flagged (deterministic test hook).
 *   - A configured UPLOAD_AV_HOOK gets the final say.
 *   - Otherwise: no-op clean (dev / self-host without a scanner).
 */
async function scanBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) return { clean: false, signature: 'invalid-buffer' };
    // Cheap deterministic check first — a prefix scan catches the EICAR probe.
    if (buffer.subarray(0, 256).toString('latin1').includes(EICAR)) {
        return { clean: false, signature: 'EICAR-Test-File' };
    }
    const hook = resolveAvHook();
    if (hook) {
        try {
            const r = await hook(buffer);
            if (r && typeof r === 'object') return { clean: !!r.clean, signature: r.signature };
            return { clean: !!r };
        } catch (err) {
            // Fail CLOSED — a scanner that errors must not wave a file through.
            log.error(`[UploadGuard] AV hook error: ${err.message}`);
            return { clean: false, signature: 'scanner-error' };
        }
    }
    return { clean: true };
}

// ── Middleware factory ──────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]  size cap (bytes) → 413 when exceeded
 * @param {readonly string[]} [opts.allow]   declared-MIME allowlist → 415 otherwise
 * @param {string} [opts.field]     multipart field name (default 'file')
 */
function uploadGuard({ maxBytes = DEFAULT_MAX_BYTES, allow = DEFAULT_ALLOW, field = 'file' } = {}) {
    const allowSet = new Set(allow);
    const parseOne = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes, files: 1 },
    }).single(field);

    return function uploadGuardMiddleware(req, res, next) {
        parseOne(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({ error: `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit` });
                }
                return res.status(400).json({ error: 'Upload failed' });
            }
            const file = req.file;
            if (!file || !Buffer.isBuffer(file.buffer)) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            if (file.size > maxBytes) {
                return res.status(413).json({ error: `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit` });
            }

            const declaredRaw = String(file.mimetype || '').toLowerCase();
            let declared = declaredRaw;
            // CAD arrives under a zoo of vendor aliases (application/dxf,
            // application/acad, …) — fold those to the canonical mime first.
            const cadCanonical = canonicalCadMime(declared);
            if (cadCanonical) declared = cadCanonical;
            // Generic declared type (octet-stream & friends): the FILENAME may
            // PROPOSE a canonical CAD mime — it only proposes. The UNCHANGED
            // allowlist + magic-byte checks below still run against the
            // proposal, so application/octet-stream is never accepted on its
            // own: an .exe renamed part.step sniffs 'binary', not 'step', and
            // is refused.
            else if (GENERIC_MIMES.has(declared)) {
                const proposed = cadMimeForName(file.originalname);
                if (proposed) declared = proposed;
            }
            // Rewrite the multer mimetype so downstream ledgers store
            // something meaningful instead of octet-stream.
            if (declared !== declaredRaw) file.mimetype = declared;

            if (!allowSet.has(declared)) {
                return res.status(415).json({ error: `File type "${declared || 'unknown'}" is not allowed` });
            }
            if (!magicMatchesDeclared(declared, file.buffer)) {
                return res.status(415).json({ error: 'File contents do not match the declared type' });
            }

            // SVG: sanitize (strip scripts/handlers/external refs) or reject.
            if (declared === 'image/svg+xml') {
                const { sanitizeSvg } = require('../utils/svgSanitizer');
                const clean = sanitizeSvg(file.buffer);
                if (!clean) return res.status(415).json({ error: 'SVG could not be sanitized' });
                file.buffer = clean;
                file.size = clean.length;
                file.sanitized = true;
            }
            next();
        });
    };
}

module.exports = {
    uploadGuard,
    scanBuffer,
    DEFAULT_ALLOW,
    DEFAULT_MAX_BYTES,
    // First-class, not test-only: bytes now also arrive from a mail provider
    // rather than an HTTP upload, and that path needs the same magic-byte
    // verdict without going through Express middleware.
    sniffFamily,
    magicMatchesDeclared,
    // Legacy aliases kept so existing tests keep their names.
    _sniffFamily: sniffFamily,
    _magicMatchesDeclared: magicMatchesDeclared,
    _resetAvHook: () => { _avHook = undefined; },
    EICAR,
};
