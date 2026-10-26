// @typecheck strict
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
const { z, closedObject, bodyOf, typeError } = require('../core/http/schemaParts');
const { sessionUser } = require('../core/http/sessionUser');

const EVENT_TEXT = 'Each event is true or false.';
/**
 * @param {string} subject
 */
const perEvent = (subject) => closedObject(
    Object.fromEntries(notificationPrefsStore.EVENTS.map((e) => [e, z.boolean({ error: typeError({ invalid: EVENT_TEXT }) }).optional()])),
    subject,
).optional();

const PrefsBody = bodyOf({
    bell: perEvent('The bell preferences'),
    email: perEvent('The e-mail preferences'),
}, 'Notification preferences');

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requireUser(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    return next();
}

router.get('/', requireUser, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    res.json(await notificationPrefsStore.getPrefs(sessionUser(req).id));
});

router.put('/', requireUser, validate({ body: PrefsBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const userId = sessionUser(req).id;
    await notificationPrefsStore.setPrefs(userId, { bell: req.body.bell, email: req.body.email });
    res.json(await notificationPrefsStore.getPrefs(userId));
});

module.exports = router;
