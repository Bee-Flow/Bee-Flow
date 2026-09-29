/**
 * Compliance — the auditor hand-over exports: the risk register PDF, the ISMS
 * policy pack PDF and the hash-stamped evidence bundle ZIP that carries every
 * artefact plus the recent evidence chain.
 */

// ── Why the three export routes have no schema ────────────────
//
// They are GETs a browser NAVIGATES to — an <a download> for a PDF or a zip.
// A schema refusal travels to the terminal error handler, which answers JSON,
// so a stray query param would put `{"error": …}` in a download the reader
// expected to be a document. They take no parameters at all; anything in the
// query is ignored on purpose.

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const crypto = require('crypto');
const complianceStore = require('../../stores/complianceStore');
const soaStore = require('../../stores/soaStore');
const ismsDocStore = require('../../stores/ismsDocStore');
const userStore = require('../../stores/userStore');
const isoControls = require('../../compliance/iso/controls');
const registry = require('../../compliance/registry');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { computeScore, REGULATIONS } = require('../../compliance/score');
const { getAll } = require('../../db');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const {
    resolveOrgId, REGULATION_KEY, computeVerificationSummary,
    _riskStore, _recordSoaEvidence, _buildClauseConformity,
} = require('./shared');

// ───────────────── ISO 27001 — remaining exports ─────────────────

async function _riskPdfData(orgId) {
    const store = _riskStore();
    const [risks, treatments, stats] = await Promise.all([
        store.listRisks(orgId), store.listTreatments(orgId), store.getStats(orgId),
    ]);
    const byRisk = {};
    for (const tr of treatments) (byRisk[tr.risk_id] = byRisk[tr.risk_id] || []).push(tr);
    const ownerIds = [...new Set(risks.map(r => r.owner_user_id).filter(Boolean))];
    const ownerName = {};
    for (const id of ownerIds) {
        try { const u = await userStore.getUser(id); ownerName[id] = u?.displayName || u?.username || id; }
        catch { ownerName[id] = id; }
    }
    const rows = risks.map(r => ({
        title: r.title,
        category: r.category || '—',
        score: `${r.likelihood}×${r.impact}=${r.score}`,
        score_num: r.score,
        status: r.status,
        owner: r.owner_user_id ? (ownerName[r.owner_user_id] || r.owner_user_id) : '—',
        treatments: (byRisk[r.id] || []).map(tr => `${tr.option}: ${tr.description || ''}`.trim()).join('; ') || '—',
        accepted: r.accepted_at ? `${new Date(r.accepted_at).toISOString().slice(0, 10)}` : '—',
    }));
    return { rows, stats };
}

router.get('/iso/risks.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const org = await userStore.getOrganization(orgId).catch(() => null);
    const { rows, stats } = await _riskPdfData(orgId);
    const { buildRiskRegisterPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildRiskRegisterPdf({
        orgName: org?.name || orgId, generatedAt: new Date().toISOString(), rows, stats,
    });
    await _recordSoaEvidence(orgId, 'risks.pdf', { action: 'risk_register_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="risk-register.pdf"');
    res.send(buffer);
});

async function _policyPackData(orgId) {
    const docs = (await ismsDocStore.listDocs(orgId)).filter(d => d.status === 'published' && d.current_version > 0);
    const documents = [];
    for (const d of docs) {
        const v = await ismsDocStore.getPublishedBody(orgId, d.slug);
        if (v) documents.push({ slug: d.slug, title: v.title, version: v.version, sha256: v.sha256, published_at: v.published_at, body: v.body });
    }
    return documents;
}

router.get('/iso/policy-pack.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const org = await userStore.getOrganization(orgId).catch(() => null);
    const documents = await _policyPackData(orgId);
    if (!documents.length) return res.status(400).json({ error: 'no_published_policies' });
    const { buildPolicyPackPdf } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildPolicyPackPdf({
        orgName: org?.name || orgId, generatedAt: new Date().toISOString(), documents,
    });
    await _recordSoaEvidence(orgId, 'policy-pack.pdf', { action: 'policy_pack_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="isms-policy-pack.pdf"');
    res.send(buffer);
});

// The auditor hand-over: every export in one hash-stamped ZIP plus the recent
// evidence chain as JSON (the hashes are the audit story).
router.get('/iso/evidence-bundle.zip', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const org = await userStore.getOrganization(orgId).catch(() => null);
    const orgName = org?.name || orgId;
    const now = new Date().toISOString();
    const pdf = require('../../utils/compliancePdf');
    const JSZip = require('jszip');
    const zip = new JSZip();
    const manifest = [];
    const failed = [];
    const add = (name, buffer, hash) => { zip.file(name, buffer); manifest.push({ file: name, sha256: hash }); };
    // An artefact that could not be built is RECORDED in the bundle, never
    // dropped: an auditor must be able to tell "this organisation has no
    // Statement of Applicability" from "the SoA could not be read". A pack
    // whose gaps cannot be told apart from its failures is not evidence.
    //
    // The reason is a fixed code plus the error's CLASS (its pg SQLSTATE or
    // constructor name) — never the error's own message, which routinely
    // quotes the row value that broke (BFSF-441).
    const skip = (name, err) => {
        const errorType = (err && (err.code || err.name)) ? String(err.code || err.name).slice(0, 60) : 'Error';
        failed.push({ file: name, reason: 'build_failed', error_type: errorType });
        log.warn(`[Compliance] evidence bundle: ${name} could not be built (${errorType})`);
    };

    // Each artefact is best-effort: an empty register must not sink the bundle.
    try {
        const latest = await complianceStore.getLatestPerCheck(orgId);
        const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
        const rows = latest.map(r => ({
            regulation: r.regulation, article: r.article, severity: r.severity,
            verification: registry.get(r.check_id)?.verification || 'automated',
            title: GUI_DEFAULTS[registry.get(r.check_id)?.titleKey] || r.check_id,
            status: r.status, details: r.details, scope_id: r.scope_id || null, evidence_hash: null,
        }));
        const scores = {};
        for (const reg of REGULATIONS) scores[REGULATION_KEY[reg]] = computeScore(latest.filter(r => r.regulation === reg));
        const r1 = await pdf.buildComplianceReport({ orgName, generatedAt: now, overall: computeScore(latest), ...scores, verificationSummary: computeVerificationSummary(latest), rows });
        add('compliance-report.pdf', r1.buffer, r1.hash);
    } catch (e) { skip('compliance-report.pdf', e); }
    try {
        const clauses = await _buildClauseConformity(orgId);
        const r = await pdf.buildClauseConformityPdf({ orgName, generatedAt: now, clauses });
        add('isms-clause-conformity.pdf', r.buffer, r.hash);
    } catch (e) { skip('isms-clause-conformity.pdf', e); }
    try {
        const entries = await soaStore.listEntries(orgId);
        const stats = await soaStore.getStats(orgId);
        const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
        const byRef = new Map(entries.map(e => [e.control_ref, e]));
        const rows = isoControls.CONTROLS.map(c => {
            const e = byRef.get(c.ref) || null;
            return {
                ref: c.ref, title: GUI_DEFAULTS[c.titleKey] || c.ref,
                applicable: e ? (e.applicable ? 'yes' : 'no') : 'yes',
                source: e?.source || (c.bucket === 'physical' ? 'inherited' : c.bucket),
                status: e?.status || 'todo', check: '—', owner: '—',
                justification: e?.justification || '—',
            };
        });
        const r = await pdf.buildSoaPdf({ orgName, generatedAt: now, rows, stats });
        add('statement-of-applicability.pdf', r.buffer, r.hash);
    } catch (e) { skip('statement-of-applicability.pdf', e); }
    try {
        const { rows, stats } = await _riskPdfData(orgId);
        if (rows.length) {
            const r = await pdf.buildRiskRegisterPdf({ orgName, generatedAt: now, rows, stats });
            add('risk-register.pdf', r.buffer, r.hash);
        }
    } catch (e) { skip('risk-register.pdf', e); }
    try {
        const documents = await _policyPackData(orgId);
        if (documents.length) {
            const r = await pdf.buildPolicyPackPdf({ orgName, generatedAt: now, documents });
            add('isms-policy-pack.pdf', r.buffer, r.hash);
        }
    } catch (e) { skip('isms-policy-pack.pdf', e); }
    try {
        const evidence = await getAll(`
                SELECT id, check_id, subject_type, subject_id, captured_at, hash
                FROM compliance_evidence
                WHERE organization_id = $1
                ORDER BY captured_at DESC
                LIMIT 2000
            `, [orgId]);
        zip.file('evidence-chain.json', JSON.stringify({ organization: orgName, exported_at: now, rows: evidence }, null, 2));
    } catch (e) { skip('evidence-chain.json', e); }
    // The bundle states its own completeness, in both the human and the
    // machine-readable form, so a gap can never be mistaken for a nil return.
    zip.file('manifest.json', JSON.stringify({
        organization: orgName,
        generated_at: now,
        complete: failed.length === 0,
        files: manifest,
        failed,
    }, null, 2));
    zip.file('README.txt', [
        `ISMS evidence bundle — ${orgName}`,
        `Generated ${now} by Bee Flow Compliance Hub.`,
        '',
        'Every PDF footer carries the sha256 of its source data; evidence-chain.json',
        'lists the immutable evidence rows those hashes anchor to. This bundle',
        'supports — but does not replace — your ISMS, your internal auditor, and',
        'your certification body.',
        '',
        'Manifest:',
        ...manifest.map(m => `  ${m.file}  sha256:${m.sha256}`),
        '',
        ...(failed.length
            ? [
                `INCOMPLETE — ${failed.length} artefact(s) could not be built for this export.`,
                'Their absence below is a READ FAILURE, not an empty register: re-run the',
                'export, and treat this bundle as partial until it comes back clean.',
                ...failed.map(f => `  ${f.file}  ${f.reason} (${f.error_type})`),
            ]
            : ['Complete: every artefact in this bundle was built successfully.']),
    ].join('\n'));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const bundleHash = crypto.createHash('sha256').update(buffer).digest('hex');
    await _recordSoaEvidence(orgId, 'evidence-bundle.zip', {
        action: 'evidence_bundle_generated', files: manifest.map(m => m.file),
        // The chain records that this export was partial, and which artefact
        // was missing — file names and a reason code only, no error text.
        failed: failed.map(f => ({ file: f.file, reason: f.reason })),
        complete: failed.length === 0,
        by: actorId, at: now, sha256: bundleHash,
    });
    // NIS2 Art. 21(2)(d) supplier questionnaire pack: stamp the export so the
    // check can report `last_bundle_export_at` (allow-listed payload, no actor).
    const stampRow = {
        organization_id: orgId, check_id: 'NIS2-Art21(2)(d)-questionnaire-pack',
        subject_type: 'export', subject_id: 'evidence-bundle.zip',
        hash: bundleHash, payload: { action: 'evidence_bundle_exported', at: now, sha256: bundleHash },
    };
    // The stamp never blocks the download — but a lost stamp makes the
    // check report "no bundle ever exported", so the failure is reported.
    await complianceStore.addEvidence(stampRow).catch(onEvidenceWriteFailed(stampRow));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="isms-evidence-bundle.zip"');
    res.send(buffer);
});

module.exports = router;
