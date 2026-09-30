/**
 * Compliance — the check surface: the per-check table the UI renders, one
 * check's history, manual runs (all / one) and the auto-fix trigger.
 *
 * Rows are filtered to the org's ACTIVE frameworks (frameworkPolicy): a
 * disabled framework's checks are neither run nor shown, a locked one is shown
 * locked on the frameworks page — never here. `?framework=<id>` narrows the
 * list to every check that counts for that framework, including checks whose
 * home is elsewhere but carry a secondary mapping (a GDPR Art. 33 check also
 * counts for ISO A.5.24). Custom-framework rows come from
 * customFrameworkStore when the store is present and the org has the
 * capability.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const runner = require('../../compliance/runner');
const registry = require('../../compliance/registry');
const frameworks = require('../../compliance/frameworks');
const { computeScore, scoresByFramework, scoreNumbers, SEVERITY_WEIGHT } = require('../../compliance/score');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId, activeResultsFilter } = require('./shared');
const findingState = require('../../compliance/findingState');
const { makeFindingStateRouter } = require('./findingStates');

function _frameworkPolicy() { return require('../../compliance/frameworkPolicy'); }
function _customStore() {
    try { return require('../../stores/customFrameworkStore'); } catch { return null; }
}

function _rowFromDef(def, r, states = null) {
    const state = r && states ? findingState.stateFor(states, { ...r, check_id: def.id }) : null;
    return {
        check_id: def.id,
        regulation: def.regulation,
        framework_id: frameworks.frameworkIdOf(def.regulation),
        frameworks: Array.isArray(def.frameworks) ? def.frameworks : [],
        in_force_since: def.in_force_since ?? frameworks.inForceSince(def.regulation, def.article),
        article: def.article,
        severity: def.severity,
        weight: SEVERITY_WEIGHT[def.severity] || 1,
        scope: def.scope,
        verification: def.verification || 'automated',
        scope_id: r?.scope_id || null,
        titleKey: def.titleKey,
        descriptionKey: def.descriptionKey,
        remediationKey: def.remediationKey,
        remediationLink: def.remediationLink || null,
        autoFixId: def.autoFixId || null,
        status: r?.status || 'pending',
        details: r?.details || null,
        evidence: r?.evidence || null,
        run_at: r?.run_at || null,
        // An admin's decision about this finding (acknowledged / accepted
        // risk / snoozed), with `active` false once it no longer holds.
        finding_state: state ? findingState.publicState(state, { ...r, check_id: def.id }, def) : null,
    };
}

// Does `def` count for framework `fwId`? Home regulation or any secondary tag.
function _countsFor(def, fwId) {
    if (!fwId) return true;
    const reg = frameworks.regulationOf(fwId);
    if (!reg) return false;
    if (def.regulation === reg) return true;
    return Array.isArray(def.frameworks) && def.frameworks.some(f => f.regulation === reg || f.framework_id === fwId);
}

// Rows for the org's custom frameworks: one per custom check, status from the
// persisted CUSTOM result row when present (the custom runner writes them via
// recordCheckResult), else 'pending'.
async function _customRows(orgId, latest, onlyFrameworkId) {
    const store = _customStore();
    if (!store || typeof store.listFrameworks !== 'function') return [];
    let fws;
    try { fws = await store.listFrameworks(orgId, { includeArchived: false }); } catch { return []; }
    const rows = [];
    for (const fw of fws || []) {
        const fwId = `custom:${fw.id}`;
        if (onlyFrameworkId && onlyFrameworkId !== fwId) continue;
        if (fw.status && fw.status !== 'active') continue;
        let checks = [];
        try { checks = await store.listChecks(orgId, fw.id); } catch { checks = []; }
        for (const chk of checks || []) {
            const checkId = store.customCheckId(fw.code, chk.ref);
            const r = latest.find(x => x.check_id === checkId) || null;
            rows.push({
                check_id: checkId,
                regulation: frameworks.CUSTOM_REGULATION,
                framework_id: fwId,
                framework_code: fw.code,
                frameworks: [{ regulation: frameworks.CUSTOM_REGULATION, ref: chk.ref, framework_id: fwId, in_force_since: null }],
                in_force_since: null,
                article: chk.ref,
                severity: chk.severity || 'medium',
                weight: SEVERITY_WEIGHT[chk.severity] || 1,
                scope: 'global',
                verification: 'attestation',
                scope_id: null,
                title: chk.title,
                description: chk.description || null,
                evidence_required: !!chk.evidence_required,
                mapped_check_id: chk.mapped_check_id || null,
                remediationLink: null,
                autoFixId: null,
                status: r?.status || 'pending',
                details: r?.details || null,
                evidence: r?.evidence || null,
                run_at: r?.run_at || null,
            });
        }
    }
    return rows;
}

/**
 * Project checks name their subjects by id only. The admin reading the table
 * gets the CURRENT names of the org's projects those rows refer to, resolved
 * here at read time (compliance/projects/projectNames.js) and never stored. A
 * lookup that fails leaves the rows as they are — ids, never an error.
 */
async function _annotateProjectNames(orgId, rows) {
    const { projectIdsOfRow, projectNames } = require('../../compliance/projects/projectNames');
    const ids = new Set();
    for (const r of rows) for (const id of projectIdsOfRow(r)) ids.add(id);
    if (!ids.size) return;
    let names = {};
    try { names = await projectNames(orgId, ids); } catch { return; }
    for (const r of rows) {
        const mine = {};
        for (const id of projectIdsOfRow(r)) if (names[id] != null) mine[id] = names[id];
        if (Object.keys(mine).length) r.project_names = mine;
    }
}

const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const FRAMEWORK_TEXT = 'framework must be a framework id.';
/** `?framwork=gdpr` used to drop the filter and answer with every framework's checks. */
const ChecksQuery = z.object({
    framework: z.string({ invalid_type_error: FRAMEWORK_TEXT }).max(120, 'framework is at most 120 characters.').optional(),
}).strict();

// ── Why POST /checks/:id/auto-fix keeps an open body ────────────
//
// The body is forwarded whole to `runner.autoFix`, which hands it to the
// check module that owns the fix. Each one reads its own options (which
// agent, which retention window, which connector), and there is no register
// here that knows them: a schema in this router would have to enumerate every
// check's fix arguments and would fall behind the first new check.
// `/checks` keeps its own `unknown_framework` 400, which already names the
// value it refused.

// ───────────────── Checks ─────────────────

router.get('/checks', requireAuth, requirePermission('admin_compliance'), validate({ query: ChecksQuery }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const fwParam = typeof req.query.framework === 'string' && req.query.framework ? req.query.framework : null;
    if (fwParam && !frameworks.byId(fwParam) && !frameworks.isCustomId(fwParam)) {
        return res.status(400).json({ error: 'unknown_framework', framework: fwParam });
    }
    const [latest, isActive, active, stateRows] = await Promise.all([
        complianceStore.getLatestPerCheck(orgId),
        activeResultsFilter(orgId, { req }),
        _frameworkPolicy().activeRegulations(orgId, { req }),
        // Decisions are an annotation: unreadable → the table still renders.
        typeof complianceStore.listFindingStates === 'function'
            ? complianceStore.listFindingStates(orgId).catch(() => [])
            : [],
    ]);
    const states = findingState.indexStates(stateRows);
    const rows = [];

    // For global checks: one row per check def.
    // For per-source checks: one row per latest result so the UI can show each subject.
    for (const def of registry.getAll()) {
        if (!active.has(def.regulation)) continue;
        if (!_countsFor(def, fwParam)) continue;
        const matches = latest.filter(r => r.check_id === def.id && isActive(r));
        if (def.scope === 'per-source' && matches.length > 0) {
            // A retired slot (its subject no longer exists) is history, not a row.
            for (const r of matches) {
                if (r.evidence && r.evidence.retired === true) continue;
                rows.push(_rowFromDef(def, r, states));
            }
        } else {
            rows.push(_rowFromDef(def, matches[0], states));
        }
    }
    if (active.has(frameworks.CUSTOM_REGULATION) && (!fwParam || frameworks.isCustomId(fwParam))) {
        rows.push(...await _customRows(orgId, latest, fwParam));
    }
    await _annotateProjectNames(orgId, rows);
    res.json(rows);
});

router.get('/checks/:id/history', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const rows = await complianceStore.getCheckHistory(orgId, req.params.id, 100);
    res.json(rows);
});

router.post('/checks/run', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const orgId = await resolveOrgId(req);
        const results = await runner.runAll(orgId, { runType: 'manual' });
        let scores = {};
        try {
            // scoresByFramework filters on REGULATION CODES (score.js keys its
            // output by framework id but gates on fw.regulation) — hand it the
            // active regulation set, not a set of ids, or every score is null.
            const active = await _frameworkPolicy().activeRegulations(orgId, { req });
            scores = scoreNumbers(scoresByFramework(results, active));
        } catch { scores = scoreNumbers(scoresByFramework(results)); }
        res.json({ ran: results.length, score: computeScore(results), scores });
    } catch (e) {
        if (e && e.status && e.body) return res.status(e.status).json(e.body);
        next(e);
    }
});

router.post('/checks/:id/run', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    try {
        const orgId = await resolveOrgId(req);
        const result = await runner.runOne(orgId, req.params.id);
        res.json(result);
    } catch (e) {
        // FrameworkDisabledError (409 framework_disabled) and friends carry
        // their own status + body; everything else is a plain 500.
        if (e && e.status && e.body) return res.status(e.status).json(e.body);
        next(e);
    }
});

router.post('/checks/:id/auto-fix', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const result = await runner.autoFix(orgId, req.params.id, {
            ...(req.body || {}),
            actorId,
        });
        // Re-run the check so the UI shows the fresh result.
        await runner.runOne(orgId, req.params.id).catch(() => {});
        res.json({ ok: true, result });
    } catch (e) {
        if (e && e.status && e.body) return res.status(e.status).json(e.body);
        res.status(400).json({ error: e.message });
    }
});

// POST /checks/:id/state — acknowledge / accept / snooze / re-open a finding.
router.use(makeFindingStateRouter());

module.exports = router;
