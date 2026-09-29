// @typecheck
/**
 * CAD type table — the ONE place that knows which CAD interchange formats we
 * accept and what they are called on the wire.
 *
 * Three consumers share it: middleware/uploadGuard.js (HTTP uploads),
 * appStudio/mailboxAttachments.js (mail ingestion — the route that matters,
 * customers mail .step/.dxf to a quoting inbox) and core/attachmentExtractor.js
 * (routing to the CAD metadata reader). Two copies of a type allowlist is two
 * allowlists waiting to drift, so none of them carries its own.
 *
 * Vocabulary:
 *   - CANONICAL mime  — the one we store and route on (one per format).
 *   - ALIAS mime      — the zoo of vendor spellings mail clients and OSes
 *                       declare (application/dxf, drawing/x-dwg, …); folded to
 *                       the canonical before any allowlist check.
 *   - GENERIC mime    — says nothing at all (octet-stream & friends). The
 *                       FILENAME may then PROPOSE a canonical mime — propose
 *                       only; the magic-byte sniff still has to confirm.
 *   - FAMILY          — the label uploadGuard's sniffFamily assigns to the
 *                       actual bytes; CAD_MIME_FAMILIES says which families
 *                       satisfy which canonical mime.
 */

'use strict';

// Extension → canonical mime. Keys are lowercase extensions without the dot.
const CAD_EXT_TO_MIME = Object.freeze({
    step: 'model/step',
    stp: 'model/step',
    p21: 'model/step',
    dxf: 'image/vnd.dxf',
    dwg: 'image/vnd.dwg',
    iges: 'model/iges',
    igs: 'model/iges',
    // The wider 3D zoo a machining customer's suppliers actually mail:
    // meshes (STL), Rhino, Parasolid/ACIS kernels, SolidWorks/Inventor native.
    // Same contract as the rest of the table: the extension only PROPOSES; the
    // magic-byte sniff must confirm (see uploadGuard.sniffCadFamily — binary
    // STL is confirmed by its 84+50n structural length, natives by their OLE
    // container, so a renamed .exe still refuses everywhere).
    stl: 'model/stl',
    '3dm': 'model/x-3dm',
    x_t: 'model/x-parasolid',
    x_b: 'model/x-parasolid',
    sat: 'model/x-acis',
    sab: 'model/x-acis',
    sldprt: 'model/x-sldprt',
    ipt: 'model/x-ipt',
});

// Vendor/legacy spellings → canonical mime.
const CAD_MIME_ALIASES = Object.freeze({
    'application/step': 'model/step',
    'application/x-step': 'model/step',
    'application/p21': 'model/step',
    'model/x-step': 'model/step',
    'application/dxf': 'image/vnd.dxf',
    'application/x-dxf': 'image/vnd.dxf',
    'application/acad': 'image/vnd.dwg',
    'application/x-autocad': 'image/vnd.dwg',
    'application/dwg': 'image/vnd.dwg',
    'drawing/x-dwg': 'image/vnd.dwg',
    'application/iges': 'model/iges',
    'application/sla': 'model/stl',
    'application/vnd.ms-pki.stl': 'model/stl',
    'model/x-stl': 'model/stl',
    'application/x-parasolid': 'model/x-parasolid',
    'application/x-sat': 'model/x-acis',
});

// Canonical mime → sniffed byte families that satisfy it (uploadGuard labels).
const CAD_MIME_FAMILIES = Object.freeze({
    'model/step': ['step'],
    'image/vnd.dxf': ['dxf', 'dxf-binary'],
    'image/vnd.dwg': ['dwg'],
    'model/iges': ['iges'],
    'model/stl': ['stl'],
    'model/x-3dm': ['3dm'],
    'model/x-parasolid': ['parasolid'],
    'model/x-acis': ['sat'],
    // SolidWorks/Inventor natives are OLE compound containers — the sniff
    // confirms the container, which is what keeps a renamed .exe (family
    // 'binary') or a zip-in-disguise out. The payload is stored opaque and
    // never parsed, exactly like DWG.
    'model/x-sldprt': ['ole'],
    'model/x-ipt': ['ole'],
});

const CAD_CANONICAL_MIMES = new Set(Object.keys(CAD_MIME_FAMILIES));

// Declared types that carry no information — for these the filename may
// propose a canonical CAD mime (and only propose: bytes must confirm).
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'application/binary', 'binary/octet-stream']);

/** Canonical CAD mime for a filename, by extension — or null. */
function cadMimeForName(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
    if (!m) return null;
    return CAD_EXT_TO_MIME[m[1].toLowerCase()] || null;
}

/** Fold a declared mime to its canonical CAD mime (canonical → itself) — or null. */
function canonicalCadMime(declared) {
    const mime = String(declared || '').toLowerCase().trim();
    if (CAD_CANONICAL_MIMES.has(mime)) return mime;
    return CAD_MIME_ALIASES[mime] || null;
}

/** True when the mime is a canonical CAD mime or a known alias of one. */
function isCadMime(mime) {
    return canonicalCadMime(mime) !== null;
}

// ── ASCII DXF recognition ───────────────────────────────────────────
//
// Lives here because TWO readers need the same verdict, and disagreeing about
// it is a bug you only meet in production: uploadGuard.sniffCadFamily decides
// whether the bytes may be STORED at all, and cadMetadata.detectFormat decides
// whether they are then READ as a drawing. A file the first accepts and the
// second does not is a drawing filed as an unreadable blob.
//
// A DXF is strictly (group-code line, value line) pairs. The signature is the
// opening `0` / `SECTION` pair, or the $ACADVER header variable.
//
// LEADING 999 COMMENT PAIRS ARE SKIPPED FIRST. Every DXF writer may emit them
// and nesting/CAM exporters do ("999" then "DXF written by …"); those same
// exporters often write no HEADER section at all, so such a file matched
// NEITHER branch: a waterjet .DXF sniffed as plain text and the intake refused
// it as "not what it claims to be", while a .step — which always opens with
// ISO-10303-21; — sailed through. Only code 999 is skippable, and only from
// the front: this must never become "the word SECTION appears somewhere".
const DXF_MAX_LEADING_COMMENTS = 20;
const DXF_COMMENT_PAIR = /^\s*999[ \t]*\r?\n[^\r\n]*\r?\n/;
const DXF_SECTION_OPENER = /^\s*0[ \t]*\r?\n[ \t]*SECTION/;

/**
 * Does this head — the first ~2 KB decoded as UTF-8, BOM already stripped —
 * belong to an ASCII DXF?
 */
function isAsciiDxfHead(head) {
    const text = String(head || '');
    if (text.includes('$ACADVER')) return true;
    let rest = text;
    for (let i = 0; i < DXF_MAX_LEADING_COMMENTS; i += 1) {
        const m = DXF_COMMENT_PAIR.exec(rest);
        if (!m) break;
        rest = rest.slice(m[0].length);
    }
    return DXF_SECTION_OPENER.test(rest);
}

module.exports = {
    CAD_EXT_TO_MIME,
    CAD_MIME_ALIASES,
    CAD_MIME_FAMILIES,
    CAD_CANONICAL_MIMES,
    GENERIC_MIMES,
    cadMimeForName,
    canonicalCadMime,
    isCadMime,
    isAsciiDxfHead,
};
