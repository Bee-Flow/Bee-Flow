// @typecheck
/**
 * Login Routes — public password signup: bot gate, password policy, invite
 * redemption, account placement and the auto-login that follows. The OAuth
 * callback runs the identical provisioning path. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { getOrCreateUserDEKCompat } = require('../encryption');
const { establishSession } = require('../establishSession');
const accountProvisioning = require('../accountProvisioning');
const { validatePasswordAsync } = require('../passwordPolicy');
const { sanitizePlainText } = require('../../utils/htmlSanitizer');
const signupCaptcha = require('../signupCaptcha');
const { signupIpLimiter, signupTargetLimiter } = require('../authRateLimits');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CREDENTIALS_TEXT = 'Username and password are required';

/**
 * The whole signup request in one shape. Closed, because the body is handed
 * WHOLE to accountProvisioning.normalizeSignupIntent — every key that matters
 * is read by name there, so a key nobody reads was accepted, answered with a
 * created account, and thrown away. `orgDetails` and `privacyShield` stay open
 * for the reason given in signupIntakeRoutes: they are wizard payloads this
 * route does not own, consumed field-by-field (and sanitised) downstream.
 *
 * `username` is NOT trimmed: it becomes the account's id, and /admin-login
 * compares the submitted identifier untrimmed — trimming on the way in would
 * mint an account whose owner can no longer name it the way they typed it.
 */
const SignupBody = z.object({
    username: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT).max(200, 'A username is at most 200 characters.'),
    password: worded(CREDENTIALS_TEXT).min(1, CREDENTIALS_TEXT),
    displayName: worded('A display name must be text.').max(400, 'That display name is too long.').optional(),
    firstName: worded('A first name must be text.').max(200, 'That first name is too long.').optional(),
    lastName: worded('A last name must be text.').max(200, 'That last name is too long.').optional(),
    email: worded('An e-mail address must be text.').trim().max(254, 'That e-mail address is too long.').optional(),
    locale: worded('A locale must be text.').trim().max(32, 'That locale is too long.').nullable().optional(),
    selectedPlanId: worded('A plan id must be text.').trim().max(200, 'That plan id is too long.').nullable().optional(),
    captchaToken: worded('A challenge token must be text.').max(4096, 'That challenge token is too long.').optional(),
    inviteToken: worded('An invitation token must be text.').trim().max(512, 'That invitation token is too long.').optional(),
    newOrgName: worded('An organization name must be text.').trim().max(200, 'An organization name is at most 200 characters.').optional(),
    organizationId: worded('An organization id must be text.').trim().max(200, 'That organization id is too long.').optional(),
    orgDetails: z.record(z.unknown(), { invalid_type_error: 'orgDetails must be an object.' }).optional(),
    privacyShield: z.record(z.unknown(), { invalid_type_error: 'privacyShield must be an object.' }).nullable().optional(),
}).strict();

// Public signup — create user + optionally a new organization
router.post('/signup', signupIpLimiter, signupTargetLimiter, validate({ body: SignupBody }), async (req, res) => {
    const { username, password, displayName, firstName, lastName, email, inviteToken } = req.body;

    if (username === 'admin') {
        return res.status(400).json({ error: 'This username is not available' });
    }

    // ── Bot gate (M-05) ──
    // A no-op unless the operator configured a provider. Checked before the
    // password policy so an unsolved challenge costs a bot nothing more to
    // learn than "solve the challenge" — and before any DB write, so a failed
    // signup cannot leave anything behind.
    const captcha = await signupCaptcha.verifyCaptcha(req.body.captchaToken, req);
    if (!captcha.ok) {
        return res.status(400).json({ error: captcha.error, code: captcha.code });
    }

    // ── Password policy (M-01) ──
    // A real organisation account was created here with the password
    // `password` — the length check was the only rule. The founder of a new
    // organisation IS its administrator, so a signup that creates an org is
    // held to the administrative minimum rather than the member one.
    const foundingAnOrg = !inviteToken && !!req.body.newOrgName;
    const policy = await validatePasswordAsync(password, {
        username, email,
        orgRole: foundingAnOrg ? 'org_admin' : '',
    });
    if (!policy.ok) {
        return res.status(400).json({ error: policy.error, code: policy.code });
    }

    // ── Handle invite token ──────────────────────────────────────
    let inviteData = null;
    if (inviteToken) {
        const invitationStore = require('../../stores/invitationStore');
        inviteData = await invitationStore.getInvitationByToken(inviteToken);
        if (!inviteData) {
            return res.status(400).json({ error: 'Invalid or expired invitation. Please request a new one.' });
        }
    }

    // ── Guards, account type, and placement ──────────────────────
    // Guards + org creation run BEFORE the user row exists, so a rejected signup
    // (org name taken, domain taken, signups disabled) can't strand a half-made
    // account. See auth/accountProvisioning.js — the OAuth callback runs the
    // identical path.
    let intent, placement;
    try {
        intent = accountProvisioning.normalizeSignupIntent(req.body, { inviteData, inviteToken, channel: 'password' });
        placement = await accountProvisioning.prepareAccountPlacement(intent, { req });
    } catch (e) {
        if (e instanceof accountProvisioning.SignupError) {
            // M-04: "that domain already has an organisation" is an answer only
            // the address owner is entitled to. When we can send mail, we send
            // it to them and give the anonymous caller the same
            // verification-pending response a normal signup produces, so the
            // two cases are indistinguishable from outside. The OAuth signup
            // path deliberately keeps the specific error — by the time it runs,
            // the caller has proved control of the address at their IdP.
            if (e.code === 'ORG_DOMAIN_TAKEN') {
                const notified = await accountProvisioning.notifyOrganisationAlreadyExists({
                    email, displayName: displayName || username, error: e,
                });
                if (notified) return res.json({ success: true, emailVerificationRequired: true });
            }
            return res.status(e.status).json(e.toResponse());
        }
        throw e;
    }

    const orgId = placement.organizationId;
    const passwordHash = await bcrypt.hash(password, 10);
    const resolvedStatus = placement.status;
    const needsVerification = placement.needsVerification;

    // Anonymous input. The org fields on this same request are stripped in
    // accountProvisioning; the person's own name is the other half, and it is
    // the one that lands in "<inviter> has invited you to join" in an HTML
    // email. A live check after sanitising only the org side found this still
    // storing `<img src=x onerror=...>` verbatim.
    const newUser = {
        id: username, username,
        displayName: sanitizePlainText(displayName, { maxLen: 200 }) || username,
        firstName: sanitizePlainText(firstName, { maxLen: 100 }) || null,
        lastName: sanitizePlainText(lastName, { maxLen: 100 }) || null,
        email: email || null,
        phone: null, avatar: null, avatarType: null,
        passwordHash, role: 'user', groups: placement.groups,
        organizationId: orgId || null,
        orgRole: placement.orgRole || '',
        status: resolvedStatus
    };

    try {
        accountProvisioning.assertUserCreated(
            await userStore.createUserWithSeatCheck(newUser, { strict: true }),
        );
    } catch (e) {
        if (e instanceof accountProvisioning.SignupError) {
            return res.status(e.status).json(e.toResponse());
        }
        if (e instanceof userStore.SeatCapExceededError) {
            return res.status(403).json({ error: 'seat_cap_exceeded', current: e.current, max: e.max });
        }
        throw e;
    }

    // Privacy shield, consent ledger, locale, verification token, invite
    // redemption, onboarding seed, trial and welcome email — identical for org
    // and consumer accounts.
    await accountProvisioning.finalizeAccount({
        userId: newUser.id,
        email: newUser.email,
        displayName: newUser.displayName,
        intent, placement, req,
    });

    // ── Email verification required — do NOT log in, do NOT create a DEK ──
    // The account exists as 'unverified'. The DEK is derived on the first real
    // login after the user confirms via the emailed link. The SPA shows a
    // "check your inbox" state and offers POST /auth/resend-verification.
    if (needsVerification) {
        return res.json({ success: true, emailVerificationRequired: true });
    }

    // If user is pending approval or waitlisted, notify but don't fully log in
    if (resolvedStatus === 'pending' || resolvedStatus === 'waitlist') {
        // H11: rotate the session id on establishment (session fixation).
        const sessionUser = {
            id: newUser.id, displayName: newUser.displayName,
            role: 'user', isAdmin: false, avatar: null, avatarType: null,
            organizationId: orgId || '', orgRole: ''
        };
        try {
            await establishSession(req, {
                user: sessionUser, isAdmin: false, extra: { pendingApproval: true },
                audit: {
                    method: 'signup', organizationId: orgId || null,
                    details: { pendingApproval: true },
                },
            });
        } catch (err) {
            log.error('Session save error:', err);
        }
        res.json({ success: true, pendingApproval: true, user: sessionUser });
        return;
    }

    // Auto-login after signup
    // H11: rotate the session id on establishment (session fixation).
    const sessionUser = {
        id: newUser.id, displayName: newUser.displayName,
        role: 'user', isAdmin: false, avatar: null, avatarType: null,
        organizationId: orgId || '', orgRole: placement.orgRole || ''
    };

    try {
        const result = await getOrCreateUserDEKCompat(newUser.id, password);
        try {
            await establishSession(req, {
                user: sessionUser,
                isAdmin: false,
                extra: { encryptionKey: result?.encryptionKey || null },
                audit: { method: 'signup', organizationId: orgId || null },
            });
        } catch (err) {
            log.error('Session save error:', err);
            return res.status(500).json({ error: 'Failed to save session' });
        }
        const response = { success: true, user: sessionUser };
        if (result?.recoveryKey) {
            response.recoveryKey = result.recoveryKey;
        }
        res.json(response);
    } catch (err) {
        log.error('[Auth] Signup DEK creation failed:', err.message);
        return res.status(500).json({ error: 'Encryption initialization failed' });
    }
});

module.exports = router;
