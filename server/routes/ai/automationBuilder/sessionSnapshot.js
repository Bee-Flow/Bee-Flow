/**
 * Automation Builder — the persisted builder-session snapshot the client
 * rehydrates from on mount (GET /session/:automationId).
 *
 * Shape (written by chatStream.js at the end of every turn, trimmed by
 * stores/automationStore/builderSessions.js): {sessionId, version, draft,
 * lastValidation, summary, conversation, todos, catalogOrder, updatedAt}.
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
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');

const NoQuery = z.object({}).strict();

// GET the persisted builder-session snapshot for an automation. Used by
// the client on mount to rehydrate chat history + draft + last validation
// after a refresh or SSE drop. Mirror to the SSE `resume` event payload.
router.get('/session/:automationId', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const snapshot = await automationStore.getBuilderSession(req.params.automationId, userId);
    if (!snapshot) return res.status(404).json({ error: 'No builder session for this automation' });
    res.json({ snapshot });
});

// Review actions only clear the saved proposal/plan. Applying a definition
// still goes through the ordinary automation editor's save and validation.
router.post('/session/:automationId/review', requireAuth, validate({ query: NoQuery, body: z.object({
    action: z.enum(['discardProposal', 'rejectPlan']),
    revisionId: z.string().min(1).max(200),
}).strict() }), async (req, res, next) => {
    try {
        const userId = req.session.user.id;
        const snapshot = await automationStore.getBuilderSession(req.params.automationId, userId);
        if (!snapshot) return res.status(404).json({ error: 'No builder session for this automation' });
        const key = req.body.action === 'rejectPlan' ? 'reviewPlan' : 'proposal';
        if (snapshot[key]?.id !== req.body.revisionId) return res.status(409).json({ error: 'The review has changed. Reload the latest revision.' });
        const result = await automationStore.setBuilderSession(req.params.automationId, userId, { ...snapshot, [key]: null }, { expectedVersion: snapshot.version });
        if (!result.ok) return res.status(409).json({ error: 'The builder session changed. Reload the latest revision.' });
        res.json({ ok: true });
    } catch (e) { next(e); }
});

module.exports = router;
