/**
 * Compliance — org-defined ("custom") frameworks: a customer questionnaire, a
 * sector code or an internal standard, its items, and the attestations that
 * answer them (stores/customFrameworkStore). Results are produced by
 * compliance/custom/runner.js on every sweep; this router only edits the
 * definition and records answers.
 *
 * Every route: requireAuth + requirePermission('admin_compliance') +
 * requireCapability('compliance_hub_custom') — the capability is a licence
 * feature, so a Community deployment gets 403 feature_locked here rather than
 * a missing mount.
 *
 * Personal data: the export carries the attester's user id only (BFSF-441) —
 * never a name or e-mail.
 *
 * ── What a caller may send ──────────────────────────────────
 *
 * Every body here is `.strict()`, and three of them were losing data quietly:
 *
 *   - `evidence_refs` is filtered by the store to OBJECTS carrying an
 *     `evidence_id` or a `sha256`. A list of bare hash STRINGS passed this
 *     route's `evidence_required` gate (a non-empty array) and then arrived at
 *     the column as `[]` — an attestation that says it has evidence and has
 *     none, answered 201.
 *   - a check row's `evidence_required` was read as
 *     `=== true || === 'true' || === 1`, so 'yes' (and any other truthy text)
 *     imported the item as NOT requiring evidence.
 *   - PUT /custom/frameworks/:id copied a fixed list of keys off the body, so
 *     a misspelled one was dropped under a 200 carrying the unchanged row.
 *
 * `code` stays in the patch schema on purpose: the store answers it with
 * "code is immutable — create a new framework instead", which is the message
 * the caller needs.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const customFrameworkStore = require('../../stores/customFrameworkStore');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireCapability } = require('../../core/entitlements/entitlements');
const { resolveOrgId } = require('./shared');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const guard = [requireAuth, requirePermission('admin_compliance'), requireCapability('compliance_hub_custom')];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EXPIRES_MONTHS = 120;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const STATUSES = ['draft', 'active'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

const MONTHS_TEXT = `attestation_valid_months is a whole number of months, 1..${MAX_EXPIRES_MONTHS}.`;
const months = z.coerce.number({ invalid_type_error: MONTHS_TEXT })
    .int(MONTHS_TEXT).min(1, MONTHS_TEXT).max(MAX_EXPIRES_MONTHS, MONTHS_TEXT);

const NAME_TEXT = 'A framework needs a name.';
const FrameworkBody = bodyOf({
    code: worded('A framework needs a code.').optional(),
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(200, 'A framework name is at most 200 characters.'),
    reference: worded('reference must be text.').max(300, 'A reference is at most 300 characters.').nullish(),
    description: worded('description must be text.').max(4000, 'A description is at most 4000 characters.').nullish(),
    attestation_valid_months: months.optional(),
    attestationValidMonths: months.optional(),
    status: oneOf('status', STATUSES).optional(),
});

const FrameworkPatch = bodyOf({
    // Kept so the store's own "code is immutable" answer still reaches the caller.
    code: worded('code must be text.').optional(),
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(200, 'A framework name is at most 200 characters.').optional(),
    reference: worded('reference must be text.').max(300, 'A reference is at most 300 characters.').nullish(),
    description: worded('description must be text.').max(4000, 'A description is at most 4000 characters.').nullish(),
    attestation_valid_months: months.optional(),
    attestationValidMonths: months.optional(),
    status: oneOf('status', STATUSES).optional(),
});

const REF_TEXT = 'A check row needs a ref.';
const TITLE_TEXT = 'A check row needs a title.';
const CheckRow = z.object({
    ref: worded(REF_TEXT).trim().min(1, REF_TEXT).max(40, 'A ref is at most 40 characters.'),
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(300, 'A title is at most 300 characters.'),
    description: worded('description must be text.').max(4000, 'A description is at most 4000 characters.').nullish(),
    severity: oneOf('severity', SEVERITIES).nullish(),
    // 'yes' used to import the item as NOT requiring evidence.
    evidence_required: z.boolean({ invalid_type_error: 'evidence_required is true or false.' }).optional(),
    evidenceRequired: z.boolean({ invalid_type_error: 'evidenceRequired is true or false.' }).optional(),
    mapped_check_id: worded('mapped_check_id must be a check id.').max(120, 'mapped_check_id is at most 120 characters.').nullish(),
    mappedCheckId: worded('mappedCheckId must be a check id.').max(120, 'mappedCheckId is at most 120 characters.').nullish(),
    sort_order: z.coerce.number({ invalid_type_error: 'sort_order is a whole number.' }).int('sort_order is a whole number.').optional(),
    sortOrder: z.coerce.number({ invalid_type_error: 'sortOrder is a whole number.' }).int('sortOrder is a whole number.').optional(),
}).strict();

const ROWS_TEXT = 'checks must be an array of rows';
const rowList = z.array(CheckRow, { required_error: ROWS_TEXT, invalid_type_error: ROWS_TEXT })
    .max(500, 'At most 500 rows per upsert.');
/**
 * The import posts a bare array, `{ checks: [...] }` or `{ rows: [...] }`.
 * Unwrapped before the rows are checked, so a refusal names the ROW and the
 * field in it (`body.0.evidence_required`) instead of one message for the
 * whole batch.
 */
const ChecksBody = z.preprocess((v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return v.checks ?? v.rows ?? v;
    return v;
}, rowList);

/** An uploaded evidence file, by its id or its hash — never a bare string. */
const evidenceRef = z.object({
    evidence_id: z.union([z.string(), z.number()]).nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    sha256: worded('sha256 must be a hex digest.').nullish(),
    filename: worded('filename must be text.').nullish(),
}).passthrough().refine(
    (r) => (r.evidence_id ?? r.id) != null || !!r.sha256,
    'An evidence reference needs an evidence_id or a sha256.',
);

const EXPIRES_TEXT = `expires_in_months must be 1..${MAX_EXPIRES_MONTHS}`;
const AttestBody = bodyOf({
    // The route answers a wrong VALUE with invalid_outcome, which lists them.
    outcome: worded('outcome must be an outcome.').optional(),
    statement: worded('statement must be text.').max(4000, 'A statement is at most 4000 characters.').nullish(),
    subject_id: worded('subject_id must be a subject id.').max(200, 'subject_id is at most 200 characters.').nullish(),
    evidence_refs: z.array(evidenceRef, { invalid_type_error: 'evidence_refs is a list of evidence references.' })
        .max(50, 'At most 50 evidence references.').optional(),
    // `null` is evergreen; anything else is a whole number of months.
    expires_in_months: z.coerce.number({ invalid_type_error: EXPIRES_TEXT })
        .int(EXPIRES_TEXT).min(1, EXPIRES_TEXT).max(MAX_EXPIRES_MONTHS, EXPIRES_TEXT).nullable().optional(),
});

const ARCHIVED_TEXT = 'include_archived is one of: 1, 0, true, false.';
const ListQuery = z.object({
    include_archived: z.enum(['1', '0', 'true', 'false'], { errorMap: () => ({ message: ARCHIVED_TEXT }) }).optional(),
}).strict();

const LIMIT_TEXT = 'limit must be a whole number of rows.';
const AttestationsQuery = z.object({
    limit: z.coerce.number({ invalid_type_error: LIMIT_TEXT }).int(LIMIT_TEXT).min(1, LIMIT_TEXT).optional(),
    subject_id: worded('subject_id must be a subject id.').max(200, 'subject_id is at most 200 characters.').optional(),
}).strict();

function _badRequest(res, e) {
    if (e instanceof customFrameworkStore.InvalidCodeError) return res.status(400).json({ error: e.code, message: e.message });
    if (e instanceof customFrameworkStore.CodeTakenError) return res.status(409).json({ error: e.code, message: e.message });
    return res.status(400).json({ error: e.message });
}

function _isUuid(v) {
    return typeof v === 'string' && UUID_RE.test(v);
}

function _invalidateCounts(orgId) {
    // routes/compliance/counts.js is another stream's file; its absence is harmless.
    try { require('./counts').invalidate(orgId); } catch { /* not shipped yet */ }
}

/** Evidence row for an attestation — explicit allow-list, never the raw body or user record. */
function _recordAttestationEvidence(orgId, checkId, attestation, actorId) {
    const refs = Array.isArray(attestation?.evidence_refs) ? attestation.evidence_refs : [];
    const row = {
        organization_id: orgId,
        check_id: checkId,
        subject_type: 'custom_check',
        subject_id: attestation?.subject_id ? `${checkId}#${attestation.subject_id}` : checkId,
        payload: {
            action: 'attested',
            attestation_id: attestation?.id || null,
            check_id: checkId,
            subject_id: attestation?.subject_id || null,
            outcome: attestation?.outcome || null,
            evidence_refs: refs.map(r => ({ evidence_id: r.evidence_id ?? null, sha256: r.sha256 ?? null })),
            expires_at: attestation?.expires_at || null,
            by: actorId,
            at: new Date().toISOString(),
        },
    };
    // The attestation is saved either way; a lost ledger row is reported so it
    // cannot pass for "never attested".
    return complianceStore.addEvidence(row).catch(onEvidenceWriteFailed(row));
}

/** attested_at + N months (the framework's validity; body override ≤ 120), or null for evergreen. */
function computeExpiresAt(attestedAt, months) {
    if (months === null) return null;
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRES_MONTHS) throw new Error(`expires_in_months must be 1..${MAX_EXPIRES_MONTHS}`);
    const d = new Date(attestedAt);
    if (Number.isNaN(d.getTime())) throw new Error('attested_at is not a date');
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
}

// ───────────────── Frameworks ─────────────────

router.get('/custom/frameworks', ...guard, validate({ query: ListQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    res.json(await customFrameworkStore.listFrameworks(orgId, { includeArchived }));
});

router.post('/custom/frameworks', ...guard, validate({ body: FrameworkBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const body = req.body;
        const fw = await customFrameworkStore.createFramework(orgId, {
            code: body.code,
            name: body.name,
            reference: body.reference,
            description: body.description,
            attestationValidMonths: body.attestation_valid_months ?? body.attestationValidMonths,
            status: body.status,
            createdBy: req.session?.user?.id || null,
        });
        _invalidateCounts(orgId);
        res.status(201).json(fw);
    } catch (e) {
        _badRequest(res, e);
    }
});

router.get('/custom/frameworks/:id', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const fw = await customFrameworkStore.getFramework(orgId, req.params.id);
    if (!fw) return res.status(404).json({ error: 'not found' });
    const checks = await customFrameworkStore.listChecks(orgId, fw.id);
    res.json({ ...fw, checks });
});

router.put('/custom/frameworks/:id', ...guard, validate({ body: FrameworkPatch }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
        const body = req.body;
        const patch = {};
        for (const k of ['name', 'reference', 'description', 'status']) if (body[k] !== undefined) patch[k] = body[k];
        if (body.attestation_valid_months !== undefined) patch.attestation_valid_months = body.attestation_valid_months;
        if (body.attestationValidMonths !== undefined) patch.attestationValidMonths = body.attestationValidMonths;
        if (body.code !== undefined) patch.code = body.code; // the store refuses — surfaces as 400
        const fw = await customFrameworkStore.updateFramework(orgId, req.params.id, patch);
        if (!fw) return res.status(404).json({ error: 'not found' });
        _invalidateCounts(orgId);
        res.json(fw);
    } catch (e) {
        _badRequest(res, e);
    }
});

// DELETE archives: checks and attestations stay (append-only history); the runner skips it.
router.delete('/custom/frameworks/:id', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const ok = await customFrameworkStore.archiveFramework(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    _invalidateCounts(orgId);
    res.json({ ok: true, status: 'archived' });
});

// ───────────────── Checks ─────────────────

// Bulk upsert by ref. Accepts { checks: [...] } or a bare JSON array.
router.post('/custom/frameworks/:id/checks', ...guard, validate({ body: ChecksBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
        const body = req.body;
        const rows = body;
        const list = await customFrameworkStore.upsertChecks(orgId, req.params.id, rows);
        if (list === null) return res.status(404).json({ error: 'not found' });
        _invalidateCounts(orgId);
        res.json({ checks: list, count: list.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/custom/checks/:id', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const ok = await customFrameworkStore.deleteCheck(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    _invalidateCounts(orgId);
    res.json({ ok: true });
});

// ───────────────── Attestations ─────────────────

router.post('/custom/checks/:id/attest', ...guard, validate({ body: AttestBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
        const check = await customFrameworkStore.getCheck(orgId, req.params.id);
        if (!check) return res.status(404).json({ error: 'not found' });
        const body = req.body;
        if (!customFrameworkStore.OUTCOMES.includes(body.outcome)) {
            return res.status(400).json({ error: 'invalid_outcome', allowed: customFrameworkStore.OUTCOMES });
        }
        if (check.evidence_required && !(Array.isArray(body.evidence_refs) && body.evidence_refs.length)) {
            return res.status(400).json({ error: 'evidence_required', message: 'This item requires at least one evidence reference.' });
        }
        const fw = await customFrameworkStore.getFramework(orgId, check.framework_id);
        const months = body.expires_in_months === null
            ? null
            : (body.expires_in_months ?? fw?.attestation_valid_months ?? 12);
        const attestedAt = new Date();
        const expiresAt = computeExpiresAt(attestedAt, months);
        const checkId = customFrameworkStore.customCheckId(check.framework_code, check.ref);
        const attestation = await customFrameworkStore.attest(orgId, {
            checkId,
            subjectId: body.subject_id || null,
            outcome: body.outcome,
            statement: body.statement,
            evidenceRefs: body.evidence_refs,
            attestedBy: actorId,
            expiresAt,
        });
        await _recordAttestationEvidence(orgId, checkId, attestation, actorId);
        _invalidateCounts(orgId);
        res.status(201).json(attestation);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/custom/checks/:id/attestations', ...guard, validate({ query: AttestationsQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const check = await customFrameworkStore.getCheck(orgId, req.params.id);
    if (!check) return res.status(404).json({ error: 'not found' });
    const checkId = customFrameworkStore.customCheckId(check.framework_code, check.ref);
    const limit = Math.min(req.query.limit ?? 50, 200);
    const subjectId = req.query.subject_id || null;
    res.json(await customFrameworkStore.listAttestations(orgId, checkId, subjectId, { limit }));
});

// ───────────────── Export ─────────────────

const ATTESTATION_EXPORT_FIELDS = ['id', 'check_id', 'subject_id', 'outcome', 'statement', 'evidence_refs', 'attested_by', 'attested_at', 'expires_at'];

function _pick(row, fields) {
    const out = {};
    for (const f of fields) if (row && row[f] !== undefined) out[f] = row[f];
    return out;
}

router.get('/custom/frameworks/:id/export.json', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    if (!_isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const fw = await customFrameworkStore.getFramework(orgId, req.params.id);
    if (!fw) return res.status(404).json({ error: 'not found' });
    const checks = await customFrameworkStore.listChecks(orgId, fw.id);
    const latest = await customFrameworkStore.listLatestByPrefix(orgId, `CUSTOM-${fw.code}-`);
    const latestByCheck = new Map();
    for (const a of latest) {
        if (a.subject_id) continue;
        if (!latestByCheck.has(a.check_id)) latestByCheck.set(a.check_id, a);
    }
    const payload = {
        exported_at: new Date().toISOString(),
        framework: _pick(fw, ['id', 'code', 'name', 'reference', 'description', 'attestation_valid_months', 'status', 'created_at', 'updated_at']),
        checks: checks.map(c => {
            const checkId = customFrameworkStore.customCheckId(fw.code, c.ref);
            const att = latestByCheck.get(checkId) || null;
            return {
                ..._pick(c, ['id', 'ref', 'title', 'description', 'severity', 'evidence_required', 'mapped_check_id', 'sort_order']),
                check_id: checkId,
                latest_attestation: att ? _pick(att, ATTESTATION_EXPORT_FIELDS) : null,
            };
        }),
    };
    const safeCode = String(fw.code).replace(/[^A-Z0-9_]/gi, '_');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="custom-framework-${safeCode}.json"`);
    res.send(JSON.stringify(payload, null, 2));
});

module.exports = router;
module.exports.computeExpiresAt = computeExpiresAt;
