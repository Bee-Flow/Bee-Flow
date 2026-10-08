// @typecheck
/**
 * Login Routes — first-run instance setup: the pre-auth /setup-status payload
 * (signup toggles, locales, branding, captcha config) and the one-shot /setup
 * that sets the operator password. Split out of auth/loginRoutes.js.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { loadConfig, saveConfig } = require('../permissions');
const { MIN_PASSWORD_LENGTH, validatePasswordAsync } = require('../passwordPolicy');
const signupCaptcha = require('../signupCaptcha');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const PASSWORD_TEXT = 'Choose a password for the operator account.';
// Only the password, and it must be a string: the policy check below reads
// `.length` and the complexity check runs regexes over it, neither of which
// means anything for a number or an array.
const SetupBody = z.object({
    password: worded(PASSWORD_TEXT).min(1, PASSWORD_TEXT),
}).strict();

// Check if setup is complete (admin password set)
router.get('/setup-status', async (req, res) => {
    const config = await loadConfig();
    const isSetupComplete = !!config.admin.passwordHash;
    const isOAuthConfigured = !!(config.oauth.clientId && config.oauth.clientSecret);
    const isGoogleConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);
    const isMicrosoftConfigured = !!(config.providers?.microsoft?.clientId && config.providers?.microsoft?.clientSecret);
    // Expose server URL so frontend can redirect OAuth directly to the backend
    // (bypassing the frontend nginx proxy which strips Set-Cookie from 302s)
    const serverUrl = process.env.SERVER_PUBLIC_HOST
        ? `${process.env.SERVER_PROTOCOL || 'https'}://${process.env.SERVER_PUBLIC_HOST}`
        : '';
    // Include available locales for pre-auth language picker
    let availableLocales = [];
    try {
        const languageStore = require('../../stores/languageStore');
        const locales = await languageStore.getAvailableLocales();
        availableLocales = locales.map(l => ({ code: l.code, name: l.name }));
    } catch (err) {
        log.error('[Auth] setup-status — failed to load locales:', err.message);
    }
    // ── Granular signup toggles (database-backed, fallback to env) ──
    const envAllowSignups = process.env.ALLOW_SIGNUPS !== 'false';
    const allowOrgSignups = envAllowSignups ? ((await configStore.getConfig('signup_org_enabled')) ?? true) : false;
    const allowConsumerSignups = envAllowSignups ? ((await configStore.getConfig('signup_consumer_enabled')) ?? false) : false;
    const waitlistEnabled = (await configStore.getConfig('signup_waitlist_enabled')) ?? false;
    const consumerLoginMethods = (await configStore.getConfig('consumer_login_methods')) ?? ['password', 'google', 'microsoft'];
    // Connector-only mode blocks all web signups (org, consumer, OAuth) — hide
    // the "Create Account" button by reporting allowSignups=false below.
    const connectorOnly = (await configStore.getConfig('signup_connector_only')) ?? false;

    // Self-hosted deploys have a single tenant — surface its branding pre-auth
    // so the login page and initial loading screen can render the customer's
    // logo instead of Bee Flow's. Skipped on cloud where there's no single org.
    const deploymentMode = process.env.DEPLOYMENT_MODE || 'cloud';
    let branding = null;
    if (deploymentMode === 'self-hosted') {
        try {
            const orgs = await userStore.getAllOrganizations();
            const org = Array.isArray(orgs) ? orgs.find(o => o.logo || o.name) || orgs[0] : null;
            if (org) branding = { logo: org.logo || null, name: org.name || null };
        } catch (err) {
            log.warn('[Auth] setup-status — branding lookup failed:', err.message);
        }
    }

    res.json({
        isSetupComplete,
        isOAuthConfigured,
        isGoogleConfigured,
        isMicrosoftConfigured,
        serverUrl,
        deploymentMode,
        branding,
        allowSignups: (allowOrgSignups || allowConsumerSignups) && !connectorOnly,
        allowOrgSignups,
        allowConsumerSignups,
        connectorOnly,
        waitlistEnabled,
        consumerLoginMethods,
        allowPasswordLogin: process.env.ALLOW_PASSWORD_LOGIN !== 'false',
        availableLocales,
        // Bot protection for the signup form. { enabled:false } when no provider
        // is configured, which is the default; the site key is public by design
        // and the secret never leaves the server.
        signupCaptcha: signupCaptcha.publicConfig(),
        // The minimum the SPA should enforce client-side before submitting. The
        // server re-checks this and much more (breach list, identity-derived
        // passwords) — this only spares the user a round-trip.
        minPasswordLength: MIN_PASSWORD_LENGTH,
        // Self-hosted / white-label deploys can override the upgrade URL via
        // LICENSE_UPGRADE_URL. Frontend reads this once at boot.
        licenseUpgradeUrl: process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing',
    });
});

// Initial admin setup (set password for first time)
router.post('/setup', validate({ body: SetupBody }), async (req, res) => {
    const config = await loadConfig();

    // Only allow if password not set yet
    if (config.admin.passwordHash) {
        return res.status(400).json({ error: 'Setup already complete' });
    }

    const { password } = req.body;
    // The very first credential on the installation, and it belongs to the
    // super-admin — so the administrative minimum applies and the deny-list is
    // checked. `password` and `12345678` used to sail through the old
    // length-only gate here exactly as they did everywhere else.
    const policy = await validatePasswordAsync(password, { username: config.admin.username, isAdmin: true });
    if (!policy.ok) {
        return res.status(400).json({ error: policy.error, code: policy.code });
    }
    // Complexity on top, for this route only. NIST would drop it, and the
    // shared policy deliberately does not impose it — but it predates that
    // policy and removing an existing control while closing a password finding
    // would be a strange trade.
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Password must contain uppercase, lowercase, and a number' });
    }

    config.admin.passwordHash = await bcrypt.hash(password, 12);
    if (!await saveConfig({ admin: config.admin })) {
        return res.status(500).json({ error: 'Failed to save config' });
    }

    // Create admin user in the users table so DEK can be stored
    try {
        const existing = await userStore.getUser('admin');
        if (!existing) {
            await userStore.createUser({
                id: 'admin',
                username: 'admin',
                displayName: 'Administrator',
                passwordHash: config.admin.passwordHash,
                role: 'admin',
                groups: []
            });
        } else {
            // Update the password hash if admin row already exists
            await userStore.updateUser('admin', { passwordHash: config.admin.passwordHash });
        }

        // Generate per-user DEK (same as regular users) with recovery key
        const { createUserDEK, secureClear } = require('../encryption');
        const { dek, recoveryKey } = await createUserDEK('admin', password);
        secureClear(dek);

        log.info('[Auth] Admin DEK created with per-user Argon2id encryption');
        res.json({ success: true, recoveryKey });
    } catch (err) {
        log.error('[Auth] Admin DEK setup failed:', err.message);
        // Config was saved, so setup is complete, but DEK failed —
        // getOrCreateUserDEKCompat will create it on first login
        res.json({ success: true });
    }
});

module.exports = router;
