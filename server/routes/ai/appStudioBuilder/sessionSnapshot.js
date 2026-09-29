/**
 * App Studio Builder — the persisted builder-session snapshot the client
 * rehydrates from on mount (GET /session/:appId).
 *
 * Written at the end of every turn by ./turnClosing.js: {sessionId, appId,
 * messages, lastValidation, summary, lastTier, todos, brief} plus the
 * plan-first keys (approvedPlan / pendingPlan / continueToken) until the
 * build finalizes. The store trims the HEAD in whole blocks so the prefix the
 * model saw survives between evictions.
 *
 * There is one snapshot per app and this route returns it whole, so it reads
 * nothing from the query: a `?version=` or `?since=` that looks like it asks
 * for an older or a partial one is refused by name, not answered with the
 * latest.
 */

const express = require('express');
const router = express.Router();

const studioAppStore = require('../../../stores/studioAppStore');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');

const NoQuery = z.object({}).strict();

// GET the persisted builder-session snapshot for an app. Used by the client
// on mount to rehydrate chat history + validation state after a refresh or
// SSE drop. Owner-scoped inside getBuilderSession (non-owners get null).
router.get('/session/:appId', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const snapshot = await studioAppStore.getBuilderSession(req.params.appId, userId);
    if (!snapshot) return res.status(404).json({ error: 'No builder session for this app' });
    res.json({ snapshot });
});

module.exports = router;
