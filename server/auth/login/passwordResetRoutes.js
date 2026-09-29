// @typecheck
/**
 * Login Routes — self-service password reset: the emailed one-time link and
 * the token-checked new-password write. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { validatePasswordAsync } = require('../passwordPolicy');
const loginThrottle = require('../loginThrottle');
const {
    forgotPasswordIpLimiter, resetPasswordIpLimiter, forgotPasswordTargetLimiter,
} = require('../authRateLimits');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const EMAIL_TEXT = 'Enter the e-mail address of the account you want to reset.';
// The constant-200 contract below is unchanged: this only refuses a request
// that names NO address, which used to be answered "success" while no mail was
// ever attempted — a typo of the key `email` left the user waiting on an
// e-mail nothing had been asked to send. The address FORMAT is deliberately
// not checked: whether a given string could be an account here is exactly the
// question this endpoint refuses to answer.
const ForgotBody = z.object({
    email: worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT).max(254, EMAIL_TEXT),
}).strict();

const TOKEN_TEXT = 'This reset link is invalid or has expired. Request a new one.';
const NEW_PASSWORD_TEXT = 'Choose a new password.';
const ResetBody = z.object({
    token: worded(TOKEN_TEXT).min(1, TOKEN_TEXT).max(512, TOKEN_TEXT),
    newPassword: worded(NEW_PASSWORD_TEXT).min(1, NEW_PASSWORD_TEXT),
}).strict();

// ── Self-service password reset ──────────────────────────────────────────
// Request a reset link. Always responds 200 (never reveals whether an email
// exists). The raw token only ever appears in the emailed link; the DB stores
// SHA-256(token) with a 1-hour expiry.
router.post('/forgot-password', forgotPasswordIpLimiter, forgotPasswordTargetLimiter, validate({ body: ForgotBody }), async (req, res) => {
    const respond = () => res.json({ success: true });
    try {
        const { email } = req.body;
        // Breadth: the per-address cap stops one mailbox being flooded, but says
        // nothing about one source walking a list of addresses. Applied before
        // any lookup and to every request alike, so it stays outside the
        // constant-response contract this endpoint depends on.
        const fan = await loginThrottle.recordFanOut(req, 'forgot', email);
        if (fan.delayMs > 0) await loginThrottle.sleep(fan.delayMs);

        const user = await userStore.getUserByEmail(email);
        // Only password accounts can reset (skip OAuth-only / SSO accounts and
        // accounts without an email on file).
        if (!user || !user.email || !user.passwordHash) return respond();

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await userStore.updateUser(user.id, {
            passwordResetTokenHash: tokenHash,
            passwordResetExpiresAt: expires,
        });

        const appPaths = require('../../utils/appPaths');
        // Point at the SPA login route, which reads `?reset=<token>` and shows the
        // "set new password" form (LoginPage.jsx). `/?reset=` lands on the marketing
        // homepage, which ignores the param, so recovery silently dead-ends (BFSF-239).
        //
        // Built through appPaths like the verification and invite redirects,
        // not by hand: this link sits in mailboxes for an hour at a time, and
        // the hand-rolled version was the one /login shape appPaths.test.js
        // could not freeze. Output is byte-identical to what it replaces.
        const resetUrl = `${appPaths.clientHost()}${appPaths.legacyLoginPath(`reset=${token}`)}`;
        const { sendPasswordResetEmail } = require('../../utils/emailService');
        sendPasswordResetEmail({ email: user.email, displayName: user.displayName, resetUrl })
            .catch(e => log.warn('[Auth] reset email failed:', e.message));
        return respond();
    } catch (err) {
        log.error('[Auth] forgot-password error:', err.message);
        return respond();
    }
});

// Complete a reset with a valid token + a new password.
router.post('/reset-password', resetPasswordIpLimiter, validate({ body: ResetBody }), async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const user = await userStore.getUserByPasswordResetToken(tokenHash);
        if (!user || !user.password_reset_expires_at || new Date(user.password_reset_expires_at).getTime() < Date.now()) {
            return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
        }
        // Policy is applied AFTER the token is validated, so an anonymous caller
        // cannot use this endpoint as a free oracle for what the password rules
        // are — and, more usefully, so the rules can be applied with the account's
        // own username and role in hand.
        const policy = await validatePasswordAsync(newPassword, {
            username: user.username || user.id,
            email: user.email,
            role: user.role,
            orgRole: user.orgRole || user.org_role,
        });
        if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await userStore.updateUser(user.id, {
            passwordHash,
            passwordResetTokenHash: null,
            passwordResetExpiresAt: null,
            passwordResetRequired: 0,
        });
        // A completed reset proves the mailbox owner is back, so lift any
        // lockout the failed attempts that led them here had accumulated —
        // otherwise the recovery path dead-ends in a 429.
        try {
            await loginThrottle.clearIdentifier(user.id);
            if (user.username) await loginThrottle.clearIdentifier(user.username);
            if (user.email) await loginThrottle.clearIdentifier(user.email);
        } catch (_) { /* best-effort */ }
        log.info(`[Auth] Password reset completed for user ${user.id}`);
        return res.json({ success: true });
    } catch (err) {
        log.error('[Auth] reset-password error:', err.message);
        return res.status(500).json({ error: 'Failed to reset password' });
    }
});

module.exports = router;
