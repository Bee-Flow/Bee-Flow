// @typecheck
/**
 * Login Routes — platform signup policy: the instance-wide signup/waitlist/MFA
 * and geo toggles, plus the waitlist queue itself. Platform scope, never org
 * scope. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { requireSuperAdmin } = require('../permissions');
const { getSignupAccessConfig } = require('../signupGuards');
const { isOrgDirectoryPublic } = require('./signupIntakeRoutes');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const LOGIN_METHODS = ['password', 'google', 'microsoft'];
const GEO_MODES = ['off', 'allowlist', 'blocklist'];

const flag = (name) => z.boolean({ invalid_type_error: `${name} must be true or false.` }).optional();

/**
 * An enum whose every refusal is a sentence. `invalid_type_error` alone is not
 * enough: zod reports a value that is a string but not a member as
 * `invalid_enum_value`, whose default message quotes the whole option list
 * back at the caller. The errorMap covers every issue this schema can raise.
 */
const wordedEnum = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

/**
 * Every field the admin console can change here, and every value each one may
 * take. All optional — this is a partial save — but nothing is dropped any
 * more, which is the whole point:
 *
 * every setting used to be written only `if (typeof x === 'boolean')` or
 * `if (['off','allowlist','blocklist'].includes(x))`, and anything else was
 * DISCARDED under a 200. So `geoMode: 'blocklst'` left geo-blocking off while
 * the console reported it saved, `allowOrgSignups: "false"` left signups open,
 * and `geoCountries: ['NLD','BE']` silently dropped NL — which in allowlist
 * mode locks out the country the admin was trying to admit, and in blocklist
 * mode fails to block it. A control an administrator believes is on and which
 * is not is worse than no control, so these now refuse instead.
 */
const SignupSettingsBody = z.object({
    allowOrgSignups: flag('allowOrgSignups'),
    allowConsumerSignups: flag('allowConsumerSignups'),
    waitlistEnabled: flag('waitlistEnabled'),
    emailVerificationEnabled: flag('emailVerificationEnabled'),
    requireMfaForPasswordAccounts: flag('requireMfaForPasswordAccounts'),
    consumerLoginMethods: z.array(
        wordedEnum(LOGIN_METHODS, `A login method is one of ${LOGIN_METHODS.join(', ')}.`),
        { invalid_type_error: 'consumerLoginMethods must be a list of login methods.' },
    ).optional(),
    orgDirectoryPublic: flag('orgDirectoryPublic'),
    connectorOnly: flag('connectorOnly'),
    geoMode: wordedEnum(GEO_MODES, `geoMode is one of ${GEO_MODES.join(', ')}.`).optional(),
    geoCountries: z.array(
        z.string({ invalid_type_error: 'A country is a two-letter ISO code, e.g. NL.' })
            .trim()
            .regex(/^[A-Za-z]{2}$/, 'A country is a two-letter ISO code, e.g. NL.')
            .transform((c) => c.toUpperCase()),
        { invalid_type_error: 'geoCountries must be a list of two-letter ISO codes.' },
    ).optional(),
    geoBlockUnknown: flag('geoBlockUnknown'),
    geoApplyConnector: flag('geoApplyConnector'),
}).strict();

// ═══════════════════════════════════════════════════════════
// ── Admin: Signup Settings ────────────────────────────────
// ═══════════════════════════════════════════════════════════
// Instance-wide signup policy: org/consumer signup toggles, waitlist, MFA
// enforcement and geo blocking. One installation has one answer, so this is
// platform scope — never org scope.
router.get('/admin/signup-settings', requireSuperAdmin, async (req, res) => {
    try {
        const orgEnabled = (await configStore.getConfig('signup_org_enabled')) ?? true;
        const consumerEnabled = (await configStore.getConfig('signup_consumer_enabled')) ?? false;
        const waitlistEnabled = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
        const emailVerificationEnabled = (await configStore.getConfig('signup_email_verification_enabled')) ?? false;
        // Whether the platform can actually send the verification email — the UI
        // uses this to warn that the toggle is a no-op without service email.
        let serviceEmailConfigured = false;
        try { serviceEmailConfigured = (await require('../../utils/emailService').getServiceEmailConfig()).configured; } catch (_) { /* ignore */ }
        const requireMfaForPasswordAccounts = (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true;
        const consumerLoginMethods = (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'];
        const access = await getSignupAccessConfig();
        // The ALLOW_SIGNUPS env var is a global kill-switch the public
        // /setup-status applies but these DB toggles don't reflect — surface it
        // so the admin can see *why* the Create Account button is hidden.
        const allowSignupsEnv = process.env.ALLOW_SIGNUPS !== 'false';
        res.json({
            allowOrgSignups: orgEnabled,
            allowConsumerSignups: consumerEnabled,
            waitlistEnabled,
            emailVerificationEnabled,
            serviceEmailConfigured,
            // What is ACTUALLY enforced. The gate in accountProvisioning fails
            // open when service email is unconfigured, so the toggle alone does
            // not mean addresses are being verified. Surfacing the derived value
            // stops the admin UI from reporting a control that is not running.
            emailVerificationEffective: emailVerificationEnabled && serviceEmailConfigured,
            requireMfaForPasswordAccounts,
            consumerLoginMethods,
            // Whether GET /auth/organizations/public discloses the tenant list.
            orgDirectoryPublic: await isOrgDirectoryPublic(),
            connectorOnly: access.connectorOnly,
            geoMode: access.geoMode,
            geoCountries: access.geoCountries,
            geoBlockUnknown: access.geoBlockUnknown,
            geoApplyConnector: access.geoApplyConnector,
            // Effective signup state after all overrides (env + connector-only).
            allowSignupsEnv,
            effectiveAllowSignups: (orgEnabled || consumerEnabled) && !access.connectorOnly && allowSignupsEnv,
        });
    } catch (err) {
        log.error('[Auth] Failed to get signup settings:', err.message);
        res.status(500).json({ error: 'Failed to load signup settings' });
    }
});

router.put('/admin/signup-settings', requireSuperAdmin, validate({ body: SignupSettingsBody }), async (req, res) => {
    try {
        const { allowOrgSignups, allowConsumerSignups, waitlistEnabled, emailVerificationEnabled, requireMfaForPasswordAccounts, consumerLoginMethods,
                orgDirectoryPublic, connectorOnly, geoMode, geoCountries, geoBlockUnknown, geoApplyConnector } = req.body;

        // Snapshot current values for the audit trail before mutating.
        const snapshot = async () => ({
            signup_org_enabled: (await configStore.getConfig('signup_org_enabled')) ?? true,
            signup_consumer_enabled: (await configStore.getConfig('signup_consumer_enabled')) ?? false,
            signup_waitlist_enabled: (await configStore.getConfig('signup_waitlist_enabled')) ?? false,
            signup_email_verification_enabled: (await configStore.getConfig('signup_email_verification_enabled')) ?? false,
            require_mfa_for_password_accounts: (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true,
            consumer_login_methods: (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'],
            signup_org_directory_public: await isOrgDirectoryPublic(),
            ...(await getSignupAccessConfig()),
        });
        const oldValues = await snapshot();

        if (allowOrgSignups !== undefined) {
            await configStore.setConfig('signup_org_enabled', allowOrgSignups);
        }
        if (allowConsumerSignups !== undefined) {
            await configStore.setConfig('signup_consumer_enabled', allowConsumerSignups);
        }
        if (waitlistEnabled !== undefined) {
            await configStore.setConfig('signup_waitlist_enabled', waitlistEnabled);
        }
        if (emailVerificationEnabled !== undefined) {
            await configStore.setConfig('signup_email_verification_enabled', emailVerificationEnabled);
        }
        if (requireMfaForPasswordAccounts !== undefined) {
            await configStore.setConfig('require_mfa_for_password_accounts', requireMfaForPasswordAccounts);
        }
        if (consumerLoginMethods !== undefined) {
            await configStore.setConfig('consumer_login_methods', [...new Set(consumerLoginMethods)]);
        }
        if (orgDirectoryPublic !== undefined) {
            await configStore.setConfig('signup_org_directory_public', orgDirectoryPublic);
        }
        // ── Connector-only + geo-blocking ──
        if (connectorOnly !== undefined) {
            await configStore.setConfig('signup_connector_only', connectorOnly);
        }
        if (geoMode !== undefined) {
            await configStore.setConfig('signup_geo_mode', geoMode);
        }
        if (geoCountries !== undefined) {
            await configStore.setConfig('signup_geo_countries', [...new Set(geoCountries)]);
        }
        if (geoBlockUnknown !== undefined) {
            await configStore.setConfig('signup_geo_block_unknown', geoBlockUnknown);
        }
        if (geoApplyConnector !== undefined) {
            await configStore.setConfig('signup_geo_apply_connector', geoApplyConnector);
        }

        // Audit the change (best-effort; logAccessAudit never throws).
        const newValues = await snapshot();
        await userStore.logAccessAudit('signup.access_settings_updated', 'signup_settings', 'global', req.session?.user?.id, oldValues, newValues, null);

        log.info(`[Auth] Signup settings updated — org: ${allowOrgSignups}, consumer: ${allowConsumerSignups}, waitlist: ${waitlistEnabled}, connectorOnly: ${connectorOnly}, geoMode: ${geoMode}`);
        res.json({ success: true });
    } catch (err) {
        log.error('[Auth] Failed to save signup settings:', err.message);
        res.status(500).json({ error: 'Failed to save signup settings' });
    }
});

// ── Waitlist Management ──────────────────────────────────────
router.get('/admin/waitlist', requireSuperAdmin, async (req, res) => {
    try {
        const allUsers = await userStore.getAllUsers();
        const waitlisted = allUsers
            .filter(u => u.status === 'waitlist')
            .map(u => ({
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                email: u.email,
                organizationId: u.organizationId,
                createdAt: u.createdAt,
            }));
        res.json(waitlisted);
    } catch (err) {
        log.error('[Auth] Failed to fetch waitlist:', err.message);
        res.status(500).json({ error: 'Failed to load waitlist' });
    }
});

router.post('/admin/waitlist/:userId/approve', requireSuperAdmin, async (req, res) => {
    try {
        const user = await userStore.getUser(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status !== 'waitlist') return res.status(400).json({ error: 'User is not on the waitlist' });

        await userStore.updateUser(user.id, { status: 'active' });
        log.info(`[Auth] Waitlist approved: ${user.id} (${user.email || 'no email'})`);

        // Send approval email if user has an email
        if (user.email) {
            try {
                const { sendWaitlistApprovedEmail } = require('../../utils/emailService');
                await sendWaitlistApprovedEmail({ email: user.email, displayName: user.displayName || user.username });
            } catch (emailErr) {
                log.error('[Auth] Failed to send approval email:', emailErr.message);
            }
        }

        res.json({ success: true });
    } catch (err) {
        log.error('[Auth] Waitlist approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve user' });
    }
});

router.post('/admin/waitlist/:userId/reject', requireSuperAdmin, async (req, res) => {
    try {
        const user = await userStore.getUser(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.status !== 'waitlist') return res.status(400).json({ error: 'User is not on the waitlist' });

        await userStore.deleteUser(user.id);
        log.info(`[Auth] Waitlist rejected & deleted: ${user.id}`);
        res.json({ success: true });
    } catch (err) {
        log.error('[Auth] Waitlist reject error:', err.message);
        res.status(500).json({ error: 'Failed to reject user' });
    }
});

module.exports = router;
