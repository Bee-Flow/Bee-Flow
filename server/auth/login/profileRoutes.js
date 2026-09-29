// @typecheck
/**
 * Login Routes — the two session-mutating endpoints on one's own account:
 * profile update (avatar, display name) and logout. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth } = require('../permissions');
const { HttpError } = require('../../core/http/errors');
const { sanitizePlainText } = require('../../utils/htmlSanitizer');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/**
 * An enum whose every refusal is a sentence. `invalid_type_error` alone is not
 * enough: zod reports a string that is not a member as `invalid_enum_value`,
 * whose default message quotes the whole option list back at the caller.
 */
const wordedEnum = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

const NAME_TEXT = 'A display name must be text.';
// `avatar` carries either an emoji or a data: URL, so it is bounded but not
// shaped; `null` is how the picker clears it. The TYPE is closed, because the
// renderer branches on it and an unrecognised value silently draws the default
// icon — which is what a mis-typed 'emojii' used to do, with a 200 over it.
// '' is kept: it is what the mobile client sends for "no type".
const ProfileBody = z.object({
    avatar: worded('An avatar must be text.').max(2_000_000, 'That avatar image is too large.').nullable().optional(),
    avatarType: wordedEnum(['emoji', 'url', 'image', ''], 'An avatar is an emoji, a url or an image.')
        .nullable().optional(),
    displayName: worded(NAME_TEXT).trim().min(1, 'A display name cannot be blank.').max(200, 'A display name is at most 200 characters.').optional(),
}).strict();

// Update current user's profile (avatar, displayName)
router.post('/update-profile', requireAuth, validate({ body: ProfileBody }), async (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { avatar, avatarType, displayName } = req.body;
    const updates = {};
    if (avatar !== undefined) updates.avatar = avatar;
    if (avatarType !== undefined) updates.avatarType = avatarType;
    // Self-writable, and it lands in the invitation email's "<inviter> has
    // invited you" line — an HTML document sent to someone else. Strip markup
    // here rather than trusting every future render path. A name that is
    // NOTHING BUT markup sanitises away to nothing; saying so beats answering
    // "saved" to someone whose name did not change.
    if (displayName !== undefined) {
        const clean = sanitizePlainText(displayName, { maxLen: 200 });
        if (!clean) {
            throw new HttpError(400, 'invalid_request', 'That display name is empty once markup is removed.');
        }
        updates.displayName = clean;
    }

    try {
        const ok = await userStore.updateUser(userId, updates);
        if (!ok) return res.status(500).json({ error: 'Failed to update profile' });

        // Reflect changes in session
        if (updates.avatar !== undefined) req.session.user.avatar = updates.avatar;
        if (updates.avatarType !== undefined) req.session.user.avatarType = updates.avatarType;
        if (updates.displayName !== undefined) req.session.user.displayName = updates.displayName;

        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true });
        });
    } catch (err) {
        log.error('[Auth] update-profile failed:', err.message);
        res.status(500).json({ error: 'Update failed' });
    }
});

// Logout
router.post('/logout', async (req, res) => {
    // Destroying the session is not enough for a client that authenticates by
    // header. A bridge token is a bearer standing on its own in Redis: it
    // survives session.destroy(), nothing else in the system invalidates one,
    // and a native client now holds one for thirty days. So "sign out" has to
    // mean the token too — otherwise the phone in someone else's hand is still
    // signed in after the owner signed out on it.
    //
    // Best-effort on purpose: a Redis blip must not turn a logout into a 500,
    // because the user's next move would be to try again and they would still
    // be signed in.
    const presented = req.headers['x-session-token'];
    if (presented) {
        try {
            await require('../../utils/sessionToken').deleteSessionToken(presented);
        } catch (err) {
            log.error('[Auth] Failed to revoke bridge token on logout:', err.message);
        }
    }

    req.session.destroy((err) => {
        if (err) log.error('Logout error:', err);
        res.json({ success: true });
    });
});

module.exports = router;
