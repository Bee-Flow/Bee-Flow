// @typecheck strict
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
// set for the whole installation, not for one tenant. Not requireAdmin,
// which passes on 'manage_users' — a permission every org_admin holds — so an
// org admin could read and repoint the installation's identity provider.
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
// The primary Microsoft app plus the additional sign-in connections (each its
// own tenant, app registration, label and logo): one module decides what a
// connection is, here and on the login routes.
const msConnections = require('./microsoftConnections.mts');

/** @param {string} what */
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
/** @type {Readonly<Record<string, string[]>>} */
const PROVIDER_KEYS = Object.freeze({
    nextcloud: ['url', 'clientId', 'clientSecret'],
    google: ['clientId', 'clientSecret'],
    microsoft: ['clientId', 'clientSecret', 'tenantId', 'label', 'logo', 'connections'],
});

// One additional Microsoft sign-in connection as the form sends it. The id is
// the form's (kept across saves so a typed secret stays with its row) or minted
// here when absent; the secret is only required for a connection that has none yet.
const MicrosoftConnectionBody = z.object({
    id: worded('A connection id must be text.').trim().max(32, 'That connection id is too long.').optional(),
    label: worded('A button text must be text.').trim().max(msConnections.MAX_LABEL_LENGTH, 'That button text is too long.'),
    logo: worded('A logo must be text.').max(2 * msConnections.MAX_LOGO_BYTES, 'That logo is too large.').optional(),
    clientId: worded('A client id must be text.').trim().min(1, 'A connection needs an Application (client) ID.').max(512, 'That client id is too long.'),
    clientSecret: secret('client secret'),
    tenantId: worded('A tenant id must be text.').trim().max(128, 'That tenant id is too long.').optional(),
}).strict();

const ProviderConfigBody = z.object({
    url: worded('A URL must be text.').trim().max(2048, 'That URL is too long.').optional(),
    clientId: worded('A client id must be text.').trim().max(512, 'That client id is too long.').optional(),
    clientSecret: secret('client secret'),
    tenantId: worded('A tenant id must be text.').trim().max(128, 'That tenant id is too long.').optional(),
    label: worded('A button text must be text.').trim().max(msConnections.MAX_LABEL_LENGTH, 'That button text is too long.').optional(),
    logo: worded('A logo must be text.').max(2 * msConnections.MAX_LOGO_BYTES, 'That logo is too large.').optional(),
    connections: z.array(MicrosoftConnectionBody, { error: 'The connections must be a list.' })
        .max(msConnections.MAX_CONNECTIONS, `At most ${msConnections.MAX_CONNECTIONS} additional connections.`).optional(),
}).strict();

/**
 * The Microsoft provider as the admin form reads it: never a secret, only
 * whether one is stored, for the primary and for every additional connection.
 * @param {msConnections.MicrosoftProviderConfig | undefined} pc
 */
function microsoftView(pc = {}) {
    return {
        enabled: !!(pc.clientId && pc.clientSecret),
        clientId: pc.clientId || '',
        clientSecretSet: !!pc.clientSecret,
        tenantId: pc.tenantId || 'common',
        label: pc.label || '',
        logo: pc.logo || '',
        connections: msConnections.connectionsOf({ providers: { microsoft: pc } }).map((c) => ({
            id: c.id, label: c.label || '', logo: c.logo || '', clientId: c.clientId || '',
            tenantId: c.tenantId || 'common', clientSecretSet: !!(c.clientSecret || c.hasClientSecret),
        })),
    };
}

/** @param {string} tid */
const tenantIdError = (tid) => new HttpError(400, 'invalid_tenant_id',
    `Invalid Tenant ID "${tid}". Must be a GUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) or one of: common, organizations, consumers`);

/**
 * The additional connections as they will be stored: ids minted or checked,
 * tenants normalised, logos checked, and a secret present for every new one.
 * @param {{ id?: string, label: string, logo?: string, clientId: string, clientSecret?: string, tenantId?: string }[]} supplied
 * @param {msConnections.MicrosoftConnection[]} existing
 */
function cleanConnections(supplied, existing) {
    const seen = new Set();
    return supplied.map((c, index) => {
        const id = c.id || msConnections.newConnectionId();
        if (!msConnections.isValidConnectionId(id)) throw new HttpError(400, 'invalid_connection_id', `Connection ${index + 1} has an invalid id.`);
        if (seen.has(id)) throw new HttpError(400, 'duplicate_connection_id', `Connection ${index + 1} repeats the id of another connection.`);
        seen.add(id);
        const tenantId = msConnections.normalizeTenantId(c.tenantId);
        if (tenantId === null) throw tenantIdError(String(c.tenantId));
        if (c.logo !== undefined && !msConnections.isValidLogo(c.logo)) {
            throw new HttpError(400, 'invalid_logo', `The logo of connection ${index + 1} must be a PNG, JPEG, GIF, WebP or SVG image of at most ${msConnections.MAX_LOGO_BYTES / 1024} KB.`);
        }
        const previous = existing.find((e) => e.id === id);
        const hasSecret = !!(c.clientSecret && c.clientSecret.trim()) || !!(previous && (previous.clientSecret || previous.hasClientSecret));
        if (!hasSecret) throw new HttpError(400, 'connection_secret_required', `Connection ${index + 1} ("${c.label || c.clientId}") needs a client secret.`);
        return { id, label: c.label, logo: c.logo, clientId: c.clientId, clientSecret: c.clientSecret, tenantId };
    });
}

/**
 * What a PUT on the Microsoft provider stores. Throws a 400 that names the
 * field; nothing is written before every field was understood.
 * @param {{ clientId?: string, clientSecret?: string, tenantId?: string, label?: string, logo?: string, connections?: { id?: string, label: string, logo?: string, clientId: string, clientSecret?: string, tenantId?: string }[] }} body
 * @param {msConnections.MicrosoftProviderConfig} current
 */
function microsoftPatch(body, current) {
    const { clientId, clientSecret, tenantId, label, logo, connections } = body;
    /** @type {Record<string, unknown>} */
    const patch = { clientId, clientSecret, label };
    if (tenantId !== undefined) {
        const tid = msConnections.normalizeTenantId(tenantId);
        if (tid === null) throw tenantIdError(tenantId.trim());
        patch.tenantId = tid;
    }
    if (logo !== undefined) {
        if (!msConnections.isValidLogo(logo)) throw new HttpError(400, 'invalid_logo', `The logo must be a PNG, JPEG, GIF, WebP or SVG image of at most ${msConnections.MAX_LOGO_BYTES / 1024} KB.`);
        patch.logo = logo;
    }
    if (connections !== undefined) {
        patch.connections = cleanConnections(connections, msConnections.connectionsOf({ providers: { microsoft: current } }));
    }
    return patch;
}

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

    if (!(await saveConfig({ oauth: { nextcloudUrl, clientId, clientSecret } }))) {
        throw new Error('Failed to save the OAuth configuration');
    }
    res.json({
        success: true,
        message: 'OAuth configuration saved',
        enabled: !!config.oauth.nextcloudUrl
    });
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
        microsoft: microsoftView(providers.microsoft),
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
/** @type {import('express').RequestHandler | null} */
/** @type {import('express').RequestHandler | null} */
let _ssoSamlGate = null;
// Tagged (auth/gateMeta.js) so the route walk can see what this enforces.
// paramDependent because the verdict genuinely depends on :provider — Nextcloud
// OAuth is Community and passes, everything else needs the sso_saml capability.
// The Access Map renders this as "Depends on what is opened" rather than
// guessing one answer for every provider.
const requireSsoProvider = tagGate((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
    const provider = (/** @type {string} */ (req.params.provider) || '').toLowerCase();
    // `ssoLogin: false` marks an OAUTH_PROVIDERS entry that only exists so an
    // integration connector can share its endpoints (Withings). It is not an
    // identity provider, so it must 404 here rather than reach an SSO handler.
    if (provider !== 'nextcloud' && (!/** @type {Record<string, { ssoLogin?: boolean }>} */ (OAUTH_PROVIDERS)[provider] || /** @type {Record<string, { ssoLogin?: boolean }>} */ (OAUTH_PROVIDERS)[provider].ssoLogin === false)) {
        return res.status(404).json({ error: `Unknown SSO provider: ${provider}` });
    }
    // Nextcloud OAuth is Community — let it through. Everything else needs the
    // Enterprise `sso_saml` licence feature.
    if (provider === 'nextcloud') return next();
    // Unified gate — sso_saml is a non-togglable core capability, so the
    // resolver grants it implicitly whenever it's in the tier/plan ceiling
    // (equivalent to the old requireFeature, but on the one resolver).
    const gate = _ssoSamlGate || (_ssoSamlGate = require('../../core/entitlements/entitlements').requireCapability('sso_saml'));
    return gate(req, res, next);
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
        res.json(microsoftView(config.providers?.microsoft));
    } else {
        res.status(404).json({ error: 'Unknown provider' });
    }
});

router.put('/providers/:provider', requireSuperAdmin, requireSsoProvider, validate({ body: ProviderConfigBody }), async (req, res) => {
    const { provider } = /** @type {Record<string, string>} */ (req.params);
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
    /** @type {Record<string, unknown> | undefined} */
    let providerPatch;

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
        providerPatch = microsoftPatch(req.body, config.providers?.microsoft || {});

    } else {
        return res.status(404).json({ error: 'Unknown provider' });
    }

    const update = provider === 'nextcloud'
        ? { oauth: { ...req.body, nextcloudUrl: req.body.url, url: undefined } }
        : { providers: { [provider]: providerPatch || req.body } };
    if (!(await saveConfig(update))) {
        throw new Error(`Failed to save the ${provider} SSO configuration`);
    }
    res.json({ success: true, message: `${provider} configuration saved` });
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
