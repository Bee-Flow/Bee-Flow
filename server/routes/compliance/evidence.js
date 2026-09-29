/**
 * Compliance — evidence: uploading and streaming back file attachments, and
 * the per-check evidence-chain history.
 */

const express = require('express');
const router = express.Router();

const crypto = require('crypto');
const complianceStore = require('../../stores/complianceStore');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');

// ───────────────── Evidence file attachments ─────────────────
//
// Pentest reports, supplier certificates, NDAs, management-review minutes:
// the bytes live in object storage, the evidence row keeps the sha256 and
// metadata — so the chain stays verifiable while the file stays downloadable.

const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── Why POST /iso/evidence/upload has no body schema ───────────
//
// It is a multipart upload: multer parses the stream and `req.body` only ever
// holds the text fields that rode along with the file. Running a zod schema
// over it would validate half a request — the file itself, which is the whole
// point, is in `req.file` and is checked there (present, non-empty, under the
// 15 MB cap). The text fields are each capped where they are read.

const multer = require('multer');
const evidenceUpload = multer({
    storage: multer.memoryStorage(),
    // 15 MB ceiling — pentest PDFs and certificate scans fit comfortably;
    // anything bigger belongs in a document system, not the evidence chain.
    limits: { fileSize: 15 * 1024 * 1024 },
});

router.post('/iso/evidence/upload', requireAuth, requirePermission('admin_compliance'),
    evidenceUpload.single('file'), async (req, res) => {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        if (!req.file?.buffer?.length) return res.status(400).json({ error: 'file is required' });
        const subjectType = String(req.body?.subject_type || 'attachment').slice(0, 40);
        const subjectId = String(req.body?.subject_id || '').slice(0, 120) || null;
        const checkId = req.body?.check_id ? String(req.body.check_id).slice(0, 120) : null;
        const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
        const safeName = String(req.file.originalname || 'evidence.bin')
            .replace(/[^\w.\-()+ ]/g, '_').slice(0, 140);
        const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
        const storageKey = `iso-evidence/${orgId}/${hash.slice(0, 16)}-${safeName}`;
        const storageStore = require('../../stores/storageStore');
        await storageStore.uploadFile(storageKey, req.file.buffer, req.file.mimetype || 'application/octet-stream');
        await complianceStore.addEvidence({
            organization_id: orgId,
            check_id: checkId,
            subject_type: subjectType,
            subject_id: subjectId,
            hash,
            storage_key: storageKey,
            payload: {
                action: 'evidence_file_uploaded',
                filename: safeName,
                content_type: req.file.mimetype || null,
                size: req.file.buffer.length,
                sha256: hash,
                note,
                by: actorId, at: new Date().toISOString(),
            },
        });
        res.json({ uploaded: true, sha256: hash, filename: safeName });
    });

router.get('/evidence/file/:id', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const orgId = await resolveOrgId(req);
        const row = await complianceStore.getEvidenceById(orgId, req.params.id);
        if (!row?.storage_key) return res.status(404).json({ error: 'no_file' });
        const storageStore = require('../../stores/storageStore');
        const { stream, contentType, contentLength } = await storageStore.streamFile(row.storage_key);
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        const filename = row.payload?.filename || `evidence-${row.id}`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        stream.pipe(res);
    } catch (e) {
        if (e?.name === 'NoSuchKey') return res.status(404).json({ error: 'file_gone' });
        next(e);
    }
});

// ───────────────── Evidence ─────────────────
//
// Three reads, most specific route last-but-one: the flat paged list, the
// chain verification report, then the per-check history. `/evidence` and
// `/evidence/chain` MUST stay above `/evidence/:checkId` — otherwise 'chain'
// is read as a check id.

const EVIDENCE_PAGE_MAX = 200;
const CHAIN_LIMIT_DEFAULT = 500;
// The verifier itself clamps at 50 000; a request-time verification is a full
// re-hash of the window, so the route is far stingier.
const CHAIN_LIMIT_MAX = 2000;

function _int(v, dflt, min, max) {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(n, max));
}

/**
 * GET /evidence?regulation=&limit=&offset= → { rows, total, limit, offset }
 *
 * The flat, paged evidence ledger behind the Evidence tab. `total` is the
 * count under the SAME filter (the pager needs it); `regulation` filters on
 * the check-id prefix the store already understands.
 */
const _word = (name) => z.string({ invalid_type_error: `${name} must be text.` }).optional();

/**
 * `.strict()` only. `?regulaton=GDPR` used to drop the filter and hand back
 * the WHOLE ledger to someone reading one regulation's trail — that is the
 * silent one, and it is now a 400 naming the query.
 *
 * `limit` and `offset` keep `_int`'s clamping rather than becoming enums of
 * their own: the response echoes both back ("clamped and echoed back so the
 * pager can trust them", evidence.test.js), so a caller who asked for 5000
 * rows can SEE it got 200. A clamp a client is told about is not a silent
 * fallback, and turning it into a refusal would break a pager that leans on it.
 */
const EvidenceQuery = z.object({
    regulation: _word('regulation'),
    subject_type: _word('subject_type'),
    limit: _word('limit'),
    offset: _word('offset'),
}).strict();

const ChainQuery = z.object({ limit: _word('limit') }).strict();

router.get('/evidence', requireAuth, requirePermission('admin_compliance'), validate({ query: EvidenceQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const regulation = req.query.regulation ? String(req.query.regulation).slice(0, 40) : null;
    const subjectType = req.query.subject_type ? String(req.query.subject_type).slice(0, 40) : null;
    const limit = _int(req.query.limit, 50, 1, EVIDENCE_PAGE_MAX);
    const offset = _int(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const filters = { ...(regulation ? { regulation } : {}), ...(subjectType ? { subjectType } : {}) };
    const [rows, total] = await Promise.all([
        complianceStore.listEvidence(orgId, { ...filters, limit, offset }),
        complianceStore.countEvidence(orgId, filters),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ rows: rows || [], total, limit, offset });
});

/**
 * GET /evidence/chain?limit= → the verifyChain report as-is
 * ({ ok, rows_total, chained_rows, pre_chain_rows, pre_chain_invalid,
 * verified_rows, first_break, head, window, latest_captured_at, checked_at } —
 * the shape be-evidence-chain pinned; the route adds nothing so the two can
 * never drift. `ok: null` + `reason: 'columns_missing'` is the not-provisioned
 * case the client must render as "unknown", not as "broken").
 */
router.get('/evidence/chain', requireAuth, requirePermission('admin_compliance'), validate({ query: ChainQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const limit = _int(req.query.limit, CHAIN_LIMIT_DEFAULT, 1, CHAIN_LIMIT_MAX);
    const { verifyChain } = require('../../compliance/evidence/chain');
    const report = await verifyChain(orgId, { limit });
    res.set('Cache-Control', 'private, no-store');
    res.json(report);
});

router.get('/evidence/:checkId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const rows = await complianceStore.getEvidenceHistory(orgId, req.params.checkId, 100);
    res.json(rows);
});

module.exports = router;
