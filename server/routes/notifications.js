/**
 * Notification Routes — REST API for in-app notifications.
 *
 * GET    /                → list notifications
 * GET    /unread-count    → badge count
 * POST   /:id/read        → mark one as read
 * POST   /read-all        → mark all as read
 * DELETE /:id             → delete one
 */

const express = require('express');
const router = express.Router();
const notificationStore = require('../stores/notificationStore');
const { pool } = require('../db');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// The list read its two query parameters by exact match and parseInt, so
// neither could fail:
//
//   - `?unread=1` (or `yes`, or a misspelled `?unraed=true`) returned EVERY
//     notification, the read ones included, to a caller that asked for the
//     unread ones only;
//   - `?limit=-1` became `LIMIT -1`, which Postgres refuses: a 500;
//   - `?limit=abc` and `?limit=0` became 50, and `?limit=1e3` became 1.
//
// The two POSTs take no body. They ignored one, so `{ read: false }` on
// /:id/read marked the notification READ, and a filter on /read-all marked
// everything read.
//
// The session check is middleware now, in front of the schema: an anonymous
// caller still gets the same 401 before anything about its request is read.

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const NoBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, { invalid_type_error: 'This request takes no body.' }).strict(),
);

const UNREAD_TEXT = "unread is 'true' or 'false'.";
const LIMIT_TEXT = 'limit is a whole number of notifications, 1 or more.';
const ListQuery = z.object({
    unread: z.enum(['true', 'false', '1', '0'], { errorMap: () => ({ message: UNREAD_TEXT }) })
        .transform((v) => v === 'true' || v === '1')
        .optional(),
    limit: z.coerce.number({ invalid_type_error: LIMIT_TEXT })
        .int(LIMIT_TEXT).min(1, LIMIT_TEXT)
        .optional(),
}).strict();

function requireUser(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return next();
}

/**
 * Ownership predicate for the single-notification routes.
 *
 * This router is mounted bare — there is no app-level auth middleware in front
 * of it — so POST /:id/read and DELETE /:id used to mutate any user's row with
 * no session at all. The mutations themselves are now tenancy-scoped in the
 * store (`markRead(id, userId)` / `deleteNotification(id, userId)` require a
 * userId and always emit `AND user_id = $2`), which is what actually closes the
 * hole; this SELECT stays because it is what distinguishes "not yours / does
 * not exist" (404) from "yours, and now updated" (200). Keep both: if this
 * helper is ever removed, the scoped store call must keep its second argument.
 *
 * Not racy: `user_id` is written once at INSERT and never updated anywhere in
 * the codebase, and ids are crypto.randomUUID() so a deleted row's id is never
 * reused.
 */
async function ownsNotification(userId, id) {
    const { rowCount } = await pool.query(
        'SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2',
        [id, userId]
    );
    return rowCount > 0;
}

// GET / — list notifications
router.get('/', requireUser, validate({ query: ListQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const { unread: unreadOnly = false, limit = 50 } = req.query;
    const notifications = await notificationStore.getNotifications(userId, { unreadOnly, limit });
    res.json({ notifications });
});

// GET /unread-count — quick badge count
router.get('/unread-count', requireUser, async (req, res) => {
    const count = await notificationStore.getUnreadCount(req.session.user.id);
    res.json({ count });
});

// POST /read-all — mark all as read (must be before /:id/read to avoid route conflict)
router.post('/read-all', requireUser, validate({ body: NoBody }), async (req, res) => {
    const count = await notificationStore.markAllRead(req.session.user.id);
    res.json({ success: true, marked: count });
});

// POST /:id/read — mark one as read
router.post('/:id/read', requireUser, validate({ body: NoBody }), async (req, res) => {
    const userId = req.session.user.id;

    // 404 rather than 403 — a distinct "exists but isn't yours" answer would
    // turn this route into an id-existence oracle.
    if (!await ownsNotification(userId, req.params.id)) {
        return res.status(404).json({ error: 'Notification not found' });
    }

    const ok = await notificationStore.markRead(req.params.id, userId);
    res.json({ success: ok });
});

// DELETE /:id — delete one
router.delete('/:id', requireUser, async (req, res) => {
    const userId = req.session.user.id;

    if (!await ownsNotification(userId, req.params.id)) {
        return res.status(404).json({ error: 'Notification not found' });
    }

    const ok = await notificationStore.deleteNotification(req.params.id, userId);
    res.json({ success: ok });
});

module.exports = router;
