/**
 * Swarms — discovery + (later) custom-swarm CRUD.
 *
 * v1 surface:
 *   GET /api/ai/swarms/available — list swarms the caller may use.
 *
 * v3 will add:
 *   POST   /api/ai/swarms/custom        — create a custom swarm
 *   PUT    /api/ai/swarms/custom/:id    — update
 *   DELETE /api/ai/swarms/custom/:id    — delete
 *
 * The whole router is mounted behind `requireBetaFeature('swarm')` in
 * routes/ai.js so unauthorised users see neither the endpoints nor the
 * sidebar section that consumes them.
 *
 * /available reads nothing from the query: the list is the built-in swarms,
 * the same for everyone who gets past the gate. A `?kind=` or `?q=` that looks
 * like it filters is refused by name rather than answered with all of them.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { listAvailableSwarms } = require('../../core/swarms/swarmRuntime');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const NoQuery = z.object({}).strict();

router.get('/available', requireAuth, validate({ query: NoQuery }), (req, res) => {
    try {
        const swarms = listAvailableSwarms();
        return res.json({ swarms });
    } catch (e) {
        log.error('[Swarms] available list failed:', e);
        return res.status(500).json({ error: 'Failed to list available swarms' });
    }
});

module.exports = router;
