// @typecheck
/**
 * Admin Routes — deployment-wide configuration (super-admin only): default
 * org integrations, connector provisioning mode and the free-email-domain
 * blocklist. Split out of auth/adminRoutes.js; mounted there in the original
 * registration order.
 */

const express = require('express');
const router = express.Router();

const { requireSuperAdmin } = require('../permissions');
const freeEmailDomains = require('../../utils/freeEmailDomains');
const { ALL_INTEGRATIONS } = require('./integrationCatalog');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// Declared up here because the request schema names it in its refusal message;
// the route below documents what each mode means.
/** @type {[string, ...string[]]} */
const CONNECTOR_PROVISIONING_MODES = ['open', 'pairing_only'];

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const DEFAULTS_TEXT = 'Send a list of integration ids, or null for "all enabled".';
/**
 * `defaults` is REQUIRED, and the difference between `null` and absent matters
 * here: null means "every integration enabled", absent meant `setConfig(key,
 * undefined)`. So a body that mis-spelled the key erased the deployment-wide
 * default integration set for every organisation that had not overridden it,
 * and answered 200.
 */
const DefaultIntegrationsBody = z.object({
    defaults: z.array(worded('An integration id must be text.').trim().min(1, 'An integration id cannot be blank.'), {
        required_error: DEFAULTS_TEXT, invalid_type_error: DEFAULTS_TEXT,
    }).nullable(),
}).strict();

const MODE_TEXT = `mode must be one of ${CONNECTOR_PROVISIONING_MODES.join(', ')}, or null`;
const ConnectorModeBody = z.object({
    mode: z.enum(CONNECTOR_PROVISIONING_MODES, { errorMap: () => ({ message: MODE_TEXT }) }).nullable(),
}).strict();

const DOMAINS_TEXT = 'extra must be an array of domains';
const FreeEmailDomainsBody = z.object({
    extra: z.array(z.unknown(), { required_error: DOMAINS_TEXT, invalid_type_error: DOMAINS_TEXT })
        .max(500, 'too many domains (max 500)'),
}).strict();

// === Default Integrations Config (Super Admin Only) ===

const configStore = require('../../stores/configStore');

router.get('/default-integrations', requireSuperAdmin, async (req, res) => {
    const defaults = await configStore.getConfig('default_org_integrations') || null;
    // Include installed MCP servers
    let mcpIntegrations = [];
    try {
        const mcpStore = require('../../stores/mcpStore');
        const mcpServers = await mcpStore.listServers();
        mcpIntegrations = mcpServers.map(s => ({
            id: `mcp:${s.id}`,
            label: s.name,
            category: 'MCP servers',
            icon: s.icon || '🔌',
        }));
    } catch (e) { /* mcpStore not available */ }
    res.json({ integrations: [...ALL_INTEGRATIONS, ...mcpIntegrations], defaults });
});

router.put('/default-integrations', requireSuperAdmin, validate({ body: DefaultIntegrationsBody }), async (req, res) => {
    const { defaults } = req.body;
    // defaults = null means all enabled, or array of enabled IDs
    await configStore.setConfig('default_org_integrations', defaults);
    res.json({ success: true });
});

// Connector provisioning mode — governs whether an *unknown* Nextcloud may
// auto-create a fresh Bee Flow org via POST /auth/connector/bootstrap. See
// server/auth/connectorBootstrap.js (resolveProvisioningMode). `null`/unset
// means "use the deployment default" (open on Bee Flow Cloud, pairing_only on
// self-hosted). Returning binds, pairing codes and email-domain adoption are
// never affected by this setting.
router.get('/connector-provisioning-mode', requireSuperAdmin, async (req, res) => {
    const mode = await configStore.getConfig('connector_provisioning_mode');
    res.json({ mode: mode || null, allowed: CONNECTOR_PROVISIONING_MODES });
});

router.put('/connector-provisioning-mode', requireSuperAdmin, validate({ body: ConnectorModeBody }), async (req, res) => {
    const { mode } = req.body;
    await configStore.setConfig('connector_provisioning_mode', mode);
    res.json({ success: true });
});

// Free/public email-provider domains — the blocklist that stops a shared
// consumer domain (gmail.com, …) from auto-binding a user to an organisation
// via email-domain matching (OAuth login, Nextcloud connector, password
// signup). `builtin` is a non-removable safety floor; admins manage only the
// `extra` additions (stored under free_email_domains_extra). See
// server/utils/freeEmailDomains.js.
router.get('/free-email-domains', requireSuperAdmin, async (req, res) => {
    const extra = await freeEmailDomains.getExtraFreeEmailDomains();
    res.json({
        builtin: [...freeEmailDomains.FREE_EMAIL_DOMAINS].sort(),
        extra,
    });
});

router.put('/free-email-domains', requireSuperAdmin, validate({ body: FreeEmailDomainsBody }), async (req, res) => {
    const { extra } = req.body;
    // Normalise, drop built-in floor entries (implicit) and duplicates, and
    // reject anything that isn't a valid bare domain.
    const seen = new Set();
    const normalised = [];
    for (const item of extra) {
        const domain = freeEmailDomains.normalizeDomain(item);
        if (!domain) {
            return res.status(400).json({ error: `Invalid domain: "${String(item).slice(0, 100)}"` });
        }
        if (freeEmailDomains.FREE_EMAIL_DOMAINS.has(domain) || seen.has(domain)) continue;
        seen.add(domain);
        normalised.push(domain);
    }
    await configStore.setConfig(freeEmailDomains.EXTRA_CONFIG_KEY, normalised);
    res.json({ success: true, extra: normalised });
});

module.exports = router;
