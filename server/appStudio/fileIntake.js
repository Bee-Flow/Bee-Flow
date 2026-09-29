/**
 * file_intake — one button-press files a whole mailed order.
 *
 * Redeems a conversation's attachments in bulk (the existing per-file
 * materialize route shares the upload limiter at 20/min, so a 20-attachment
 * order 429s on its own last file), classifies each one by DETERMINISTIC rules
 * — no model call: an LLM classifying twenty filenames is twenty times slower,
 * costs money, and is wrong in a way a regex is not — pairs drawings with
 * their CAD files by base name (MW2604-01-3021-001.pdf ↔ .step), and
 * optionally upserts one row per pair so re-pressing the button updates the
 * layout instead of duplicating it.
 *
 * AUTHORITY, in order, none of it widened here:
 *   • Locate under the VIEWER's read filter (a records binding through
 *     stepDataSource) — someone who may not see the conversation redeems
 *     nothing. Never client-supplied fileIds; never owner scope.
 *   • Redeem through materializeAttachment, which re-checks access, quota and
 *     the malware scan per file, and resolves mailbox credentials by the
 *     connector's own runAs ladder — never a fallback to owner credentials.
 *   • Write rows as the VIEWER under RLS (writeRecord) — the same
 *     create-permission story ai_extract depends on.
 *
 * FAILURE SEMANTICS: per-file, named. File 14 failing its scan is recorded in
 * `refused` while 15–20 continue — a folder with a named hole, not nineteen
 * silent files. The one abort is quota: it is app-wide, so once a 409 lands
 * every remaining file would 409 too, and carrying on would just burn
 * provider calls.
 */

'use strict';
const log = require('../telemetry/log');

// Sized for a real order, not for the first one we saw. These were 25/40/60,
// which is a twenty-part package — and then an RFQ arrived as one archive of 77
// article folders, each holding a .dxf and a .pdf. 154 entries.
//
// The per-intake ceiling is the one that bites twice: after expansion those 154
// entries ARE attachment rows of the conversation, so a second press locates
// 157 rows. At 25 the button silently stopped being idempotent — it would
// re-pair a fifth of the order and leave the rest untouched.
const MAX_FILES_PER_INTAKE = 500;

// Zip expansion bounds. Generous enough for ~250 parts and still small enough
// that a crafted archive cannot turn one button press into a memory or storage
// incident — the byte ceiling, not the count, is what actually bounds that.
const MAX_ZIP_ENTRIES = 500;
// How deep we follow an archive that holds an archive. 1 is the mailed file, 2
// is the zip inside it — which is what a forwarded order looks like, and what
// "I zipped the project folder" produces when that folder already had a zip in
// it. Deeper than that is not a packing habit, it is a nesting bomb.
const MAX_ARCHIVE_DEPTH = 2;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024; // uncompressed, per intake
const MAX_TOTAL_FILES = 500;                   // loose + expanded, per intake

// What counts as a purchase order, by filename. Overridable per step
// (validate.js refuses a pattern that does not compile).
//
// The quote vocabulary sits here beside the order vocabulary on purpose: a
// request for quotation carries the same table of positions and quantities as
// an order does, and the step that reads it does not care which one it is.
const DEFAULT_PO_PATTERN = 'inkoopbestelbon|inkooporder|purchase.?order|purchase.?quote'
    + '|request.?for.?quotation|offerte.?aanvraag|bestelbon|\\brfq\\b|^PO[-_ ]?\\d+';

// Which CountCustom-style outputs writeTo.mapping may name. Mirrors
// FILE_INTAKE_OUTPUTS in validate.js — the executor is lenient (unknown
// output → null) because validation already refused it at save time.
const PAIR_ROLES = { BOTH: 'paired', CAD_ONLY: 'cad_only', DRAWING_ONLY: 'drawing_only' };

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
function operationOf(base) {
    const m = OPERATION_RE.exec(String(base || '').trim());
    if (!m) return '';
    const op = m[1].trim();
    return (!op || /^\d+$/.test(op)) ? '' : op.toLowerCase();
}
function withoutOperation(base) {
    const s = String(base || '').trim();
    const m = OPERATION_RE.exec(s);
    if (!m || !operationOf(s)) return s;
    return s.slice(0, m.index).trim();
}

/** The PART a file belongs to: no extension, no operation, normalised. */
function partKeyOf(filename) {
    return normalizeBase(withoutOperation(baseNameOf(filename)));
}

/** The part an article FOLDER stands for — its last segment, same treatment. */
function partKeyOfFolder(folderPath) {
    const leaf = String(folderPath || '').split('/').pop() || '';
    return normalizeBase(withoutOperation(leaf.trim().toLowerCase()));
}

/** Does this read like a part number at all — long enough, and with a digit in it? */
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
const CAD_EXT_PREFERENCE = {
    step: 0, stp: 0, p21: 0, dxf: 1, dwg: 2, iges: 3, igs: 3,
    x_t: 4, x_b: 4, sat: 5, sab: 5, '3dm': 6, sldprt: 7, ipt: 7, stl: 8,
};
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

function extensionOf(filename) {
    const s = String(filename || '');
    const dot = s.lastIndexOf('.');
    return dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
}

/** The attachments-grain child of a mailbox connector's sync tree. */
function attachmentsTableFor(model, connector) {
    const children = Array.isArray(connector?.sync?.children) ? connector.sync.children : [];
    const child = children.find((c) => c && c.level === 2) || children[1] || null;
    if (!child || typeof child.tableId !== 'string') return null;
    const tables = Array.isArray(model?.tables) ? model.tables : [];
    return tables.find((t) => t && (t.id === child.tableId || t.key === child.tableId)) || null;
}

/** First `file`-typed column on a table — where the descriptor lives. */
function fileFieldOf(table) {
    return (table.fields || []).find((f) => f && f.type === 'file') || null;
}

/**
 * The id materializeAttachment can actually find a row by: the one INSIDE the
 * stored file descriptor.
 *
 * This is subtle enough to have broken every intake on a mailbox whose
 * attachments table keeps a separate provider key. `locateDescriptor` matches
 * `descriptor.attachmentId === attachmentId` (or `.fileId`), i.e. the provider's
 * own opaque handle — for Gmail an `ANGjdJ…` blob. A mailbox row ALSO carries
 * `provider_attachment_id`, which is a composite key of its own shape
 * (`<messageId>:<filename>:<size>`) built for uniqueness, not for lookup.
 * Passing that one matched nothing and surfaced as a flat 404 "Not found" per
 * file — indistinguishable from an expired provider handle, which is exactly
 * the wrong diagnosis to hand an operator.
 *
 * Returns null when the column is absent or unparseable; callers keep their
 * existing fallbacks.
 */
function descriptorIdOf(row, fileField) {
    if (!row || !fileField || !fileField.key) return null;
    const raw = row[fileField.key];
    if (!raw) return null;
    let d = raw;
    if (typeof raw === 'string') {
        try { d = JSON.parse(raw); } catch { return null; }
    }
    if (!d || typeof d !== 'object') return null;
    return d.attachmentId || d.fileId || null;
}

function hasField(table, key) {
    return (table.fields || []).some((f) => f && f.key === key);
}

/** Bytes a redeemed file reports, or 0 — only ever used to rank candidates. */
function sizeOfDescriptor(file) {
    const size = file && file.descriptor && file.descriptor.size;
    return Number.isFinite(size) ? size : 0;
}

/**
 * An archive entry's path, as we address it: forward slashes, no leading
 * slash. Zips written on Windows carry backslashes, and a path we do not
 * normalise is a folder we do not recognise.
 */
function zipEntryPath(name) {
    return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

/** The folder an archive entry sits in — '' for an entry at the root. */
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

/** The result shape, with nothing in it — every key a caller may read. */
function emptyIntakeResult() {
    return {
        filed: 0, total: 0, parts: 0, refused: [], pairs: [],
        poFile: null, poName: null, poSource: null,
        sheetFile: null, sheetName: null, lineListFile: null, lineListName: null, sheets: [],
        sampleFile: null, sampleName: null,
        sheetOnly: [], sheetOnlySummary: '',
        skippedFolders: [], skippedSummary: '', others: [],
        emptyFolders: [], emptySummary: '',
        unpairedDrawings: [], unpairedCad: [],
        fuzzy: 0, fuzzyPairs: [], written: 0,
    };
}

/**
 * File one zip entry as an attachment ROW of the same conversation.
 *
 * Written defensively — this step runs against whatever attachments table the
 * app's mailbox connector generated, so every column is written only if the
 * model actually has it, and the conversation keys and message relation are
 * INHERITED from the archive's own row rather than guessed.
 *
 * The synthetic `provider_attachment_id` is what keeps a second press honest:
 * the column is unique, and `<the archive's id>#<entry PATH>` is stable, so a
 * re-run collides instead of duplicating. (It normally never gets that far —
 * the caller skips an entry whose name is already among the filed files — so a
 * failure here is reported per entry and the batch carries on.)
 *
 * The PATH, not the bare name. An archive with folders is an archive whose
 * names repeat — that is what the folders are FOR — so "map-a/tekening.pdf" and
 * "map-b/tekening.pdf" would otherwise both claim `<zip>#tekening.pdf`, and the
 * unique constraint would turn the second one into a per-entry refusal. The
 * displayed filename stays the bare name; only the identity carries the path.
 *
 * Returns the saved row, or null when the table cannot describe a file at all.
 */
async function fileEntryAsAttachment(app, model, attTable, {
    entryName, entryPath, descriptor, bytes, sourceRow, fileField, writeRecord, writeViewer, ctx,
} = {}) {
    if (!attTable || !fileField || !fileField.key) return null;
    const src = sourceRow || {};
    const values = { [fileField.key]: descriptor };

    if (hasField(attTable, 'filename')) values.filename = entryName;
    if (hasField(attTable, 'mime_type')) values.mime_type = (descriptor && descriptor.mime) || null;
    if (hasField(attTable, 'size')) values.size = bytes;
    if (hasField(attTable, 'is_inline')) values.is_inline = false;
    // WHERE it came from, when the table can hold it. An archive of 243 files
    // is one flat pile without this, and the folder is not decoration: it is
    // the only thing that says a "Labels" folder holds labels rather than 77
    // more parts. A loose mailed file has no folder and gets null.
    if (hasField(attTable, 'map')) values.map = folderOf(entryPath) || null;
    if (hasField(attTable, 'provider_attachment_id')) {
        const parent = src.provider_attachment_id || src.id || 'zip';
        values.provider_attachment_id = `${parent}#${entryPath || entryName}`;
    }
    // Conversation keys + the message relation come from the archive's row:
    // the entry belongs to exactly the mail the zip was attached to.
    for (const key of ['thread_key', 'provider_message_id']) {
        if (hasField(attTable, key) && src[key] !== undefined) values[key] = src[key];
    }
    for (const f of attTable.fields || []) {
        if (f && f.type === 'relation' && src[f.key] !== undefined) values[f.key] = src[f.key];
    }

    return writeRecord(app, model, attTable, values, { viewer: writeViewer(ctx) });
}

// A spreadsheet is order paperwork by its nature: nobody sends a plate as a
// .xlsx. Recognising it by extension keeps that fact out of the PO pattern,
// which is about what a file is CALLED rather than what it is.
const SHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls', 'csv']);

// How many spreadsheets we OPEN to find out what they are. A package carries
// one bill of materials and a couple of strays; past this the biggest ones
// were opened and the rest still rank by size, exactly as they always did.
const MAX_SHEETS_SCANNED = 10;

/**
 * Classify one attachment row. Cheapest signal first: extension → CAD or
 * spreadsheet; the PO pattern → purchase order; any other PDF is treated as a
 * drawing (a customer who forgot the CAD file still deserves a project line,
 * visibly incomplete); everything else is 'other'.
 */
function classify(name, poRe) {
    const { cadMimeForName } = require('../core/cad/cadTypes');
    // 'zip' is the KIND for every container, whatever the container is. A .7z
    // is one we cannot open, and it still has to be recognised as an archive —
    // otherwise it falls through to 'other' and the report says nothing about
    // the one file that held the whole order.
    if (require('./archive').looksLikeArchiveName(name)) return 'zip';
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

/**
 * Resolve writeTo.constants ({ col: binding }) to literal values, keeping only
 * columns that exist on the target table. Resolved ONCE for the whole batch —
 * provenance cannot vary between rows of the same intake.
 */
function resolveConstants(constants, table, ctx, scope, resolveBinding) {
    const out = {};
    if (!constants || typeof constants !== 'object') return out;
    for (const [col, binding] of Object.entries(constants)) {
        if (!hasField(table, col)) continue;
        out[col] = resolveBinding(binding, ctx, scope);
    }
    return out;
}

/**
 * Execute the step. `helpers` carries actionExecutor's own primitives
 * (resolveBinding / buildServerScope / writeViewer / findTable / writeRecord)
 * so the two modules never require each other at load time.
 */
async function fileIntakeStep(app, model, step, ctx, helpers) {
    const { resolveBinding, buildServerScope, writeViewer, findTable, writeRecord } = helpers;
    const stepDataSource = require('./stepDataSource');
    const connectors = require('./connectors');
    const { materializeAttachment } = require('./mailboxAttachments');

    const scope = buildServerScope(ctx);
    const viewer = {
        id: ctx.viewerId ?? null,
        role: ctx.role ?? null,
        organizationId: app.organizationId || null,
    };

    const threadKeyRaw = resolveBinding(step.threadKey, ctx, scope);
    const threadKey = typeof threadKeyRaw === 'string' ? threadKeyRaw.trim() : (threadKeyRaw == null ? '' : String(threadKeyRaw));
    if (!threadKey) return { ok: false, error: 'No conversation was selected' };

    const connector = connectors.findConnector(model, step.connectorId);
    if (!connector || connector.kind !== 'mailbox') {
        return { ok: false, error: 'This action is not connected to a mailbox' };
    }
    const attTable = attachmentsTableFor(model, connector);
    if (!attTable) return { ok: false, error: 'This mailbox does not record attachments' };
    if (!hasField(attTable, 'thread_key')) {
        return { ok: false, error: 'The attachments table has no thread_key column' };
    }
    const fileField = fileFieldOf(attTable);
    if (!fileField) return { ok: false, error: 'The attachments table has no file column' };

    let poRe;
    try {
        const src = step.poPattern && typeof step.poPattern === 'string' ? step.poPattern : DEFAULT_PO_PATTERN;
        // Same guard as validate.js, re-checked here because definitions saved
        // before the guard existed still execute: a nested-quantifier pattern
        // against a sender-controlled filename hangs the shared event loop.
        const { hasNestedQuantifier } = require('./safePattern');
        poRe = new RegExp(hasNestedQuantifier(src) ? DEFAULT_PO_PATTERN : src, 'i');
    } catch {
        poRe = new RegExp(DEFAULT_PO_PATTERN, 'i');
    }

    // ── 1. Locate, as the viewer ────────────────────────────────────────
    // A synthetic records binding through the same reader promptContext uses:
    // the real query compiler, under the viewer's row-level access. Inline
    // images (signature logos) are excluded when the column exists.
    const filter = [{ field: 'thread_key', op: 'eq', value: threadKey, required: true }];
    if (hasField(attTable, 'is_inline')) filter.push({ field: 'is_inline', op: 'eq', value: false });
    const located = await stepDataSource.resolveDataBinding(app, model, {
        kind: 'records',
        tableId: attTable.id,
        filter,
        sort: hasField(attTable, 'filename') ? [{ field: 'filename', dir: 'asc' }] : undefined,
    }, {
        viewer,
        role: ctx.role ?? null,
        resolveValue: (b) => resolveBinding(b, ctx, scope),
        maxRows: MAX_FILES_PER_INTAKE + 1,
    });
    if (located === null) return { ok: false, error: 'The attachments for this conversation could not be read' };

    const truncated = located.length > MAX_FILES_PER_INTAKE;
    const rows = truncated ? located.slice(0, MAX_FILES_PER_INTAKE) : located;
    if (!rows.length) {
        if (!step.allowEmpty) return { ok: false, error: 'This conversation has no attachments to file' };
        // Asked to run unattended (opening a conversation, say): nothing to
        // file is an outcome, not a failure. The report keeps its full shape
        // so a formula reading .pairs or .filed sees zeroes, never undefined.
        return { ok: true, result: emptyIntakeResult() };
    }

    // Storage checked ONCE before the batch — twenty provider fetches followed
    // by twenty failed puts is a bad way to learn the store is down.
    const storageStore = require('../stores/storageStore');
    if (!storageStore.isAvailable()) return { ok: false, error: 'File storage is not available' };

    // ── 2. Redeem each, per-file failure isolation ──────────────────────
    const files = [];       // { name, baseName, kind, descriptor, rowId }
    const refused = [];     // { name, reason }
    let quotaHit = null;
    for (const row of rows) {
        const name = (typeof row.filename === 'string' && row.filename) ? row.filename : `attachment_${String(row.id || '').slice(0, 8)}`;
        if (quotaHit) break;
        try {
            const descriptor = await materializeAttachment(app, model, {
                attachmentId: descriptorIdOf(row, fileField) || row.provider_attachment_id || row.id,
                tableId: attTable.id,
                recordId: row.id,
                viewer,
            });
            files.push({
                name: (descriptor && descriptor.name) || name,
                baseName: baseNameOf((descriptor && descriptor.name) || name),
                kind: classify((descriptor && descriptor.name) || name, poRe),
                descriptor,
                // Read back from the row, so the folder a file came out of
                // still decides on the SECOND press. Expanding an archive
                // turns its entries into ordinary attachment rows, and a rule
                // that only held during the run that unpacked them would quietly
                // change its mind the next time somebody pressed the button.
                folder: folderOfRow(row),
                rowId: row.id,
                // The whole row, not just its id: a zip's entries inherit the
                // conversation keys and the message relation from it.
                row,
            });
        } catch (e) {
            // Quota is app-wide: every remaining file would 409 too. Anything
            // else (a dirty scan, a provider 404, an unsupported type) is a
            // named per-file refusal and the batch carries on.
            if (e && e.status === 409 && e.code === 'quota_exceeded') { quotaHit = e; break; }
            refused.push({ name, reason: e && e.message ? String(e.message).slice(0, 200) : 'failed' });
        }
    }

    // Backfill the folder column for rows filed before it existed. One pass, the
    // first time somebody presses the button again; after that every row has it
    // and this does nothing. Without it the files view would group an already
    // unpacked archive under nothing at all.
    if (hasField(attTable, 'map')) {
        for (const f of files) {
            const row = f.row;
            if (!f.folder || !row || (typeof row.map === 'string' && row.map)) continue;
            try {
                await writeRecord(app, model, attTable, { map: f.folder }, {
                    viewer: writeViewer(ctx), recordId: f.rowId,
                });
            } catch { /* a display column is never worth failing an intake for */ }
        }
    }

    if (quotaHit && files.length === 0) {
        return { ok: false, error: quotaHit.message || 'App storage is full', code: 'quota_exceeded' };
    }

    // ── 2b. Expand zip packages ─────────────────────────────────────────
    // A customer's order can arrive as ONE archive. Each entry goes through
    // the SAME acceptance ladder as a mailed file (storeDerivedFile: name
    // proposes, bytes confirm, scan before ledger) and hangs off the zip's
    // own attachment row, so it is readable by exactly whoever may read the
    // zip. Nested zips are refused, never recursed into.
    const zipReports = [];
    // Folders the archive DECLARES and then leaves empty. In a real order one
    // article folder arrived with nothing in it: the part is on the order and
    // on the customer's own line list, and every file for it was forgotten.
    // It produces no project line (files decide which lines exist), so the
    // only thing standing between that plate and silence is saying its name.
    const emptyFolders = [];
    // A QUEUE, not a list: an archive may hold an archive, and the entries of
    // the inner one are files of this same conversation. `prefix` keeps their
    // paths distinct — two nested packages may each carry a "parts/" folder, and
    // without it those two folders would read as one part.
    const queue = files.filter((f) => f.kind === 'zip' && f.descriptor)
        .map((f) => ({ file: f, depth: 1, prefix: '' }));
    if (queue.length && !quotaHit) {
        const mailbox = require('./mailboxAttachments');
        const archive = require('./archive');
        const canExpand = typeof mailbox.getStoredAttachmentBuffer === 'function'
            && typeof mailbox.storeDerivedFile === 'function';
        while (queue.length) {
            const { file: zipFile, depth, prefix } = queue.shift();
            const report = { name: zipFile.name, extracted: 0, refusedEntries: [] };
            zipReports.push(report);
            if (quotaHit) break;
            if (!canExpand) {
                report.refusedEntries.push({ name: zipFile.name, reason: 'zip expansion is not available' });
                continue;
            }
            let opened;
            try {
                const bytes = await mailbox.getStoredAttachmentBuffer(app, zipFile.descriptor.fileId);
                if (!bytes || !bytes.length) throw new Error('empty');
                opened = await archive.openArchive(bytes, { name: zipFile.name });
            } catch (e) {
                // The REASON, not a shrug. "Could not open the zip" about a
                // password-protected archive or a .7z sends somebody hunting a
                // corrupt file; naming the format or the password is a sentence
                // they can forward to the customer instead.
                report.refusedEntries.push({
                    name: zipFile.name,
                    reason: (e && e.reason) || 'could not open the archive',
                });
                if (e && e.format) report.format = e.format;
                continue;
            }
            report.format = opened.format;
            const allEntries = opened.entries;
            // Against the FULL list, never the truncated one: a folder we simply
            // did not read is not a folder the customer left empty.
            const entryPaths = allEntries.map((e) => zipEntryPath(e.path));
            for (const d of opened.dirs || []) {
                const dir = zipEntryPath(d).replace(/\/+$/, '');
                if (!dir) continue;
                if (entryPaths.some((f) => f.startsWith(`${dir}/`))) continue;
                emptyFolders.push(prefix ? `${prefix}/${dir}` : dir);
            }
            let entries = allEntries;
            if (entries.length > MAX_ZIP_ENTRIES) {
                report.refusedEntries.push({ name: zipFile.name, reason: `only the first ${MAX_ZIP_ENTRIES} of ${entries.length} entries were read` });
                entries = entries.slice(0, MAX_ZIP_ENTRIES);
            }
            report.entries = entries.length;
            // How many files are coming, written on the archive's own row BEFORE
            // the work starts. Unpacking 243 files takes minutes inside this one
            // step, and a count of what is done means nothing without the count
            // of what there is — this is the denominator, published early
            // precisely so something can watch the numerator climb.
            if (hasField(attTable, 'entries') && zipFile.rowId) {
                try {
                    await writeRecord(app, model, attTable, { entries: entries.length }, {
                        viewer: writeViewer(ctx), recordId: zipFile.rowId,
                    });
                } catch { /* a progress denominator is never worth failing an intake for */ }
            }
            let totalBytes = 0;
            for (const entry of entries) {
                if (quotaHit) break;
                // The path identifies the entry; the last segment names it. An
                // order that arrives as one folder per article ("RFQ-1/3010-
                // 005424-01/3010-005424-01.dxf") flattens to the filename the
                // pairing already understands, and keeps the path for identity.
                const innerPath = zipEntryPath(entry.path);
                const entryPath = prefix ? `${prefix}/${innerPath}` : innerPath;
                const entryName = entryPath.split('/').pop().trim();
                if (!entryName || entryName.startsWith('.')) continue; // junk/hidden
                const nested = archive.looksLikeArchiveName(entryName);
                if (nested && depth >= MAX_ARCHIVE_DEPTH) {
                    report.refusedEntries.push({
                        name: entryPath,
                        reason: `archives nested more than ${MAX_ARCHIVE_DEPTH} deep are not opened`,
                    });
                    continue;
                }
                // A file mailed loose AND inside the zip is one file, not two.
                // Only against LOOSE files: two entries in different folders
                // legitimately share a name, and comparing against what this
                // expansion already produced would drop the second one without
                // a word — the archive has folders precisely so that it can
                // hold "deel-a/tekening.pdf" beside "deel-b/tekening.pdf".
                if (files.some((f) => f.kind !== 'zip' && !f.fromZip
                    && f.name.toLowerCase() === entryName.toLowerCase())) continue;
                if (files.filter((f) => f.kind !== 'zip').length >= MAX_TOTAL_FILES) {
                    report.refusedEntries.push({ name: entryPath, reason: 'file limit for one intake reached' });
                    continue;
                }
                let bytes;
                try { bytes = await entry.read(); } catch {
                    report.refusedEntries.push({ name: entryPath, reason: 'could not read the entry' });
                    continue;
                }
                totalBytes += bytes.length;
                if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
                    report.refusedEntries.push({ name: entryPath, reason: 'the zip is too large in total' });
                    break;
                }
                try {
                    const descriptor = await mailbox.storeDerivedFile(app, {
                        buffer: bytes, name: entryName,
                        recordId: zipFile.rowId, fieldKey: fileField.key,
                        // Said out loud, and only inside the depth budget — the
                        // store refuses an archive entry unless a caller takes
                        // responsibility for what happens to it next.
                        allowArchive: nested,
                    });
                    // The entry becomes a REAL attachment row of the same
                    // conversation, not just a member of this run's pairing
                    // list. Without it "unpacked" was only true inside the
                    // step: the project lines got their CAD file, while every
                    // files view stayed bound to the attachments table and
                    // went on showing one .zip nobody could open — which is
                    // not what anyone means by unpacking an archive.
                    const filedRow = await fileEntryAsAttachment(app, model, attTable, {
                        entryName, entryPath, descriptor, bytes: bytes.length,
                        sourceRow: zipFile.row, fileField, writeRecord, writeViewer, ctx,
                    });
                    files.push({
                        name: entryName,
                        baseName: baseNameOf(entryName),
                        kind: classify(entryName, poRe),
                        descriptor,
                        // The folder decides whether these files describe PARTS
                        // at all — see the CAD-less-folder rule in the pairing.
                        folder: folderOf(entryPath),
                        // Its OWN row when it got one, so anything hanging off
                        // the file addresses the file and not the archive.
                        rowId: (filedRow && filedRow.id) || zipFile.rowId,
                        fromZip: zipFile.name,
                    });
                    report.extracted += 1;
                    if (filedRow && filedRow.id) report.filed = (report.filed || 0) + 1;
                    if (nested) {
                        // Its entries belong to this conversation too. They hang
                        // off the INNER archive's own row, so access follows the
                        // file rather than the mail it was forwarded in.
                        queue.push({
                            file: files[files.length - 1],
                            depth: depth + 1,
                            prefix: entryPath,
                        });
                    }
                } catch (e) {
                    if (e && e.status === 409 && e.code === 'quota_exceeded') { quotaHit = e; break; }
                    report.refusedEntries.push({ name: entryPath, reason: e && e.message ? String(e.message).slice(0, 200) : 'refused' });
                }
            }
        }
    }

    // ── 3. Pair — exact first, then SAFE normalisations only ────────────
    // Tier 1: identical base names. Tier 2: canonical forms equal (case,
    // " (1)" copy suffix, separator style). Tier 3: unique containment-prefix.
    // Anything below tier 1 is marked 'fuzzy' so the app can say "controle
    // nodig" — and an AMBIGUOUS candidate set never matches at all: no match
    // is honest, a guessed match cuts the wrong plate.
    const po = files.find((f) => f.kind === 'po') || null;

    // A FOLDER WITHOUT A SINGLE CAD FILE DESCRIBES NO PARTS.
    //
    // An order archive puts one folder per article beside a "Labels" folder of
    // 77 label sheets. Flattened, every one of those labels looks like a lone
    // drawing and becomes a project line of its own — 77 parts nobody ordered,
    // sitting between the real ones. The folder is the only thing that says
    // otherwise, and it is exactly the thing flattening throws away.
    //
    // Only files that came OUT OF AN ARCHIVE have a folder; a loose mailed
    // drawing keeps every bit of its old behaviour, including becoming a line
    // with an empty CAD column when the customer forgot the model.
    const foldersWithCad = new Set(
        files.filter((f) => f.kind === 'cad' && f.folder).map((f) => f.folder),
    );
    const skipped = new Map();
    const inSkippedFolder = (f) => {
        if (!f.folder || foldersWithCad.has(f.folder)) return false;
        skipped.set(f.folder, (skipped.get(f.folder) || 0) + 1);
        return true;
    };

    // TIER 0: AN ARTICLE FOLDER IS ONE PART, WHATEVER ITS FILES ARE CALLED.
    //
    // Grouping on the filename is right for a flat pile and wrong for a folder
    // tree, because inside a folder the names are free to vary: nine article
    // folders in one real order hold 'X.dxf' AND 'X (afschuining).dxf', which
    // read as names are two parts and read as a folder are one plate with a
    // chamfer. Measured against that customer's own line list, filename
    // grouping produced 85 lines where 77 were ordered; folder grouping
    // produced 76 — every one of them a line they actually placed.
    //
    // The folder only gets to speak when it says ONE thing: every CAD file in
    // it must belong to the same part. A folder holding two part numbers is a
    // folder that means nothing, and those files fall back to their names.
    const cadKeysByFolder = new Map();
    for (const f of files) {
        if (f.kind !== 'cad' || !f.folder) continue;
        const seen = cadKeysByFolder.get(f.folder) || new Set();
        seen.add(partKeyOf(f.name));
        cadKeysByFolder.set(f.folder, seen);
    }
    const partFolders = new Map();      // folder path → the part it stands for
    for (const [folder, keys] of cadKeysByFolder) {
        if (keys.size !== 1) continue;
        partFolders.set(folder, partNameForFolder(folder, [...keys][0]));
    }

    const groups = new Map();
    for (const f of files) {
        if (f.kind !== 'cad' && f.kind !== 'drawing') continue;
        if (f === po) continue;
        if (inSkippedFolder(f)) continue;
        const folderPart = f.folder ? partFolders.get(f.folder) : undefined;
        const key = folderPart === undefined ? canonicalBaseOf(f.name) : folderPart;
        const g = groups.get(key)
            || { key, cads: [], drawings: [], folder: folderPart === undefined ? '' : f.folder };
        (f.kind === 'cad' ? g.cads : g.drawings).push(f);
        groups.set(key, g);
    }
    // `meta` is what the FOLDER knew and the filename could not say. Defaults
    // come off the leading file, so a loose mailed pair keeps exactly the shape
    // it always had.
    const mkPair = (baseName, cad, drawing, matchStatus, meta = {}) => {
        const lead = cad || drawing;
        return {
            baseName,
            // The join key an order sheet can be matched on: no extension, no
            // operation. The sheet says '3010-010857' + variant '01'; the files
            // say '3010-010857-01 (afschuining).dxf'. Neither side can find the
            // other without one agreed spelling.
            partKey: meta.partKey || (lead ? partKeyOf(lead.name) : baseName),
            folder: meta.folder || (lead && lead.folder) || '',
            // Work instruction, never identity — 'afschuining', 'tappen'.
            operation: meta.operation || (lead ? operationOf(baseNameOf(lead.name)) : ''),
            cadName: cad ? cad.name : null,
            cadFile: cad ? cad.descriptor : null,
            drawingName: drawing ? drawing.name : null,
            drawingFile: drawing ? drawing.descriptor : null,
            role: cad && drawing ? PAIR_ROLES.BOTH : (cad ? PAIR_ROLES.CAD_ONLY : PAIR_ROLES.DRAWING_ONLY),
            matchStatus,
            // The CAD files this line did NOT pick. Names only: the bytes are
            // already attachment rows of the same conversation, and a second
            // descriptor per line is what pushed a 243-part result over the
            // 64 kB step-body ceiling.
            extraCad: meta.extraCad || [],
        };
    };
    const pairs = [];
    const loneCads = [];
    const loneDrawings = [];
    const prefer = cadPreferenceWith(step.cadPreferred);
    for (const g of groups.values()) {
        g.cads.sort((a, b) => {
            const byFormat = prefer(a.name) - prefer(b.name);
            if (byFormat) return byFormat;
            // Same format, so the NAME decides: the file that spells out the
            // operation is the deliverable. A folder '…-01 (Afschuining)' holds
            // the plain plate beside the chamfered one, and it is the chamfered
            // one that gets cut — their own line list picks it ten times out of
            // ten. Ties fall back to the name so the choice is reproducible.
            const opA = operationOf(baseNameOf(a.name)) ? 0 : 1;
            const opB = operationOf(baseNameOf(b.name)) ? 0 : 1;
            return opA !== opB ? opA - opB : a.name.localeCompare(b.name);
        });
        const cad = g.cads[0] || null;
        const drawing = g.drawings[0] || null;
        // Two CAD files carrying DIFFERENT operations is not a plate-and-its-
        // variant, it is '(links)' beside '(rechts)' — two plates the folder
        // happens to hold together. Pick one and say so; never quietly.
        const namedOps = new Set(g.cads.map((c) => operationOf(baseNameOf(c.name))).filter(Boolean));
        const meta = {
            partKey: g.folder ? g.key : undefined,
            folder: g.folder || undefined,
            operation: (g.folder && operationOf(String(g.folder).split('/').pop())) || undefined,
            extraCad: g.cads.slice(1).map((c) => c.name),
        };
        if (cad && drawing) {
            // Inside a folder the two files need not share a name — the folder
            // already said they belong together, so comparing PARTS is the
            // honest test. Outside one, only an identical base name is exact.
            const exact = g.folder
                ? partKeyOf(cad.name) === partKeyOf(drawing.name)
                : cad.baseName === drawing.baseName;
            const status = namedOps.size > 1 ? 'controleren' : (exact ? 'exact' : 'fuzzy');
            pairs.push(mkPair(g.key, cad, drawing, status, meta));
        } else if (cad) {
            loneCads.push({ key: g.key, cad, used: false, meta, ambiguous: namedOps.size > 1 });
        } else if (drawing) {
            loneDrawings.push({ key: g.key, drawing, used: false, meta });
        }
    }
    for (const d of loneDrawings) {
        const hits = loneCads.filter((c) => !c.used && containsPrefix(d.key, c.key));
        if (hits.length === 1) {
            hits[0].used = true;
            d.used = true;
            pairs.push(mkPair(d.key, hits[0].cad, d.drawing, 'fuzzy', hits[0].meta));
        }
    }
    for (const c of loneCads) {
        if (!c.used) pairs.push(mkPair(c.key, c.cad, null, c.ambiguous ? 'controleren' : 'geen', c.meta));
    }
    for (const d of loneDrawings) {
        if (!d.used) pairs.push(mkPair(d.key, null, d.drawing, 'geen', d.meta));
    }

    // WITHOUT A FOLDER, TWO NAMES THAT DIFFER ONLY BY THEIR OPERATION ARE A
    // QUESTION, NOT AN ANSWER.
    //
    // In a flat archive 'plaat-01.dxf' and 'plaat-01 (afschuining).dxf' become
    // two groups and there is nothing to arbitrate between them: they may be
    // one plate cut once, and '(links)'/'(rechts)' may be two. Merging would
    // cut one plate too few, splitting one too many — so both lines stand and
    // both are flagged for a human.
    const looseByPart = new Map();
    for (const pair of pairs) {
        if (pair.folder) continue;
        const share = looseByPart.get(pair.partKey) || [];
        share.push(pair);
        looseByPart.set(pair.partKey, share);
    }
    for (const share of looseByPart.values()) {
        if (share.length < 2) continue;
        for (const pair of share) pair.matchStatus = 'controleren';
    }
    // ── 3b. The order document, when its NAME does not say so ───────────
    // Tier 1 is the filename pattern above, and it only ever knew one
    // customer's naming ("Inkoopbestelbon_PO24118.pdf"). A supplier whose
    // order is called "B263232.pdf" fell straight through to 'drawing', which
    // cost twice over: the purchase order became a project line of its own,
    // and the step that reads the quantities off it was handed nothing.
    //
    // Tier 2 is structural rather than lexical, and stays inside the same rule
    // as the pairing: never guess between candidates. One unpaired PDF sitting
    // beside files that DID pair with CAD is the paperwork — two unpaired PDFs
    // is a customer who forgot a CAD file, and picking one of those is how you
    // cut the wrong plate.
    let poEntry = po;
    let poSource = po ? 'name' : null;
    if (!poEntry) {
        const orphans = pairs.filter((p) => p.role === PAIR_ROLES.DRAWING_ONLY);
        const family = pairs.filter((p) => p.cadFile).map((p) => p.baseName);
        const orphan = orphans.length === 1 ? orphans[0] : null;
        // The second half of the rule, and the one that stops it cutting a
        // part: an unpaired drawing whose number sits in the SAME family as
        // the CAD files is a plate whose model went missing, never the order.
        // "MW2604-01-3021-001.step" beside "MW2604-01-3022-001.pdf" shares
        // thirteen characters — that is a sibling. "B263232.pdf" beside
        // "19.0592.136.01_alu_5mm.DXF" shares none — that is paperwork.
        if (orphan && family.length && !family.some((key) => sharesNumberFamily(orphan.baseName, key))) {
            pairs.splice(pairs.indexOf(orphan), 1);
            poEntry = { name: orphan.drawingName, descriptor: orphan.drawingFile };
            poSource = 'structure';
        }
    }

    // ── 3c. The bill of materials, if one was sent ──────────────────────
    // Reported SEPARATELY from the order document rather than instead of it,
    // because a real order sends both and they are not the same thing: the PDF
    // is the letter (who, when, which reference) and the sheet is the table
    // (position, quantity, material, thickness, per line). One is read by a
    // model looking at a page; the other is read exactly, from cells.
    //
    // The largest sheet wins when several arrive — a bill of materials is the
    // big one, and a stray "contactgegevens.csv" is not. Never a guess between
    // equals: on a tie the first by name keeps the deterministic order the
    // whole step is built on.
    const sheets = files.filter((f) => f.kind === 'sheet' && f.descriptor);
    const sheetReports = [];
    const sheetOnly = [];
    let sheetEntry = null;
    let lineListEntry = null;
    if (sheets.length) {
        const mailbox = require('./mailboxAttachments');
        const { scanSheet } = require('./sheetScan');
        const partKeys = [...new Set(pairs.map((pair) => pair.partKey).filter(Boolean))];
        const opened = [...sheets].sort((a, b) => sizeOfDescriptor(b) - sizeOfDescriptor(a))
            .slice(0, MAX_SHEETS_SCANNED);
        for (const f of opened) {
            try {
                const bytes = typeof mailbox.getStoredAttachmentBuffer === 'function'
                    ? await mailbox.getStoredAttachmentBuffer(app, f.descriptor.fileId)
                    : null;
                if (bytes && bytes.length) f.scan = scanSheet(bytes, { partKeys, normalize: normalizeBase });
            } catch { /* a sheet we cannot open ranks by size, exactly as before */ }
        }
        for (const f of sheets) {
            sheetReports.push({
                name: f.name,
                rows: f.scan ? f.scan.rows : null,
                columns: f.scan ? f.scan.columns : null,
                hits: f.scan ? f.scan.hits : null,
                missing: f.scan ? f.scan.unmatchedCount : null,
                lineList: Boolean(f.scan && f.scan.lineList),
            });
        }
        // Naming the parts beats being big; among sheets that name the same
        // parts the WIDER table wins, because that is the one that still has a
        // thickness column. With nothing read at all every rank collapses to
        // the size rule this used to be.
        const rank = (f) => [f.scan ? f.scan.hits : 0, f.scan ? f.scan.columns : 0, sizeOfDescriptor(f)];
        const better = (a, b) => {
            const ra = rank(a);
            const rb = rank(b);
            for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b;
            return a;                       // a tie keeps the order we found them in
        };
        const best = (list) => (list.length ? list.reduce(better) : null);
        const asTable = sheets.filter((f) => !(f.scan && f.scan.lineList));
        sheetEntry = best(asTable.length ? asTable : sheets);
        lineListEntry = best(sheets.filter((f) => f.scan && f.scan.lineList));
        // Only the sheet we actually believe. A stray export that named no part
        // we recognise has no standing to declare anything missing.
        if (sheetEntry && sheetEntry.scan && sheetEntry.scan.hits) {
            sheetOnly.push(...sheetEntry.scan.unmatched);
        }
    }

    // Deliberately from the PAIRS rather than from `files`: a label sheet in a
    // CAD-less folder is a file of this conversation but not a document about a
    // part, and showing a model the wrong page is worse than showing it none.
    const samplePair = pairs.find((p) => p.drawingFile) || pairs.find((p) => p.cadFile) || null;
    const sampleEntry = samplePair
        ? {
            descriptor: samplePair.drawingFile || samplePair.cadFile,
            name: samplePair.drawingName || samplePair.cadName,
        }
        : null;

    const others = files
        .filter((f) => f.kind === 'other')
        .map((f) => ({ name: f.name, file: f.descriptor }));

    // ── 4. Upsert one row per pair, as the viewer ───────────────────────
    let written = 0;
    if (step.writeTo && typeof step.writeTo === 'object' && step.writeTo.tableId && pairs.length) {
        const table = findTable(model, step.writeTo.tableId);
        if (!table) return { ok: false, error: 'The table to write pairs to was not found' };
        const mapping = (step.writeTo.mapping && typeof step.writeTo.mapping === 'object') ? step.writeTo.mapping : {};
        const constants = resolveConstants(step.writeTo.constants, table, ctx, scope, resolveBinding);

        // The mapped base_name column is the upsert key (validate.js makes it
        // required); the scalar constants narrow the match so two orders never
        // collide on the same part number.
        const baseCol = Object.entries(mapping).find(([, out]) => out === 'base_name')?.[0] || null;
        if (!baseCol || !hasField(table, baseCol)) {
            return { ok: false, error: 'writeTo.mapping must map a column to base_name' };
        }

        const outputsFor = (pair) => ({
            base_name: pair.baseName,
            cad_name: pair.cadName,
            cad_file: pair.cadFile,
            drawing_name: pair.drawingName,
            drawing_file: pair.drawingFile,
            role: pair.role,
            file_name: pair.cadName || pair.drawingName,
            // The spelling both sides of the order agree on, so an extraction
            // reading the bill of materials can upsert onto the right line.
            part_key: pair.partKey,
            // 'afschuining', 'tappen' — what still has to happen to the plate.
            operation: pair.operation || null,
            folder: pair.folder || null,
            // What this line did NOT take, so a second cutting file is visible
            // on the line rather than only in the attachments list.
            extra_cad: pair.extraCad && pair.extraCad.length ? pair.extraCad.join(', ') : null,
            // 'exact' | 'fuzzy' | 'geen' — how the drawing↔CAD pairing was
            // made. Fuzzy is a flag for the human, never a silent success.
            match_status: pair.matchStatus,
        });

        for (const pair of pairs) {
            const outputs = outputsFor(pair);
            const values = {};
            for (const [col, out] of Object.entries(mapping)) {
                if (!hasField(table, col)) continue;
                values[col] = Object.prototype.hasOwnProperty.call(outputs, out) ? outputs[out] : null;
            }
            // Constants last — provenance wins over anything mapped onto the
            // same column, exactly as ai_extract's writeTo does.
            Object.assign(values, constants);

            // Existing row for this (base name + scalar constants)?
            const matchFilter = [{ field: baseCol, op: 'eq', value: pair.baseName, required: true }];
            for (const [col, v] of Object.entries(constants)) {
                // Date/datetime constants are stamps, not identity: a
                // `toegevoegd_op: now` resolves fresh on every press, so
                // matching on it would never find the first run's rows and
                // the second press would duplicate every pair — the exact
                // failure the upsert exists to prevent.
                const field = (table.fields || []).find((f) => f && f.key === col);
                if (field && (field.type === 'date' || field.type === 'datetime')) continue;
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    matchFilter.push({ field: col, op: 'eq', value: v });
                }
            }
            const existing = await stepDataSource.resolveDataBinding(app, model, {
                kind: 'record', tableId: table.id, filter: matchFilter,
            }, {
                viewer,
                role: ctx.role ?? null,
                resolveValue: (b) => resolveBinding(b, ctx, scope),
            });

            // Upsert semantics: a re-run refreshes the descriptors and the
            // pairing but must never clobber columns the mapping does not own
            // (someone's manual edits on the line survive the second press).
            const saved = await writeRecord(app, model, table, values, {
                viewer: writeViewer(ctx),
                recordId: existing && existing.id ? existing.id : undefined,
            });

            // Hand the row id BACK to the caller on the pair. Everything an
            // action wants to do per document afterwards — read the drawing,
            // write the result onto its line — needs to address that line, and
            // a pair that only carries file descriptors cannot say which row it
            // became. Without this, an action looping over `pairs` and guarding
            // on `paar.recordId` silently ran zero iterations: the lines were
            // created and paired, and every extracted column stayed empty.
            pair.recordId = (saved && (saved.id || saved.recordId))
                || (existing && existing.id)
                || null;
            written += 1;
        }
    }

    const fuzzyPairs = pairs.filter((p) => p.matchStatus === 'fuzzy');
    const result = {
        filed: files.filter((f) => f.kind !== 'zip').length,
        total: rows.length,
        // How many parts this package describes. A COUNT, always present in
        // both detail modes, so a gate never has to walk the pairs array to
        // ask "did this produce anything".
        parts: pairs.length,
        refused,
        pairs,
        poFile: poEntry ? poEntry.descriptor : null,
        poName: poEntry ? poEntry.name : null,
        // How the order document was recognised: 'name' (the filename
        // pattern), 'structure' (the lone unpaired document beside real CAD
        // files) or null. An operator reading a wrong quantity deserves to
        // know which of those picked the file it came from.
        poSource,
        // ONE document to look at when the package carried no order and no
        // sheet — the first drawing, else the first CAD file.
        //
        // An app asking a model "what kind of request is this?" needs something
        // to show it, and the obvious fallback was `pairs[0].drawingFile`. That
        // reads an array which 'summary' empties and which is empty anyway when
        // nothing paired, so the honest fallback has to be a field of its own:
        // one descriptor, always present in both detail modes, null when there
        // is genuinely nothing to look at.
        sampleFile: sampleEntry ? sampleEntry.descriptor : null,
        sampleName: sampleEntry ? sampleEntry.name : null,
        // The bill of materials, when one was sent. A step reading this instead
        // of the PDF reads cells rather than a picture of cells.
        sheetFile: sheetEntry ? sheetEntry.descriptor : null,
        sheetName: sheetEntry ? sheetEntry.name : null,
        // ARTICLES THE ORDER LISTS AND THE PACKAGE DID NOT CARRY.
        //
        // The mirror image of `emptyFolders`, and the general case of it: an
        // empty folder is a missing part the ARCHIVE happened to admit to, while
        // this catches the same plate when the files were mailed loose and
        // nothing in the package hints that one is absent. The files decide
        // which lines exist, so this creates none — it only refuses to let a
        // plate go missing quietly.
        sheetOnly,
        sheetOnlySummary: sheetOnly.join(', '),
        // A file whose headers ALREADY are the target columns is not a table to
        // interpret, it is a list to import — reported apart so an app can skip
        // a model call rather than pay one to read an answer it was handed.
        lineListFile: lineListEntry ? lineListEntry.descriptor : null,
        lineListName: lineListEntry ? lineListEntry.name : null,
        // Every spreadsheet that was in the package and what it looked like, so
        // a screen can offer the other one instead of hiding that a choice
        // was made at all.
        sheets: sheetReports,
        // Folders that hold documents but no CAD file, and therefore produced no
        // project lines. Named and counted for the same reason `refused` and
        // `fuzzyPairs` are: a rule that quietly drops 77 files is
        // indistinguishable from a bug until it says which 77.
        skippedFolders: [...skipped].map(([folder, count]) => ({ folder, files: count })),
        // The same fact as one sentence. An action can count an array in a
        // formula but cannot walk one, and "which folders" is the half that
        // makes the count worth reading.
        skippedSummary: [...skipped].map(([folder, count]) => `${folder} (${count})`).join(', '),
        // Declared folders that held no file at all — the same honesty channel
        // seen from the other side: skippedFolders is 'files, but no part',
        // emptyFolders is 'a part, but no files'.
        emptyFolders,
        emptySummary: emptyFolders.join(', '),
        others,
        unpairedDrawings: pairs.filter((p) => p.role === PAIR_ROLES.DRAWING_ONLY).map((p) => p.drawingName),
        unpairedCad: pairs.filter((p) => p.role === PAIR_ROLES.CAD_ONLY).map((p) => p.cadName),
        // The honesty channel: how many pairs were NOT a 1-op-1 name match,
        // and which — the app surfaces this so a human re-checks them.
        fuzzy: fuzzyPairs.length,
        fuzzyPairs: fuzzyPairs.map((p) => ({ baseName: p.baseName, cadName: p.cadName, drawingName: p.drawingName })),
        ...(zipReports.length ? { zips: zipReports } : {}),
        written,
        ...(truncated ? { truncated: true, limit: MAX_FILES_PER_INTAKE } : {}),
        ...(quotaHit ? { code: 'quota_exceeded', remaining: Math.max(0, rows.length - files.length - refused.length) } : {}),
    };

    // ── 5. Trim, when the caller says it does not need the detail ───────
    //
    // Every result variable of a server step rides back to the browser and then
    // returns in the BODY of every later step of the same action. `pairs`
    // carries two file descriptors per part, so a 243-file order put ~110 kB in
    // that bag and the next step came back 413 — the button simply stopped
    // working, on exactly the orders this feature exists for.
    //
    // The rows are in the table either way; `pairs` is a convenience that
    // duplicates them. A caller that loops over the table instead asks for
    // 'summary' and keeps a variable bag that does not grow with the order.
    if (step.resultDetail === 'summary') {
        result.pairs = [];
        result.unpairedDrawings = [];
        result.unpairedCad = [];
        result.fuzzyPairs = [];
        result.others = [];
        // The honesty channels stay, bounded: the first few names say WHICH,
        // and the counts beside them say how many there were.
        result.refusedCount = refused.length;
        result.refused = refused.slice(0, 10);
        // These stay, bounded: they are the only place an operator learns that
        // an article folder came in empty, and a count with no names is a
        // rumour. Ten of each is enough to act on.
        result.emptyFolderCount = emptyFolders.length;
        result.emptyFolders = emptyFolders.slice(0, 10);
        result.sheetOnlyCount = sheetOnly.length;
        result.sheetOnly = sheetOnly.slice(0, 10);
        result.skippedFolders = result.skippedFolders.slice(0, 10);
        if (Array.isArray(result.zips)) {
            result.zips = result.zips.map((z) => ({
                ...z,
                refusedCount: (z.refusedEntries || []).length,
                refusedEntries: (z.refusedEntries || []).slice(0, 10),
            }));
        }
    }

    // One line per intake, because "it did nothing" is otherwise invisible:
    // the step used to report ok:true whether it wrote twenty rows or none, and
    // an action reading vars.intake.pairs simply looped zero times and carried
    // on to a cheerful "Klaar".
    const counts = `files=${rows.length} filed=${result.filed} refused=${refused.length} pairs=${pairs.length}`
        + ` written=${written} po=${poEntry ? poSource : 'NO'} sheet=${sheetEntry ? sheetEntry.name : 'NO'}`
        + ` empty=${emptyFolders.length} skipped=${skipped.size} sheetOnly=${sheetOnly.length}`;
    // "Wrote nothing" is only suspicious when it was ASKED to write; a step
    // with no writeTo is a pure pairing read and zero writes is its contract.
    const wroteNothingButShould = Boolean(step.writeTo && step.writeTo.tableId) && pairs.length > 0 && written === 0;
    if (!pairs.length || wroteNothingButShould) {
        log.warn(`[fileIntake] app=${app.id} thread=${threadKey} produced NOTHING to work with — ${counts}`
            + (refused.length ? ` | refused: ${refused.slice(0, 5).map((r) => `${r.name}: ${r.reason}`).join('; ')}` : '')
            + (step.writeTo?.tableId ? '' : ' | no writeTo configured'));
    } else {
        log.info(`[fileIntake] app=${app.id} thread=${threadKey} ${counts}`);
    }

    // EVERY file refused is a failure, not an empty result. Returning ok here
    // is what let a whole run look successful while doing nothing: the caller
    // reads `pairs`, finds none, loops zero times and reports "done". The most
    // common cause is stale provider descriptors — the mailbox was re-synced,
    // so the stored attachment ids 404 — and the operator can only act on that
    // if someone says it out loud.
    if (rows.length && !files.length) {
        const why = refused.length
            ? [...new Set(refused.map((r) => r.reason))].slice(0, 3).join('; ')
            : 'unknown';
        return {
            ok: false,
            error: `None of the ${rows.length} attachments on this conversation could be read (${why}). `
                + 'If this says "Not found", the stored attachment references are stale — re-sync the mailbox and try again.',
            result,
        };
    }

    return { ok: true, result };
}

module.exports = {
    fileIntakeStep,
    // exported for tests
    MAX_FILES_PER_INTAKE,
    MAX_ZIP_ENTRIES,
    MAX_ZIP_TOTAL_BYTES,
    MAX_TOTAL_FILES,
    DEFAULT_PO_PATTERN,
    _internal: { baseNameOf, canonicalBaseOf, normalizeBase, operationOf, withoutOperation, partKeyOf, partKeyOfFolder, partNameForFolder, looksLikePartNumber, containsPrefix, cadPreference, cadPreferenceWith, extensionOf, zipEntryPath, classify, attachmentsTableFor, descriptorIdOf },
};
