// @typecheck
/**
 * OAuth/SSO configuration API (admin only) — the instance-wide Nextcloud OAuth
 * settings, the per-provider client credentials, and the sso_saml gate that
 * guards the provider routes.
 */

const express = require('express');
const router = express.Router();

const { loadConfig, saveConfig, requireSuperAdmin, OAUTH_PROVIDERS } = require('../permissions');
const { tagGate } = require('../gateMeta');

// requireSsoProvider (the Nextcloud-exempt `sso_saml` gate) is defined lower in
// this file, just above the `/providers/:provider` route registrations that use
// it — see the "Provider-Specific Configuration API" section. Do NOT redeclare
// it here (a second declaration crashes module load with "Identifier
// 'requireSsoProvider' has already been declared").

// === OAuth/SSO Configuration API (Admin Only) ===

// Instance-wide SSO configuration: the OAuth client id/secret and the provider
// set for the whole installation, not for one tenant. Previously requireAdmin,
// which passes on 'manage_users' — a permission every org_admin holds — so an
// org admin could read and repoint the installation's identity provider.
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const secret = (what) => worded(`A ${what} must be text.`).max(4096, `That ${what} is too long.`).optional();

const OAuthConfigBody = z.object({
    nextcloudUrl: worded('A Nextcloud URL must be text.').trim().max(2048, 'That Nextcloud URL is too long.').optional(),
    clientId: worded('A client id must be text.').trim().max(512, 'That client id is too long.').optional(),
    clientSecret: secret('client secret'),
}).strict();

/**
 * Which keys each provider's configuration actually has. The handler branches
 * on `:provider` and reads a DIFFERENT set of keys in each branch, and nothing
 * refused a key the branch did not read — so the value was accepted, answered
 * "<provider> configuration saved", and dropped.
 *
 * On Microsoft that is not cosmetic. `tenantId` is what pins SSO to ONE
 * directory; when it is absent the configuration keeps (or falls back to)
 * `common`, the multi-tenant endpoint that accepts a sign-in from ANY Microsoft
 * tenant. A mis-typed `tenantID` therefore left the installation open to every
 * directory in the world while the administrator read "saved" on a form where
 * they had just restricted it to their own.
 */
const PROVIDER_KEYS = Object.freeze({
    nextcloud: ['url', 'clientId', 'clientSecret'],
    google: ['clientId', 'clientSecret'],
    microsoft: ['clientId', 'clientSecret', 'tenantId'],
});

const ProviderConfigBody = z.object({
    url: worded('A URL must be text.').trim().max(2048, 'That URL is too long.').optional(),
    clientId: worded('A client id must be text.').trim().max(512, 'That client id is too long.').optional(),
    clientSecret: secret('client secret'),
    tenantId: worded('A tenant id must be text.').trim().max(128, 'That tenant id is too long.').optional(),
}).strict();

router.get('/oauth-config', requireSuperAdmin, async (req, res) => {
    const config = await loadConfig();
    const oauth = config.oauth || {};

    res.json({
        enabled: !!oauth.nextcloudUrl,
        nextcloudUrl: oauth.nextcloudUrl || '',
        clientId: oauth.clientId || '',
        clientSecretSet: !!oauth.clientSecret
    });
});

router.put('/oauth-config', requireSuperAdmin, validate({ body: OAuthConfigBody }), async (req, res) => {
    const { nextcloudUrl, clientId, clientSecret } = req.body;

    const config = await loadConfig();
    config.oauth = config.oauth || {};

    if (nextcloudUrl !== undefined) config.oauth.nextcloudUrl = nextcloudUrl;
    if (clientId !== undefined) config.oauth.clientId = clientId;
    if (clientSecret && clientSecret.trim()) config.oauth.clientSecret = clientSecret;

    if (await saveConfig({ oauth: { nextcloudUrl, clientId, clientSecret } })) {
        res.json({
            success: true,
            message: 'OAuth configuration saved',
            enabled: !!config.oauth.nextcloudUrl
        });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

router.post('/oauth-config/test', requireSuperAdmin, async (req, res) => {
    const config = await loadConfig();
    const oauth = config.oauth || {};

    if (!oauth.nextcloudUrl) {
        return res.status(400).json({ error: 'Nextcloud URL not configured' });
    }

    try {
        const response = await fetch(`${oauth.nextcloudUrl}/status.php`);
        if (response.ok) {
            const data = /** @type {{ productname?: string, versionstring?: string }} */ (await response.json()); // Nextcloud status.php
            res.json({
                success: true,
                message: `Connected to ${data.productname || 'Nextcloud'} v${data.versionstring || 'unknown'}`
            });
        } else {
            res.status(400).json({ error: `Failed to connect: ${response.status}` });
        }
    } catch (err) {
        res.status(400).json({ error: `Connection failed: ${err.message}` });
    }
});

// === Provider-Specific Configuration API ===

router.get('/providers', requireSuperAdmin, async (req, res) => {
    const config = await loadConfig();
    const providers = config.providers || {};
    const oauth = config.oauth || {};

    res.json({
        nextcloud: {
            enabled: !!(oauth.nextcloudUrl && oauth.clientId && oauth.clientSecret),
            url: oauth.nextcloudUrl || '',
            clientId: oauth.clientId || '',
            clientSecretSet: !!oauth.clientSecret
        },
        google: {
            enabled: !!(providers.google?.clientId && providers.google?.clientSecret),
            clientId: providers.google?.clientId || '',
            clientSecretSet: !!providers.google?.clientSecret
        },
        microsoft: {
            enabled: !!(providers.microsoft?.clientId && providers.microsoft?.clientSecret),
            clientId: providers.microsoft?.clientId || '',
            clientSecretSet: !!providers.microsoft?.clientSecret,
            tenantId: providers.microsoft?.tenantId || 'common'
        }
    });
});

// Guards the /providers/:provider SSO routes. Two jobs:
//   1. Reject unknown providers with a 404 before the handler runs.
//   2. Tier-gate SSO: Nextcloud OAuth login is a Community feature
//      (`nextcloud_oauth`), so the Nextcloud provider stays reachable; Google /
//      Microsoft / SAML SSO are Enterprise (`sso_saml`) and 403 on Community.
// Defined ONCE here, just above the three /providers/:provider routes that
// reference it — do NOT redeclare it elsewhere (a second declaration crashes
// module load with "Identifier 'requireSsoProvider' has already been declared",
// which crash-looped the server). The licence middleware is required lazily +
// memoised so this file has no load-order dependency on it.
let _ssoSamlGate = null;
// Tagged (auth/gateMeta.js) so the route walk can see what this enforces.
// paramDependent because the verdict genuinely depends on :provider — Nextcloud
// OAuth is Community and passes, everything else needs the sso_saml capability.
// The Access Map renders this as "Depends on what is opened" rather than
// guessing one answer for every provider.
const requireSsoProvider = tagGate((req, res, next) => {
    const provider = (req.params.provider || '').toLowerCase();
    // `ssoLogin: false` marks an OAUTH_PROVIDERS entry that only exists so an
    // integration connector can share its endpoints (Withings). It is not an
    // identity provider, so it must 404 here rather than reach an SSO handler.
    if (provider !== 'nextcloud' && (!OAUTH_PROVIDERS[provider] || OAUTH_PROVIDERS[provider].ssoLogin === false)) {
        return res.status(404).json({ error: `Unknown SSO provider: ${provider}` });
    }
    // Nextcloud OAuth is Community — let it through. Everything else needs the
    // Enterprise `sso_saml` licence feature.
    if (provider === 'nextcloud') return next();
    if (!_ssoSamlGate) {
        // Unified gate — sso_saml is a non-togglable core capability, so the
        // resolver grants it implicitly whenever it's in the tier/plan ceiling
        // (equivalent to the old requireFeature, but on the one resolver).
        _ssoSamlGate = require('../../core/entitlements/entitlements').requireCapability('sso_saml');
    }
    return _ssoSamlGate(req, res, next);
}, { axis: 'capability', id: 'sso_saml', param: 'provider', paramDependent: true, note: 'Nextcloud OAuth is Community and exempt; every other provider needs sso_saml.' });

router.get('/providers/:provider', requireSuperAdmin, requireSsoProvider, async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const oauth = config.oauth || {};
        res.json({
            enabled: !!(oauth.nextcloudUrl && oauth.clientId && oauth.clientSecret),
            url: oauth.nextcloudUrl || '',
            clientId: oauth.clientId || '',
            clientSecretSet: !!oauth.clientSecret
        });
    } else if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        res.json({
            enabled: !!(providerConfig.clientId && providerConfig.clientSecret),
            clientId: providerConfig.clientId || '',
            clientSecretSet: !!providerConfig.clientSecret
        });
    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        res.json({
            enabled: !!(providerConfig.clientId && providerConfig.clientSecret),
            clientId: providerConfig.clientId || '',
            clientSecretSet: !!providerConfig.clientSecret,
            tenantId: providerConfig.tenantId || 'common'
        });
    } else {
        res.status(404).json({ error: 'Unknown provider' });
    }
});

router.put('/providers/:provider', requireSuperAdmin, requireSsoProvider, validate({ body: ProviderConfigBody }), async (req, res) => {
    const { provider } = req.params;
    // The schema knows the union of every provider's fields; only this branch
    // knows which of them THIS provider has. See PROVIDER_KEYS above for why a
    // key the branch does not read must not be answered with "saved".
    const belongs = PROVIDER_KEYS[provider];
    if (belongs) {
        const stray = Object.keys(req.body).filter((k) => !belongs.includes(k));
        if (stray.length > 0) {
            throw new HttpError(400, 'unknown_fields', `${provider} has no setting called ${stray.join(', ')}.`);
        }
    }
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const { url, clientId, clientSecret } = req.body;
        config.oauth = config.oauth || {};
        if (url !== undefined) config.oauth.nextcloudUrl = url;
        if (clientId !== undefined) config.oauth.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.oauth.clientSecret = clientSecret;

    } else if (provider === 'google') {
        const { clientId, clientSecret } = req.body;
        config.providers = config.providers || {};
        config.providers.google = config.providers.google || {};
        if (clientId !== undefined) config.providers.google.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.providers.google.clientSecret = clientSecret;

    } else if (provider === 'microsoft') {
        const { clientId, clientSecret, tenantId } = req.body;
        config.providers = config.providers || {};
        config.providers.microsoft = config.providers.microsoft || {};
        if (clientId !== undefined) config.providers.microsoft.clientId = clientId;
        if (clientSecret && clientSecret.trim()) config.providers.microsoft.clientSecret = clientSecret;
        if (tenantId !== undefined) {
            const tid = (tenantId || '').trim();
            const knownAliases = ['common', 'organizations', 'consumers', ''];
            const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid);
            if (!knownAliases.includes(tid.toLowerCase()) && !isGuid) {
                return res.status(400).json({ error: `Invalid Tenant ID "${tid}". Must be a GUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or one of: common, organizations, consumers` });
            }
            config.providers.microsoft.tenantId = tid || 'common';
        }

    } else {
        return res.status(404).json({ error: 'Unknown provider' });
    }

    if (await saveConfig(provider === 'nextcloud' ? { oauth: { ...req.body, nextcloudUrl: req.body.url, url: undefined } } : { providers: { [provider]: req.body } })) {
        res.json({ success: true, message: `${provider} configuration saved` });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

router.post('/providers/:provider/test', requireSuperAdmin, requireSsoProvider, async (req, res) => {
    const { provider } = req.params;
    const config = await loadConfig();

    if (provider === 'nextcloud') {
        const oauth = config.oauth || {};
        if (!oauth.nextcloudUrl) {
            return res.status(400).json({ error: 'Nextcloud URL not configured' });
        }
        try {
            const response = await fetch(`${oauth.nextcloudUrl}/status.php`);
            if (response.ok) {
                const data = /** @type {{ productname?: string, versionstring?: string }} */ (await response.json()); // Nextcloud status.php
                res.json({
                    success: true,
                    message: `Connected to ${data.productname || 'Nextcloud'} v${data.versionstring || 'unknown'}`
                });
            } else {
                res.status(400).json({ error: `Failed to connect: ${response.status}` });
            }
        } catch (err) {
            res.status(400).json({ error: `Connection failed: ${err.message}` });
        }

    } else if (provider === 'google') {
        const providerConfig = config.providers?.google || {};
        if (!providerConfig.clientId) {
            return res.status(400).json({ error: 'Google Client ID not configured' });
        }
        if (providerConfig.clientId.includes('.apps.googleusercontent.com')) {
            res.json({ success: true, message: 'Google OAuth credentials configured (format valid)' });
        } else {
            res.status(400).json({ error: 'Invalid Google Client ID format' });
        }

    } else if (provider === 'microsoft') {
        const providerConfig = config.providers?.microsoft || {};
        if (!providerConfig.clientId) {
            return res.status(400).json({ error: 'Microsoft Client ID not configured' });
        }
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (guidRegex.test(providerConfig.clientId)) {
            res.json({ success: true, message: 'Microsoft OAuth credentials configured (format valid)' });
        } else {
            res.status(400).json({ error: 'Invalid Microsoft Client ID format (should be a GUID)' });
        }

    } else {
        res.status(404).json({ error: 'Unknown provider' });
    }
});

module.exports = router;
