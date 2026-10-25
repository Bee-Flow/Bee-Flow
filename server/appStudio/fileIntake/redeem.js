// @typecheck
/**
 * file_intake phase 2 — redeem every located row through
 * materializeAttachment (which re-checks access, quota and the malware scan per
 * file), with per-file failure isolation; then backfill the folder column.
 */

'use strict';
const { baseNameOf, classify, folderOfRow } = require('./naming');
const { descriptorIdOf, hasField } = require('./attachmentRows');
const log = require('../../telemetry/log');
const { isMissingTable } = require('../../utils/isMissingTable');

/** Returns the phase state the later phases share: `{ files, refused, quotaHit }`. */
async function redeemAttachments(app, model, { rows, attTable, fileField, viewer, poRe, materializeAttachment }) {
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
            refused.push({ name, reason: e && /** @type {Error} */ (e).message ? String(/** @type {Error} */ (e).message).slice(0, 200) : 'failed' });
        }
    }
    return { files, refused, quotaHit };
}

async function backfillFolders(app, model, attTable, files, { writeRecord, writeViewer, ctx }) {
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
            } catch (err) { if (!isMissingTable(err)) throw err; log.debug('a display column is never worth failing an intake for', err); }
        }
    }
}

module.exports = { redeemAttachments, backfillFolders };
