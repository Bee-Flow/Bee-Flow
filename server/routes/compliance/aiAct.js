/**
 * Compliance — EU AI Act classification register.
 *
 *   GET /ai-act/assessments                 newest attestation per target (+ title)
 *   GET /ai-act/assessments/:kind/:id       stored snapshot + history (404 outside the org)
 *   GET /ai-act/assessments/:kind/:id/signals   signals recomputed live
 *   PUT /ai-act/assessments/:kind/:id       { answers } → new row, evidence, event
 *
 * kind ∈ {automation, agent}. Org membership is checked per kind before any
 * read or write: agents on agents.organization_id, automations through the
 * COALESCE(a.organization_id, u."organizationId") join forms.js uses (both
 * live in compliance/aiAct/signals.js so the route and the checks agree).
 *
 * The org is resolved STRICTLY: an account without an organisation gets a 403,
 * never the 'default' bucket (that would let it attest another org's automations).
 *
 * The evidence row is built from an explicit allow-list — target kind/id,
 * outcome, actor id, attested_at. No prompts, no answers, no titles, no names
 * (BFSF-441): the register row itself holds the answers; the chain only proves
 * that an attestation happened. The writing lives in compliance/aiAct/attest.js,
 * shared with the automation's own AI Act check (routes/automation/aiAct.js,
 * the automation's owner and editors), so both places record the same thing.
 */

const express = require('express');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ────────────────────────────────────
//
// `AssessmentBody` is `.strict()` around one deliberately open field. The
// questionnaire lives in `answers` and grows with the ladder, so that object
// stays open and `assess.assess` owns its vocabulary — but the key itself was
// the trap: `answer` instead of `answers` was dropped, `assess` then ran on an
// empty questionnaire, and the outcome it computed from the live signals alone
// was attested, written to the evidence chain and answered 200 as if the
// admin's answers had been recorded.
const log = require('../../telemetry/log');
const router = express.Router();

const aiActAssessmentStore = require('../../stores/aiActAssessmentStore');
const signals = require('../../compliance/aiAct/signals');
const assess = require('../../compliance/aiAct/assess');
const { attest } = require('../../compliance/aiAct/attest');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { requireOrgId } = require('./shared');

const guard = [requireAuth, requirePermission('admin_compliance')];

const KINDS = new Set(['automation', 'agent']);
const ID_RE = /^[A-Za-z0-9._:@-]{1,160}$/;

function _target(req, res) {
    const kind = String(req.params.kind || '');
    const id = String(req.params.id || '');
    if (!KINDS.has(kind)) { res.status(400).json({ error: 'invalid_kind', allowed: [...KINDS] }); return null; }
    if (!ID_RE.test(id)) { res.status(400).json({ error: 'invalid_target_id' }); return null; }
    return { kind, id };
}

/** The org-scoped row for the target, or null. Titles only. */
async function _loadTarget(orgId, kind, id) {
    return kind === 'agent' ? signals.loadAgent(orgId, id) : signals.loadAutomation(orgId, id);
}

async function _liveSignals(orgId, kind, id) {
    return kind === 'agent' ? signals.signalsForAgent(orgId, id) : signals.signalsForAutomation(orgId, id);
}

function _titleOf(kind, row) {
    if (!row) return null;
    return kind === 'agent' ? (row.name || null) : (row.title || null);
}

function _publicRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        target_kind: row.target_kind,
        target_id: row.target_id,
        signals: row.signals || {},
        answers: row.answers || {},
        outcome: row.outcome,
        attested_by: row.attested_by || null,
        attested_at: row.attested_at,
        expires_at: row.expires_at || null,
        current: aiActAssessmentStore.isCurrent(row),
    };
}

/** The questionnaire is `assess`'s own vocabulary; the key around it is not. */
const AssessmentBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    answers: z.record(z.unknown(), { invalid_type_error: 'answers is a JSON object.' }).optional(),
}).strict());

router.get('/ai-act/assessments', ...guard, async (req, res) => {
    try {
        const orgId = await requireOrgId(req, res);
        if (!orgId) return;
        const rows = await aiActAssessmentStore.listForOrg(orgId);
        const titles = await signals.titlesFor(orgId, rows);
        res.json(rows.map(r => ({
            target_kind: r.target_kind,
            target_id: r.target_id,
            title: (titles[r.target_kind] || {})[String(r.target_id)] ?? null,
            outcome: r.outcome,
            attested_by: r.attested_by || null,
            attested_at: r.attested_at,
            expires_at: r.expires_at || null,
            current: aiActAssessmentStore.isCurrent(r),
        })));
    } catch (e) {
        log.error('[compliance/aiAct] list failed:', e.message);
        res.status(500).json({ error: 'Failed to list AI Act assessments' });
    }
});

router.get('/ai-act/assessments/:kind/:id/signals', ...guard, async (req, res) => {
    try {
        const orgId = await requireOrgId(req, res);
        if (!orgId) return;
        const t = _target(req, res);
        if (!t) return;
        const live = await _liveSignals(orgId, t.kind, t.id);
        if (!live) return res.status(404).json({ error: 'target_not_found' });
        res.json(live);
    } catch (e) {
        log.error('[compliance/aiAct] signals failed:', e.message);
        res.status(500).json({ error: 'Failed to compute AI Act signals' });
    }
});

router.get('/ai-act/assessments/:kind/:id', ...guard, async (req, res) => {
    try {
        const orgId = await requireOrgId(req, res);
        if (!orgId) return;
        const t = _target(req, res);
        if (!t) return;
        const target = await _loadTarget(orgId, t.kind, t.id);
        if (!target) return res.status(404).json({ error: 'target_not_found' });
        const latest = await aiActAssessmentStore.getLatest(orgId, t.kind, t.id);
        const history = await aiActAssessmentStore.listHistory(orgId, t.kind, t.id, { limit: 20 });
        if (!latest) {
            // Never assessed: hand the drawer the live signals so the questionnaire
            // opens pre-filled; outcome stays null until the admin attests.
            const live = await _liveSignals(orgId, t.kind, t.id);
            return res.json({
                target_kind: t.kind, target_id: t.id, title: _titleOf(t.kind, target),
                signals: live || {}, answers: null, outcome: null,
                attested_by: null, attested_at: null, expires_at: null, current: false,
                open_duties: assess.openDuties(live || {}, {}),
                history: [],
            });
        }
        const row = _publicRow(latest);
        res.json({
            ...row,
            title: _titleOf(t.kind, target),
            open_duties: assess.openDuties(row.signals, row.answers),
            history: history.map(_publicRow),
        });
    } catch (e) {
        log.error('[compliance/aiAct] detail failed:', e.message);
        res.status(500).json({ error: 'Failed to load AI Act assessment' });
    }
});

router.put('/ai-act/assessments/:kind/:id', ...guard, validate({ body: AssessmentBody }), async (req, res) => {
    try {
        const orgId = await requireOrgId(req, res);
        if (!orgId) return;
        const t = _target(req, res);
        if (!t) return;
        const body = req.body;
        const target = await _loadTarget(orgId, t.kind, t.id);
        if (!target) return res.status(404).json({ error: 'target_not_found' });

        const live = await _liveSignals(orgId, t.kind, t.id);
        const actorId = req.session?.user?.id || null;
        const { row, result } = await attest({
            orgId, kind: t.kind, id: t.id, signals: live || {}, answers: body.answers || {}, actorId,
        });

        res.json({ ...(_publicRow(row) || {}), title: _titleOf(t.kind, target), open_duties: result.open_duties });
    } catch (e) {
        log.error('[compliance/aiAct] attest failed:', e.message);
        res.status(500).json({ error: 'Failed to record AI Act assessment' });
    }
});

module.exports = router;
