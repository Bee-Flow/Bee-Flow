// @typecheck
/**
 * Login Routes — the shared tail of a password login: the unverified/waitlist
 * gates, DEK derivation and session establishment. Split out of
 * auth/loginRoutes.js; called by both /admin-login and /mfa/verify-login.
 */

const userStore = require('../../stores/userStore');
const { loadConfig } = require('../permissions');
const { getOrCreateUserDEKCompat } = require('../encryption');
const { establishSession } = require('../establishSession');
const { canSkipApproval, canSkipEmailVerification } = require('../signupGuards');
const { recordAuthEvent } = require('../../telemetry/metrics');
const { isLoginBlockedAccount, REFUSAL } = require('../accountStatusGate');
const { auditLoginBlocked } = require('../loginAudit');
const { padFailureResponse } = require('../loginThrottle');

/**
 * Check if encryption is enabled for a user based on their org's subscription plan.
 * Encryption is a paid feature — disabled by default unless plan explicitly includes it.
 */
// Strict opt-in, unchanged in spirit: no admin bypass, and an org with no
// entitlement never gets a forced PIN-setup screen.
//
// What DID change: this used to read `allowed_features` directly, which is only
// the plan-grant half of entitlement. An org entitled through its licence TIER
// — the normal case for an enterprise licence, and the ONLY case on self-hosted
// where subscriptions are never consulted — passed the admin-side gate in
// adminRoutes and failed here. The org could then be switched to `zk`, whose
// only key source is the session DEK derived below, and every message would be
// written in plaintext with nothing but a console.error to show for it.
//
// One definition now, shared with the admin gate and with oauthRoutes (which
// carried a verbatim copy of the old logic).
const { isEncryptionEnabledForUser } = require('../../stores/encryptionAvailability');
const log = require('../../telemetry/log');

/**
 * Establish the authenticated session after credentials (and MFA, when
 * enabled) have been verified. Extracted from /admin-login so the MFA
 * verify-login path reuses the exact same session-completion logic
 * (waitlist gate, DEK derivation, recovery-key surfacing).
 */
// `startedAt` is the timestamp the CALLER took at the top of its handler, so a
// refusal here is padded to the same floor as a wrong password. Callers that
// do not pass one still get a floor, measured from entry into this function —
// shorter, but never zero.
async function finalizeLogin(req, res, { user, isAdmin, storedUser, password, startedAt = Date.now() }) {
    // Session establishment happens at the success exits via establishSession
    // (H11). Deliberately NO session writes here: the DEK path below can still
    // return 401, and pre-writing isAuthenticated=true let express-session
    // auto-persist a half-authenticated session at response end.
    const sessionUser = { ...user, isAdmin };

    // Two gates, two DIFFERENT predicates — see auth/signupGuards.js for why
    // conflating them was a vulnerability. Approval exempts org founders;
    // verification does not.
    const isOwnerOrAdmin = canSkipApproval(storedUser, isAdmin);

    // ── Block suspended accounts ──
    // FIRST, and with no exemption. The gates below are states on the way in
    // (not verified yet, not approved yet) and carry founder/admin exemptions;
    // `suspended` is a decision somebody made about an account that already had
    // access, so an exemption would mean "you may suspend anyone except the
    // people most worth suspending". See auth/accountStatusGate.js.
    //
    // Same 401 + "Invalid credentials" as a wrong password: a distinct message
    // would confirm the account exists and was singled out to anyone holding a
    // working password. And the failure floor applies, so this refusal cannot be
    // told from a wrong password by how long it took (auth/loginThrottle.js).
    if (isLoginBlockedAccount(storedUser)) {
        recordAuthEvent({ kind: 'login', status: 'blocked' });
        // Written before the floor, so the wait already owed absorbs it and the
        // refusal cannot be told apart by how long it took. A suspended account
        // still being signed into is the row an auditor looks for by name.
        await auditLoginBlocked(req, {
            userId: storedUser.id, organizationId: storedUser.organizationId || null,
            method: 'password', reason: `account_${storedUser.status}`,
        });
        await padFailureResponse(startedAt);
        return res.status(REFUSAL.status).json(REFUSAL.body);
    }

    // Counted here rather than on entry. It used to fire before every gate
    // below, so a refused sign-in was recorded as a successful one — harmless
    // while the gates only slowed people down, actively misleading now that one
    // of them is a security decision. The unverified/waitlist exits keep their
    // existing (unrecorded) behaviour; changing those is a metrics question,
    // not this one.
    recordAuthEvent({ kind: 'login', status: 'ok' });

    // ── Block unverified accounts ──
    // A fresh signup whose email isn't confirmed yet cannot log in. Distinct
    // from waitlist/pending so the SPA shows a "verify your email / resend"
    // state, not "awaiting approval". No DEK is derived here — that happens on
    // the first real login after verification flips the row to 'active'.
    if (storedUser && storedUser.status === 'unverified' && !canSkipEmailVerification(storedUser, isAdmin)) {
        req.session.isAuthenticated = false;
        req.session.isAdmin = false;
        req.session.user = null;
        return req.session.save((err) => {
            if (err) log.error('Session save error:', err);
            res.json({ success: false, emailVerificationRequired: true });
        });
    }
    if (storedUser && (storedUser.status === 'waitlist' || storedUser.status === 'pending') && !isOwnerOrAdmin) {
        // H11: rotate the session id on establishment (session fixation).
        try {
            await establishSession(req, {
                user: sessionUser, isAdmin, extra: { pendingApproval: true },
                audit: {
                    method: 'password', organizationId: storedUser?.organizationId || null,
                    details: { pendingApproval: true },
                },
            });
        } catch (err) {
            log.error('Session save error:', err);
        }
        return res.json({ success: true, pendingApproval: true, user: sessionUser });
    }
    // Derive and store encryption key — only when encryption is enabled for user's plan
    const encryptionEnabled = await isEncryptionEnabledForUser(user.id);
    try {
        if (!encryptionEnabled) {
            // Encryption disabled for this user's plan — skip DEK
            try {
                await establishSession(req, {
                    user: sessionUser, isAdmin,
                    // The session-user shape has no organisation; the stored row does.
                    audit: { method: 'password', organizationId: storedUser?.organizationId || null },
                });
            } catch (err) {
                log.error('Session save error:', err);
            }
            return res.json({ success: true, user: sessionUser });
        }

        // Ensure admin user exists in users table (for DEK storage)
        if (user.id === 'admin') {
            const adminRow = await userStore.getUser('admin');
            if (!adminRow) {
                const config = await loadConfig();
                await userStore.createUser({
                    id: 'admin', username: 'admin', displayName: 'Administrator',
                    passwordHash: config.admin.passwordHash, role: 'admin', groups: [],
                    // The hash is copied out of the config, where it has been
                    // sitting since setup — nothing about this login changed the
                    // credential, so the row must not be dated as if it did.
                    credentialUnchanged: true,
                });
            }
        }

        const result = await getOrCreateUserDEKCompat(user.id, password);
        if (!result) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        try {
            await establishSession(req, {
                user: sessionUser, isAdmin, extra: { encryptionKey: result.encryptionKey },
                audit: { method: 'password', organizationId: storedUser?.organizationId || null },
            });
        } catch (err) {
            log.error('Session save error:', err);
            return res.status(500).json({ error: 'Failed to save session' });
        }
        // Include recovery key in response if DEK was just created or migrated
        const response = { success: true, user: sessionUser };
        if (result.recoveryKey) response.recoveryKey = result.recoveryKey;
        return res.json(response);
    } catch (err) {
        log.error('[Auth] DEK operation failed:', err.message);
        return res.status(500).json({ error: 'Encryption initialization failed' });
    }
}

module.exports = { finalizeLogin };
