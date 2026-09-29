// @typecheck
/**
 * Login Routes — what the signup form needs before it submits: the (optional)
 * public organisation directory and the pending-signup blob the OAuth flows
 * pick up in their callback. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { checkWebSignupAllowed } = require('../signupGuards');
const loginThrottle = require('../loginThrottle');
const signupCaptcha = require('../signupCaptcha');
const { signupIpLimiter } = require('../authRateLimits');
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

const AUTH_METHODS = ['password', 'google', 'microsoft'];
const ORG_NAME_TEXT = 'Organization name is required';

/**
 * `signupType` decides which ACCOUNT TYPE this signup becomes, and anything
 * that was not exactly 'consumer' fell through to the organisation branch —
 * so a mis-typed 'consumr' created an org signup, and the consent row the
 * callback writes recorded accountType 'org_admin' for somebody who asked for
 * a personal account. Absent still means org, because that is what the org
 * wizard sends; an unrecognised value is now refused instead of guessed.
 *
 * `authMethod` is stored on the pending blob and becomes the organisation's
 * write-once `authMethod` column (it can never be corrected afterwards — see
 * admin/orgRoutes.js), and for a consumer signup it silently defaulted to
 * 'google' for every value the caller could name.
 *
 * `orgDetails` and `privacyShield` stay open on purpose: they are wizard
 * payloads consumed field-by-field downstream (accountProvisioning sanitises
 * the org text; the shield is a config blob), and closing them here would
 * freeze two shapes this route does not own.
 */
const PendingSignupBody = z.object({
    signupType: wordedEnum(['consumer', 'org'], 'signupType is one of consumer, org.').optional(),
    authMethod: wordedEnum(AUTH_METHODS, `A sign-in method is one of ${AUTH_METHODS.join(', ')}.`).optional(),
    newOrgName: worded(ORG_NAME_TEXT).trim().min(1, ORG_NAME_TEXT).max(200, 'An organization name is at most 200 characters.').optional(),
    orgDetails: z.record(z.unknown(), { invalid_type_error: 'orgDetails must be an object.' }).optional(),
    privacyShield: z.record(z.unknown(), { invalid_type_error: 'privacyShield must be an object.' }).nullable().optional(),
    selectedPlanId: worded('A plan id must be text.').trim().max(200, 'That plan id is too long.').nullable().optional(),
    locale: worded('A locale must be text.').trim().max(32, 'That locale is too long.').nullable().optional(),
    captchaToken: worded('A challenge token must be text.').max(4096, 'That challenge token is too long.').optional(),
}).strict();

// Get organizations with signup enabled (public, no auth required)
//
// M-03: this used to hand every organisation on the instance to any anonymous
// caller. On a multi-tenant SaaS that is the customer list, and it was also a
// direct attack aid — the ids returned here were exactly what a pentest fed
// into its cross-tenant attempts (which all correctly failed, but an attacker
// should not be given the target list for free).
//
// The endpoint predates a frontend change: SignupStepOrg.jsx no longer offers
// self-service "join an existing organisation" at all ("users join an org via an
// email invitation, not by self-selecting it"), so on cloud there is nothing
// left that needs a directory. It is therefore OFF by default on cloud and ON by
// default self-hosted, where the instance has a single tenant and listing it
// discloses nothing the login page doesn't already show. Admins can flip it via
// PUT /auth/admin/signup-settings { orgDirectoryPublic }.
async function isOrgDirectoryPublic() {
    const configured = await configStore.getConfig('signup_org_directory_public');
    if (configured !== null && configured !== undefined) return !!configured;
    return (process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud';
}

router.get('/organizations/public', async (req, res) => {
    try {
        if (!(await isOrgDirectoryPublic())) return res.json([]);
        const allOrgs = await userStore.getAllOrganizations();
        const orgs = allOrgs.filter(o => o.allowSignup);
        res.json(orgs.map(o => ({ id: o.id, name: o.name, logo: o.logo || null, description: o.description || '' })));
    } catch (err) {
        res.json([]);
    }
});


// Store pending signup data in session (for OAuth flows)
router.post('/pending-signup', signupIpLimiter, validate({ body: PendingSignupBody }), async (req, res) => {
    if (process.env.ALLOW_SIGNUPS === 'false') {
        return res.status(403).json({ error: 'Account creation is disabled on this server.' });
    }
    // Connector-only + geo gating (OAuth signup entry point)
    const gate = await checkWebSignupAllowed(req);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
    // The OAuth signup entry point. Without the same bot gate as POST /signup,
    // the CAPTCHA would only cover half the ways a tenant can be created.
    const captcha = await signupCaptcha.verifyCaptcha(req.body.captchaToken, req);
    if (!captcha.ok) {
        return res.status(400).json({ error: captcha.error, code: captcha.code });
    }
    const { signupType, authMethod, newOrgName, orgDetails } = req.body;

    // Breadth: signupIpLimiter stands aside for untrusted peers, so on a
    // load-balanced deployment nothing bounded this route at all unless a
    // CAPTCHA provider was configured. One source naming many distinct
    // organisations is the abuse signature worth slowing; there is no target
    // address here to key on, and every tenant carries an LLM quota that costs
    // real money.
    if (newOrgName) {
        const fan = await loginThrottle.recordFanOut(req, 'pending-signup', newOrgName);
        if (fan.delayMs > 0) await loginThrottle.sleep(fan.delayMs);
    }

    // Consumer OAuth signup
    if (signupType === 'consumer') {
        const consumerSignupsEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
        if (!consumerSignupsEnabled) {
            return res.status(403).json({ error: 'Consumer registration is currently disabled.' });
        }
        // `privacyShield` carries the wizard's privacy-step choices through to
        // the OAuth callback, where the user row (and its shield) is created.
        req.session.pendingSignup = {
            signupType: 'consumer',
            authMethod: authMethod || 'google',
            privacyShield: req.body.privacyShield ?? null,
            selectedPlanId: req.body.selectedPlanId ?? null,
            locale: req.body.locale ?? null,
            consent: { accepted: true, accountType: 'consumer' },
        };
        return req.session.save((err) => {
            if (err) {
                log.error('[PendingSignup] Session save error:', err);
                return res.status(500).json({ error: 'Failed to save pending signup' });
            }
            log.info(`[PendingSignup] Stored consumer signup in session ${req.sessionID}`);
            res.json({ ok: true });
        });
    }

    // Org OAuth signup
    const orgSignupsEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
    if (!orgSignupsEnabled) {
        return res.status(403).json({ error: 'Organization registration is currently disabled.' });
    }
    if (!newOrgName) {
        return res.status(400).json({ error: ORG_NAME_TEXT });
    }
    req.session.pendingSignup = {
        newOrgName,
        orgDetails: orgDetails || {},
        selectedPlanId: req.body.selectedPlanId ?? null,
        locale: req.body.locale ?? null,
        consent: { accepted: true, accountType: 'org_admin' },
    };
    req.session.save((err) => {
        if (err) {
            log.error('[PendingSignup] Session save error:', err);
            return res.status(500).json({ error: 'Failed to save pending signup' });
        }
        log.info(`[PendingSignup] Stored org "${newOrgName}" in session ${req.sessionID}`);
        res.json({ ok: true });
    });
});

module.exports = router;
// The directory toggle is also read by the platform signup-settings routes.
module.exports.isOrgDirectoryPublic = isOrgDirectoryPublic;
