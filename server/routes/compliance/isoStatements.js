/**
 * Compliance — the two ISO 27001 statement renders: the Statement of
 * Applicability PDF and the clause 4–10 conformity pack.
 */

// ── Why the two PDF routes have no schema ────────────────────
//
// Same reason as isoAuditPack.js: a browser navigates to them and expects a
// document back, so a 400 in JSON would land in a download. They read nothing
// from the query.

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const soaStore = require('../../stores/soaStore');
const userStore = require('../../stores/userStore');
const isoControls = require('../../compliance/iso/controls');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId, _isoChecksByControl, _recordSoaEvidence, _buildClauseConformity } = require('./shared');

// SoA PDF — a render of the rows (the trail stays in the store + evidence chain).
router.get('/iso/soa.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const [entries, stats, latest, org] = await Promise.all([
        soaStore.listEntries(orgId),
        soaStore.getStats(orgId),
        complianceStore.getLatestPerCheck(orgId),
        userStore.getOrganization(orgId).catch(() => null),
    ]);
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const byRef = new Map(entries.map(e => [e.control_ref, e]));
    const checksByControl = _isoChecksByControl();
    const statusByCheck = {};
    for (const r of latest) {
        if (!statusByCheck[r.check_id] || r.status === 'fail') statusByCheck[r.check_id] = r.status;
    }
    // Resolve owner display names once.
    const ownerIds = [...new Set(entries.map(e => e.owner_user_id).filter(Boolean))];
    const ownerName = {};
    for (const id of ownerIds) {
        try {
            const u = await userStore.getUser(id);
            ownerName[id] = u?.displayName || u?.username || id;
        } catch { ownerName[id] = id; }
    }
    const rows = isoControls.CONTROLS.map(c => {
        const e = byRef.get(c.ref) || null;
        const checkIds = checksByControl[c.ref] || [];
        const worst = checkIds.map(id => statusByCheck[id]).filter(Boolean)
            .sort((a, b) => ({ fail: 3, warn: 2, pass: 1 }[b] || 0) - ({ fail: 3, warn: 2, pass: 1 }[a] || 0))[0] || null;
        return {
            ref: c.ref,
            title: GUI_DEFAULTS[c.titleKey] || c.ref,
            applicable: e ? (e.applicable ? 'yes' : 'no') : 'yes',
            source: e?.source || (c.bucket === 'physical' ? 'inherited' : c.bucket),
            status: e?.status || 'todo',
            check: worst ? `${worst} (${checkIds.length})` : '—',
            owner: e?.owner_user_id ? (ownerName[e.owner_user_id] || e.owner_user_id) : '—',
            justification: e?.justification || '—',
        };
    });
    const { buildSoaPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildSoaPdf({
        orgName: org?.name || orgId,
        generatedAt: new Date().toISOString(),
        rows, stats,
    });
    await _recordSoaEvidence(orgId, 'soa.pdf', {
        action: 'soa_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="statement-of-applicability.pdf"');
    res.send(buffer);
});

router.get('/iso/clause-conformity.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const org = await userStore.getOrganization(orgId).catch(() => null);
    const clauses = await _buildClauseConformity(orgId);
    const { buildClauseConformityPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildClauseConformityPdf({
        orgName: org?.name || orgId,
        generatedAt: new Date().toISOString(),
        clauses,
    });
    await _recordSoaEvidence(orgId, 'clause-conformity.pdf', {
        action: 'clause_conformity_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="isms-clause-conformity.pdf"');
    res.send(buffer);
});

module.exports = router;
