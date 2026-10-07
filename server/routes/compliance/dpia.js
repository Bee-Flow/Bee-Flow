/**
 * Compliance — the per-agent Data Protection Impact Assessments: the org
 * listing, one agent's assessment, its PDF and the upsert.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const dpiaStore = require('../../stores/dpiaStore');
const runner = require('../../compliance/runner');
const { getAll } = require('../../db');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { CHAT_MONITORING_DPIA_KEY } = require('../../stores/lib/chatMonitoringVocab');

/**
 * Chat signals keep their org-wide DPIA under the key 'chat_monitoring'. A
 * save of that one refreshes the chat signals resolver and re-runs its checks
 * (routes/compliance/chatMonitoring.js chatMonitoringDpiaHook, after the
 * response). Required lazily, for that key only: every other DPIA save never
 * loads the chat signals router through this file.
 */
function chatMonitoringDpiaHook(req, res, next) {
    if (req.params?.agentId !== CHAT_MONITORING_DPIA_KEY) return next();
    return require('./chatMonitoring').chatMonitoringDpiaHook(req, res, next);
}

// ── What a caller may send ────────────────────────────────────────
//
// `DpiaBody` is `.strict()`. dpiaStore answers a `mode` it does not know by
// recording 'attestation', so a questionnaire filed under a near-miss spelling
// was stored as a bare attestation — the Art-35(7) answers still in the body,
// the row saying nobody had answered anything, and a 200 with the saved row.
// A misspelled key went the same way: `mitigation` instead of `mitigations`
// dropped the measures the assessment turns on.
//
// `answers` stays an open object: it is the questionnaire's own vocabulary and
// grows with the form, and dpiaStore stores it whole as jsonb.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const MODES = ['attestation', 'questionnaire'];
const RISKS = ['low', 'medium', 'high'];
const oneOf = (name, values) => z.enum(values, {
    errorMap: () => ({ message: `${name} is one of: ${values.join(', ')}.` }),
});

const DpiaBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    mode: oneOf('mode', MODES).optional(),
    risk_level: oneOf('risk_level', RISKS).optional(),
    expires_at: worded('expires_at must be a date.')
        .refine((v) => !Number.isNaN(new Date(v).getTime()), 'expires_at must be a date.')
        .nullish(),
    // The questionnaire's own shape; the store keeps it whole.
    answers: z.record(z.unknown(), { invalid_type_error: 'answers is a JSON object.' }).optional(),
    mitigations: z.array(worded('mitigations is a list of measures.'), {
        invalid_type_error: 'mitigations is a list of measures.',
    }).max(100, 'At most 100 measures.').optional(),
}).strict());

// ───────────────── DPIA ─────────────────

router.get('/dpia', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const rows = await dpiaStore.listForOrg(orgId);
    res.json(rows);
});

// PDF rendition of one agent's latest DPIA. Registered before /dpia/:agentId
// so the sub-path wins.
router.get('/dpia/:agentId/pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const dpia = await dpiaStore.getLatestForAgent(orgId, req.params.agentId);
    if (!dpia) return res.status(404).json({ error: 'no DPIA on record for this agent' });
    let agentName = req.params.agentId;
    try {
        const row = await getAll(`SELECT name FROM agents WHERE id = $1 LIMIT 1`, [req.params.agentId]);
        if (row?.[0]?.name) agentName = row[0].name;
    } catch { /* keep id */ }
    const { buildDpiaPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildDpiaPdf({ agentName, dpia });
    // The PDF goes out either way, but a lost stamp makes the trail say the
    // DPIA was never exported — reported, not swallowed.
    const evidenceRow = {
        organization_id: orgId,
        check_id: 'GDPR-Art35-dpia-high-risk',
        subject_type: 'export',
        subject_id: req.params.agentId,
        hash,
        payload: { action: 'dpia_pdf_generated', agent_id: req.params.agentId, by: actorId, at: new Date().toISOString(), sha256: hash },
    };
    await complianceStore.addEvidence(evidenceRow).catch(onEvidenceWriteFailed(evidenceRow));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dpia-${encodeURIComponent(req.params.agentId)}.pdf"`);
    res.send(buffer);
});

router.get('/dpia/:agentId', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const row = await dpiaStore.getLatestForAgent(orgId, req.params.agentId);
    res.json(row || null);
});

router.post('/dpia/:agentId', requireAuth, requirePermission('admin_compliance'), validate({ body: DpiaBody }), chatMonitoringDpiaHook, async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const saved = await dpiaStore.upsertAssessment(orgId, req.params.agentId, {
        ...req.body,
        approved_by: actorId,
    });
    runner.runOne(orgId, 'GDPR-Art35-dpia-high-risk', { subjectId: req.params.agentId }).catch(() => {});
    res.json(saved);
});

module.exports = router;
