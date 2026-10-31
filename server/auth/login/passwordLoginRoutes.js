// @typecheck strict
/**
 * Login Routes — username/password sign-in: the abuse gate, the constant-time
 * credential check and the MFA hand-off. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const passwords = require('../passwordHash');
const { upgradeStoredHash } = require('./passwordRehash');
const crypto = require('crypto');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');
const { isPlatformOperator } = require('../platformOperator');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig } = require('../permissions');
const { recordAuthEvent } = require('../../telemetry/metrics');
const loginThrottle = require('../loginThrottle');
const { auditLoginFailure, auditLoginBlocked } = require('../loginAudit');
const { loginIpLimiter } = require('../authRateLimits');
const { finalizeLogin, prepareLoginDek } = require('./finalizeLogin');
const { mfaMethodsFor, parkPendingLogin } = require('./pendingMfa');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

// One sentence for both fields and for every way they can be wrong. The 400
// must not distinguish a missing username from a missing password any more
// than it distinguishes a real account from an imaginary one; `details` names
// the field, which says something about the request and nothing about who has
// an account here.
const CREDENTIALS_TEXT = 'Username and password are required';

// NOT trimmed, on purpose. The submitted identifier is compared against the
// operator's configured name and is the throttle's key; trimming would make
// " admin" a second spelling of one account, with its own failure counter and
// its own way past the lockout.
const LoginBody = z.object({
    username: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT),
    password: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT),
}).strict();

/**
 * ── Constant-time credential check (H-02) ────────────────────────────────────
 *
 * Without this, response time separates a real account from an imaginary one by a
 * factor of about ninety:
 *
 *   admin              -> 0.516s   ← exists
 *   nonexistent_zzz1   -> 0.008s   ← does not
 *   tomsmit@beeflow.nl -> 0.006s
 *
 * Both return the same generic `401 Invalid credentials`, so the message was
 * never the leak — the clock was. The cause is the ordinary one: when the user
 * is not found the handler returns immediately, and when the user IS found it
 * first runs a deliberately slow password hash. The gap was wide enough that a
 * SINGLE request classified an account with certainty, which turns an unbounded
 * guessing problem into a targeted one and hands an attacker the username list
 * before they start.
 *
 * The fix is to always spend the hash. When no stored hash was available to
 * compare against, compare the submitted password with this fixed dummy hash
 * instead and throw the result away.
 *
 * The dummy is generated once per process from random bytes — nobody can supply
 * a password that matches it, and the salt is irrelevant since only the cost
 * matters. It comes from the shared hash function, so it uses the algorithm and cost
 * every new password gets (auth/passwordHash.js: bcrypt cost 10 by default,
 * argon2id with PASSWORD_HASH_ALGORITHM=argon2id). Rows hashed differently
 * (the built-in admin at cost 12, or bcrypt rows awaiting an argon2id upgrade)
 * cost a different amount than the dummy; the failure-response floor in
 * loginThrottle.js (padFailureResponse) sits above all of them and is what
 * makes every failure path take the same time. `admin` is a fixed, documented
 * account name whose existence was never the secret.
 */
/** @type {Promise<string> | null} */
let _dummyHashPromise = null;
function dummyPasswordHash() {
    if (!_dummyHashPromise) {
        _dummyHashPromise = passwords.hash(crypto.randomBytes(32).toString('hex'));
    }
    return _dummyHashPromise;
}
/** @param {string} password */
async function burnPasswordCompare(password) {
    try {
        await passwords.verify(String(password ?? ''), await dummyPasswordHash());
    } catch (err) { bestEffort('auth/login:burnPasswordCompare', err); } // the result is discarded, only the elapsed time matters
}

// Admin/User login with username/password
router.post('/admin-login', loginIpLimiter, validate({ body: LoginBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    // Taken before any work, so every failure exit can be padded to the same
    // floor regardless of which branch produced it — see padFailureResponse.
    const startedAt = Date.now();
    const config = await loadConfig();
    const { username, password } = req.body;

    // SSO-only mode. The operator account keeps password access — it is the way
    // back in when SSO breaks — but nobody else authenticates this way.
    //
    // Returning 403 immediately for every name EXCEPT the operator's, before the
    // throttle and with no padding, would let a single request name the
    // admin account. So the check decides only whether credentials can succeed;
    // the refusal itself is emitted from the one shared failure exit below, with
    // the same wording, timing and floor for every identifier — including the
    // operator's when their password is wrong.
    const passwordLoginDisabled = process.env.ALLOW_PASSWORD_LOGIN === 'false';
    const mayUsePassword = !passwordLoginDisabled || username === config.admin.username;

    // ── Abuse gate (H-01) ──
    // Checked BEFORE any credential work, so a refused attempt costs neither a
    // database round-trip nor a bcrypt round. Keyed on the SUBMITTED identifier
    // regardless of whether it names a real account — keying it on a resolved
    // user id would have rebuilt the very enumeration oracle the constant-time
    // work below exists to remove.
    const gate = await loginThrottle.checkLoginAllowed(req, username);
    if (!gate.allowed) {
        recordAuthEvent({ kind: 'login', status: 'blocked' });
        // No account lookup here, on purpose: the gate deliberately runs before
        // any database round-trip, and resolving the identifier just to enrich
        // an audit row would put the timing difference back that the dummy
        // bcrypt below exists to remove. The row carries the fingerprint.
        await auditLoginBlocked(req, { identifier: username, method: 'password', reason: 'throttled' });
        return loginThrottle.denyLogin(res, gate.retryAfterSec);
    }

    /** @type {{ id: string, displayName: string, role: string, avatar?: string | null, avatarType?: string | null } | null} */
    let user = null;
    let isAdmin = false;
    let storedUser = null;
    // Did we spend a real password-hash comparison? If not, one is spent on a dummy
    // hash before answering — see burnPasswordCompare at the top of this file.
    let hashCompared = false;

    // 1. Check Config Admin
    if (config.admin.passwordHash && username === config.admin.username) {
        const isValid = await passwords.verify(password, config.admin.passwordHash);
        hashCompared = true;
        if (isValid) {
            user = { id: 'admin', displayName: 'Administrator', role: 'admin' };
            isAdmin = true;
            await upgradeStoredHash({ userId: 'admin', storedHash: config.admin.passwordHash, password, isConfigAdmin: true });
        }
    }

    // 2. Check UserStore Users (if not already logged in as admin).
    // In SSO-only mode nobody but the operator gets here, and the lookup is
    // skipped rather than its result discarded — a skipped branch leaves
    // hashCompared false, so the dummy compare below still runs and the cost is
    // the same as a real attempt.
    if (!user && mayUsePassword) {
        storedUser = await userStore.getUser(username);
        // Fallback: if not found by ID and input looks like an email, try email lookup
        if (!storedUser && username.includes('@')) {
            storedUser = await userStore.getUserByEmail(username);
        }
        if (storedUser && storedUser.passwordHash) {
            // If user has migrated to OPAQUE, reject legacy login
            if (storedUser.kdfMode === 'opaque_v1') {
                // Burn the hash first. This response body necessarily differs
                // from a generic 401 — the client has to be told to switch
                // protocols — so it remains a (much narrower) existence signal
                // for OPAQUE-migrated accounts only. Equalising the TIMING at
                // least stops it from being readable without parsing the body.
                //
                // The pad matters in BOTH directions: this branch spends a real
                // bcrypt, so without the floor it would be an
                // outlier below every other failure on the route.
                await burnPasswordCompare(password);
                await auditLoginFailure(req, {
                    userId: storedUser.id, identifier: username, method: 'password',
                    organizationId: storedUser.organizationId || null,
                    reason: 'legacy_password_on_opaque_account',
                });
                await loginThrottle.padFailureResponse(startedAt);
                return res.status(400).json({
                    error: 'This account uses OPAQUE authentication',
                    useOpaque: true,
                    kdfMode: 'opaque_v1'
                });
            }
            const isValid = await passwords.verify(password, storedUser.passwordHash);
            hashCompared = true;
            if (isValid) {
                await upgradeStoredHash({ userId: storedUser.id, storedHash: storedUser.passwordHash, password });
                user = {
                    id: storedUser.id,
                    displayName: storedUser.displayName,
                    role: storedUser.role || 'user',
                    avatar: storedUser.avatar || null,
                    avatarType: storedUser.avatarType || null
                };
                isAdmin = storedUser.role === 'admin';
            }
        }
    }

    // H-02: an unknown username must cost the same as a known one.
    if (!hashCompared) {
        await burnPasswordCompare(password);
    }

    if (!user) {
        recordAuthEvent({ kind: 'login', status: 'fail' });
        // Progressive delay, then the generic 401. The delay is derived from the
        // failure count for this identifier, which an attacker created
        // themselves and which behaves identically for real and imaginary
        // accounts — so it costs them time without telling them anything.
        const outcome = await loginThrottle.recordLoginFailure(req, username);
        // `storedUser` is what the lookup above found — null for a name that
        // matches nothing, which is how the row tells an attempt on a real
        // account from one on an imaginary one without the audit module ever
        // performing a lookup of its own. The built-in operator has no row in
        // the user store, so it is null for that account too; naming it here
        // keeps failed attempts against the operator — the one account whose
        // failures matter most — from filing under "unknown identifier".
        const failedAccountId = storedUser ? storedUser.id
            : (config.admin.passwordHash && username === config.admin.username ? 'admin' : null);
        // Between the failure record and the floor, so the write is absorbed by
        // the wait that is already owed and cannot become a timing signal.
        await auditLoginFailure(req, {
            userId: failedAccountId, identifier: username,
            organizationId: storedUser ? storedUser.organizationId || null : null,
            method: 'password', reason: passwordLoginDisabled ? 'password_login_disabled' : 'invalid_credentials',
        });
        if (outcome.delayMs > 0) await loginThrottle.sleep(outcome.delayMs);
        await loginThrottle.padFailureResponse(startedAt);
        if (outcome.locked) return loginThrottle.denyLogin(res, outcome.retryAfterSec);
        // Same refusal for everyone when the server is SSO-only — the operator
        // included. Telling only non-operators that password login is disabled
        // is what named the operator.
        if (passwordLoginDisabled) {
            return res.status(403).json({ error: 'Password login is disabled on this server.' });
        }
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Credentials were correct — clear this identifier's failure counter. Done
    // here rather than after MFA so a user who fumbles their TOTP code doesn't
    // accumulate password failures they never made; the MFA step has its own
    // attempt cap (MFA_LOGIN_MAX_ATTEMPTS below).
    await loginThrottle.recordLoginSuccess(req, username);

    // ── MFA gate ──
    // If the account has TOTP enabled, hold off on establishing the
    // authenticated session: do the DEK step now, from the password that was
    // just verified, park the result for the second factor and ask the client
    // for a code. The password itself is kept nowhere. The OPAQUE path has
    // the same gate (auth/opaqueRoutes.js /login/finish); both finish through
    // login/pendingMfa.js.
    const mfaRow = storedUser || (isPlatformOperator(user) ? await userStore.getUser('admin') : null);
    if (mfaRow && mfaRow.mfa_enabled) {
        const derived = await prepareLoginDek(user, password);
        if (derived === false) {
            // The same refusal finalizeLogin gives when the key cannot be
            // derived from a verified password.
            await loginThrottle.padFailureResponse(startedAt);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        parkPendingLogin(req, { userId: user.id, isAdmin, user, derived });
        const mfaMethods = await mfaMethodsFor(userStore, { ...mfaRow, id: user.id });
        return req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ mfaRequired: true, mfaMethods });
        });
    }

    return finalizeLogin(req, res, { user, isAdmin, storedUser, password, startedAt });
});

module.exports = router;
