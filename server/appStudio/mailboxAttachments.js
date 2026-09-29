/**
 * App Studio — turning a mail attachment into a real, readable file.
 *
 * THE SHAPE: a `file` column holds one of two descriptors, and the second
 * replaces the first the moment anyone actually wants the bytes.
 *
 *   sync writes  → { kind:'mailbox_attachment', connectorId, messageId,
 *                    attachmentId, name, mime, size }
 *   first reader → { kind:'studio_attachment', fileId, name, mime, size }
 *
 * One column, one binding. An author — human or AI — writes `item.file` and
 * nothing else, and both the viewer component and `ai_extract` accept it. That
 * is what makes this a general capability instead of a mailbox special case: no
 * new step kind, no new binding kind, nothing extra in the catalog.
 *
 * WHY LAZY. Downloading every attachment of every synced message on a
 * two-minute schedule would copy documents nobody opens into our storage, under
 * a retention policy, at the owner's quota, widening the malware surface and
 * burning provider quota — for data no one asked for. It would also force owner
 * credentials on a runAs:'viewer' connector, the exact identity confusion
 * mailboxIdentity.js exists to prevent. Redeeming on first use pays per use and
 * leaves exactly one place to scan, account and authorise.
 *
 * ORDER MATTERS. Cheap refusals come before the network call: a viewer who
 * cannot read the ticket, a type we will not accept, a size over the limit or a
 * blown quota must all fail without ever touching Gmail or Graph.
 */

'use strict';

const crypto = require('crypto');

const studioAppDataStore = require('../stores/studioAppDataStore');
const studioAppDbStore = require('../stores/studioAppDbStore');
const storageStore = require('../stores/storageStore');
const rlsGateway = require('./rlsGateway');
const queryCompiler = require('./queryCompiler');
const studioAppQuota = require('./studioAppQuota');
const { DATA_LIMITS } = require('./dataModel');
const { scanBuffer, sniffFamily } = require('../middleware/uploadGuard');
const {
    CAD_MIME_FAMILIES, CAD_CANONICAL_MIMES, GENERIC_MIMES,
    cadMimeForName, canonicalCadMime,
} = require('../core/cad/cadTypes');
const { resolveMailboxIdentity } = require('./mailboxIdentity');
const emailFetch = require('../services/email/fetch');
const { viewerMayReadAttachment } = require('./attachmentAccess');

// The formats an LLM or a browser can
// actually do something with. Everything else is refused rather than stored.
// CAD (STEP/DXF/DWG/IGES) is included because the mailbox is THE ingestion
// route that matters for it — customers mail .step/.dxf to a quoting inbox.
// Canonical mimes only; aliases are folded before this set is consulted.
const ALLOWED_MIME = new Set([
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.ms-excel',
    // A mailed order package often IS one zip (drawings + CAD in a single
    // archive). The zip is stored as an opaque attachment here; ONLY
    // file_intake expands it, bounded and per-entry re-gated (storeDerivedFile
    // below) — nothing else ever unpacks third-party archives.
    'application/zip',
    // The other containers a customer's context menu offers. We cannot OPEN a
    // .7z or a .rar (see appStudio/archive.js — no third-party archiver runs on
    // mailed bytes here), and storing them anyway is the difference between an
    // operator who can download the file and forward it, and one staring at a
    // 415 that says "that file type is not supported" about an order.
    'application/x-7z-compressed',
    'application/vnd.rar',
    'application/x-tar',
    'application/gzip',
    ...CAD_CANONICAL_MIMES,
]);

// Extension → canonical archive mime, for the propose-then-confirm path.
const ARCHIVE_MIME_BY_EXT = Object.freeze({
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    rar: 'application/vnd.rar',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    tgz: 'application/gzip',
});
const ARCHIVE_MIMES = new Set(Object.values(ARCHIVE_MIME_BY_EXT));

/** Provider spellings for the archives, folded before ALLOWED_MIME is consulted. */
const ARCHIVE_ALIAS_MIMES = Object.freeze({
    'application/x-7z-compressed': 'application/x-7z-compressed',
    'application/x-rar-compressed': 'application/vnd.rar',
    'application/x-rar': 'application/vnd.rar',
    'application/vnd.rar': 'application/vnd.rar',
    'application/x-gzip': 'application/gzip',
    'application/gzip': 'application/gzip',
    'application/x-tar': 'application/x-tar',
    'application/x-gtar': 'application/x-tar',
});

// Provider aliases for zip, folded before ALLOWED_MIME is consulted.
const ZIP_ALIAS_MIMES = new Set([
    'application/zip', 'application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip',
]);

// Never rendered or parsed, whatever the provider claims. uploadGuard sanitises
// SVG on the upload path, but sanitising a stranger's inbound mail is not a
// promise worth making — an app that renders attacker-authored markup is one
// bug away from being a phishing host.
const REFUSED_MIME = new Set(['image/svg+xml', 'text/html', 'application/xml', 'text/xml', 'application/xhtml+xml']);

// One mailed DOCUMENT: deliberately well under the platform ceiling. These
// bytes are a stranger's, fetched over someone else's credentials, and a
// drawing or a purchase order that needs more than this is not a drawing.
const MAX_ATTACHMENT_BYTES = Math.min(10 * 1024 * 1024, DATA_LIMITS.MAX_ATTACHMENT_BYTES);

// An ARCHIVE is a container, and the same ten megabytes mean something else
// here: a package of 77 parts, each file perfectly ordinary, arrives as one
// 18 MB zip and was refused as "too large to open" — while the intake that
// would have unpacked it has its own bounds anyway (entry count, uncompressed
// total, and every entry facing this whole ladder again on the way in). The
// ceiling that matters for a container is the platform's, not a document's.
const MAX_ARCHIVE_BYTES = DATA_LIMITS.MAX_ATTACHMENT_BYTES;

/** How many bytes this KIND of attachment may be. */
function ceilingFor(mime) {
    return ARCHIVE_MIMES.has(mime) ? MAX_ARCHIVE_BYTES : MAX_ATTACHMENT_BYTES;
}

function httpError(status, message, code) {
    const e = new Error(message);
    e.status = status;
    if (code) e.code = code;
    return e;
}

/**
 * A `file` column holds JSON text (dataModel.js:208) — or already an object.
 *
 * The parse UNWRAPS repeatedly (bounded): rows written while the connector
 * pre-stringified the descriptor are double-encoded — JSON text whose parse
 * yields a STRING, not the object — and those rows outlive the code fix
 * whenever their message has left the sync's lookback window. Refusing them
 * would refuse the very file the row exists to describe.
 */
function parseDescriptor(value) {
    let v = value;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) {
        try { v = JSON.parse(v); } catch { return null; }
    }
    if (!v || typeof v !== 'object') return null;
    return Array.isArray(v) ? v[0] || null : v;
}

function studioDescriptor(att, { name, mime, from }) {
    return {
        kind: 'studio_attachment',
        fileId: att.id,
        name: name || 'attachment',
        mime: att.mimeType || mime || 'application/octet-stream',
        size: att.size || 0,
        // The provider ids ride along after redemption. Two reasons: a client
        // still holding the pre-redemption descriptor can still find this row
        // (otherwise it 404s forever on data it fetched a second too early),
        // and the row keeps saying which message the file came from.
        ...(from?.attachmentId ? { attachmentId: from.attachmentId } : null),
        ...(from?.messageId ? { messageId: from.messageId } : null),
    };
}

/** True when this descriptor is a redeemable mailbox pointer. */
function isPending(d) {
    return Boolean(d && d.kind === 'mailbox_attachment' && d.attachmentId && d.messageId);
}

/**
 * Locate the row an attachment descriptor lives in — UNDER RLS.
 *
 * The client cannot name it: a pending descriptor is written by the connector
 * before the row has an id, so it carries the provider's identifiers and
 * nothing about where it ended up. Probing for it here rather than trusting a
 * client-supplied table/record is also the safer shape — a viewer can only ever
 * find a row their role can already read.
 *
 * The `contains` probe over file columns is the same trick studioAppFiles uses
 * to link an attachment uploaded before its record existed.
 */
async function locateDescriptor(app, model, { attachmentId, tableId, recordId, viewer }) {
    const role = viewer?.role ?? null;
    const candidates = (model?.tables || []).filter((t) => {
        if (tableId && t.id !== tableId) return false;
        if (!rlsGateway.canRead(t, role)) return false;
        return (t.fields || []).some((f) => f && f.type === 'file');
    });

    for (const table of candidates) {
        const accessFilter = rlsGateway.compileAccessFilter(table, role, viewer || {}, 'read');
        const fileFields = (table.fields || []).filter((f) => f && f.type === 'file');

        const probes = recordId
            ? [queryCompiler.compileGetById(table, recordId, accessFilter)]
            : fileFields.map((f) => queryCompiler.compileRecordList(
                table, { filters: [{ field: f.key, op: 'contains', value: attachmentId }], limit: 1 }, accessFilter,
            ));

        for (const { sql, params } of probes) {
            let rows;
            try { ({ rows } = await studioAppDbStore.query(app.userId, app.id, sql, params)); } catch { continue; }
            const row = rows && rows[0];
            if (!row) continue;
            for (const f of fileFields) {
                const d = parseDescriptor(row[f.key]);
                if (!d) continue;
                const matches = d.attachmentId === attachmentId || d.fileId === attachmentId;
                if (matches) return { table, row, fieldKey: f.key, descriptor: d };
            }
        }
    }
    return null;
}

/**
 * Redeem a pending descriptor for real bytes, or return the stored file if it
 * was already redeemed. Idempotent: the second viewer of the same attachment
 * costs zero provider calls.
 *
 * @param {object} app    - studio app row (userId = owner)
 * @param {object} model  - the canonical data model
 * @param {object} opts
 * @param {string} opts.attachmentId - the provider attachment id (or a fileId)
 * @param {string} [opts.tableId]    - narrows the probe when the caller knows it
 * @param {string} [opts.recordId]   - ditto
 * @param {object} opts.viewer       - { id, role, organizationId? }
 * @param {object} [opts.deps]       - injection seam for tests
 * @returns {Promise<object>} a studio_attachment descriptor
 */
async function materializeAttachment(app, model, {
    attachmentId, tableId, recordId, viewer, deps = {},
} = {}) {
    const fetchBytes = deps.getAttachmentBytes || emailFetch.getAttachmentBytes;
    const identityFor = deps.resolveMailboxIdentity || resolveMailboxIdentity;
    const scan = deps.scanBuffer || scanBuffer;

    // 1. Find it under the viewer's own read access. Someone who may not see the
    //    ticket may not redeem its attachment — that is the whole authorisation
    //    story, and it happens before anything else.
    const found = await locateDescriptor(app, model, { attachmentId, tableId, recordId, viewer });
    if (!found) throw httpError(404, 'Not found');
    const { table, row, fieldKey, descriptor } = found;
    recordId = row.id;

    // 2. Already redeemed → hand back what is stored. Checked before anything
    //    expensive so repeat views are free.
    if (descriptor.kind === 'studio_attachment' && descriptor.fileId) {
        const existing = await studioAppDataStore.getAttachment(descriptor.fileId, app.id, app.userId);
        if (existing && existing.scanned && !existing.quarantined) return descriptor;
        throw httpError(422, 'That file is not available');
    }
    if (!isPending(descriptor)) throw httpError(415, 'That attachment cannot be opened');

    // 3. Cheap refusals, all BEFORE the provider call.
    //    CAD first: mail providers label .step/.dxf as octet-stream or a
    //    vendor alias more often than the real thing, so fold aliases and let
    //    the attachment NAME propose a canonical mime for a generic type —
    //    propose only; the post-download sniff (step 6) still has to confirm
    //    the bytes. The 10 MB document cap is deliberate and unchanged for
    //    CAD; only an archive is measured against the larger container ceiling.
    let mime = String(descriptor.mime || '').toLowerCase();
    const cadCanonical = canonicalCadMime(mime);
    if (cadCanonical) mime = cadCanonical;
    else if (ZIP_ALIAS_MIMES.has(mime)) mime = 'application/zip';
    else if (ARCHIVE_ALIAS_MIMES[mime]) mime = ARCHIVE_ALIAS_MIMES[mime];
    else if (GENERIC_MIMES.has(mime)) {
        const proposed = cadMimeForName(descriptor.name);
        if (proposed) mime = proposed;
        // Same propose-then-confirm rule as CAD: a generic type with an archive
        // name is proposed as that archive, and step 6 still demands the bytes
        // to sniff as one.
        else {
            const ext = String(descriptor.name || '').toLowerCase().split('.').pop();
            if (ARCHIVE_MIME_BY_EXT[ext]) mime = ARCHIVE_MIME_BY_EXT[ext];
        }
    }
    if (REFUSED_MIME.has(mime)) throw httpError(415, 'That file type is not supported');
    if (!ALLOWED_MIME.has(mime)) throw httpError(415, 'That file type is not supported');
    if (descriptor.isInline) throw httpError(415, 'That is an inline image, not an attachment');
    const declared = Number(descriptor.size) || 0;
    const ceiling = ceilingFor(mime);
    if (declared > ceiling) throw httpError(413, 'That attachment is too large to open here');

    // 4. Quota, still before the network: a 409 must not cost a download.
    await studioAppQuota.assertAttachmentQuota(app, declared || 1);
    await assertAttachmentTotalBytes(app, declared);

    // 5. Whose credentials? Exactly the ladder the sync uses — runAs:'viewer'
    //    means the person clicking, runAs:'owner' means the owner. Never a
    //    third rule invented here.
    const connector = (model?.connectors || []).find((c) => c && c.id === descriptor.connectorId);
    if (!connector) throw httpError(404, 'That mailbox connection no longer exists');
    const identity = await identityFor(connector, { app, viewerId: viewer?.id ?? null });

    const { buffer, mimeType, filename } = await fetchBytes({
        provider: identity.provider,
        tokens: identity.tokens,
        onRefresh: identity.onRefresh,
        mailbox: identity.mailbox,
        messageId: descriptor.messageId,
        attachmentId: descriptor.attachmentId,
        maxBytes: ceiling,
    });
    if (!buffer || !buffer.length) throw httpError(422, 'That attachment came back empty');

    // 6. Trust the BYTES, never the provider's content type — that header is
    //    written by whoever sent the mail. (The family table now also carries
    //    the CAD families, so a proposed model/step must really sniff 'step'.)
    const family = sniffFamily(buffer);
    const expected = FAMILY_BY_MIME[mime];
    if (expected && !expected.includes(family)) {
        throw httpError(415, 'That file is not what it claims to be');
    }

    const verdict = await scan(buffer);
    if (verdict && verdict.clean === false) {
        throw httpError(422, 'That file did not pass the malware scan');
    }

    // 7. Store, then record. A ledger row only ever describes clean bytes.
    //    The stored mime is the CANONICAL one — the extractor routes on it
    //    later, and "application/octet-stream" routes nowhere.
    let storedMime = String(mimeType || mime || 'application/octet-stream').toLowerCase();
    storedMime = canonicalCadMime(storedMime)
        || (CAD_CANONICAL_MIMES.has(mime) && GENERIC_MIMES.has(storedMime) ? mime : storedMime);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, sha256);
    await storageStore.uploadFile(key, buffer, storedMime);

    let ledger;
    try {
        ledger = await studioAppDataStore.addAttachment(app.id, app.userId, {
            recordId,
            fieldKey,
            mimeType: storedMime,
            sha256,
            size: buffer.length,
        });
        await studioAppDataStore.setAttachmentScan(ledger.id, app.id, app.userId, { scanned: true, quarantined: false });
    } catch (err) {
        // Do not leave an orphan blob behind a failed ledger write.
        await storageStore.deleteFile(key).catch(() => {});
        throw err;
    }

    const next = studioDescriptor({ ...ledger, size: buffer.length }, {
        name: filename || descriptor.name,
        mime: storedMime,
        from: descriptor,
    });

    // 8. Write the descriptor back with OWNER authority. The reader may only
    //    have read access — caching what they just fetched must not depend on
    //    them being able to write.
    const writeFilter = rlsGateway.compileAccessFilter(table, 'owner', { id: app.userId, role: 'owner' }, 'update');
    // The OBJECT, not JSON text — compileUpdate's coerceValue serialises file
    // columns itself. Pre-stringifying here re-created the exact double-encoding
    // this file exists to redeem: the cached studio_attachment would parse to a
    // string, and the SECOND open of a file would break where the first worked.
    const upd = queryCompiler.compileUpdate(table, recordId, { [fieldKey]: next }, writeFilter);
    await studioAppDbStore.exec(app.userId, app.id, upd.sql, upd.params);

    return next;
}

// Which sniffed families satisfy a declared MIME. Mirrors uploadGuard's
// MIME_FAMILIES for the subset we accept from a mailbox.
const FAMILY_BY_MIME = Object.freeze({
    'application/pdf': ['pdf'],
    'image/png': ['png'],
    'image/jpeg': ['jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    // text/* WIDENED with the text-shaped CAD families, exactly like
    // uploadGuard: a genuine STEP/DXF/IGES file declared text/plain must not
    // START failing now that those bytes sniff their own family. Widening only.
    'text/plain': ['text', 'step', 'dxf', 'iges', 'stl', 'sat', 'parasolid'],
    'text/csv': ['text', 'step', 'dxf', 'iges', 'stl', 'sat', 'parasolid'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
    'application/msword': ['ole'],
    'application/vnd.ms-excel': ['ole'],
    'application/zip': ['zip'],
    'application/x-7z-compressed': ['7z'],
    'application/vnd.rar': ['rar'],
    'application/gzip': ['gzip'],
    // A tar is 512-byte blocks with its marker inside the first header, and an
    // old enough one has no marker at all — so 'binary' satisfies it too. The
    // reader in archive.js is the real gate: bytes that are not tar blocks
    // enumerate to nothing, which is a named empty archive, not a stored lie.
    'application/x-tar': ['tar', 'binary'],
    // CAD families come from the shared table (core/cadTypes.js).
    ...CAD_MIME_FAMILIES,
});

const MAX_ATTACHMENT_TOTAL_BYTES = parseInt(process.env.STUDIO_APP_ATTACHMENT_TOTAL_BYTES, 10)
    || 1024 * 1024 * 1024;

/**
 * Sum the owner-scoped ledger against the app's total-bytes ceiling. Same frozen
 * 409 contract studioAppQuota uses, so every caller surfaces it identically.
 * (Single implementation — routes/studioAppFiles.js imports this one.)
 */
async function assertAttachmentTotalBytes(app, addBytes) {
    const rows = await studioAppDataStore.listAttachments(app.id, app.userId);
    // Count each BLOB once. Storage is content-addressed by sha256, so two
    // records attaching the same file occupy one object — summing ledger rows
    // charged an app for bytes it does not use, and a thread where the customer
    // quotes their own invoice back could hit the ceiling on a single document.
    // The ledger itself stays per record: the retention refcount depends on it.
    const seen = new Set();
    let used = 0;
    for (const a of (Array.isArray(rows) ? rows : [])) {
        const sha = a && a.sha256;
        if (sha) {
            if (seen.has(sha)) continue;
            seen.add(sha);
        }
        used += Math.max(0, parseInt(a && a.size, 10) || 0);
    }
    if (used + addBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw studioAppQuota.quotaError('quota_exceeded', {
            limit: MAX_ATTACHMENT_TOTAL_BYTES,
            used,
            message: `App attachment storage limit reached (${MAX_ATTACHMENT_TOTAL_BYTES} bytes)`,
        });
    }
}

// What a zip ENTRY may claim to be, by extension — entries carry no content
// type at all, so the name proposes and the bytes must confirm, exactly like
// the mailed-attachment ladder above. A zip inside a zip is deliberately NOT
// in this map: nesting is refused, not recursed into.
const ENTRY_MIME_BY_EXT = Object.freeze({
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    txt: 'text/plain', csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** Bytes of an ALREADY-STORED attachment blob (ledger id → content-addressed key). */
async function getStoredAttachmentBuffer(app, fileId) {
    if (!fileId) return null;
    const att = await studioAppDataStore.getAttachment(fileId, app.id, app.userId);
    if (!att || !att.sha256) return null;
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, att.sha256);
    const { stream } = await storageStore.streamFile(key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/**
 * Store a file DERIVED from an already-accepted attachment (a zip entry) as a
 * first-class attachment of its own. Same invariants as the mail path, in the
 * same order: name proposes a type, REFUSED/ALLOWED gate it, the bytes must
 * sniff as that type, the malware scan runs BEFORE anything is stored, and a
 * ledger row only ever describes clean bytes. recordId/fieldKey hang the
 * ledger row off the record the source attachment lives on, so the derived
 * file is readable by exactly whoever may read that record.
 */
async function storeDerivedFile(app, { buffer, name, recordId, fieldKey, allowArchive = false, deps = {} } = {}) {
    const scan = deps.scanBuffer || scanBuffer;
    const cleanName = String(name || '').trim();
    if (!buffer || !buffer.length) throw httpError(422, 'That file came back empty');
    if (buffer.length > (allowArchive ? MAX_ARCHIVE_BYTES : MAX_ATTACHMENT_BYTES)) {
        throw httpError(413, 'That file is too large to open here');
    }

    const dot = cleanName.lastIndexOf('.');
    const ext = dot > 0 ? cleanName.slice(dot + 1).toLowerCase() : '';
    // AN ARCHIVE INSIDE AN ARCHIVE IS STILL CLOSED BY DEFAULT.
    //
    // Recursing into third-party archives without a budget is how one mailed
    // file becomes an unbounded amount of work, so the caller has to say out
    // loud that it is inside its depth allowance — and file_intake is the only
    // caller that ever does. A forwarded order really does arrive as a zip
    // holding a zip; refusing that outright cost a real customer their package.
    if (ARCHIVE_MIME_BY_EXT[ext] && !allowArchive) {
        throw httpError(415, 'An archive inside an archive is not supported');
    }
    const mime = cadMimeForName(cleanName) || ARCHIVE_MIME_BY_EXT[ext] || ENTRY_MIME_BY_EXT[ext] || null;
    if (!mime || REFUSED_MIME.has(mime) || !ALLOWED_MIME.has(mime)) {
        throw httpError(415, 'That file type is not supported');
    }
    const family = sniffFamily(buffer);
    const expected = FAMILY_BY_MIME[mime];
    if (expected && !expected.includes(family)) {
        throw httpError(415, 'That file is not what it claims to be');
    }

    const verdict = await scan(buffer);
    if (verdict && verdict.clean === false) {
        throw httpError(422, 'That file did not pass the malware scan');
    }

    await studioAppQuota.assertAttachmentQuota(app, buffer.length);
    await assertAttachmentTotalBytes(app, buffer.length);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, sha256);
    await storageStore.uploadFile(key, buffer, mime);
    let ledger;
    try {
        ledger = await studioAppDataStore.addAttachment(app.id, app.userId, {
            recordId: recordId || null,
            fieldKey: fieldKey || null,
            mimeType: mime,
            sha256,
            size: buffer.length,
        });
        await studioAppDataStore.setAttachmentScan(ledger.id, app.id, app.userId, { scanned: true, quarantined: false });
    } catch (err) {
        await storageStore.deleteFile(key).catch(() => {});
        throw err;
    }
    return studioDescriptor({ ...ledger, size: buffer.length }, { name: cleanName, mime });
}

module.exports = {
    materializeAttachment,
    locateDescriptor,
    assertAttachmentTotalBytes,
    viewerMayReadAttachment,
    getStoredAttachmentBuffer,
    storeDerivedFile,
    isPending,
    parseDescriptor,
    ALLOWED_MIME,
    REFUSED_MIME,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_TOTAL_BYTES,
};
