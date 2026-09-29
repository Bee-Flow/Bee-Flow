/**
 * Compliance — Machinery Regulation (EU) 2023/1230: the detected industrial
 * integrations (Art. 3 relevance) and the per-subject Art. 18 safety-component
 * assessment. The assessment is an attestation on the built-in check id
 * 'MACHINERY-Art18-safety-component-assessment' keyed by subject
 * ('<source>:<id>' | 'manual:<id>'); the classification rides in the statement
 * as a leading marker the check reads back.
 *
 * ── What a caller may send ──────────────────────────────────
 *
 * `AttestBody` is `.strict()`, and `evidence_refs` is the reason. The store's
 * `_evidenceRefs` keeps only OBJECTS carrying an `evidence_id` or a `sha256`
 * and drops everything else, so a list of bare hash STRINGS — the shape a
 * client reaches for first — was filtered away to nothing: an assessment with
 * "evidence attached" that carried none, answered 201 with the saved row.
 * The upload drawer in agent-hub already sends the object shape; this pins it.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const customFrameworkStore = require('../../stores/customFrameworkStore');
const runner = require('../../compliance/runner');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireCapability } = require('../../core/entitlements/entitlements');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const guard = [requireAuth, requirePermission('admin_compliance'), requireCapability('compliance_hub_machinery')];

const ART18_CHECK_ID = 'MACHINERY-Art18-safety-component-assessment';
const CLASSIFICATIONS = Object.freeze(['safety_component', 'monitoring_only', 'not_safety_component']);
// Every classification is a completed assessment → the store's 'compliant'
// outcome; the check derives pass/warn/na from the classification marker.
const SUBJECT_RE = /^[a-z0-9_-]{1,40}:[A-Za-z0-9._:@-]{1,160}$/;
const VALID_MONTHS = 12;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

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

const AttestBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // The route answers a wrong VALUE with invalid_outcome, which lists the three.
    outcome: worded('outcome must be a classification.').optional(),
    classification: worded('classification must be a classification.').optional(),
    statement: worded('statement must be text.').max(4000, 'A statement is at most 4000 characters.').nullish(),
    evidence_refs: z.array(evidenceRef, { invalid_type_error: 'evidence_refs is a list of evidence references.' })
        .max(50, 'At most 50 evidence references.').optional(),
}).strict());

function _detector() {
    try {
        const mod = require('../../compliance/detectors/industrialIntegrations');
        return typeof mod?.detect === 'function' ? mod : null;
    } catch {
        return null;
    }
}

router.get('/machinery/detections', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    const detector = _detector();
    if (!detector) return res.status(503).json({ error: 'not_provisioned', message: 'Industrial-integration detector is not available on this deployment.' });
    const result = await detector.detect(orgId);
    const settings = await complianceStore.getSettings(orgId).catch(() => null);
    const manual = Array.isArray(settings?.machinery_manual_subjects) ? settings.machinery_manual_subjects : [];
    const latest = await customFrameworkStore.listLatestByPrefix(orgId, ART18_CHECK_ID).catch(() => []);
    const bySubject = new Map();
    for (const a of latest || []) if (a.subject_id && !bySubject.has(a.subject_id)) bySubject.set(a.subject_id, a);
    const decorate = (subjectId) => {
        const a = bySubject.get(subjectId);
        if (!a) return null;
        return {
            id: a.id,
            classification: _classificationOf(a),
            attested_at: a.attested_at,
            expires_at: a.expires_at,
            current: customFrameworkStore.isCurrent(a),
        };
    };
    const matches = (Array.isArray(result?.matches) ? result.matches : []).map(m => {
        const subjectId = m.subject_id || (m.source && m.id != null ? `${m.source}:${m.id}` : null);
        return { ...m, subject_id: subjectId, assessment: subjectId ? decorate(subjectId) : null };
    });
    const manualSubjects = manual.map((s, i) => {
        const id = typeof s === 'string' ? s : (s?.id ?? s?.subject_id ?? String(i));
        const subjectId = String(id).includes(':') ? String(id) : `manual:${id}`;
        return {
            subject_id: subjectId,
            label: typeof s === 'string' ? s : (s?.label || s?.name || subjectId),
            source: 'manual',
            assessment: decorate(subjectId),
        };
    });
    res.json({
        scanned: result?.scanned || {},
        matches,
        skipped: Array.isArray(result?.skipped) ? result.skipped : [],
        manual_subjects: manualSubjects,
        classifications: CLASSIFICATIONS,
    });
});

function _classificationOf(att) {
    if (att?.classification && CLASSIFICATIONS.includes(att.classification)) return att.classification;
    const m = /^\s*\[(safety_component|monitoring_only|not_safety_component)\]/.exec(String(att?.statement || ''));
    return m ? m[1] : null;
}

function _subjectId(raw) {
    // Express has already decoded the param once; a second pass only helps a
    // client that double-encoded, and must never throw on a stray '%'.
    let s = String(raw || '');
    try { s = decodeURIComponent(s); } catch { /* keep as-is */ }
    s = s.trim();
    if (!SUBJECT_RE.test(s)) return null;
    return s;
}

router.post('/machinery/subjects/:id/attest', ...guard, validate({ body: AttestBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const subjectId = _subjectId(req.params.id);
        if (!subjectId) return res.status(400).json({ error: 'invalid_subject', message: "Subject must look like '<source>:<id>'." });
        const body = req.body;
        const outcome = String(body.outcome || body.classification || '');
        if (!CLASSIFICATIONS.includes(outcome)) return res.status(400).json({ error: 'invalid_outcome', allowed: CLASSIFICATIONS });
        const statement = String(body.statement ?? '').replace(/^\s*\[[a-z_]+\]\s*/, '').trim().slice(0, 3900);
        const attestedAt = new Date();
        const expiresAt = new Date(attestedAt);
        expiresAt.setUTCMonth(expiresAt.getUTCMonth() + VALID_MONTHS);
        const attestation = await customFrameworkStore.attest(orgId, {
            checkId: ART18_CHECK_ID,
            subjectId,
            outcome: 'compliant',
            statement: `[${outcome}]${statement ? ` ${statement}` : ''}`,
            evidenceRefs: body.evidence_refs,
            attestedBy: actorId,
            expiresAt,
        });
        const refs = Array.isArray(attestation?.evidence_refs) ? attestation.evidence_refs : [];
        await complianceStore.addEvidence({
            organization_id: orgId,
            check_id: ART18_CHECK_ID,
            subject_type: 'machinery_subject',
            subject_id: subjectId,
            payload: {
                action: 'safety_component_assessed',
                attestation_id: attestation?.id || null,
                subject_id: subjectId,
                classification: outcome,
                evidence_refs: refs.map(r => ({ evidence_id: r.evidence_id ?? null, sha256: r.sha256 ?? null })),
                expires_at: attestation?.expires_at || null,
                by: actorId,
                at: attestedAt.toISOString(),
            },
        }).catch(() => {});
        runner.runOne(orgId, ART18_CHECK_ID, { runType: 'event', subjectId }).catch(() => {});
        try { require('./counts').invalidate(orgId); } catch { /* counts router not shipped yet */ }
        res.status(201).json({ ...attestation, classification: outcome });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/machinery/subjects/:id/attestations', ...guard, async (req, res) => {
    const orgId = await resolveOrgId(req);
    const subjectId = _subjectId(req.params.id);
    if (!subjectId) return res.status(400).json({ error: 'invalid_subject' });
    const rows = await customFrameworkStore.listAttestations(orgId, ART18_CHECK_ID, subjectId, { limit: 50 });
    res.json(rows.map(a => ({ ...a, classification: _classificationOf(a) })));
});

module.exports = router;
module.exports.ART18_CHECK_ID = ART18_CHECK_ID;
module.exports.CLASSIFICATIONS = CLASSIFICATIONS;
