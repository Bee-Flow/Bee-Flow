// @typecheck
/**
 * Login Routes — email confirmation: the path-style verification link that
 * activates an account, and the throttled resend. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const loginThrottle = require('../loginThrottle');
const {
    resendVerificationIpLimiter, resendVerificationTargetLimiter,
} = require('../authRateLimits');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const EMAIL_TEXT = 'Enter the e-mail address you signed up with.';
// Same reasoning as /forgot-password: the constant-200 contract survives, and
// only a request naming no address at all is refused. Mis-spelling the key
// used to answer "success" without a mail ever being attempted.
const ResendBody = z.object({
    email: worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT).max(254, EMAIL_TEXT),
}).strict();

// ── Email verification ───────────────────────────────────────────────────
// Confirm an account's email via the emailed link. Path-style token + a
// 302-redirect that drops the token from the URL (same rationale as
// /redeem-invite): the raw token never lands in the SPA address bar, the
// Referer header, or proxy access logs. On success the account flips to
// 'active' and the welcome email is sent (once) in the user's locale.
router.get('/verify-email/:token', async (req, res) => {
    const appPaths = require('../../utils/appPaths');
    const clientHost = appPaths.clientHost();
    try {
        const raw = String(req.params.token || '');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        const user = await userStore.getUserByEmailVerificationToken(tokenHash);
        if (!user) {
            // No matching token. Could be already-consumed (one-shot) — but we
            // can't tell which user, so treat as invalid/expired.
            return res.redirect(`${clientHost}${appPaths.legacyLoginPath('error=verify_expired')}`);
        }
        // Already verified (double-click / token not yet cleared): idempotent success.
        if (user.status !== 'unverified') {
            return res.redirect(`${clientHost}${appPaths.legacyLoginPath('verified=1')}`);
        }
        if (!user.email_verification_expires_at || new Date(user.email_verification_expires_at).getTime() < Date.now()) {
            return res.redirect(`${clientHost}${appPaths.legacyLoginPath('error=verify_expired')}`);
        }

        await userStore.updateUser(user.id, {
            status: 'active',
            emailVerifiedAt: new Date().toISOString(),
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
        });
        log.info(`[Auth] Email verified for user ${user.id}`);
        try {
            await userStore.logAccessAudit('user.email_verified', 'user', user.id, user.id, null, { email: user.email }, user.organizationId || null);
        } catch (_) { /* best-effort */ }

        // Welcome email (once) — now that the account is active.
        if (user.email) {
            Promise.resolve().then(async () => {
                try {
                    const claimed = await userStore.claimNotification('user', user.id, 'welcome_email', user.email);
                    if (!claimed) return;
                    const orgName = user.organizationId ? (await userStore.getOrganization(user.organizationId))?.name : '';
                    const { sendWelcomeEmail } = require('../../utils/emailService');
                    await sendWelcomeEmail({ email: user.email, displayName: user.displayName, loginUrl: clientHost, orgName, locale: user.preferred_locale });
                } catch (e) { log.warn('[Auth] welcome email after verify failed:', e.message); }
            });
        }

        return res.redirect(`${clientHost}${appPaths.legacyLoginPath('verified=1')}`);
    } catch (err) {
        log.error('[Auth] verify-email error:', err.message);
        return res.redirect(`${clientHost}${appPaths.legacyLoginPath('error=verify_error')}`);
    }
});

// Resend a verification link. Always responds 200 (never reveals whether an
// account exists or its status). Throttled: refuses to regenerate if a token
// was issued in the last 60 seconds.
router.post('/resend-verification', resendVerificationIpLimiter, resendVerificationTargetLimiter, validate({ body: ResendBody }), async (req, res) => {
    const respond = () => res.json({ success: true });
    try {
        const { email } = req.body;
        // Same breadth control as /forgot-password — this endpoint also sends
        // mail to an address the caller names.
        const fan = await loginThrottle.recordFanOut(req, 'resend', email);
        if (fan.delayMs > 0) await loginThrottle.sleep(fan.delayMs);

        const user = await userStore.getUserByEmail(email);
        if (!user || user.status !== 'unverified' || !user.email || !user.passwordHash) return respond();

        // Throttle: if the current token is younger than 60s (24h TTL), skip.
        if (user.email_verification_expires_at) {
            const issuedAt = new Date(user.email_verification_expires_at).getTime() - 24 * 60 * 60 * 1000;
            if (Date.now() - issuedAt < 60 * 1000) return respond();
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await userStore.updateUser(user.id, {
            emailVerificationTokenHash: tokenHash,
            emailVerificationExpiresAt: expires,
        });

        const clientHost = require('../../utils/appPaths').clientHost();
        const verifyUrl = `${clientHost}/auth/verify-email/${token}`;
        const orgName = user.organizationId ? (await userStore.getOrganization(user.organizationId))?.name : '';
        const { sendVerificationEmail } = require('../../utils/emailService');
        sendVerificationEmail({ email: user.email, displayName: user.displayName, verifyUrl, orgName, locale: user.preferred_locale })
            .catch(e => log.warn('[Auth] resend verification email failed:', e.message));
        try {
            await userStore.logAccessAudit('user.verification_resent', 'user', user.id, user.id, null, { email: user.email }, user.organizationId || null);
        } catch (_) { /* best-effort */ }
        return respond();
    } catch (err) {
        log.error('[Auth] resend-verification error:', err.message);
        return respond();
    }
});

module.exports = router;
