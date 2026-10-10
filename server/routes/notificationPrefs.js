/**
 * Notification preference routes — what I am told about, per channel.
 *
 * GET /api/me/notification-prefs  → { bell: {event: bool}, email: {event: bool} }
 * PUT /api/me/notification-prefs  → change some of them; answers the merged result
 *
 * Both closed objects: an unknown channel or event is a 400 before the store.
 */

const express = require('express');
const router = express.Router();
const notificationPrefsStore = require('../stores/notificationPrefsStore');
const { validate } = require('../core/http/validate');
const { z, closedObject, bodyOf } = require('../core/http/schemaParts');

const EVENT_TEXT = 'Each event is true or false.';
const perEvent = (subject) => closedObject(
    Object.fromEntries(notificationPrefsStore.EVENTS.map((e) => [e, z.boolean({ invalid_type_error: EVENT_TEXT }).optional()])),
    subject,
).optional();

const PrefsBody = bodyOf({
    bell: perEvent('The bell preferences'),
    email: perEvent('The e-mail preferences'),
}, 'Notification preferences');

function requireUser(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return next();
}

router.get('/', requireUser, async (req, res) => {
    res.json(await notificationPrefsStore.getPrefs(req.session.user.id));
});

router.put('/', requireUser, validate({ body: PrefsBody }), async (req, res) => {
    const userId = req.session.user.id;
    await notificationPrefsStore.setPrefs(userId, { bell: req.body.bell, email: req.body.email });
    res.json(await notificationPrefsStore.getPrefs(userId));
});

module.exports = router;
