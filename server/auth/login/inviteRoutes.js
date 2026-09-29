// @typecheck
/**
 * Login Routes — invitation tokens on the public side: validation, the
 * path-style redeem landing that hides the token from the URL, and the
 * read of the stashed token. Split out of auth/loginRoutes.js.
 *
 * No request schema: no route here reads a body or a query. The token is a
 * path segment that is only ever looked up, and `/redeem-invite/:token` is an
 * e-mail link the browser navigates to — a 400 there would be a dead end with
 * nothing to show, where an unknown token already lands on the login page
 * with `error=invite_expired`.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');

// ═══════════════════════════════════════════════════════════
// ── Invitation Token Validation (public route) ────────────
// ═══════════════════════════════════════════════════════════
router.get('/invite/:token', async (req, res) => {
    try {
        const invitationStore = require('../../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(req.params.token);
        if (!invitation) {
            return res.status(410).json({ valid: false, error: 'Invitation expired or invalid' });
        }
        const org = await userStore.getOrganization(invitation.organization_id);
        res.json({
            valid: true,
            email: invitation.email,
            organizationId: invitation.organization_id,
            orgName: org?.name || '',
            orgLogo: org?.logo || null,
            role: invitation.role,
        });
    } catch (err) {
        log.error('[Invite] Token validation error:', err);
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

// Invitation landing handler. The email link is `/auth/redeem-invite/<token>`
// (path-style — the token is on the URL path, not in a query string). This
// endpoint validates the token, stashes it in the session, and 302-redirects
// to the SPA login route WITHOUT the token in the URL. That keeps the token
// out of the browser address bar, the Referer header, and reverse-proxy
// access logs after the redirect fires.
router.get('/redeem-invite/:token', async (req, res) => {
    const token = req.params.token;
    const appPaths = require('../../utils/appPaths');
    const clientHost = appPaths.clientHost();
    try {
        const invitationStore = require('../../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(token);
        if (!invitation) {
            return res.redirect(`${clientHost}${appPaths.legacyLoginPath('error=invite_expired')}`);
        }
        // Persist on the session — the SPA picks it up via GET /auth/pending-invite.
        req.session.pendingInviteToken = token;
        req.session.save(() => res.redirect(`${clientHost}${appPaths.legacyLoginPath('signup=1')}`));
    } catch (err) {
        log.error('[Invite] Redeem error:', err);
        res.redirect(`${clientHost}${appPaths.legacyLoginPath('error=invite_error')}`);
    }
});

// Read the invite token previously stashed by /redeem-invite. Returns the
// resolved invitation payload (same shape as /invite/:token) plus the
// underlying token so the signup flow can submit it. Reading does NOT clear
// it — LoginPage reads it on every mount, and a refresh of the signup form
// must not lose the invitation. The entry goes when it stops resolving (the
// invitation was accepted, revoked or expired: see below), when login
// regenerates the session (establishSession), or on POST /pending-invite/clear.
router.get('/pending-invite', async (req, res) => {
    try {
        const token = req.session?.pendingInviteToken;
        if (!token) return res.json({ valid: false });
        const invitationStore = require('../../stores/invitationStore');
        const invitation = await invitationStore.getInvitationByToken(token);
        if (!invitation) {
            delete req.session.pendingInviteToken;
            return res.json({ valid: false, error: 'Invitation expired or invalid' });
        }
        const org = await userStore.getOrganization(invitation.organization_id);
        res.json({
            valid: true,
            token,
            email: invitation.email,
            organizationId: invitation.organization_id,
            orgName: org?.name || '',
            orgLogo: org?.logo || null,
            role: invitation.role,
        });
    } catch (err) {
        log.error('[Invite] pending-invite error:', err);
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

router.post('/pending-invite/clear', async (req, res) => {
    if (req.session?.pendingInviteToken) delete req.session.pendingInviteToken;
    req.session.save(() => res.json({ ok: true }));
});

module.exports = router;
