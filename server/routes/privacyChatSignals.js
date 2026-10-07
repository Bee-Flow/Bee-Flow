/**
 * The caller's own "Don't count my chat turns" preference (GDPR Art. 21).
 *
 *   GET /api/privacy/chat-signals/preference   → { counted: boolean }
 *   PUT /api/privacy/chat-signals/preference   { counted: boolean } → { counted }
 *
 * Chat signals count, per organisation, what the Privacy Shield already
 * decided on chat messages (core/privacy/chatSignals.js). A signed-in person
 * can object to their own turns being counted; the recorder honours it inside
 * the request (stores/chatSignalObjectionStore.isObjecting), before anything
 * is counted.
 *
 * Self-scoped, and only that: no user id in the path, the query, the body or
 * the response, so the route can never be pointed at somebody else. There is
 * deliberately NO admin equivalent, list or count anywhere: whether a person
 * objected is never visible to an admin (amendment 12). Mounted at
 * /api/privacy/chat-signals (server/index.js) beside the shield status;
 * declared in auth/accessRegistry.js.
 */

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { validate } = require('../core/http/validate');
// requireAuth is the canonical gate from auth/permissions (verifies the user
// still exists in the DB, cached 5 s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');
const objections = require('../stores/chatSignalObjectionStore');

const NO_QUERY = z.object({}).strict('Your chat-signals preference is always your own; it takes no query parameters.');
const COUNTED_TEXT = 'counted is true or false.';
const PreferenceBody = z.object({
    counted: z.boolean({ required_error: COUNTED_TEXT, invalid_type_error: COUNTED_TEXT }),
}, { invalid_type_error: 'The preference is { counted: true|false }.' }).strict('The preference is { counted: true|false }; it takes no other keys.');

// GET /preference: are the caller's chat turns counted? A read error reads as
// "not counted" (the store's rule: when in doubt, do not count).
router.get('/preference', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    const objecting = await objections.isObjecting(req.session.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ counted: !objecting });
});

// PUT /preference: object (counted:false) or withdraw the objection
// (counted:true). A failed write throws: the terminal handler answers with a
// correlation id, and the switch in the chat says it did not save.
router.put('/preference', requireAuth, validate({ query: NO_QUERY, body: PreferenceBody }), async (req, res) => {
    const { counted } = req.body;
    await objections.setObjecting(req.session.user.id, !counted);
    res.set('Cache-Control', 'no-store');
    res.json({ counted });
});

module.exports = router;
