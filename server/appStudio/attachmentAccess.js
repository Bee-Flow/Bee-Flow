/**
 * App Studio — "may this viewer read this attachment?", in ONE place.
 *
 * This lived only in routes/studioAppFiles.js, guarding the download endpoint.
 * The AI path never called it: aiRuntime.loadAttachment checked owner-scope and
 * the malware-scan flag and nothing else, while `ai_extract.source` resolves
 * from CLIENT-supplied formValues / vars / item. Any signed-in viewer could
 * therefore POST a step with a forged descriptor naming any fileId in the app
 * and have its text read out by the model — and with `writeTo`, written into a
 * table they are allowed to read.
 *
 * That gap was survivable while the only way to get a file into an app was to
 * upload it to a form yourself. It is not survivable now that a mailbox fills a
 * file column with whatever customers attach, so both callers go through here.
 *
 * The check is deliberately record-shaped rather than attachment-shaped: an
 * attachment is readable exactly when a record it hangs off is readable under
 * the viewer's RLS role. Runtime uploads carry a null recordId (the file exists
 * before the record does), so the link is then only visible from the record
 * side — hence the `contains` probe over file columns.
 */

'use strict';

const rlsGateway = require('./rlsGateway');
const queryCompiler = require('./queryCompiler');
const studioAppDbStore = require('../stores/studioAppDbStore');

/**
 * The access-scoped probe(s) proving a record this attachment hangs off exists
 * and is visible.
 */
function attachmentProbes(table, attachment, accessFilter) {
    if (attachment.recordId) {
        return [queryCompiler.compileGetById(table, attachment.recordId, accessFilter)];
    }
    return (Array.isArray(table.fields) ? table.fields : [])
        .filter((f) => f && f.type === 'file' && (!attachment.fieldKey || f.key === attachment.fieldKey))
        .map((f) => queryCompiler.compileRecordList(
            table,
            { filters: [{ field: f.key, op: 'contains', value: attachment.id }], limit: 1 },
            accessFilter,
        ));
}

/**
 * @param {object} app        - the studio app row (userId = owner)
 * @param {object} attachment - a ledger row: { id, recordId, fieldKey, ... }
 * @param {object} viewer     - { id, role, model, organizationId? }
 * @returns {Promise<boolean>}
 */
async function viewerMayReadAttachment(app, attachment, { id: viewerId, role, model, organizationId = null }) {
    if (!attachment) return false;
    // The owner's own storage envelope — nothing to scope against.
    if (app.userId === viewerId) return true;
    if (!model || !Array.isArray(model.tables)) return false;

    const viewer = { id: viewerId, role, organizationId };

    // Candidate tables: those carrying the attachment's file field, or every
    // readable table when the field key is unknown (legacy rows).
    const candidates = model.tables.filter((t) => {
        if (!rlsGateway.canRead(t, role)) return false;
        if (!attachment.fieldKey) return true;
        return (Array.isArray(t.fields) ? t.fields : [])
            .some((f) => f && f.key === attachment.fieldKey && f.type === 'file');
    });

    for (const table of candidates) {
        try {
            const accessFilter = rlsGateway.compileAccessFilter(table, role, viewer, 'read');
            for (const { sql, params } of attachmentProbes(table, attachment, accessFilter)) {
                const { rows } = await studioAppDbStore.query(app.userId, app.id, sql, params);
                if (rows && rows.length) return true;
            }
        } catch (_) { /* this table is not readable for the role — try the next */ }
    }
    return false;
}

/**
 * "May this role WRITE somewhere in the app?" — the upload permission rule,
 * shared by the attachment uploader (routes/studioAppFiles.js) and the dataset
 * uploader (routes/studioAppDatasets.js) so the two can never drift: uploading
 * lands bytes in the OWNER's storage envelope, so a read-only audience must be
 * refused on BOTH paths for the same reason.
 */
function roleMayWriteSomewhere(model, role) {
    if (!model || !Array.isArray(model.tables)) return false;
    return model.tables.some((t) => rlsGateway.resolveScope(t, role, 'create') === true
        || rlsGateway.resolveScope(t, role, 'update') !== 'none');
}

module.exports = { viewerMayReadAttachment, attachmentProbes, roleMayWriteSomewhere };
