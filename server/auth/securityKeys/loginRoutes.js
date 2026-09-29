// @typecheck
/**
 * The security key as the second factor of a password sign-in — mounted at
 * /auth next to /mfa/verify-login, and gated the same way: by the
 * session.mfaPending that /admin-login leaves behind once the password was
 * right, not by requireAuth (there is no session yet).
 *
 *   POST /mfa/security-key/options       challenge for the keys usable here
 *   POST /mfa/security-key/verify-login  the key's answer; completes the login
 *
 * A wrong answer counts against the same attempt budget as a wrong code
 * (mfa.MFA_LOGIN_MAX_ATTEMPTS), so switching between the two methods does not
 * reset it. Exhausting it destroys mfaPending, which also carries the password
 * needed to derive the encryption key, so the user starts again at the
 * password step.
 *
 * The challenge is stored INSIDE mfaPending: whatever ends the pending login
 * (success, exhaustion, a new password attempt) ends the challenge with it.
 */

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { credentialJson } = require('./schemas');

const VerifyBody = z.object({ response: credentialJson }).strict();
const OptionsBody = z.object({}).strict();

const CHALLENGE_FIELD = 'securityKeyChallenge';

/**
 * @param {{
 *   userStore: { getUser: Function, listSecurityKeys: Function, recordSecurityKeyUse: Function },
 *   ceremony: typeof import('./ceremony'),
 *   relyingPartyOf: (req: any) => ({ rpID: string, origin: string } | null),
 *   finalizeLogin: Function,
 *   recordAuthEvent: Function,
 *   auditLoginFailure: Function,
 *   limiter: import('express').RequestHandler,
 *   maxAttempts: number,
 *   log: { warn: Function },
 * }} deps
 */
function createSecurityKeyLoginRouter(deps) {
    const {
        userStore, ceremony, relyingPartyOf, finalizeLogin,
        recordAuthEvent, auditLoginFailure, limiter, maxAttempts, log,
    } = deps;
    const router = express.Router();

    const noPendingLogin = () => new HttpError(401, 'no_pending_login', 'No pending MFA login');

    // The keys this pending user can use on the host they are on. A key only
    // answers for the RP ID it was registered under.
    async function usableKeys(userId, rpID) {
        const keys = await userStore.listSecurityKeys(userId);
        return keys.filter((k) => k.rpId === rpID);
    }

    router.post('/mfa/security-key/options', limiter, validate({ body: OptionsBody }), async (req, res) => {
        const pending = req.session.mfaPending;
        if (!pending) throw noPendingLogin();
        const rp = relyingPartyOf(req);
        if (!rp) {
            throw new HttpError(400, 'webauthn_unavailable', 'Security keys cannot be used from this address.');
        }
        const row = await userStore.getUser(pending.userId);
        if (!row?.mfa_enabled) {
            delete req.session.mfaPending;
            throw new HttpError(400, 'mfa_not_enabled', 'MFA is not enabled for this account');
        }
        const keys = await usableKeys(pending.userId, rp.rpID);
        if (keys.length === 0) {
            throw new HttpError(409, 'no_security_key_here', 'None of your security keys is registered for this address. Use another way to sign in.');
        }
        const options = await ceremony.authenticationOptions({ rp, keys });
        pending[CHALLENGE_FIELD] = ceremony.challengeRecord(options, rp);
        req.session.save((err) => {
            if (err) {
                log.warn('[SecurityKeys] session save failed:', err.message);
                return res.status(503).json({ error: 'Could not start the security key check. Try again.', code: 'session_unavailable' });
            }
            res.json({ options });
        });
    });

    router.post('/mfa/security-key/verify-login', limiter, validate({ body: VerifyBody }), async (req, res) => {
        // Taken first, so the success path hands finalizeLogin the same floor
        // /mfa/verify-login does.
        const startedAt = Date.now();
        const pending = req.session.mfaPending;
        if (!pending) throw noPendingLogin();

        // No challenge is a broken flow (never asked, or asked too long ago),
        // not a wrong answer: it costs no attempt.
        const record = ceremony.takeChallenge(pending, CHALLENGE_FIELD);
        if (!record) {
            throw new HttpError(400, 'challenge_expired', 'That took too long. Try your security key again.');
        }

        const row = await userStore.getUser(pending.userId);
        if (!row?.mfa_enabled) {
            delete req.session.mfaPending;
            throw new HttpError(400, 'mfa_not_enabled', 'MFA is not enabled for this account');
        }

        const { response } = req.body;
        const key = (await usableKeys(pending.userId, record.rpID)).find((k) => k.credentialId === response.id);
        const result = key
            ? await ceremony.verifyAuthentication({ response, record, key })
            : { ok: false, reason: 'unknown credential' };

        if (!result.ok) {
            log.warn(`[SecurityKeys] sign-in refused for user ${pending.userId}: ${result.reason}`);
            recordAuthEvent({ kind: 'mfa', status: 'fail' });
            await auditLoginFailure(req, {
                userId: pending.userId, method: 'security_key',
                organizationId: row.organizationId || null,
                reason: 'security_key_rejected',
            });
            pending.attempts = (pending.attempts || 0) + 1;
            if (pending.attempts >= maxAttempts) {
                delete req.session.mfaPending;
                return res.status(401).json({
                    error: 'Too many failed attempts. Sign in again with your password.',
                    code: 'mfa_attempts_exhausted',
                });
            }
            return res.status(401).json({ error: 'The security key could not be verified.', code: 'security_key_rejected' });
        }

        await userStore.recordSecurityKeyUse(pending.userId, key.id, result.newCounter);
        recordAuthEvent({ kind: 'mfa', status: 'ok' });
        const { user, isAdmin, password } = pending;
        delete req.session.mfaPending;
        return finalizeLogin(req, res, { user, isAdmin, storedUser: row, password, startedAt });
    });

    return router;
}

module.exports = { createSecurityKeyLoginRouter };
