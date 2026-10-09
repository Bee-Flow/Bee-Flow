/**
 * Automation Builder — the persisted builder-session snapshot the client
 * rehydrates from on mount (GET /session/:automationId).
 *
 * Shape (written by chatStream.js at the end of every turn, trimmed by
 * stores/automationStore/builderSessions.js): {sessionId, version, draft,
 * lastValidation, summary, conversation, todos, catalogOrder, updatedAt,
 * reviewPlan, reviewQuestions, questionsMeta, proposal}. `questionsMeta` is
 * { round, planId, mode } | null: the question round of the current plan cycle
 * (round 1 = the card was shown; the next plan turn must write the plan) and
 * the approved plan a card asked during a build paused (planId).
 * `conversation` is user/assistant text with the latest assistant entry's
 * toolCalls; it is unsliced, and the store trims its HEAD in blocks that match
 * the prompt window so a rehydrated client re-sends a history the server's
 * prompt-prefix cache still recognises. `catalogOrder` is server-internal: the
 * app order this session's system prompt is rendered in.
 *
 * There is one snapshot per automation and this route returns it whole, so it
 * reads nothing from the query: a `?version=` or `?since=` that looks like it
 * asks for an older or a partial one is refused by name, not answered with the
 * latest.
 */

const express = require('express');
const router = express.Router();

const automationStore = require('../../../stores/automationStore');
const { requireAuth, requireActiveOrgForMutations } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');
const { applyPendingDatatables, keptDatatables } = require('./applyPendingDatatables');
const { clientSnapshot } = require('./datatableTurn');

const NoQuery = z.object({}).strict();

// GET the persisted builder-session snapshot for an automation. Used by
// the client on mount to rehydrate chat history + draft + last validation
// after a refresh or SSE drop. Mirror to the SSE `resume` event payload.
router.get('/session/:automationId', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const snapshot = await automationStore.getBuilderSession(req.params.automationId, userId);
    if (!snapshot) return res.status(404).json({ error: 'No builder session for this automation' });
    res.json({ snapshot: clientSnapshot(snapshot) });
});

// Review actions clear the saved proposal/plan and record what the user did
// with it, so the agent's next turn is told (workMode.reviewStatusNote) instead
// of guessing whether its staged changes went live (BFSF-486). Applying a
// definition still goes through the ordinary automation editor's save and
// validation. `applyProposal` records that the user pressed Apply; when the
// proposal also creates tables (pendingDatatables) it is where they are made
// and the staged ids are swapped for the real ones (applyPendingDatatables),
// and the response carries the definition the client then saves.
//
// Response contract the client reads:
//   applyProposal -> { ok, outcome:'applied', definition: object|null, createdDatatables: [{ref,id,key,name}] }
//   discardProposal -> { ok, outcome:'discarded', keptDatatables: [{id,name}] }
//   rejectPlan -> { ok, outcome:'rejected' }
const REVIEW_OUTCOMES = {
    applyProposal: { key: 'proposal', kind: 'proposal', status: 'applied' },
    discardProposal: { key: 'proposal', kind: 'proposal', status: 'discarded' },
    rejectPlan: { key: 'reviewPlan', kind: 'plan', status: 'rejected' },
};
router.post('/session/:automationId/review', requireAuth, requireActiveOrgForMutations(), validate({ query: NoQuery, body: z.object({
    action: z.enum(Object.keys(REVIEW_OUTCOMES)),
    revisionId: z.string().min(1).max(200),
}).strict() }), async (req, res, next) => {
    try {
        const userId = req.session.user.id;
        const snapshot = await automationStore.getBuilderSession(req.params.automationId, userId);
        if (!snapshot) return res.status(404).json({ error: 'No builder session for this automation' });
        const { key, kind, status } = REVIEW_OUTCOMES[req.body.action];
        if (snapshot[key]?.id !== req.body.revisionId) return res.status(409).json({ error: 'The review has changed. Reload the latest revision.' });
        if (req.body.action === 'applyProposal' && snapshot.proposal?.pendingDatatables?.length) {
            return res.json(await applyPendingDatatables({ req, automationId: req.params.automationId, userId, snapshot }, { automationStore }));
        }
        const reviewOutcome = { kind, id: req.body.revisionId, status, at: new Date().toISOString() };
        // Tables an earlier failed Apply had already made stay (never deleted)
        // and count as chosen, so the next turn may bind to them.
        const kept = req.body.action === 'discardProposal' ? keptDatatables(snapshot.proposal) : [];
        const next = { ...snapshot, [key]: null, reviewOutcome };
        if (kept.length) next.approvedDatatableIds = [...new Set([...(snapshot.approvedDatatableIds || []), ...kept.map((t) => t.id)])].slice(-200);
        const result = await automationStore.setBuilderSession(req.params.automationId, userId, next, { expectedVersion: snapshot.version });
        if (!result.ok) return res.status(409).json({ error: 'The builder session changed. Reload the latest revision.' });
        res.json({
            ok: true, outcome: status,
            ...(req.body.action === 'applyProposal' ? { definition: null, createdDatatables: [] } : {}),
            ...(req.body.action === 'discardProposal' ? { keptDatatables: kept } : {}),
        });
    } catch (e) { next(e); }
});

module.exports = router;
