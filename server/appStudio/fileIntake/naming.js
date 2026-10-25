// @typecheck
/**
 * file_intake — what a NAME says: base names, part keys, operations, folders,
 * the CAD format ranking and the deterministic classifier. Pure functions,
 * no I/O (the classifier lazily reads two lookup modules).
 */

'use strict';

// What counts as a purchase order, by filename. Overridable per step
// (validate.js refuses a pattern that does not compile).
//
// The quote vocabulary sits here beside the order vocabulary on purpose: a
// request for quotation carries the same table of positions and quantities as
// an order does, and the step that reads it does not care which one it is.
const DEFAULT_PO_PATTERN = 'inkoopbestelbon|inkooporder|purchase.?order|purchase.?quote'
    + '|request.?for.?quotation|offerte.?aanvraag|bestelbon|\\brfq\\b|^PO[-_ ]?\\d+';

/**
 * @param {string} filename
 */
function baseNameOf(filename) {
    const s = String(filename || '');
    const dot = s.lastIndexOf('.');
    return (dot > 0 ? s.slice(0, dot) : s).trim().toLowerCase();
}

/**
 * The SAFE-normalisation form of a base name, for the fuzzy pairing tier.
 *
 * Only transformations that cannot change WHICH part a name denotes: case,
 * the browser's " (1)" re-download suffix, and separator style (space /
 * underscore / hyphen unified). Deliberately NO edit-distance and NO digit
 * tolerance — TN...3021 and TN...3022 are different plates, and a fuzzy
 * matcher that could cross them would cut the wrong steel.
 * @param {string} filename
 */
function canonicalBaseOf(filename) {
    return normalizeBase(baseNameOf(filename));
}

/**
 * The same normalisation applied to a name that has ALREADY lost its extension
 * — a FOLDER name, say.
 *
 * Separate from canonicalBaseOf because that one strips everything after the
 * last dot, and a folder is not a filename: "19.0592.136.01_alu_5mm" is a real
 * article folder in this customer's world, and running the extension strip over
 * it would silently file the part as "19.0592.136".
 */
function normalizeBase(base) {
    return String(base || '').trim().toLowerCase()
        .replace(/\s*\(\d+\)$/, '')     // "naam (1)" → "naam"
        .replace(/[\s_]+/g, '-')        // separators unified
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
}

/**
 * The trailing "(…)" on a part name: a MACHINING OPERATION, not another part.
 *
 * An article folder arrives as "3010-010857-01 (Afschuining)" and holds BOTH
 * "3010-010857-01.dxf" and "3010-010857-01 (afschuining).dxf" — one plate, cut
 * once, with a chamfer on it. Read as two names those become two project lines,
 * and the shop cuts the plate twice. Nine folders in one real order do this.
 *
 * A purely NUMERIC parenthetical is the browser's re-download suffix ("naam
 * (1)"), which normalizeBase already owns — never an operation.
 *
 * Both helpers take an extension-less base name; call them through baseNameOf.
 */
const OPERATION_RE = /\(([^()]+)\)\s*$/;
/**
 * @param {string | undefined} base
 */
function operationOf(base) {
    const m = OPERATION_RE.exec(String(base || '').trim());
    if (!m) return '';
    const op = m[1].trim();
    return (!op || /^\d+$/.test(op)) ? '' : op.toLowerCase();
}
/**
 * @param {string} base
 */
function withoutOperation(base) {
    const s = String(base || '').trim();
    const m = OPERATION_RE.exec(s);
    if (!m || !operationOf(s)) return s;
    return s.slice(0, m.index).trim();
}

/**
 * The PART a file belongs to: no extension, no operation, normalised.
 * @param {string} filename
 */
function partKeyOf(filename) {
    return normalizeBase(withoutOperation(baseNameOf(filename)));
}

/** The part an article FOLDER stands for — its last segment, same treatment. */
function partKeyOfFolder(folderPath) {
    const leaf = String(folderPath || '').split('/').pop() || '';
    return normalizeBase(withoutOperation(leaf.trim().toLowerCase()));
}

/**
 * Does this read like a part number at all — long enough, and with a digit in it?
 * @param {string} key
 */
function looksLikePartNumber(key) {
    return typeof key === 'string' && key.length >= 5 && /[0-9]/.test(key);
}

/**
 * What to CALL the part an article folder holds.
 *
 * Grouping by folder is right whatever the folder is named; NAMING the part
 * after the folder is only right when the folder is named after the part. In a
 * real order it is ("3010-010857-01 (Afschuining)" holding
 * "3010-010857-01.dxf"), and in a forwarded one it is not — the inner archive's
 * top folder is called "order", and calling the plate "order" would put a
 * meaningless number on a cutting line and break the join with the order sheet.
 *
 * So: agreement first (the folder and its files say the same thing — that is
 * evidence, not a heuristic), then whichever of the two actually reads like a
 * part number, and only then a fallback so this always returns something.
 * @param {string} fileKey
 */
function partNameForFolder(folderPath, fileKey) {
    const folderKey = partKeyOfFolder(folderPath);
    if (folderKey && folderKey === fileKey) return folderKey;
    if (looksLikePartNumber(fileKey)) return fileKey;
    if (looksLikePartNumber(folderKey)) return folderKey;
    return fileKey || folderKey;
}

/**
 * Tier-3 containment: one canonical name is a PREFIX of the other (a rev or
 * suffix tacked on one side, e.g. "...-001" vs "...-001-rev2"). Prefix only —
 * substring matching could bind a short junk name to anything — and the
 * shorter side must carry enough signal to be a real part number.
 */
function containsPrefix(a, b) {
    const [long, short] = a.length >= b.length ? [a, b] : [b, a];
    return short.length >= 8 && long !== short && long.startsWith(short);
}

/**
 * Do two canonical base names belong to the same part-number family?
 *
 * A shared leading run of six characters or more. Long enough that
 * "19-0592-136-01-alu-5mm" and "b263232" are strangers, short enough that
 * every sibling in a "MW2604-01-30xx-001" series recognises its own.
 */
const FAMILY_PREFIX_CHARS = 6;
function sharesNumberFamily(a, b) {
    const x = String(a || '');
    const y = String(b || '');
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return i >= FAMILY_PREFIX_CHARS;
}

// Which CAD file wins when one part arrives with several (the customer's real
// orders carry .step AND .DXF of the same part; their portal CSV uses the
// .step — see portaal_order_4.csv, TN2306-06-9100-001). The wider 3D zoo
// (Parasolid/ACIS/STL/natives) ranks below the portal's own interchange
// formats: it is stored and paired, but never chosen over a .step/.dxf.
/** @type {Record<string, number>} */
const CAD_EXT_PREFERENCE = {
    step: 0, stp: 0, p21: 0, dxf: 1, dwg: 2, iges: 3, igs: 3,
    x_t: 4, x_b: 4, sat: 5, sab: 5, '3dm': 6, sldprt: 7, ipt: 7, stl: 8,
};
/**
 * @param {string} name
 */
function cadPreference(name) {
    const p = CAD_EXT_PREFERENCE[extensionOf(name)];
    return p === undefined ? 9 : p;
}

/**
 * … and which format sits at the HEAD of that list is a shop's choice, not
 * a fact about CAD.
 *
 * The order above puts .step first because some portals' CSV names the .step.
 * A waterjet shop often does the opposite: every line of an order names a
 * .dxf, including parts that only shipped a .stp — for them the DXF IS the
 * cutting file and the solid is reference. Only the head moves; the rest of
 * the ranking is unchanged, so nothing else reshuffles.
 */
function cadPreferenceWith(preferred) {
    if (preferred !== 'dxf') return cadPreference;
    return (name) => (extensionOf(name) === 'dxf' ? -1 : cadPreference(name));
}

/**
 * @param {string} filename
 */
function extensionOf(filename) {
    const s = String(filename || '');
    const dot = s.lastIndexOf('.');
    return dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
}

/**
 * An archive entry's path, as we address it: forward slashes, no leading
 * slash. Zips written on Windows carry backslashes, and a path we do not
 * normalise is a folder we do not recognise.
 * @param {string} name
 */
function zipEntryPath(name) {
    return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/**
 * The folder an archive entry sits in — '' for an entry at the root.
 * @param {string} entryPath
 */
function folderOf(entryPath) {
    const p = String(entryPath || '');
    const cut = p.lastIndexOf('/');
    return cut > 0 ? p.slice(0, cut) : '';
}

/**
 * The folder of an ALREADY-FILED row.
 *
 * Prefers the `map` column, and falls back to the entry path inside the
 * synthetic id (`<archive id>#<path/inside.zip>`). The fallback is what makes
 * this rule work on archives unpacked before the column existed: the folder was
 * never actually lost, it just had nowhere of its own to live, and a rule that
 * only applied to future unpackings would treat one conversation two ways.
 */
function folderOfRow(row) {
    if (row && typeof row.map === 'string' && row.map) return row.map;
    const id = row && typeof row.provider_attachment_id === 'string' ? row.provider_attachment_id : '';
    const hash = id.indexOf('#');
    return hash >= 0 ? folderOf(id.slice(hash + 1)) : '';
}

// A spreadsheet is order paperwork by its nature: nobody sends a plate as a
// .xlsx. Recognising it by extension keeps that fact out of the PO pattern,
// which is about what a file is CALLED rather than what it is.
const SHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls', 'csv']);

/**
 * Classify one attachment row. Cheapest signal first: extension → CAD or
 * spreadsheet; the PO pattern → purchase order; any other PDF is treated as a
 * drawing (a customer who forgot the CAD file still deserves a project line,
 * visibly incomplete); everything else is 'other'.
 * @param {string} name
 */
function classify(name, poRe) {
    const { cadMimeForName } = require('../../core/cad/cadTypes');
    // 'zip' is the KIND for every container, whatever the container is. A .7z
    // is one we cannot open, and it still has to be recognised as an archive —
    // otherwise it falls through to 'other' and the report says nothing about
    // the one file that held the whole order.
    if (require('../archive').looksLikeArchiveName(name)) return 'zip';
    if (cadMimeForName(name)) return 'cad';
    // BEFORE the PO pattern: a bill of materials called "RFQ-20260001.xlsx"
    // matches that pattern too, and calling it the purchase order would hand
    // the wrong file to both readers. A sheet is a sheet.
    if (SHEET_EXTENSIONS.has(extensionOf(name))) return 'sheet';
    // The name is sender-controlled; a real filename's PO token sits well
    // within 300 chars, and bounding the scanned string bounds how far any
    // author pattern can backtrack.
    if (poRe.test(String(name || '').slice(0, 300))) return 'po';
    if (extensionOf(name) === 'pdf') return 'drawing';
    return 'other';
}

module.exports = {
    DEFAULT_PO_PATTERN,
    baseNameOf,
    canonicalBaseOf,
    normalizeBase,
    operationOf,
    withoutOperation,
    partKeyOf,
    partKeyOfFolder,
    looksLikePartNumber,
    partNameForFolder,
    containsPrefix,
    sharesNumberFamily,
    cadPreference,
    cadPreferenceWith,
    extensionOf,
    zipEntryPath,
    folderOf,
    folderOfRow,
    classify,
};
