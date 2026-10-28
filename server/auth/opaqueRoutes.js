// @typecheck noImplicitAny
/**
 * OPAQUE Authentication Routes
 * 
 * Implements the OPAQUE PAKE protocol (RFC 9807) for password-authenticated
 * key exchange. The server never sees the user's password.
 * 
 * Flow:
 *   Registration: startRegistration → createRegistrationResponse → finishRegistration
 *   Login:        startLogin → serverStartLogin → finishLogin → serverFinishLogin
 * 
 * The client obtains an `exportKey` from the OPAQUE protocol which is used
 * to derive a KEK for wrapping/unwrapping the user's DEK entirely client-side.
 */

const express = require('express');
const log = require('../telemetry/log');
const { getServerSetup, _pendingFallback, PENDING_TTL, getPendingLogin, setPendingLogin, deletePendingLogin, fakeKey, buildFakeRecords, fakeRecordFor, fakeWrappedDEK, readEnvelope, RegisterStartBody, RegisterFinishBody, LoginStartBody, LoginFinishBody, PinRegisterFinishBody, PinLoginStartBody } = require('./opaqueSupportRoutes');
const router = express.Router();
const crypto = require('crypto');
const opaque = require('@serenity-kit/opaque');
const userStore = require('../stores/userStore');
const { requireAuth } = require('./permissions');
const { recordAuthEvent } = require('../telemetry/metrics');
const { establishSession } = require('./establishSession');
const { isLoginBlockedAccount } = require('./accountStatusGate');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const loginThrottle = require('./loginThrottle');
const { auditLoginFailure, auditLoginBlocked } = require('./loginAudit');
const { checkServerSetup, isServerSetupUsable, SETUP_INVALID_BODY } = require('./opaqueSetup');

// Brute-force / abuse brakes. The login endpoints are reachable
// unauthenticated, so they key on IP (perUserRateLimit falls back to req.ip
// when there is no session user). Registration is authenticated and keys on
// the session user by default.
const opaqueLoginLimiter = perUserRateLimit({ windowMs: 15 * 60_000, max: 30, name: 'opaque-login' });
const opaqueRegisterLimiter = perUserRateLimit({ windowMs: 60 * 60_000, max: 10, name: 'opaque-register' });

// Ensure WASM is loaded before handling requests. The configured setup is
// judged in the same tick (auth/opaqueSetup.js), so no request ever sees the
// routes ready with a verdict still pending. An unreadable setup logs one error
// there and turns the start routes into a 503 below.
let opaqueReady = false;
opaque.ready.then(() => {
    const setup = checkServerSetup({ opaqueLib: opaque, log });
    opaqueReady = true;
    if (setup.valid) log.info('[OPAQUE] WASM loaded — OPAQUE protocol ready');
});

// Middleware: ensure OPAQUE WASM is ready and the configured setup readable.
// Mounted first on every route that uses the setup, before the rate limiter,
// the body check and any user lookup, so the 503 is the same for every caller
// and every username: it says something about the server, nothing about an
// account. Answered here rather than thrown as an HttpError: the terminal
// handler logs every 5xx at error level, and this one is already reported once
// at boot — per request it would give anonymous callers a log-write lever.
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function ensureReady(req, res, next) {
    if (!opaqueReady) {
        return res.status(503).json({ error: 'OPAQUE not ready — WASM loading' });
    }
    if (!isServerSetupUsable()) {
        return res.status(503).json({ ...SETUP_INVALID_BODY });
    }
    next();
}

// Cleanup stale in-memory entries (only relevant when Redis is unavailable).
// unref'd: a janitor timer has no business keeping the process alive on its own
// (it also hung `node --test` on any suite that loads this module).
const _pendingSweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of _pendingFallback) {
        if (now - entry.created > PENDING_TTL * 1000) {
            _pendingFallback.delete(key);
        }
    }
}, 60000);
if (typeof _pendingSweep.unref === 'function') _pendingSweep.unref();

// Warm the pool at boot so the first absent-user probe does not pay for it.
buildFakeRecords().catch((/** @type {Error} */ err) => {
    // An unreadable setup fails here too; it has been reported once already.
    if (!isServerSetupUsable()) return;
    log.warn('[OPAQUE] fake-credential pool could not be built yet:', err.message);
});

// ============================================================
// REGISTRATION (new user or migration)
// ============================================================

/**
 * Step 1: Client starts registration, sends registrationRequest
 */
const { validate } = require('../core/http/validate');

router.post('/register/start', ensureReady, requireAuth, opaqueRegisterLimiter, validate({ body: RegisterStartBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { registrationRequest } = req.body;

    const username = req.session.user.id;
    const serverSetup = getServerSetup();
    const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier: username,
        registrationRequest
    });

    res.json({ registrationResponse });
});

/**
 * Step 2: Client finishes registration, sends registrationRecord + wrapped keys
 * The client has already:
 *   1. Derived KEK from exportKey via HKDF
 *   2. Generated DEK (random 32 bytes)
 *   3. Wrapped DEK with KEK (AES-256-GCM)
 *   4. Generated recovery key, wrapped DEK with it
 */
router.post('/register/finish', requireAuth, opaqueRegisterLimiter, validate({ body: RegisterFinishBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { registrationRecord, wrappedDEK, recoveryWrappedDEK, kekSalt } = req.body;

    // The account being migrated is the CALLER'S, taken from the session
    // and never from the body. Both were missing: the route had no
    // requireAuth and trusted `username`, so an unauthenticated request
    // could overwrite any account's OPAQUE record and wrapped DEK and
    // then be handed a session as that user — account takeover by
    // username, plus destruction of their key wrapping. /pin/register/
    // finish below always did this correctly; this one did not.
    const userId = req.session.user.id;
    // Migration path: the account exists (created by /auth/signup, which
    // establishes the session this route now requires).
    const user = await userStore.getUser(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found — create account first via /auth/signup' });
    }

    // Re-running registration replaces the DEK wrapping. If the caller
    // re-wrapped the SAME DEK (the legacy→OPAQUE migration) that is
    // correct; if they generated a fresh one, every existing encrypted
    // row becomes permanently unreadable. The server cannot tell the two
    // apart, so make it a deliberate act instead of a silent one.
    if (user.wrappedDEK && req.body.confirmReplace !== true) {
        log.warn(`[OPAQUE] Refused to replace existing wrapped DEK for ${userId} without confirmReplace`);
        return res.status(409).json({
            error: 'This account already has an encryption key. Replacing it makes existing encrypted data unreadable unless you re-wrapped the same DEK. Retry with confirmReplace: true.',
            code: 'dek_already_exists',
        });
    }

    // Store OPAQUE record and wrapped keys
    //
    // password_changed_at is set by hand here. The store stamps it whenever
    // a new bcrypt hash is written, but an opaque_v1 account has no hash:
    // `opaqueRecord` IS its login credential, so this write is exactly as
    // much of a password change as a bcrypt one, and the security screen
    // would otherwise show "unknown" for the accounts on the newer scheme.
    // Note that the PIN registration further down does NOT do this — see
    // the note there.
    await userStore.updateUser(userId, {
        opaqueRecord: registrationRecord,
        kdfMode: 'opaque_v1',
        wrappedDEK: JSON.stringify(wrappedDEK),
        recoveryWrappedDEK: recoveryWrappedDEK ? JSON.stringify(recoveryWrappedDEK) : user.recoveryWrappedDEK,
        kekSalt: kekSalt || user.kekSalt,
        passwordChangedAt: new Date(),
    });

    log.info(`[OPAQUE] Registration complete for user ${userId} (mode: opaque_v1)`);

    // Set session — H11: rotate the session id on establishment
    // (session fixation). Note: NO encryptionKey in session — client
    // holds it.
    const sessionUser = {
        id: user.id,
        displayName: user.displayName,
        role: user.role || 'user',
        avatar: user.avatar || null,
        avatarType: user.avatarType || null
    };
    try {
        await establishSession(req, {
            user: sessionUser,
            isAdmin: user.role === 'admin',
            // Registration, not a sign-in: this is /register/finish, which
            // re-establishes the session after the OPAQUE record is stored.
            // Labelling it 'opaque' would file it among the logins.
            audit: { method: 'opaque_register', organizationId: user.organizationId || null },
            extra: { opaqueMode: true },
        });
    } catch (err) {
        log.error('Session save error:', err);
    }
    res.json({
        success: true,
        user: sessionUser
    });
});

// ============================================================
// LOGIN
// ============================================================

/**
 * Step 1: Client starts login, sends startLoginRequest
 * Server responds with loginResponse + user's wrappedDEK (for client-side unwrap)
 */
router.post('/login/start', ensureReady, opaqueLoginLimiter, validate({ body: LoginStartBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const startedAt = Date.now();
    const { username, startLoginRequest } = req.body;

    // Same abuse gate as /auth/admin-login, keyed on the submitted identifier.
    // This route carried only a 30-per-15-min per-IP cap: no account lockout, no
    // spray delay and no response floor, so it was the cheapest place in the
    // product to grind passwords.
    const gate = await loginThrottle.checkLoginAllowed(req, username);
    if (!gate.allowed) {
        recordAuthEvent({ kind: 'opaque_login', status: 'blocked' });
        await auditLoginBlocked(req, { identifier: username, method: 'opaque', reason: 'throttled' });
        return loginThrottle.denyLogin(res, gate.retryAfterSec);
    }

    // Hoisted out of the try so the catch below can name the account in its
    // audit row. Without it every protocol error on this route audits as an
    // attempt against an unknown identifier, which is the one thing the row is
    // supposed to be able to tell apart.
    let resolvedUserId = null;
    try {
        let user = await userStore.getUser(username);
        // Fallback: if not found by ID and input looks like an email, try email lookup
        if (!user && username.includes('@')) {
            user = await userStore.getUserByEmail(username);
        }
        resolvedUserId = user ? user.id : null;

        // No account, no OPAQUE record, or still on the legacy KDF — all three
        // get a well-formed response computed from a credential nobody holds.
        // The SPA only reaches this route after /auth/admin-login answered
        // useOpaque, so the old `useLegacy` hint had no live caller; what it did
        // have was a distinct status code for "this name exists but is legacy".
        const usable = !!(user && user.opaqueRecord && user.kdfMode === 'opaque_v1');
        const registrationRecord = usable ? user.opaqueRecord : await fakeRecordFor(username);

        const serverSetup = getServerSetup();
        const { serverLoginState, loginResponse } = opaque.server.startLogin({
            serverSetup,
            userIdentifier: username,
            registrationRecord,
            startLoginRequest
        });

        // Store server state for finish step. `absent` travels with it so the
        // finish step can count the failure against the right identifier — the
        // protocol would reject it anyway, but silently.
        const loginId = crypto.randomUUID();
        await setPendingLogin(loginId, {
            serverLoginState,
            username,
            absent: !usable,
            // For the audit row at the finish step — never sent to the client.
            userId: usable ? user.id : null,
        });

        /** @type {{ iv: string; authTag: string; data: string; } | null} */
        let wrappedDEK = null;
        /** @type {{ iv: string; authTag: string; data: string; } | null} */
        let recoveryWrappedDEK = null;
        if (usable) {
            wrappedDEK = readEnvelope(user.wrappedDEK);
            recoveryWrappedDEK = readEnvelope(user.recoveryWrappedDEK);
        }
        // A real account with no recovery blob returns null for it, so absence
        // has to be able to look like that too — key the fake off the username
        // rather than always emitting both fields.
        if (!usable) {
            wrappedDEK = fakeWrappedDEK(username, 'dek');
            const digest = crypto.createHmac('sha256', fakeKey()).update(`recovery:${username}`).digest();
            recoveryWrappedDEK = (digest[0] & 1) ? fakeWrappedDEK(username, 'recovery') : null;
        }

        res.json({
            loginResponse,
            loginId,
            wrappedDEK,
            recoveryWrappedDEK
        });
    } catch (err) {
        log.error('[OPAQUE] Login start failed:', /** @type {Error} */ (err).message);
        // The reserved slot has to be waited out here too. Recording the
        // failure and then answering immediately took the slot and threw the
        // wait away, which left this path faster than every other failure on
        // the route and silently exempt from the spray brake.
        const outcome = await loginThrottle.recordLoginFailure(req, username);
        await auditLoginFailure(req, {
            userId: resolvedUserId, identifier: username, method: 'opaque', reason: 'protocol_error',
        });
        if (outcome.delayMs > 0) await loginThrottle.sleep(outcome.delayMs);
        await loginThrottle.padFailureResponse(startedAt);
        if (outcome.locked) return loginThrottle.denyLogin(res, outcome.retryAfterSec);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

/**
 * Step 2: Client finishes login, sends finishLoginRequest
 * Server verifies, establishes session
 * 
 * Client has already:
 *   1. Obtained exportKey from finishLogin
 *   2. Derived KEK from exportKey
 *   3. Unwrapped DEK with KEK
 *   4. Optionally sends encrypted DEK for server-side session use
 */
router.post('/login/finish', opaqueLoginLimiter, validate({ body: LoginFinishBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const startedAt = Date.now();
    const { loginId, finishLoginRequest, encryptedDEK } = req.body;

    const pending = await getPendingLogin(loginId);
    if (!pending) {
        return res.status(400).json({ error: 'Login session expired or invalid' });
    }

    await deletePendingLogin(loginId);

    // One exit for every way this step can fail, so a wrong password, an absent
    // account and a protocol error are the same event to a caller: same status,
    // same body, same floor, and all counted against the identifier the start
    // step was given.
    /**
     * @param {string | null} logLine
     */
    const fail = async (logLine) => {
        if (logLine) log.warn(`[OPAQUE] ${logLine}`);
        recordAuthEvent({ kind: 'opaque_login', status: 'fail' });
        const outcome = await loginThrottle.recordLoginFailure(req, pending.username);
        await auditLoginFailure(req, {
            userId: pending.userId || null, identifier: pending.username, method: 'opaque',
            reason: 'invalid_credentials',
        });
        if (outcome.delayMs > 0) await loginThrottle.sleep(outcome.delayMs);
        await loginThrottle.padFailureResponse(startedAt);
        if (outcome.locked) return loginThrottle.denyLogin(res, outcome.retryAfterSec);
        return res.status(401).json({ error: 'Invalid credentials' });
    };

    try {
        // An account that never existed got a fake credential at the start step;
        // the protocol rejects it below on its own, but say so explicitly rather
        // than relying on that.
        if (pending.absent) return await fail(null);

        const { sessionKey } = opaque.server.finishLogin({
            finishLoginRequest,
            serverLoginState: pending.serverLoginState
        });

        if (!sessionKey) return await fail(null);

        const user = await userStore.getUser(pending.username);
        if (!user) return await fail(null);

        // The account-status gate. This path never had one — not for suspended,
        // not for anything — so a suspended account could sign in here while the
        // same account was refused on the password path. `fail(null)` is the
        // existing refusal: 401 "Invalid credentials", padded to the failure
        // floor, no session written. Reusing it keeps a suspended account
        // indistinguishable from a wrong password, in body AND in timing.
        // See auth/accountStatusGate.js.
        if (isLoginBlockedAccount(user)) {
            recordAuthEvent({ kind: 'opaque_login', status: 'blocked' });
            return await fail(null);
        }

        recordAuthEvent({ kind: 'opaque_login', status: 'ok' });
        await loginThrottle.recordLoginSuccess(req, pending.username);

        // Set session — H11: rotate the session id on establishment
        // (session fixation).
        const sessionUser = {
            id: user.id,
            displayName: user.displayName,
            role: user.role || 'user',
            avatar: user.avatar || null,
            avatarType: user.avatarType || null
        };

        // If client sent encrypted DEK for server-side use (Option B from plan):
        // The DEK is encrypted with the OPAQUE sessionKey — decrypt it for session storage
        /** @type {string | null} */
        let dek = null;
        if (encryptedDEK) {
            try {
                const crypto = require('crypto');
                const sessionKeyBuf = Buffer.from(sessionKey, 'base64');
                // Use first 32 bytes of session key as AES key
                const aesKey = sessionKeyBuf.subarray(0, 32);
                const iv = Buffer.from(encryptedDEK.iv, 'hex');
                const tag = Buffer.from(encryptedDEK.authTag, 'hex');
                const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(encryptedDEK.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                dek = decrypted;
            } catch (dekErr) {
                log.error('[OPAQUE] Failed to decrypt DEK from client:', /** @type {Error} */ (dekErr).message);
                // Don't fail login — client still holds DEK
            }
        }

        try {
            await establishSession(req, {
                user: sessionUser,
                isAdmin: user.role === 'admin',
                extra: { opaqueMode: true, ...(dek !== null ? { encryptionKey: dek } : {}) },
                audit: { method: 'opaque', organizationId: user.organizationId || null },
            });
        } catch (err) {
            log.error('Session save error:', err);
        }
        res.json({
            success: true,
            user: sessionUser,
            sessionKey // Client needs this for encrypting DEK to send back
        });
    } catch (err) {
        return await fail(`Login finish failed: ${/** @type {Error} */ (err).message}`);
    }
});

// ============================================================
// SSO PIN — OPAQUE for encryption PIN (same protocol, different context)
// ============================================================

/**
 * SSO PIN registration start — user sets their encryption PIN via OPAQUE
 */
router.post('/pin/register/start', ensureReady, requireAuth, opaqueRegisterLimiter, validate({ body: RegisterStartBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { registrationRequest } = req.body;

    const userId = req.session.user.id;
    const serverSetup = getServerSetup();
    const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier: `${userId}:pin`,
        registrationRequest
    });

    res.json({ registrationResponse });
});

/**
 * SSO PIN registration finish
 */
router.post('/pin/register/finish', requireAuth, opaqueRegisterLimiter, validate({ body: PinRegisterFinishBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { registrationRecord, wrappedDEK, recoveryWrappedDEK } = req.body;

    const userId = req.session.user.id;

    // Same hazard as /register/finish: this route is reachable whenever a
    // session exists, and it overwrites wrappedDEK unconditionally. A
    // re-run of the setup screen (or a CSRF, given sameSite:'lax' and no
    // CSRF token) would orphan every encrypted row. Require an explicit
    // acknowledgement once a key is already in place.
    const existing = await userStore.getUser(userId);
    if (existing?.wrappedDEK && req.body.confirmReplace !== true) {
        log.warn(`[OPAQUE] Refused to replace existing wrapped DEK for SSO user ${userId} without confirmReplace`);
        return res.status(409).json({
            error: 'Encryption is already set up for this account. Replacing the key makes existing encrypted data unreadable. Retry with confirmReplace: true.',
            code: 'dek_already_exists',
        });
    }

    // No password_changed_at here, unlike /register/finish above: this PIN
    // protects the encryption key of an account that signs in through SSO
    // and has no password at all. Dating it would put "password changed
    // today" on the security screen of someone who has never had one.
    await userStore.updateUser(userId, {
        opaqueRecord: registrationRecord,
        kdfMode: 'opaque_v1',
        wrappedDEK: JSON.stringify(wrappedDEK),
        recoveryWrappedDEK: recoveryWrappedDEK ? JSON.stringify(recoveryWrappedDEK) : undefined,
        ssoEncryptionSetup: 1
    });

    req.session.needsEncryptionSetup = false;
    req.session.needsEncryptionPin = false;
    req.session.opaqueMode = true;

    log.info(`[OPAQUE] PIN registration complete for SSO user ${userId}`);

    req.session.save((err) => {
        if (err) log.error('Session save error:', err);
        res.json({ success: true });
    });
});

/**
 * SSO PIN login start
 */
router.post('/pin/login/start', ensureReady, requireAuth, opaqueLoginLimiter, validate({ body: PinLoginStartBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { startLoginRequest } = req.body;

    const userId = req.session.user.id;
    const user = await userStore.getUser(userId);

    if (!user || !user.opaqueRecord) {
        return res.json({ needsSetup: true });
    }

    const serverSetup = getServerSetup();
    const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup,
        userIdentifier: `${userId}:pin`,
        registrationRecord: user.opaqueRecord,
        startLoginRequest
    });

    const loginId = require('crypto').randomUUID();
    await setPendingLogin(loginId, {
        serverLoginState,
        username: userId,
        isPinLogin: true,
    });

    const wrappedDEK = readEnvelope(user.wrappedDEK);

    res.json({ loginResponse, loginId, wrappedDEK });
});

/**
 * SSO PIN login finish
 */
router.post('/pin/login/finish', requireAuth, opaqueLoginLimiter, validate({ body: LoginFinishBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { loginId, finishLoginRequest, encryptedDEK } = req.body;

    const pending = await getPendingLogin(loginId);
    if (!pending || !pending.isPinLogin) {
        return res.status(400).json({ error: 'Login session expired or invalid' });
    }

    await deletePendingLogin(loginId);

    try {
        const { sessionKey } = opaque.server.finishLogin({
            finishLoginRequest,
            serverLoginState: pending.serverLoginState
        });

        if (!sessionKey) {
            return res.status(401).json({ error: 'Incorrect PIN' });
        }

        req.session.needsEncryptionPin = false;
        req.session.needsEncryptionSetup = false;
        req.session.opaqueMode = true;

        // Decrypt client-sent DEK for server session (Option B)
        if (encryptedDEK) {
            try {
                const crypto = require('crypto');
                const sessionKeyBuf = Buffer.from(sessionKey, 'base64');
                const aesKey = sessionKeyBuf.subarray(0, 32);
                const iv = Buffer.from(encryptedDEK.iv, 'hex');
                const tag = Buffer.from(encryptedDEK.authTag, 'hex');
                const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
                decipher.setAuthTag(tag);
                let decrypted = decipher.update(encryptedDEK.data, 'hex', 'utf8');
                decrypted += decipher.final('utf8');
                req.session.encryptionKey = decrypted;
            } catch (dekErr) {
                log.error('[OPAQUE] Failed to decrypt PIN DEK from client:', /** @type {Error} */ (dekErr).message);
            }
        }

        log.info(`[OPAQUE] PIN login complete for SSO user ${req.session.user.id}`);

        req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: true, sessionKey });
        });
    } catch (err) {
        log.error('[OPAQUE] PIN login finish failed:', /** @type {Error} */ (err).message);
        res.status(401).json({ error: 'Incorrect PIN' });
    }
});

/**
 * Check if user has OPAQUE registration (for frontend routing)
 */
router.get('/status', requireAuth, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const user = await userStore.getUser(req.session.user?.id);
    res.json({
        kdfMode: user?.kdfMode || 'legacy_argon2',
        hasOpaqueRecord: !!user?.opaqueRecord,
        opaqueMode: req.session.opaqueMode || false
    });
});

module.exports = router;
