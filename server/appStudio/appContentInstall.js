/**
 * Put an app archive's CONTENT into a freshly created app: the rows, and the
 * files the rows are about.
 *
 * `templateInstall.installTemplate` has already run by the time this does — it
 * wrote the data model and the datasets, which is the half an archive shares
 * with a template. What is left is the half only an archive has: thousands of
 * rows instead of a hundred, and real bytes hanging off them.
 *
 * ── THREE PASSES, AND WHY THERE HAVE TO BE THREE ──────────────────────────
 *
 * A record needs its file's descriptor before it can be written. A file needs
 * its record's id before it can be stored, because the ledger's
 * record_id/field_key is what `attachmentAccess.viewerMayReadAttachment` proves
 * access WITH — an attachment with a null record_id falls back to a scan, and
 * one pointing at the wrong record is readable by the wrong people. Each needs
 * the other, so neither can go first and the cycle is cut in the middle:
 *
 *   1. ROWS, with their file columns held back. Every alias gets a real id.
 *   2. FILES, now that every home exists. Through storeDerivedFile, which is
 *      the upload route minus Express (see below).
 *   3. THE FILE COLUMNS, patched onto the rows from pass 1.
 *
 * Only rows that actually carry a file are touched twice, so an archive with no
 * files costs exactly what a seed costs.
 *
 * ── EVERY BYTE COMES IN THROUGH THE FRONT DOOR ────────────────────────────
 *
 * `mailboxAttachments.storeDerivedFile` does, in this order: the name proposes
 * a MIME type, the REFUSED/ALLOWED gate decides whether that type may exist
 * here at all, the bytes must SNIFF as that type, the malware scan runs BEFORE
 * anything is stored, both quotas are asserted, the blob is uploaded
 * content-addressed, the ledger row is written, and only then is it marked
 * scanned.
 *
 * That last step is the one that matters most and is the easiest to skip. In
 * `studio_app_attachments`, `scanned` is not a log of something that happened —
 * it is a PERMISSION. `aiRuntime` and the automation bridge refuse a file
 * without it ("references a file that has not passed the malware scan"), and
 * the e-mail and approval steps drop one silently. A second write path that set
 * the bytes down and marked them scanned itself would be a way to hand the AI
 * steps a file that never met a scanner. So there is no second write path: an
 * imported file enters exactly where an uploaded one enters.
 *
 * ── BEST-EFFORT, NEVER SILENT ─────────────────────────────────────────────
 *
 * One row the engine refuses, or one file whose type is not allowed here, must
 * not sink an import that has already created an app. Each is caught, counted
 * and NAMED in the report. The one exception is a QUOTA refusal: the next four
 * hundred files will fail for the identical reason, so the loop stops once and
 * says so, instead of writing four hundred lines that all mean "the app is
 * full".
 */

'use strict';

const actionExecutor = require('./actionExecutor');
const mailboxAttachments = require('./mailboxAttachments');
const { orderTablesByDependency, resolveSeedRow } = require('./templateInstall');

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** How many individual failures are worth naming before a count will do. */
const MAX_NAMED_SKIPS = 10;

function reason(e) { return (e && e.message) ? e.message : String(e); }

/**
 * A refusal that will repeat for every remaining item, so the loop should stop.
 * Quota and ceiling refusals carry the frozen 409/413 contract studioAppQuota
 * and mailboxAttachments share; anything else is about the one item.
 */
function isTerminal(e) {
    const status = e && e.status;
    return status === 409 || status === 413 || (e && e.code === 'quota_exceeded');
}

/**
 * Split one already-normalised row into the values that can be written now and
 * the file refs that cannot. `{ $file: ref }` is the only shape a file column
 * carries by the time it gets here — appPortability emptied everything else.
 */
function splitFileValues(values) {
    const plain = {};
    const fileRefs = {};
    for (const [key, value] of Object.entries(values)) {
        if (isObject(value) && typeof value.$file === 'string') { fileRefs[key] = value.$file; continue; }
        plain[key] = value;
    }
    return { plain, fileRefs };
}

/**
 * installAppContent — rows and files into an app that already has its model.
 *
 * @param {object} opts
 * @param {object} opts.app        the app row (writeRecord needs it for org stamping)
 * @param {object} opts.model      the canonical data model installTemplate wrote
 * @param {object} opts.content    { records: { [tableId]: row[] }, files: entry[] } from sanitizeAppImport
 * @param {object?} opts.deps      { writeRecord, storeDerivedFile } — the injectable
 *                                 edges, appDryRun-style, so the tests run
 *                                 DB- and storage-free
 * @returns {Promise<{ok:boolean, rows:number, files:number, skipped:string[], error?:string}>}
 */
async function installAppContent({ app, model, content, deps = {} } = {}) {
    const store = deps.storeDerivedFile || mailboxAttachments.storeDerivedFile;
    const write = deps.writeRecord || actionExecutor.writeRecord;
    const records = isObject(content) && isObject(content.records) ? content.records : {};
    const files = isObject(content) && Array.isArray(content.files) ? content.files : [];
    const skipped = [];
    const note = (what) => { if (skipped.length < MAX_NAMED_SKIPS) skipped.push(what); };

    if (!app || !isObject(model) || !Array.isArray(model.tables)) {
        return { ok: false, rows: 0, files: 0, skipped, error: 'No data model to put the archive content in' };
    }

    const viewer = { id: app.userId, role: 'owner' };
    const refMap = new Map();          // $id alias → real rec_ id
    const aliasTable = new Map();      // $id alias → table
    const pending = [];                // rows that still owe their file columns
    const firstSeen = new Map();       // file ref → { recordId, fieldKey } — the fallback home
    let rows = 0;
    let rowFailures = 0;

    // ── Pass 1: the rows, file columns held back ──────────────────────
    for (const table of orderTablesByDependency(model)) {
        const list = Array.isArray(records[table.id]) ? records[table.id] : [];
        for (const row of list) {
            const { alias, values } = resolveSeedRow(row, refMap);
            const { plain, fileRefs } = splitFileValues(values);
            try {
                const { id } = await write(app, model, table, plain, { viewer });
                rows += 1;
                if (alias && id) { refMap.set(alias, id); aliasTable.set(alias, table); }
                const keys = Object.keys(fileRefs);
                if (!keys.length || !id) continue;
                pending.push({ table, recordId: id, fileRefs });
                for (const key of keys) {
                    if (!firstSeen.has(fileRefs[key])) firstSeen.set(fileRefs[key], { recordId: id, fieldKey: key });
                }
            } catch (e) {
                rowFailures += 1;
                note(`row in ${table.key}: ${reason(e)}`);
                if (isTerminal(e)) {
                    return {
                        ok: false, rows, files: 0, skipped,
                        error: `stopped while writing rows: ${reason(e)}`,
                    };
                }
            }
        }
    }
    if (rowFailures > MAX_NAMED_SKIPS) skipped.push(`…and ${rowFailures - MAX_NAMED_SKIPS} more row(s) skipped.`);

    // ── Pass 2: the files, now that every home exists ─────────────────
    const descriptors = new Map();     // file ref → studio_attachment descriptor
    let stored = 0;
    let fileFailures = 0;
    for (const entry of files) {
        // The archive's own answer first; the first row that mentioned it as a
        // fallback. A home naming an alias this archive does not carry, or a
        // column that is not a file column on that alias's table, is a claim
        // the file got wrong — so it falls back rather than being written down.
        let home = null;
        if (entry.home && refMap.has(entry.home.record)) {
            const table = aliasTable.get(entry.home.record);
            const field = table && (table.fields || []).find((f) => f.key === entry.home.field && f.type === 'file');
            if (field) home = { recordId: refMap.get(entry.home.record), fieldKey: entry.home.field };
        }
        if (!home) home = firstSeen.get(entry.ref) || null;

        try {
            const descriptor = await store(app, {
                buffer: entry.buffer,
                name: entry.name,
                recordId: home ? home.recordId : null,
                fieldKey: home ? home.fieldKey : null,
            });
            descriptors.set(entry.ref, descriptor);
            stored += 1;
        } catch (e) {
            fileFailures += 1;
            note(`file ${entry.name}: ${reason(e)}`);
            if (isTerminal(e)) {
                // Everything written so far stays — an app with 140 of its 190
                // documents is usable and the report says which ceiling it hit.
                skipped.push(`stopped storing files after ${stored}: ${reason(e)}`);
                break;
            }
        }
    }
    if (fileFailures > MAX_NAMED_SKIPS) skipped.push(`…and ${fileFailures - MAX_NAMED_SKIPS} more file(s) skipped.`);

    // ── Pass 3: the file columns ──────────────────────────────────────
    for (const { table, recordId, fileRefs } of pending) {
        const values = {};
        for (const [key, ref] of Object.entries(fileRefs)) {
            const descriptor = descriptors.get(ref);
            // No descriptor means pass 2 refused those bytes. The column stays
            // null, which is the honest state: a row that says it has a drawing
            // and has none is worse than a row that says it has none.
            if (descriptor) values[key] = descriptor;
        }
        if (!Object.keys(values).length) continue;
        try {
            await write(app, model, table, values, { viewer, recordId });
        } catch (e) {
            note(`file column on ${table.key}: ${reason(e)}`);
        }
    }

    return { ok: true, rows, files: stored, skipped };
}

module.exports = { installAppContent, _splitFileValues: splitFileValues };
