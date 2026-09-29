// @typecheck
/**
 * Login Routes — the second factor of a password login: TOTP / recovery-code
 * verification for a session held in mfaPending. Enrolment lives in
 * auth/mfaRoutes.js. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const mfa = require('../mfa');
const { recordAuthEvent } = require('../../telemetry/metrics');
const { auditLoginFailure } = require('../loginAudit');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { finalizeLogin } = require('./finalizeLogin');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CODE_TEXT = 'Enter the code from your authenticator app, or one of your recovery codes.';
// A body that names no code at all is a malformed request, not a wrong code.
// It used to be read as `undefined` and spent one of the five attempts on the
// pending login — five typos of the key `code` destroyed mfaPending and sent
// the user back to the password step with nothing to explain it.
const VerifyLoginBody = z.object({
    code: worded(CODE_TEXT).trim().min(1, CODE_TEXT).max(64, CODE_TEXT),
}).strict();

// MFA — verify the second factor for a pending password login, then complete
// the session via the shared finalizeLogin path. Gated by session.mfaPending
// (set by /admin-login) rather than requireAuth (the session isn't
// authenticated yet).
//
// BFSF-274 hardening: rate-limited (keyed by the pending user so a NAT-shared
// office isn't collectively locked out) and capped at 5 attempts per pending
// login — exhausting them destroys mfaPending, forcing the attacker (or the
// fat-fingered user) back to the password step. Without a cap, a 6-digit
// space is brute-forceable.
const { MFA_LOGIN_MAX_ATTEMPTS } = mfa;
const mfaLoginLimiter = perUserRateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    keyFn: (req) => req.session?.mfaPending?.userId || null, // IP fallback inside
});
router.post('/mfa/verify-login', mfaLoginLimiter, validate({ body: VerifyLoginBody }), async (req, res) => {
    // Taken before any work, so every failure exit pads to the same floor —
    // the same contract as /admin-login (padFailureResponse in finalizeLogin).
    //
    // This declaration was MISSING, and it made every second factor on the
    // install unusable: the success path at the bottom passes `startedAt` to
    // finalizeLogin, so a CORRECT code threw a ReferenceError, the catch below
    // swallowed it, and the user got 500 "MFA verification failed". Only the
    // success path touched the name, which is why the failure paths kept
    // working and the bug read as "MFA rejects my valid codes".
    const startedAt = Date.now();
    const pending = req.session.mfaPending;
    if (!pending) return res.status(401).json({ error: 'No pending MFA login', code: 'no_pending_login' });
    try {
        const userRow = await userStore.getUser(pending.userId);
        if (!userRow || !userRow.mfa_enabled) {
            delete req.session.mfaPending;
            return res.status(400).json({ error: 'MFA is not enabled for this account' });
        }
        const { code } = req.body;
        const secret = mfa.decryptSecret(userRow.mfa_secret);
        // An account with only security keys has no secret at all: its codes
        // are recovery codes. Only a secret that is there and does not decrypt
        // is "unreadable".
        const unreadable = !!userRow.mfa_secret && !secret;
        let ok = mfa.verifyTotp(secret, code);
        if (!ok) {
            // Fall back to a one-time recovery code (consumes it).
            const updated = await mfa.consumeRecoveryCode(userRow.mfa_recovery_codes, code);
            if (updated) {
                await userStore.updateUser(pending.userId, { mfaRecoveryCodes: JSON.stringify(updated) });
                ok = true;
            }
        }
        if (!ok) {
            recordAuthEvent({ kind: 'mfa', status: 'fail' });
            // The account is known here — the password already passed — so this
            // row names it. A run of these against one user is the clearest
            // signal in the log that somebody holds a working password and not
            // the second factor.
            await auditLoginFailure(req, {
                userId: pending.userId, method: 'mfa',
                organizationId: userRow.organizationId || null,
                reason: unreadable ? 'mfa_secret_unreadable' : 'mfa_invalid_code',
            });
            pending.attempts = (pending.attempts || 0) + 1;
            if (pending.attempts >= MFA_LOGIN_MAX_ATTEMPTS) {
                // mfaPending also carries the password used for DEK derivation —
                // destroying it forces a clean re-entry of credentials.
                delete req.session.mfaPending;
                return res.status(401).json({
                    error: 'Too many incorrect codes. Sign in again with your password.',
                    code: 'mfa_attempts_exhausted',
                });
            }
            // Distinguish an undecryptable stored secret (key rotation without
            // re-encryption / corrupted row) from a typo — a generic "Invalid
            // code" sends the user into a retry loop that burns their recovery
            // codes (the exact BFSF-274 symptom cluster).
            if (unreadable) {
                log.error(`[MFA] mfa_secret for user ${pending.userId} is undecryptable during login — MASTER_ENCRYPTION_KEY mismatch? Run scripts/rotate-master-key.js or reset the user's 2FA via the admin panel.`);
                return res.status(401).json({
                    error: 'Your authenticator can no longer be verified on this server. Use a recovery code, or ask your administrator to reset two-factor authentication.',
                    code: 'mfa_secret_unreadable',
                });
            }
            return res.status(401).json({ error: 'Invalid code', code: 'invalid_code' });
        }
        recordAuthEvent({ kind: 'mfa', status: 'ok' });

        const { user, isAdmin, password } = pending;
        delete req.session.mfaPending;
        return finalizeLogin(req, res, { user, isAdmin, storedUser: userRow, password, startedAt });
    } catch (err) {
        log.error('[Auth] MFA verify-login error:', err.message);
        return res.status(500).json({ error: 'MFA verification failed' });
    }
});

module.exports = router;
