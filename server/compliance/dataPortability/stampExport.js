/**
 * stampExport(kind) — Express middleware that records "an export of <kind>
 * was performed" in the compliance evidence chain after a 2xx response.
 *
 * Feeds DATA_ACT-Art25-exit-procedure: a written exit procedure plus a recent
 * real export shows switching works in practice. Best-effort by design — the
 * customer's download must never fail or slow down because the evidence table
 * hiccupped, so everything happens on `res.on('finish')`, after the bytes are
 * out, and every error is swallowed.
 *
 * The payload is built from an allow-list (BFSF-441): action, kind, format,
 * status, method, timestamp and the acting user's internal id. No path (ids
 * of the exported item), no filename, no query string, no e-mail address.
 *
 * Usage (one line on the route):
 *   router.get('/:id/export', require('../../compliance/dataPortability/stampExport')('automations'), handler);
 */

'use strict';

const crypto = require('crypto');

const CHECK_ID = 'DATA_ACT-Art25-exit-procedure';
const ACTION = 'data_export_performed';
const SUBJECT_TYPE = 'export';

function _formatFromResponse(res) {
    let ct = '';
    try { ct = String(res.getHeader('content-type') || '').toLowerCase(); } catch { /* headers gone */ }
    if (!ct) return null;
    if (ct.includes('json')) return 'json';
    if (ct.includes('csv')) return 'csv';
    if (ct.includes('zip')) return 'zip';
    if (ct.includes('pdf')) return 'pdf';
    if (ct.includes('markdown')) return 'md';
    if (ct.includes('wordprocessingml')) return 'docx';
    if (ct.includes('text/plain')) return 'txt';
    if (ct.includes('text/html')) return 'html';
    return null;
}

async function _resolveOrgId(req) {
    const sessionUser = req.session?.user;
    const direct = sessionUser?.organizationId || req.user?.organizationId || null;
    if (direct) return direct;
    const userId = sessionUser?.id || req.user?.id || null;
    if (!userId) return null;
    try {
        const u = await require('../../stores/userStore').getUser(userId);
        return u?.organizationId || null;
    } catch {
        return null;
    }
}

/**
 * Write the evidence row for one finished response. Exported for tests;
 * resolves to the payload written, or null when nothing was recorded.
 */
async function record(req, res, kind, format) {
    const status = Number(res.statusCode) || 0;
    if (status < 200 || status >= 300) return null;
    const orgId = await _resolveOrgId(req);
    if (!orgId) return null;
    const payload = {
        action: ACTION,
        kind,
        format: format || _formatFromResponse(res),
        status,
        method: String(req.method || '').toUpperCase() || null,
        at: new Date().toISOString(),
        by: req.session?.user?.id || req.user?.id || null,
    };
    const complianceStore = require('../../stores/complianceStore');
    await complianceStore.addEvidence({
        organization_id: orgId,
        check_id: CHECK_ID,
        subject_type: SUBJECT_TYPE,
        subject_id: kind,
        hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        payload,
    });
    return payload;
}

/**
 * @param {string} kind an exportRegistry kind ('automations', 'datatables', …)
 * @param {{format?:string}} [opts] fixed format when the response header does not say
 * @returns {import('express').RequestHandler}
 */
function stampExport(kind, { format = null } = {}) {
    if (!kind || typeof kind !== 'string') throw new Error('stampExport(kind): kind is required');
    return function stampExport(req, res, next) {
        // Route tests drive handlers with a bare `{ status, json }` response
        // double; a stamp that assumed an EventEmitter would turn every one of
        // those red. No emitter → nothing to stamp, the export proceeds.
        if (res && typeof res.on === 'function') {
            res.on('finish', () => {
                record(req, res, kind, format).catch(() => { /* best-effort evidence, never the export */ });
            });
        }
        next();
    };
}

module.exports = stampExport;
module.exports.stampExport = stampExport;
module.exports.record = record;
module.exports.CHECK_ID = CHECK_ID;
module.exports.ACTION = ACTION;
module.exports.SUBJECT_TYPE = SUBJECT_TYPE;
module.exports._formatFromResponse = _formatFromResponse;
module.exports._resolveOrgId = _resolveOrgId;
