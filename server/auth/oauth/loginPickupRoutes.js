// @typecheck
/**
 * OAuth pickup claim — the one-time session-token handoff for embedded
 * iframes that cannot see the popup's session cookie.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const ID_TEXT = 'invalid id';
const PickupQuery = z.object({
    id: z.string({ required_error: ID_TEXT, invalid_type_error: ID_TEXT }).min(1, ID_TEXT).max(128, ID_TEXT),
}).strict();

// Pickup claim — used by embedded iframes that can't see the popup's session
// cookie (Chrome storage partitioning). The popup deposits a session token
// under a random pickup id (see callback below); the iframe polls this
// endpoint until the token is available, then sends it as X-Session-Token on
// every subsequent request. One-time read.
router.get('/login-pickup', validate({ query: PickupQuery }), async (req, res) => {
    const { id } = req.query;
    const { claimPickup } = require('../../utils/sessionToken');
    const data = await claimPickup(id);
    if (!data) {
        // A miss is normally just "the callback has not finished yet", and
        // the client polls through it. But it is ALSO what a cross-replica
        // split looks like: without Redis both stores fall back to a
        // per-process Map (utils/sessionToken.js), so a pickup deposited by
        // the callback on one pod is invisible to a claim that lands on
        // another — and today that failure leaves no server-side evidence
        // at all, which is exactly why it is unreproducible. Say which
        // store answered.
        const { getRedis } = require('../../db');
        log.info(`[OAuth/login-pickup] ${id} pending (store: ${getRedis() ? 'redis' : 'in-memory'})`);
        return res.status(404).json({ pending: true });
    }
    return res.json({ sessionToken: data.sessionToken });
});

module.exports = router;
