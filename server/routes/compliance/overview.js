/**
 * Compliance — overview, the full PDF report and the score-over-time trend.
 *
 * GET /overview       — per-regulation scores, verification split, settings
 * GET /report.pdf     — every check with its latest result and evidence hash
 * GET /score-history  — one row per full sweep, for the Overview sparkline
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const DAYS_TEXT = 'days must be a whole number of days.';
/** `?dais=30` used to fall back to 90 days without saying so. */
const HistoryQuery = z.object({
    days: z.coerce.number({ invalid_type_error: DAYS_TEXT })
        .int(DAYS_TEXT).min(1, DAYS_TEXT).max(365, 'days is at most 365.').optional(),
}).strict();
const log = require('../../telemetry/log');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const runner = require('../../compliance/runner');
const registry = require('../../compliance/registry');
const userStore = require('../../stores/userStore');
const frameworks = require('../../compliance/frameworks');
const { onEvidenceWriteFailed } = require('../../compliance/evidence/writeFailures');
const { resolveOrgId, REGULATION_KEY, computeVerificationSummary, activeResultsFilter } = require('./shared');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth, requirePermission } = require('../../auth/permissions');

// ───────────────── Score model ─────────────────
// Shared with the runner's per-run snapshot — see compliance/score.js.

const { SEVERITY_WEIGHT, computeScore, scoresByFramework } = require('../../compliance/score');

// Track which orgs have had an auto-run kicked off so we don't re-trigger on
// every overview call. Keyed by orgId, value = timestamp of last auto-run.
const _autoRunCache = new Map();
const AUTO_RUN_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function ensureFreshResults(orgId) {
    const last = _autoRunCache.get(orgId) || 0;
    if (Date.now() - last < AUTO_RUN_STALE_MS) return;
    _autoRunCache.set(orgId, Date.now());
    runner.runAll(orgId, { runType: 'scheduled' }).catch(e =>
        log.warn(`[Compliance] auto-run for org "${orgId}" failed:`, e.message)
    );
}

// ───────────────── Overview ─────────────────

router.get('/overview', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const settings = await complianceStore.getSettings(orgId);
    let latest = await complianceStore.getLatestPerCheck(orgId);

    const newest = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
    const staleMs = newest ? (Date.now() - new Date(newest).getTime()) : Infinity;
    let firstScanRan = false;
    if (latest.length === 0) {
        try {
            await runner.runAll(orgId, { runType: 'scheduled' });
            firstScanRan = true;
        } catch (e) {
            log.warn('[Compliance] initial run failed:', e.message);
        }
        latest = await complianceStore.getLatestPerCheck(orgId);
        _autoRunCache.set(orgId, Date.now());
    } else if (staleMs > AUTO_RUN_STALE_MS) {
        ensureFreshResults(orgId);
    }

    // Rows of a disabled framework never surface — they were not run
    // either, but rows from before a disable would otherwise linger.
    let activeRegs = null;
    try {
        const isActive = await activeResultsFilter(orgId, { req });
        latest = latest.filter(isActive);
        // scoresByFramework gates on REGULATION CODES (fw.regulation), not
        // framework ids — mapping to ids here made the set match nothing and
        // emptied `frameworks`/`frameworks_detail` on every request.
        activeRegs = new Set(await require('../../compliance/frameworkPolicy').activeRegulations(orgId, { req }));
    } catch (e) {
        log.warn('[Compliance] framework policy unavailable, showing every row:', e.message);
    }

    const lastRunAt = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
    // Legacy keys (gdpr/aia/iso) stay for the existing clients …
    const perRegulation = {};
    for (const reg of Object.keys(REGULATION_KEY)) {
        perRegulation[REGULATION_KEY[reg]] = computeScore(latest.filter(r => r.regulation === reg));
    }
    // … and every active framework lands under frameworks.<id>, with its
    // own verification split (a shared check counts once per framework).
    const byFramework = scoresByFramework(latest, activeRegs || undefined);
    const frameworkScores = {};
    const frameworkVerification = {};
    for (const [fwId, s] of Object.entries(byFramework)) {
        if (s == null) continue;
        frameworkScores[fwId] = s.score;
        const reg = frameworks.regulationOf(fwId);
        const rows = latest.filter(r => {
            const def = registry.get(r.check_id);
            if (def?.regulation === reg || r.regulation === reg) return true;
            return Array.isArray(def?.frameworks) && def.frameworks.some(f => f.regulation === reg);
        });
        frameworkVerification[fwId] = computeVerificationSummary(rows);
    }
    res.json({
        organization_id: orgId,
        onboarded: !!settings.onboarded_at,
        settings,
        overall: computeScore(latest),
        ...perRegulation,
        frameworks: frameworkScores,
        frameworks_detail: byFramework,
        verification_summary: computeVerificationSummary(latest),
        verification_summary_by_framework: frameworkVerification,
        last_run_at: lastRunAt,
        total_checks: registry.getAll().length,
        first_scan_ran: firstScanRan,
        score_formula: {
            weights: SEVERITY_WEIGHT,
            rule: 'score = round(sum(weight × statusFactor) / sum(weight) × 100), where statusFactor is 1.0 (pass), 0.5 (warn), 0 (fail). "not_applicable" rows are excluded from the denominator.',
        },
    });
});

// Full compliance report as PDF — scores, verification split, every check with
// its latest result and evidence hash. PDF+JSON only (project rule: no CSV).
router.get('/report.pdf', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const [latest, org] = await Promise.all([
        complianceStore.getLatestPerCheck(orgId),
        userStore.getOrganization(orgId).catch(() => null),
    ]);
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const rows = [];
    for (const r of latest) {
        const def = registry.get(r.check_id);
        let evidenceHash = null;
        try {
            const ev = await complianceStore.getEvidenceHistory(orgId, r.check_id, 1);
            evidenceHash = ev?.[0]?.hash || null;
        } catch { /* best-effort */ }
        rows.push({
            regulation: r.regulation,
            article: r.article,
            severity: r.severity,
            verification: def?.verification || 'automated',
            title: GUI_DEFAULTS[def?.titleKey] || r.check_id,
            status: r.status,
            details: r.details,
            scope_id: r.scope_id || null,
            evidence_hash: evidenceHash,
        });
    }
    const reportScores = {};
    for (const reg of Object.keys(REGULATION_KEY)) {
        reportScores[REGULATION_KEY[reg]] = computeScore(latest.filter(r => r.regulation === reg));
    }
    const { buildComplianceReport } = require('../../utils/compliancePdf');
    const { buffer, hash } = await buildComplianceReport({
        orgName: org?.name || orgId,
        generatedAt: new Date().toISOString(),
        overall: computeScore(latest),
        ...reportScores,
        verificationSummary: computeVerificationSummary(latest),
        rows,
    });
    // The PDF still goes out if the ledger write fails, but "who exported
    // the compliance report, when" is exactly what the trail is for, so the
    // rejection is reported rather than swallowed.
    const evidenceRow = {
        organization_id: orgId,
        check_id: null,
        subject_type: 'export',
        subject_id: 'report.pdf',
        hash,
        payload: { action: 'report_pdf_generated', by: actorId, at: new Date().toISOString(), sha256: hash },
    };
    await complianceStore.addEvidence(evidenceRow).catch(onEvidenceWriteFailed(evidenceRow));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="compliance-report.pdf"');
    res.send(buffer);
});

// Score-over-time trend for the Overview sparkline. One row per full sweep.
router.get('/score-history', requireAuth, requirePermission('admin_compliance'), validate({ query: HistoryQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const days = req.query.days ?? 90;
    const rows = await complianceStore.getScoreHistory(orgId, days);
    res.json(rows);
});

module.exports = router;
