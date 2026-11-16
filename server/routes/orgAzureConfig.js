// @typecheck strict
/**
 * Organization Azure Configuration API
 *
 * GET and PUT /:orgId read and write the SAME global Azure configuration the
 * admin dashboard sets: the platform's Azure OpenAI endpoint and key, chat-model
 * tiers, Microsoft SSO app, PII defaults and document processing. That state is
 * instance-wide, so both routes take the platform-admin gate in every
 * deployment mode (platformConfigGate). The Microsoft SSO app also needs the
 * `sso_saml` capability, as Security > SSO does: the `sso` save is refused
 * without it and the read leaves its fields out (ssoSectionGate,
 * microsoftSsoView). The org's own `autoApproveSSO` flag rides
 * along in the `sso` section; an org admin sets it in the organisation settings
 * (auth/admin/orgRoutes.js). The group-sync routes are org-scoped and keep the
 * strict org-admin check for the organisation in the path (isOrgAdmin); their
 * status read answers through orgAzureSyncView.js, without configuration values.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { loadConfig, saveConfig, isSuperAdmin } = require('../auth/permissions');
const { tagGate } = require('../auth/gateMeta');
const { PLATFORM_GATE } = require('../auth/requirePlatformAdmin');
const { syncAzureGroupsToOrg, getSyncSettings, setSyncSettings, getSyncStatus, getSyncBinding, assertSyncBinding } = require('../integrations/azureGroupSync');
const { groupSyncView } = require('../usecases/orgAzureSyncView');
const { validate } = require('../core/http/validate');
const { forbidden } = require('../core/http/errors');
// What a caller may send, and why each save is a closed schema: orgAzureConfigSchemas.mts.
const { ConfigBody, SyncSettingsBody, NoBody, PANEL_TIERS } = require('./orgAzureConfigSchemas.mts');

// requireAuth is the canonical gate (verifies the user still exists in the DB,
// cached 5s, and destroys deleted-user sessions). isOrgAdminForOrg: platform
// admins pass for any org; otherwise the exact ORG_ADMIN orgRole of that org
// (not the legacy 'admin' orgRole variant) or an admin-carrying group of it.
const { requireAuth, isOrgAdminForOrg } = require('../auth/permissions');
/** @param {import('express').Request} req @param {string} orgId */
const isOrgAdmin = (req, orgId) => isOrgAdminForOrg(req, orgId, { strictOrgRole: true });

/**
 * The platform configuration is a platform admin's, in every deployment mode
 * (see the header). Tagged on the platform axis, so the route contract reads
 * the two routes behind it as platform-class.
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
function platformConfigGate(req, _res, next) {
    if (isSuperAdmin(req)) return next();
    return next(forbidden('platform_managed',
        'On this deployment the Azure configuration is managed by the platform administrator.'));
}
tagGate(platformConfigGate, PLATFORM_GATE);

// ── Microsoft SSO is Enterprise ─────────────────────────────────────
//
// The `sso` section writes the Microsoft app of the sign-in (providers.microsoft),
// the same one Security > SSO > Microsoft writes behind the `sso_saml` capability
// (auth/oauth/ssoConfigRoutes.js). Without that gate here, a Community install
// could save a Microsoft sign-in the login routes then refuse. The other sections
// are not sign-in and stay open to the platform admin.
const SSO_CAPABILITY = 'sso_saml';
/** @type {typeof import('../core/entitlements/entitlements') | null} */
let _entitlements = null;
// Required lazily: the entitlements module pulls in the licence and the stores.
const entitlements = () => _entitlements || (_entitlements = require('../core/entitlements/entitlements'));
/** @type {import('express').RequestHandler | null} */
let _ssoGate = null;

/**
 * The `sso_saml` gate, for the `sso` section of the save only. Runs after the
 * body schema, so `section` is one of the known five.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function ssoSectionGate(req, res, next) {
    if (req.body?.section !== 'sso') return next();
    const gate = _ssoGate || (_ssoGate = entitlements().requireCapability(SSO_CAPABILITY));
    return gate(req, res, next);
}
tagGate(ssoSectionGate, {
    axis: 'capability', id: SSO_CAPABILITY, param: 'section', paramDependent: true,
    note: 'Only the sso section of the body needs sso_saml; the other sections are not sign-in.',
});

/**
 * The Microsoft sign-in app as the read shows it: its fields only with the
 * `sso_saml` capability (the panel hides the section without it), and whether
 * the caller has it. The organisation's own auto-approve flag rides along in
 * every case: the Users screen sets it too.
 * @param {import('express').Request} req
 * @param {{ clientId?: string, clientSecret?: string, tenantId?: string }} msProvider
 */
async function microsoftSsoView(req, msProvider) {
    const user = req.session?.user;
    const ssoAvailable = await entitlements().hasCapability(SSO_CAPABILITY, {
        userId: user?.id || null,
        orgId: user?.organizationId || user?.orgId || null,
        session: req.session,
        req,
    });
    if (!ssoAvailable) return { ssoAvailable };
    return {
        ssoAvailable,
        ssoClientId: msProvider.clientId || '',
        hasSsoClientSecret: !!msProvider.clientSecret,
        ssoClientSecretMasked: maskSecret(msProvider.clientSecret),
        ssoTenantId: msProvider.tenantId || 'common',
    };
}

/**
 * Helper: Mask a secret for display (show last 4 chars)
 * @param {string | null | undefined} value
 */
function maskSecret(value) {
    if (!value) return '';
    return '••••' + value.slice(-4);
}

/**
 * Helper: Get the global AI config (same as admin dashboard)
 */
async function getAIConfig() {
    const raw = await configStore.getConfig('ai');
    return raw || {};
}

// GET /:orgId — get Azure config (reads global platform config)
router.get('/:orgId', requireAuth, platformConfigGate, /** @param {import('express').Request<{ orgId: string }>} req */ async (req, res) => {
    const { orgId } = req.params;

    // Must be member of org or super admin
    const orgIds = await resolveUserOrgIds(req);
    const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

    // Must be org admin to view config
    const admin = await isOrgAdmin(req, orgId);
    if (!admin) return res.status(403).json({ error: 'Only organization admins can view Azure configuration' });

    const config = await getAIConfig();

    // Azure OpenAI — global keys (same as admin dashboard)
    const azureEndpoint = await configStore.getConfig('azure_endpoint') || '';
    const azureApiKey = await configStore.getSecret('azure_api_key');
    const azureModels = await configStore.getConfig('azure_models') || '';

    // Chat Model Tiers — same config key as GET /ai/config/chat-models
    const chatModelTiers = await configStore.getConfig('chat_model_tiers') || {
        fast: { modelId: '', label: 'Fast' },
        thinking: { modelId: '', label: 'Thinking' },
        writer: { modelId: '', label: 'Writer' },
        pro: { modelId: '', label: 'Deep Thinking' }
    };
    if (!chatModelTiers.writer) chatModelTiers.writer = { modelId: '', label: 'Writer' };

    // Azure Document Processing
    const azureDocEndpoint = await configStore.getConfig('azure_doc_intelligence_endpoint') || '';
    const azureDocKey = await configStore.getSecret('azure_doc_intelligence_key');
    const azureEmbedEndpoint = await configStore.getConfig('azure_openai_embedding_endpoint') || '';
    const azureEmbedKey = await configStore.getSecret('azure_openai_embedding_key');
    const azureEmbedModel = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
    const useAzureDocProcessing = await configStore.getConfig('use_azure_doc_processing');

    // SSO / Microsoft provider config
    const authConfig = await loadConfig();
    const msProvider = authConfig.providers?.microsoft || {};
    const org = await userStore.getOrganization(orgId);

    // PII Detection — from ai blob
    res.json({
        // Azure OpenAI
        azureEndpoint,
        hasAzureApiKey: !!azureApiKey,
        azureApiKeyMasked: maskSecret(azureApiKey),
        azureModels,

        // Chat Model Tiers
        chatModelTiers,

        // PII Detection
        piiDetectionEnabled: config.piiDetectionEnabled === true || config.piiDetectionEnabled === 'true',
        piiDetectionCategories: config.piiDetectionCategories || null,
        piiDetectionConfidenceThreshold: config.piiDetectionConfidenceThreshold ?? 0.7,
        piiDetectionScope: config.piiDetectionScope || { userInput: true, agentOutput: false },
        piiDetectionAction: config.piiDetectionAction || 'block',

        // Azure Document Processing
        azureDocEndpoint,
        hasAzureDocEndpoint: !!azureDocEndpoint,
        hasAzureDocKey: !!azureDocKey,
        azureEmbedEndpoint,
        hasAzureEmbedEndpoint: !!azureEmbedEndpoint,
        hasAzureEmbedKey: !!azureEmbedKey,
        azureEmbedModel,
        useAzureDocProcessing: !!useAzureDocProcessing,

        // Microsoft SSO (its app only with sso_saml)
        ...(await microsoftSsoView(req, msProvider)),
        autoApproveSSO: org?.autoApproveSSO || false,

        // Group Sync settings & status
        groupSyncSettings: await getSyncSettings(orgId),
        groupSyncStatus: await getSyncStatus(orgId),
    });
});

// PUT /:orgId — save Azure config (writes to global platform config — same keys as admin dashboard)
router.put('/:orgId', requireAuth, platformConfigGate, validate({ body: ConfigBody }), ssoSectionGate, /** @param {import('express').Request<{ orgId: string }>} req */ async (req, res) => {
    const { orgId } = req.params;
    const admin = await isOrgAdmin(req, orgId);
    if (!admin) {
        return res.status(403).json({ error: 'Only organization admins can manage Azure configuration' });
    }

    const { section } = req.body;

    // Save by section — uses the same global keys as POST /ai/config
    if (section === 'openai') {
        const { azureEndpoint, azureApiKey, azureModels } = req.body;
        if (azureEndpoint !== undefined) await configStore.setConfig('azure_endpoint', azureEndpoint || '');
        if (azureApiKey !== undefined) await configStore.setSecret('azure_api_key', azureApiKey || '');
        if (azureModels !== undefined) await configStore.setConfig('azure_models', azureModels || '');
    }

    if (section === 'chatModels') {
        // Merged over what is stored: this key also holds the tiers this
        // panel does not show (standard, swarm), and a save must not drop them.
        const stored = (await configStore.getConfig('chat_model_tiers')) || {};
        const tiers = { ...stored, ...req.body.chatModelTiers };
        for (const [name, label] of Object.entries(PANEL_TIERS)) {
            if (!tiers[name]) tiers[name] = { modelId: '', label };
        }
        await configStore.setConfig('chat_model_tiers', tiers);
    }

    if (section === 'piiDetection') {
        const { piiDetectionEnabled, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionScope, piiDetectionAction } = req.body;
        const config = await getAIConfig();
        if (piiDetectionEnabled !== undefined) config.piiDetectionEnabled = piiDetectionEnabled;
        if (piiDetectionCategories !== undefined) config.piiDetectionCategories = piiDetectionCategories;
        if (piiDetectionConfidenceThreshold !== undefined) config.piiDetectionConfidenceThreshold = piiDetectionConfidenceThreshold;
        if (piiDetectionScope !== undefined) config.piiDetectionScope = piiDetectionScope;
        if (piiDetectionAction !== undefined) config.piiDetectionAction = piiDetectionAction;
        await configStore.setConfig('ai', config);
    }

    if (section === 'docProcessing') {
        // `useAzureDocProcessing` is a real boolean now (the schema), so the
        // ternary below reads it rather than its truthiness.
        const { useAzureDocProcessing, azureDocIntelligenceEndpoint, azureDocIntelligenceKey, azureOpenaiEmbeddingEndpoint, azureOpenaiEmbeddingKey, azureOpenaiEmbeddingModel } = req.body;
        if (useAzureDocProcessing !== undefined) {
            await configStore.setConfig('use_azure_doc_processing', useAzureDocProcessing ? 'true' : '');
        }
        if (azureDocIntelligenceEndpoint !== undefined) {
            await configStore.setConfig('azure_doc_intelligence_endpoint', azureDocIntelligenceEndpoint || '');
        }
        if (azureDocIntelligenceKey !== undefined) {
            await configStore.setSecret('azure_doc_intelligence_key', azureDocIntelligenceKey || '');
        }
        if (azureOpenaiEmbeddingEndpoint !== undefined) {
            await configStore.setConfig('azure_openai_embedding_endpoint', azureOpenaiEmbeddingEndpoint || '');
        }
        if (azureOpenaiEmbeddingKey !== undefined) {
            await configStore.setSecret('azure_openai_embedding_key', azureOpenaiEmbeddingKey || '');
        }
        if (azureOpenaiEmbeddingModel !== undefined) {
            await configStore.setConfig('azure_openai_embedding_model', azureOpenaiEmbeddingModel || 'text-embedding-3-small');
        }
    }

    if (section === 'sso') {
        // The tenant id is checked by the schema (GUID or a known alias).
        const { ssoClientId, ssoClientSecret, ssoTenantId, autoApproveSSO } = req.body;
        await saveConfig({ providers: { microsoft: {
            ...(ssoClientId !== undefined ? { clientId: ssoClientId } : {}),
            ...(ssoClientSecret ? { clientSecret: ssoClientSecret } : {}),
            ...(ssoTenantId !== undefined ? { tenantId: ssoTenantId || 'common' } : {}),
        } } });

        // Update org-level autoApproveSSO flag
        if (autoApproveSSO !== undefined) {
            await userStore.updateOrganization(orgId, { autoApproveSSO });
        }
    }

    log.info(`[OrgAzureConfig] Saved ${section || 'config'} for org ${orgId} by ${req.session.user?.id}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// ── Azure AD Group Sync Endpoints ─────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * The strict org-admin check of the organisation in the path (a platform admin
 * passes for any), BEFORE the directory binding is looked at: a caller who
 * administers nothing here learns nothing about which organisation it is bound to.
 * @param {string} message
 */
const syncAdmin = (message) => tagGate(/** @param {import('express').Request<{ orgId: string }>} req @param {import('express').Response} res @param {import('express').NextFunction} next */ async (req, res, next) => {
    if (await isOrgAdmin(req, req.params.orgId)) return next();
    return res.status(403).json({ error: message });
}, { axis: 'scope', kind: 'orgAdminOfParam', param: 'orgId', paramDependent: true });
/** @param {import('express').Request<{ orgId: string }>} req @param {import('express').Response} _res @param {import('express').NextFunction} next */
const boundOrg = async (req, _res, next) => { await assertSyncBinding(req.params.orgId); next(); };

// POST /:orgId/sync-groups — trigger a sync
router.post('/:orgId/sync-groups', requireAuth, syncAdmin('Only organization admins can trigger group sync'), boundOrg, validate({ body: NoBody }), /** @param {import('express').Request<{ orgId: string }>} req */ async (req, res) => {
    const { orgId } = req.params;
    log.info(`[AzureGroupSync] Sync triggered for org ${orgId} by ${req.session.user?.id}`);
    const result = await syncAzureGroupsToOrg(orgId);
    res.json(result);
});

// GET /:orgId/sync-groups/status — the last run, the settings and whether a
// directory is connected for this org; no configuration value (orgAzureSyncView.js).
router.get('/:orgId/sync-groups/status', requireAuth, syncAdmin('Only organization admins can view sync status'), /** @param {import('express').Request<{ orgId: string }>} req */ async (req, res) => {
    const { orgId } = req.params;
    const microsoft = (await loadConfig()).providers?.microsoft;
    res.json(groupSyncView({
        orgId, status: await getSyncStatus(orgId), settings: await getSyncSettings(orgId), binding: await getSyncBinding(), microsoft,
    }));
});

// PUT /:orgId/sync-groups/settings — update sync settings
router.put('/:orgId/sync-groups/settings', requireAuth, syncAdmin('Only organization admins can manage sync settings'), boundOrg, validate({ body: SyncSettingsBody }), /** @param {import('express').Request<{ orgId: string }>} req */ async (req, res) => {
    const { orgId } = req.params;
    // Only the keys that were sent: the schema adds no absent ones, and
    // setSyncSettings merges over what is stored.
    const updates = { ...req.body };

    const settings = await setSyncSettings(orgId, updates);
    log.info(`[AzureGroupSync] Settings updated for org ${orgId} by ${req.session.user?.id}:`, updates);
    res.json({ ok: true, settings });
});

module.exports = router;
