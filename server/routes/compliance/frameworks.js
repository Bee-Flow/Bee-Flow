/**
 * Compliance — the framework catalogue as this org sees it, and the three
 * per-framework mutations.
 *
 *   GET  /frameworks                    → { frameworks:[…], custom:[…] }
 *   POST /frameworks/:id/enable         → 200 { framework } · 400 framework_core|unknown_framework
 *                                         · 403 feature_locked|feature_disabled (requireCapability's bodies)
 *   POST /frameworks/:id/disable        → 200 { framework } · 400 framework_core
 *   POST /frameworks/:id/relevance      → { relevance:'relevant'|'not_relevant'|'unknown', note? } → 200 { framework }
 *
 * The catalogue (compliance/frameworks.js) is static; frameworkPolicy adds the
 * org's enabled/locked/relevance state; the scores come from the latest check
 * rows of ACTIVE frameworks (a candidate never carries a score — it has no
 * results). A locked framework is returned locked, never hidden.
 *
 * Enable = `frameworkPolicy.setEnabled` (which emits FRAMEWORK_ENABLED by
 * string) → `runner.runFramework` awaited here so the response carries the
 * first score → evidence row `subject_type:'framework'` (allow-listed payload:
 * ids and timestamps, no personal data beyond the actor's user id, which is
 * the audit trail's own subject) → counts + calendar memo invalidated.
 *
 * The per-framework capability is enforced INSIDE the policy (locked → 403),
 * never as a separate mount — a Community org must still be able to see the
 * catalogue with the locks on it.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// The note is the justification an auditor reads beside a "not relevant"
// decision, and it was the second key in a body nobody checked: `notes`
// instead of `note` was dropped, and the evidence row recorded the decision
// with no reason at all — under a 200 carrying the updated framework.
// No .max() on the note: the route truncates at 500 and the evidence row
// records the truncated text, which frameworks.test.js pins. Refusing a long
// note instead would change a contract no caller asked to have changed.
const NoteBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    // The route answers a wrong VALUE with invalid_relevance, which lists them.
    relevance: z.string({ invalid_type_error: 'relevance must be text.' }).optional(),
    note: z.string({ invalid_type_error: 'note must be text.' }).nullish(),
}).strict());

/** The enable and disable buttons post nothing and read nothing. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const log = require('../../telemetry/log');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const registry = require('../../compliance/registry');
const frameworks = require('../../compliance/frameworks');
const frameworkPolicy = require('../../compliance/frameworkPolicy');
const calendar = require('../../compliance/calendar');
const runner = require('../../compliance/runner');
const { scoresByFramework, computeScore } = require('../../compliance/score');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireOrgId } = require('./shared');

const RECENTLY_IN_FORCE_DAYS = 60;

// A latest-result row counts when ANY framework it is mapped to is active — a
// check's home regulation may be dormant while a tagged one is live.
function _activeRowsFilter(latest, activeRegs) {
    return (latest || []).filter(r => {
        const def = registry.get(r.check_id);
        if (def && Array.isArray(def.frameworks) && def.frameworks.length) {
            return def.frameworks.some(f => activeRegs.has(f.regulation));
        }
        return activeRegs.has(def?.regulation || r.regulation);
    });
}

function _customStore() {
    try { return require('../../stores/customFrameworkStore'); } catch { return null; }
}
function _invalidateCounts(orgId) {
    try { require('./counts').invalidate(orgId); } catch { /* not mounted */ }
}

function _recentlyInForce(fw, nowMs) {
    if (!fw?.in_force_since) return false;
    const since = new Date(fw.in_force_since).getTime();
    return since <= nowMs && nowMs - since <= RECENTLY_IN_FORCE_DAYS * 24 * 3600 * 1000;
}

// "Affects you" per framework: the counts the candidate card shows. Only the
// frameworks with something cheap and honest to count; the rest is null.
async function _affects(fwId, orgId, latest) {
    if (fwId === 'aia') return calendar.affectsCounts('marking', orgId);
    if (fwId === 'eaa') return calendar.affectsCounts('a11y', orgId);
    if (fwId === 'machinery') {
        // The Art. 3 detector's latest row says whether industrial protocols
        // were seen; its evidence carries the derived relevance.
        const row = (latest || []).find(r => r.check_id === 'MACHINERY-Art3-industrial-detection');
        const ev = row?.evidence && typeof row.evidence === 'object' ? row.evidence : null;
        if (!ev) return null;
        return { detections: Number(ev.matches ?? ev.detections ?? ev.count) || 0, derived_relevance: ev.derived_relevance || null };
    }
    return null;
}

/**
 * The catalogue entry + the org's state + score, the shape PLAN §1.2 names.
 * `scores` is the scoresByFramework map over the ACTIVE rows (may be {}).
 */
function serialize(fw, state, scores, calendarCounts, nowMs, affects, machineryRelevance) {
    const active = !!(state?.enabled && !state?.locked);
    const s = active ? (scores[fw.id] || null) : null;
    let relevance = state?.relevance || 'unknown';
    if (fw.id === 'machinery' && relevance === 'unknown' && machineryRelevance) relevance = machineryRelevance;
    return {
        id: fw.id,
        regulation: fw.regulation,
        name_key: fw.name_key,
        regulation_code: fw.regulation_code,
        in_force_since: fw.in_force_since || null,
        in_force_from: fw.in_force_from || null,
        phases: fw.phases || [],
        // Where the legal facts above come from, and how recently they were
        // checked (compliance/frameworks.js legalReview).
        sources: fw.sources || [],
        legal_review: frameworks.legalReview(fw, nowMs),
        description_key: fw.description_key,
        affects_key: fw.affects_key,
        affects,
        checks_count: registry.getByFramework(fw.regulation).length,
        registers: fw.registers || [],
        calendar_count: calendarCounts[fw.id] || 0,
        enabled: !!state?.enabled,
        core: !!fw.core,
        locked: state?.locked || null,
        lock: state?.lock || null,
        relevance,
        relevance_gate: !!fw.relevance_gate,
        score: s ? s.score : null,
        score_detail: s,
        recently_in_force: _recentlyInForce(fw, nowMs),
    };
}

async function _buildOne(orgId, id, req) {
    const [policy, latest] = await Promise.all([
        frameworkPolicy.resolve(orgId, { req }),
        complianceStore.getLatestPerCheck(orgId).catch(() => []),
    ]);
    const state = policy.find(p => p.id === id) || null;
    const fw = frameworks.byId(id);
    const activeIds = new Set(policy.filter(p => p.enabled && !p.locked).map(p => p.id));
    const activeRegs = new Set([...activeIds].map(i => frameworks.regulationOf(i)));
    // scoresByFramework's second argument is a Set of REGULATION CODES.
    const scores = scoresByFramework(_activeRowsFilter(latest, activeRegs), activeRegs);
    return serialize(fw, state, scores, calendar.countByFramework(), Date.now(), await _affects(id, orgId, latest), null);
}

async function _customList(orgId, latest, req) {
    const store = _customStore();
    if (!store) return [];
    let unlocked = false;
    try { unlocked = await frameworkPolicy.customUnlocked(orgId, { req }); } catch { unlocked = false; }
    let fws = [];
    try { fws = await store.listFrameworks(orgId, { includeArchived: false }); } catch { return []; }
    return (fws || []).map(fw => {
        const rows = (latest || []).filter(r => r.regulation === frameworks.CUSTOM_REGULATION && r.framework_code === fw.code);
        const s = unlocked && rows.length ? computeScore(rows) : null;
        return {
            id: `custom:${fw.id}`,
            custom_id: fw.id,
            code: fw.code,
            name: fw.name,
            reference: fw.reference || null,
            description: fw.description || null,
            status: fw.status || 'draft',
            attestation_valid_months: fw.attestation_valid_months ?? 12,
            checks_count: Number(fw.checks_count) || 0,
            attested_count: rows.filter(r => r.status === 'pass').length,
            enabled: unlocked && fw.status === 'active',
            core: false,
            locked: unlocked ? null : 'ceiling',
            relevance: 'relevant',
            score: s ? s.score : null,
            score_detail: s,
            created_at: fw.created_at || null,
            updated_at: fw.updated_at || null,
        };
    });
}

// ───────────────── GET ─────────────────

router.get('/frameworks', requireAuth, requirePermission('admin_compliance'), async (req, res, next) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    res.set('Cache-Control', 'private, no-store');
    try {
        const [policy, latest] = await Promise.all([
            frameworkPolicy.resolve(orgId, { req }),
            complianceStore.getLatestPerCheck(orgId).catch(() => []),
        ]);
        const byId = new Map(policy.map(p => [p.id, p]));
        const activeIds = new Set(policy.filter(p => p.enabled && !p.locked).map(p => p.id));
        const activeRegs = new Set([...activeIds].map(i => frameworks.regulationOf(i)));
        const scores = scoresByFramework(_activeRowsFilter(latest, activeRegs), activeRegs);
        const calendarCounts = calendar.countByFramework();
        const nowMs = Date.now();
        const list = await Promise.all(frameworks.listBuiltin().map(async (fw) => {
            let affects = null;
            try { affects = await _affects(fw.id, orgId, latest); } catch { affects = null; }
            const machineryRelevance = fw.id === 'machinery' && affects?.derived_relevance
                ? (affects.derived_relevance === 'relevant' ? 'relevant' : 'unknown')
                : null;
            return serialize(fw, byId.get(fw.id), scores, calendarCounts, nowMs, affects, machineryRelevance);
        }));
        res.json({ frameworks: list, custom: await _customList(orgId, latest, req), catalogue: frameworks.catalogueReview(nowMs) });
    } catch (e) {
        if (e && e.status && e.body) return res.status(e.status).json(e.body);
        log.error('[Compliance] frameworks error:', e);
        next(e);
    }
});

// ───────────────── Mutations ─────────────────

function _evidence(orgId, id, action, actorId, extra = {}) {
    // Explicit allow-list: ids, the action, the actor id, the timestamp.
    const payload = {
        action,
        framework_id: id,
        regulation: frameworks.regulationOf(id),
        by: actorId,
        at: new Date().toISOString(),
        ...(extra.relevance ? { relevance: extra.relevance } : {}),
        ...(typeof extra.note === 'string' && extra.note ? { note: extra.note.slice(0, 500) } : {}),
        ...(typeof extra.ran === 'number' ? { checks_ran: extra.ran } : {}),
    };
    return complianceStore.addEvidence({
        organization_id: orgId,
        check_id: null,
        subject_type: 'framework',
        subject_id: id,
        payload,
    }).catch(e => log.warn('[Compliance] framework evidence failed:', e.message));
}

function _sendPolicyError(res, e) {
    if (e && e.status && e.body) return res.status(e.status).json(e.body);
    return null;
}

router.post('/frameworks/:id/enable', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res, next) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    const id = req.params.id;
    const actorId = req.session?.user?.id || null;
    try {
        if (!frameworks.byId(id)) return res.status(400).json({ error: 'unknown_framework', framework: id });
        await frameworkPolicy.setEnabled(orgId, id, true, actorId, { req });
        // First sweep of the newly enabled checks — awaited so the card that
        // appears has a score. A run failure is reported, not fatal: the
        // framework IS enabled.
        let ran = null; let run_error = null;
        try {
            const results = await runner.runFramework(orgId, id, { runType: 'manual' });
            ran = Array.isArray(results) ? results.length : null;
        } catch (e) {
            run_error = e?.message || String(e);
            log.warn(`[Compliance] first sweep of ${id} failed:`, run_error);
        }
        await _evidence(orgId, id, 'framework_enabled', actorId, { ran: ran ?? undefined });
        _invalidateCounts(orgId);
        calendar.invalidate(orgId);
        const framework = await _buildOne(orgId, id, req);
        res.json({ framework, ran, ...(run_error ? { run_error } : {}) });
    } catch (e) {
        if (_sendPolicyError(res, e)) return;
        log.error('[Compliance] enable framework error:', e);
        next(e);
    }
});

router.post('/frameworks/:id/disable', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res, next) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    const id = req.params.id;
    const actorId = req.session?.user?.id || null;
    try {
        if (!frameworks.byId(id)) return res.status(400).json({ error: 'unknown_framework', framework: id });
        await frameworkPolicy.setEnabled(orgId, id, false, actorId, { req });
        await _evidence(orgId, id, 'framework_disabled', actorId);
        _invalidateCounts(orgId);
        calendar.invalidate(orgId);
        res.json({ framework: await _buildOne(orgId, id, req) });
    } catch (e) {
        if (_sendPolicyError(res, e)) return;
        log.error('[Compliance] disable framework error:', e);
        next(e);
    }
});

const RELEVANCE_VALUES = ['relevant', 'not_relevant', 'unknown'];

router.post('/frameworks/:id/relevance', requireAuth, requirePermission('admin_compliance'), validate({ body: NoteBody }), async (req, res, next) => {
    const orgId = await requireOrgId(req, res);
    if (!orgId) return;
    const id = req.params.id;
    const actorId = req.session?.user?.id || null;
    const relevance = req.body.relevance;
    const note = req.body.note ? req.body.note.slice(0, 500) : null;
    try {
        if (!frameworks.byId(id)) return res.status(400).json({ error: 'unknown_framework', framework: id });
        if (!RELEVANCE_VALUES.includes(relevance)) {
            return res.status(400).json({ error: 'invalid_relevance', allowed: RELEVANCE_VALUES });
        }
        await frameworkPolicy.setRelevance(orgId, id, relevance, actorId, note, { req });
        await _evidence(orgId, id, 'framework_relevance_changed', actorId, { relevance, note });
        _invalidateCounts(orgId);
        calendar.invalidate(orgId);
        res.json({ framework: await _buildOne(orgId, id, req) });
    } catch (e) {
        if (_sendPolicyError(res, e)) return;
        log.error('[Compliance] framework relevance error:', e);
        next(e);
    }
});

module.exports = router;
module.exports.serialize = serialize;
module.exports.RECENTLY_IN_FORCE_DAYS = RECENTLY_IN_FORCE_DAYS;
