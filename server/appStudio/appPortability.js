/**
 * App Studio — an app WITH ITS DATA as a file, so a working app can leave one
 * installation and arrive at another still working.
 *
 *   sanitizeAppImport(envelope) → { app, template, content, report, errors, warnings }
 *
 * PURE: no database, no network, no clock. Everything it decides, it decides
 * from the bytes it was handed — routes/studioApps.js stays the only place with
 * side effects, exactly as templatePortability.js arranges it for templates.
 *
 * ── Why a second format, next to beeflow.apptemplate ──────────────────────
 *
 * A TEMPLATE is a blueprint. It carries a definition, a data model and a small
 * seed — "here is what an app of this kind looks like, with enough example rows
 * that opening it teaches you something". Its ceilings say so out loud: 100
 * rows per table, 4 MB, and `file` columns never travel at all, because bytes
 * are not a blueprint. Install it five times and you get five identical empty
 * apps, which is the point.
 *
 * An APP ARCHIVE is a particular app, with the particular rows and the
 * particular documents that make it worth showing. A demo whose AI steps have
 * no PDFs to read is not a demo of anything, and a project line whose drawing
 * dropped out on the way is a row about a file that is not there. So this
 * format carries the files, and carrying files is the whole reason it is a
 * separate thing rather than a bigger `seed`.
 *
 * The two never merge, and the ceilings are why. Relaxing the template's caps
 * to fit an archive would mean every gallery template could quietly become a
 * 16 MB data dump of somebody's live records, re-installed by anyone who can
 * see it. Keeping them apart lets each say what it is for.
 *
 * ── THERE IS NO WRITER HERE, AND THAT IS THE DESIGN ───────────────────────
 *
 * templatePortability.js has `buildExport` beside `sanitizeImport`. This module
 * has only the reader. The product can OPEN an app archive and can never
 * produce one, so there is no button, no route and no permission that turns a
 * live app — its customer records, its mailbox, its attachments — into a file
 * somebody can carry out of the building. An archive is built deliberately, by
 * a script run by someone with a shell on the server, and that is a much
 * smaller door than a menu item.
 *
 * It also means the format has exactly one authority: this reader. Anything a
 * writer believes about the shape is a claim that gets re-decided here.
 *
 * ── Import does not trust, and re-decides everything ──────────────────────
 *
 * Same four stages templatePortability documents, for the same reasons:
 * FORMAT, ALLOW-LIST, STRIP, THE GATE. The gate is `captureTemplate` — the one
 * that decides what a definition and a data model may be — so an app archive
 * clears the bar a template clears, plus the two questions only it has to ask:
 *
 *   1. Do these rows belong to this model? `normalizeSeed` answers it, the
 *      same function that answers it for a seed, widened by one argument (the
 *      set of file refs this file declares). One row-rebuilder, one list of
 *      what a value may be per field type.
 *   2. Are these bytes what the file says they are? Every blob is decoded and
 *      SHA-256'd here, before anything is created. A truncated file, a hand-
 *      edited one, a blob swapped for another — all of them fail at the door
 *      rather than half-way through an install that has already made an app.
 *
 * What this module does NOT decide is whether the bytes are SAFE. That is
 * mailboxAttachments.storeDerivedFile's job at install time: name proposes a
 * type, the bytes must sniff as it, the malware scan runs before anything is
 * stored, the quotas are asserted, and the ledger row is marked scanned only
 * because it earned it. An imported file therefore enters through the same door
 * as an uploaded one. (`mime` in the file entry is a courtesy for whoever opens
 * the archive in an editor; nothing is decided from it.)
 *
 * ── Identity never travels ────────────────────────────────────────────────
 *
 * No app id, no record ids, no attachment ids, no owner, no organisation.
 * Records point at each other by the file's own aliases (`$id` / `{ $ref }`)
 * and at files by the file's own refs (`{ $file }`), so every id in the new
 * installation is minted there. A bare `rec_…` or a stored
 * `{ kind:'studio_attachment', fileId }` is a pointer into a database the
 * recipient cannot read, and is emptied on sight.
 *
 * `source` is a CLAIM, normalised and never believed — same treatment, and the
 * same reasons, as a template's.
 */

'use strict';

const crypto = require('crypto');

const APP_FORMAT = 'beeflow.app';
const APP_SCHEMA_VERSION = 1;

/** Every version this server can still READ, newest last. See templatePortability. */
const APP_SUPPORTED_VERSIONS = [1];

/**
 * The archive's own ceilings.
 *
 * These are NOT the engine's limits (DATA_LIMITS allows 100k rows per table and
 * 5000 attachments per app) and they are deliberately far below them. An
 * archive arrives as one JSON body that has to be parsed whole before a single
 * question about it can be answered, and the express body cap (20 MB) is the
 * real wall. Refusing at a number this module names, with a sentence saying
 * which number, beats being killed by a parser with none.
 *
 * They are also what stops a pathological file: one table with a million rows,
 * or a hundred thousand one-byte "files", costs an install loop far more than
 * its size suggests.
 */
const MAX_RECORDS_PER_TABLE = 10_000;
const MAX_RECORDS_TOTAL = 25_000;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** How long a claim out of a file may be before it is cut. */
const MAX_CLAIM_CHARS = { id: 64, name: 200, text: 400, ref: 64, key: 63 };

const SHA256_RE = /^[0-9a-f]{64}$/;

/** What the design half of an archive is allowed to carry. Nothing else does. */
const TEMPLATE_FIELDS = ['definition', 'dataModel', 'datasets', 'seedPeople'];

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

function claimText(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * A file NAME, as a name and never as a path.
 *
 * The name is what a download serves and what proposes the MIME type, so a
 * separator in it is either a mistake or an attempt. Both are answered the same
 * way: keep the last segment, drop the control characters, cap it. A name that
 * is nothing but separators and dots leaves null and the entry is refused —
 * there is no honest file called `../`.
 */
function claimFileName(value) {
    if (typeof value !== 'string') return null;
    const flat = value.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() || '';
    const trimmed = flat.trim().replace(/^\.+$/, '');
    return trimmed ? trimmed.slice(0, MAX_CLAIM_CHARS.name) : null;
}

/**
 * The `source` block, as a normalised CLAIM. One place decides what a
 * provenance assertion may contain, so no reader downstream ever touches
 * `envelope.source.orgName` raw.
 */
function readSource(envelope) {
    const raw = isObject(envelope) && isObject(envelope.source) ? envelope.source : {};
    return {
        appId: claimText(raw.appId, MAX_CLAIM_CHARS.id),
        orgId: claimText(raw.orgId, MAX_CLAIM_CHARS.id),
        orgName: claimText(raw.orgName, MAX_CLAIM_CHARS.name),
        productVersion: claimText(raw.productVersion, MAX_CLAIM_CHARS.id),
    };
}

/**
 * The app card the archive proposes: a name, a description, an icon, an accent.
 *
 * Every one of them is cosmetic and every one of them is a claim. The owner and
 * the organisation are deliberately absent — they are facts of the
 * INSTALLATION, decided by the route from the session, never read from a file.
 */
function readAppMeta(envelope) {
    const raw = isObject(envelope) && isObject(envelope.app) ? envelope.app : {};
    return {
        name: claimText(raw.name, 120),
        description: claimText(raw.description, MAX_CLAIM_CHARS.text) || '',
        icon: claimText(raw.icon, 40),
        // A colour is a token, not free text: anything that is not one is
        // dropped rather than written into a style attribute.
        accentColor: (typeof raw.accentColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.accentColor.trim()))
            ? raw.accentColor.trim() : null,
    };
}

/**
 * The `files` block: metadata + bytes, each entry re-decided.
 *
 * Returns { files, refs, dropped } where `files` carries a decoded `buffer` and
 * `refs` is the set of refs the SURVIVING entries declare — that set is what
 * makes a `{ $file }` in a record mean anything, so it is built before a single
 * record is looked at.
 *
 * Nothing here throws. An entry that cannot be made sense of is dropped and
 * NAMED, because an archive that installs minus one drawing is worth more than
 * a refusal, and a silent drop is how a row ends up describing a file nobody
 * can find.
 */
function readFiles(rawFiles, dropped) {
    const files = [];
    const refs = new Set();
    let bytes = 0;

    const list = Array.isArray(rawFiles) ? rawFiles : [];
    if (list.length > MAX_FILES) dropped.files.push(`${list.length - MAX_FILES} file(s) over the ${MAX_FILES}-file ceiling`);

    for (const raw of list.slice(0, MAX_FILES)) {
        if (!isObject(raw)) { dropped.files.push('an entry that is not an object'); continue; }
        const ref = claimText(raw.ref, MAX_CLAIM_CHARS.ref);
        if (!ref) { dropped.files.push('an entry with no ref'); continue; }
        if (refs.has(ref)) { dropped.files.push(`${ref}: a second entry claims this ref`); continue; }

        const name = claimFileName(raw.name);
        if (!name) { dropped.files.push(`${ref}: no usable file name`); continue; }

        const sha256 = claimText(raw.sha256, 64);
        if (!sha256 || !SHA256_RE.test(sha256)) { dropped.files.push(`${name}: no sha256 to check the bytes against`); continue; }

        if (typeof raw.data !== 'string' || !raw.data) { dropped.files.push(`${name}: carries no bytes`); continue; }
        let buffer;
        try {
            buffer = Buffer.from(raw.data, 'base64');
        } catch {
            buffer = null;
        }
        if (!buffer || !buffer.length) { dropped.files.push(`${name}: the bytes are not readable base64`); continue; }
        if (buffer.length > MAX_FILE_BYTES) {
            dropped.files.push(`${name}: ${Math.round(buffer.length / 1024)}kB, over the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file ceiling`);
            continue;
        }

        // THE INTEGRITY CHECK. Base64 decoding is forgiving — it will happily
        // return a short buffer for a truncated string — so the hash is the
        // only thing that says these are the bytes the archive meant. Checked
        // here, once, rather than trusted by four things downstream.
        const actual = crypto.createHash('sha256').update(buffer).digest('hex');
        if (actual !== sha256) { dropped.files.push(`${name}: the bytes do not match the sha256 in the file`); continue; }

        if (bytes + buffer.length > MAX_CONTENT_BYTES) {
            dropped.files.push(`${name}: the archive is over the ${MAX_CONTENT_BYTES / 1024 / 1024}MB total-bytes ceiling`);
            continue;
        }
        bytes += buffer.length;

        // `home` says which record this file hangs off — the ledger's
        // record_id/field_key, which is not bookkeeping: attachmentAccess
        // proves a viewer may READ an attachment by proving they may read that
        // record. Carried rather than guessed, because the source app knew the
        // answer and a guess ("the first row that mentions it") is only usually
        // right. An unresolvable home falls back to exactly that guess at
        // install time, which is better than a null.
        const rawHome = isObject(raw.home) ? raw.home : null;
        const home = rawHome ? {
            record: claimText(rawHome.record, MAX_CLAIM_CHARS.ref),
            field: claimText(rawHome.field, MAX_CLAIM_CHARS.key),
        } : null;

        refs.add(ref);
        files.push({
            ref,
            name,
            // A courtesy for a human reading the archive. storeDerivedFile
            // re-derives the type from the name and confirms it against the
            // bytes, so nothing is decided from this.
            mime: claimText(raw.mime, 128),
            size: buffer.length,
            sha256,
            home: (home && home.record && home.field) ? home : null,
            buffer,
        });
    }

    return { files, refs, bytes };
}

/**
 * sanitizeAppImport — read an app archive back, and say precisely why not.
 *
 * Stages, in this order:
 *
 *   1. FORMAT. Refuse anything that does not claim to be this format at a
 *      version this build reads, before a single key is looked at.
 *   2. FILES. Decoded and hashed FIRST, because the record pass needs the set
 *      of refs that survived: a `{ $file }` at a ref whose bytes failed their
 *      hash has to empty, not dangle.
 *   3. THE GATE. captureTemplate — scrub, canonicalize, validate, ceiling —
 *      run on the definition, the data model and the datasets, with NO seed.
 *      The rows travel in `content`, under this module's ceilings, not the
 *      template's.
 *   4. RECORDS. normalizeSeed against the model the gate just canonicalized,
 *      widened by the file refs from stage 2.
 *
 * Returns `errors` (nothing can be installed) or `warnings` (it installs, minus
 * the things named).
 */
function sanitizeAppImport(envelope) {
    const refuse = (...errors) => ({ app: null, template: null, content: null, report: null, errors, warnings: [] });

    if (!isObject(envelope)) return refuse('That file is not an app archive.');
    if (envelope.format !== APP_FORMAT) {
        const { EXPORT_FORMAT } = require('./templatePortability');
        // The neighbouring format is the likeliest wrong file to pick, and
        // "not an app archive" about a perfectly good template file is a riddle.
        if (envelope.format === EXPORT_FORMAT) {
            return refuse('That is an app TEMPLATE file, not an app archive. Import it under "From a template file" — it will land in your gallery.');
        }
        return refuse(`That file is not an app archive (expected a ${APP_FORMAT} file).`);
    }
    if (!APP_SUPPORTED_VERSIONS.includes(envelope.schemaVersion)) {
        return refuse(`App archive format version ${envelope.schemaVersion} is not supported here (this installation reads ${APP_SUPPORTED_VERSIONS.join(', ')}).`);
    }

    const rawTemplate = isObject(envelope.template) ? envelope.template : null;
    if (!rawTemplate) return refuse('The file carries no app to install.');

    const appMeta = readAppMeta(envelope);
    const title = appMeta.name || claimText(rawTemplate.title, 120) || 'Imported app';

    // ── 2. Files, before records ──────────────────────────────────────
    const rawContent = isObject(envelope.content) ? envelope.content : {};
    const dropped = { files: [], records: [] };
    const { files, refs, bytes } = readFiles(rawContent.files, dropped);

    // ── 3. The gate, on the design half ───────────────────────────────
    const { stripNeverInstallable } = require('../projects/packaging/manifest');
    const incoming = stripNeverInstallable(deepClone(
        Object.fromEntries(TEMPLATE_FIELDS
            .filter((f) => rawTemplate[f] !== undefined)
            .map((f) => [f, rawTemplate[f]])),
    ));

    const { captureTemplate } = require('./templateCapture');
    const gate = captureTemplate({
        definition: incoming.definition,
        dataModel: isObject(incoming.dataModel) ? incoming.dataModel : null,
        // NO SEED. The rows are content and are judged below, against this
        // module's ceilings. Handing them to the gate as a seed would cap them
        // at 100 per table and drop every file value — which is the template's
        // correct behaviour and the wrong answer here.
        seed: null,
        seedPeople: isObject(incoming.seedPeople) ? incoming.seedPeople : null,
        datasets: Array.isArray(incoming.datasets) ? incoming.datasets : [],
        meta: { title, description: appMeta.description, icon: appMeta.icon, version: 1 },
    });
    if (!gate.ok) return refuse(...gate.errors);

    const template = gate.template;
    const model = isObject(template.dataModel) ? template.dataModel : null;

    // ── 4. Records ────────────────────────────────────────────────────
    const rawRecords = isObject(rawContent.records) ? rawContent.records : {};
    const rawRowCount = Object.values(rawRecords)
        .reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);

    let records = {};
    let counts = {};
    let seedDropped = null;
    if (model && rawRowCount) {
        const out = require('./templateCapture')
            .normalizeSeed(model, rawRecords, MAX_RECORDS_PER_TABLE, { fileRefs: refs });
        records = out.seed;
        counts = out.counts;
        seedDropped = out.dropped;
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > MAX_RECORDS_TOTAL) {
        return refuse(`The archive carries ${total} rows, over the ${MAX_RECORDS_TOTAL}-row ceiling for one app.`);
    }

    // ── What the reader has to say out loud ───────────────────────────
    const warnings = [...(gate.report.warnings || [])];
    if (rawRowCount && !model) {
        warnings.push(`${rawRowCount} row(s) dropped: the archive carries rows but no data model to put them in.`);
    }
    for (const why of dropped.files.slice(0, 8)) warnings.push(`File skipped: ${why}.`);
    if (dropped.files.length > 8) warnings.push(`…and ${dropped.files.length - 8} more file(s) skipped.`);
    if (seedDropped) {
        if (seedDropped.tables.length) {
            warnings.push(`${seedDropped.tables.length} table(s) of rows dropped: the archive carries rows for tables its data model does not contain.`);
        }
        if (seedDropped.fields.length) {
            const shown = [...new Set(seedDropped.fields)].slice(0, 5).join(', ');
            warnings.push(`${seedDropped.fields.length} value(s) dropped — no such column, or a computed one: ${shown}.`);
        }
        if (seedDropped.rows) warnings.push(`${seedDropped.rows} row(s) dropped (not an object, or over the ${MAX_RECORDS_PER_TABLE}-row per-table ceiling).`);
        if (seedDropped.refs) warnings.push(`${seedDropped.refs} relation value(s) emptied: they pointed at rows this archive does not carry.`);
        if (seedDropped.files) warnings.push(`${seedDropped.files} file value(s) emptied: they pointed at files this archive does not carry.`);
        if (seedDropped.duplicateAliases) warnings.push(`${seedDropped.duplicateAliases} row(s) reuse an alias another row already claimed.`);
    }

    return {
        app: appMeta,
        template,
        content: { records, files },
        report: {
            ...gate.report,
            title,
            rows: total,
            rowsByTable: counts,
            files: files.length,
            fileBytes: bytes,
            source: readSource(envelope),
            exportedAt: claimText(envelope.exportedAt, MAX_CLAIM_CHARS.id),
            warnings,
        },
        errors: [],
        warnings,
    };
}

module.exports = {
    APP_FORMAT,
    APP_SCHEMA_VERSION,
    APP_SUPPORTED_VERSIONS,
    MAX_RECORDS_PER_TABLE,
    MAX_RECORDS_TOTAL,
    MAX_FILES,
    MAX_FILE_BYTES,
    MAX_CONTENT_BYTES,
    sanitizeAppImport,
    readSource,
    // Test-only internals.
    _claimFileName: claimFileName,
    _readFiles: readFiles,
};
