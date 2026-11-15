// @typecheck strict
/**
 * Compliance — the Records of Processing Activities: the synthesis
 * (usecases/compliance/buildRopa.js), its PDF rendition and the
 * mark-as-reviewed stamp.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');

/** The review button posts nothing; this stamp reads nothing out of a body. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const runner = require('../../compliance/runner');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { bestEffort } = require('../../utils/bestEffort');
const { buildRopa } = require('../../usecases/compliance/buildRopa');

router.get('/ropa', requireAuth, requirePermission('admin_compliance'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await resolveOrgId(req);
    res.json(await buildRopa(orgId));
});

// PDF rendition of the same synthesis — the document a DPO hands an auditor.
router.get('/ropa.pdf', requireAuth, requirePermission('admin_compliance'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const ropa = await buildRopa(orgId);
    const { buildRopaPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildRopaPdf(ropa);
    // Same as the other exports: the download never fails on the ledger,
    // but the failure is reported rather than dropped.
    const evidenceRow = {
        organization_id: orgId,
        check_id: 'GDPR-Art30-ropa-reviewed',
        subject_type: 'export',
        subject_id: 'ropa.pdf',
        hash,
        payload: { action: 'ropa_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash },
    };
    await complianceStore.addEvidence(evidenceRow).catch(onEvidenceWriteFailed(evidenceRow));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="ropa.pdf"');
    res.send(buffer);
});

router.post('/ropa/review', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    await complianceStore.markRopaReviewed(orgId, actorId);
    runner.runOne(orgId, 'GDPR-Art30-ropa-reviewed').catch((e) => bestEffort('routes/compliance/ropa:anon', e));
    res.json({ ok: true, reviewed_at: new Date().toISOString(), reviewer: actorId });
});

// GET/PUT/DELETE /ropa/projects[/:projectId] — the processing record of
// collaborative projects (routes/compliance/projectRegistrations.js).
router.use(require('./projectRegistrations').makeProjectRegistrationRouter());

module.exports = router;
