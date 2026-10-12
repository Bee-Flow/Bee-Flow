/**
 * Organization Azure Configuration API
 *
 * On self-hosted installs, org admins can view and manage the SAME global
 * Azure configuration that platform admins set in the admin dashboard.
 * This avoids config duplication — there's one source of truth.
 *
 * "Self-hosted" is load-bearing, and the server now says so rather than only
 * the SPA (which hides this panel on cloud): GET and PUT /:orgId read and
 * write the PLATFORM's Azure OpenAI endpoint and key, its Microsoft SSO app
 * and its PII defaults. On the multi-tenant cloud any org admin could rewrite
 * them for every tenant — point every Azure call at their own endpoint, swap
 * the SSO app, switch the platform PII default — and read the platform's
 * endpoints and the tail of its keys. There, only a platform admin passes.
 * The group-sync routes below stay org-scoped and are not gated this way.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { loadConfig, saveConfig, isSuperAdmin } = require('../auth/permissions');
const { syncAzureGroupsToOrg, getSyncSettings, setSyncSettings, getSyncStatus, assertSyncBinding } = require('../integrations/azureGroupSync');
const { validate } = require('../core/http/validate');
const { forbidden } = require('../core/http/errors');
const { z } = require('zod');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

/**
 * Check if the current user is an admin for the given org.
 * Platform super admins can manage any org.
 */
const { isOrgAdminForOrg } = require('../auth/permissions');
// orgAzureConfig historically required the exact ORG_ADMIN orgRole (it does
// not accept the legacy 'admin' orgRole variant) — preserve that strictness.
const isOrgAdmin = (req, orgId) => isOrgAdminForOrg(req, orgId, { strictOrgRole: true });

/**
 * The platform configuration is an org admin's on a self-hosted install only
 * (see the header); on any other deployment only a platform admin passes.
 */
function platformConfigGate(req, _res, next) {
    const { deploymentMode } = require('../license');
    if (deploymentMode() === 'self-hosted' || isSuperAdmin(req)) return next();
    return next(forbidden('platform_managed',
        'On this deployment the Azure configuration is managed by the platform administrator.'));
}

// ── What a caller may send ──────────────────────────────────────────
//
// The save is one PUT with a `section`, and every section writes GLOBAL keys.
// It read the body key by key, so a mistake was never refused:
//
//   - an unknown `section` ('SSO', 'opnai') matched no branch and answered
//     `{ ok: true }` — "Saved" in the panel, nothing written. So did a key
//     sent under the wrong section, or misspelled;
//   - `!!x` read the STRING "false" as true: `useAzureDocProcessing: "false"`
//     switched document processing ON (documents start going to Azure),
//     `autoApproveSSO: "false"` auto-approved every Microsoft sign-in into the
//     organisation, `piiDetectionEnabled: "false"` switched PII detection on;
//   - `chatModelTiers` was rebuilt from four tier names, so a save DROPPED the
//     `standard` and `swarm` tiers the admin dashboard keeps in the same key —
//     and every agent on `tier:standard` fell back to the fast model. A tier
//     map with a misspelled name reset the four to empty. Tiers not sent are
//     now kept, and a tier name nothing reads is refused;
//   - on the sync settings, `destructiveSync: "false"` switched DESTRUCTIVE
//     sync on — group memberships removed on the next run — and an interval
//     outside 1..168 hours was silently not saved.
//
// Inside a tier the object stays OPEN (modelId, label, maxTokens, temperature,
// reasoning knobs): it is the model-tier config the admin dashboard owns too.
// An empty or absent secret keeps the stored one, as the screens rely on.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);

/** An enum whose refusal is one sentence, for a wrong value as well as a wrong type. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` }).optional();
const text = (name) => worded(`${name} is text.`).trim().optional();

/** An address the SDK can call, or '' to clear it. */
const endpoint = (name) => {
    const message = `${name} is an https:// address, or empty to clear it.`;
    return worded(message).trim().refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), message).optional();
};

const TIER_NAMES = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro',
    // A hand-written legacy alias that still wins where someone set it
    // (core/meetingNotes/summaryHelpers.js), so it has to survive a save.
    'smart'];
const TIER_TEXT = 'A tier is an object: { modelId, … }.';
const Tier = z.object({
    modelId: z.string({ invalid_type_error: 'A tier\'s modelId is text.' }).optional(),
    label: z.string({ invalid_type_error: 'A tier\'s label is text.' }).optional(),
}, { invalid_type_error: TIER_TEXT }).passthrough();
const TIERS_TEXT = `chatModelTiers is a map of tiers: ${TIER_NAMES.join(', ')}.`;
const TierMap = z.object(Object.fromEntries(TIER_NAMES.map((n) => [n, Tier.optional()])),
    { required_error: TIERS_TEXT, invalid_type_error: TIERS_TEXT }).strict();
/** The four this panel shows, as a save always wrote them when absent. */
const PANEL_TIERS = { fast: 'Fast', thinking: 'Thinking', writer: 'Writer', pro: 'Deep Thinking' };

const PII_ACTIONS = ['block', 'tokenize', 'warn'];
const TENANT_ALIASES = ['common', 'organizations', 'consumers'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_TEXT = 'ssoTenantId is your directory (tenant) GUID, or one of common, organizations, consumers.';
const THRESHOLD_TEXT = 'piiDetectionConfidenceThreshold is a number from 0 to 1.';
const CATEGORY_TEXT = 'piiDetectionCategories is a list of categories, or null for all of them.';

const section = (name, shape) => z.object({ section: z.literal(name), ...shape }).strict();

const SECTION_TEXT = 'section is one of openai, chatModels, piiDetection, docProcessing or sso.';
const ConfigBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.discriminatedUnion('section', [
        section('openai', {
            azureEndpoint: endpoint('azureEndpoint'),
            azureApiKey: text('azureApiKey'),
            // Accepted and ignored: Azure runs on the v1 GA API, which has no
            // api-version, and installed apps older than that still send it.
            azureApiVersion: text('azureApiVersion'),
            azureModels: text('azureModels'),
        }),
        section('chatModels', { chatModelTiers: TierMap }),
        section('piiDetection', {
            piiDetectionEnabled: flag('piiDetectionEnabled'),
            piiDetectionCategories: z.array(worded(CATEGORY_TEXT).trim().min(1, CATEGORY_TEXT),
                { invalid_type_error: CATEGORY_TEXT }).nullable().optional(),
            piiDetectionConfidenceThreshold: z.number({ invalid_type_error: THRESHOLD_TEXT })
                .min(0, THRESHOLD_TEXT).max(1, THRESHOLD_TEXT).optional(),
            piiDetectionScope: z.object({
                userInput: flag('piiDetectionScope.userInput'),
                agentOutput: flag('piiDetectionScope.agentOutput'),
            }, { invalid_type_error: 'piiDetectionScope is { userInput, agentOutput }, each true or false.' })
                .strict().optional(),
            piiDetectionAction: choice(PII_ACTIONS, `piiDetectionAction is one of ${PII_ACTIONS.join(', ')}.`).optional(),
        }),
        section('docProcessing', {
            useAzureDocProcessing: flag('useAzureDocProcessing'),
            azureDocIntelligenceEndpoint: endpoint('azureDocIntelligenceEndpoint'),
            azureDocIntelligenceKey: text('azureDocIntelligenceKey'),
            azureOpenaiEmbeddingEndpoint: endpoint('azureOpenaiEmbeddingEndpoint'),
            azureOpenaiEmbeddingKey: text('azureOpenaiEmbeddingKey'),
            azureOpenaiEmbeddingModel: text('azureOpenaiEmbeddingModel'),
        }),
        section('sso', {
            ssoClientId: text('ssoClientId'),
            ssoClientSecret: text('ssoClientSecret'),
            ssoTenantId: worded(TENANT_TEXT).trim()
                .refine((v) => v === '' || TENANT_ALIASES.includes(v.toLowerCase()) || GUID.test(v), TENANT_TEXT)
                .optional(),
            autoApproveSSO: flag('autoApproveSSO'),
        }),
    ], {
        errorMap: (issue, ctx) => ({
            message: issue.code === 'invalid_union_discriminator' ? SECTION_TEXT
                : issue.code === 'invalid_type' ? 'Send the settings as a JSON object.'
                    : ctx.defaultError,
        }),
    }),
);

const INTERVAL_TEXT = 'syncIntervalHours is a whole number of hours from 1 to 168.';
const SyncSettingsBody = bodyOf({
    destructiveSync: flag('destructiveSync'),
    autoActivateUsers: flag('autoActivateUsers'),
    periodicSync: flag('periodicSync'),
    syncIntervalHours: z.number({ invalid_type_error: INTERVAL_TEXT })
        .int(INTERVAL_TEXT).min(1, INTERVAL_TEXT).max(168, INTERVAL_TEXT).optional(),
});

/** A sync run takes no options — a `dryRun` it ignored would still run for real. */
const NoBody = bodyOf({});

/**
 * Helper: Mask a secret for display (show last 4 chars)
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
router.get('/:orgId', requireAuth, platformConfigGate, async (req, res) => {
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

        // Microsoft SSO
        ssoClientId: msProvider.clientId || '',
        hasSsoClientSecret: !!msProvider.clientSecret,
        ssoClientSecretMasked: maskSecret(msProvider.clientSecret),
        ssoTenantId: msProvider.tenantId || 'common',
        autoApproveSSO: org?.autoApproveSSO || false,

        // Group Sync settings & status
        groupSyncSettings: await getSyncSettings(orgId),
        groupSyncStatus: await getSyncStatus(orgId),
    });
});

// PUT /:orgId — save Azure config (writes to global platform config — same keys as admin dashboard)
router.put('/:orgId', requireAuth, platformConfigGate, validate({ body: ConfigBody }), async (req, res) => {
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

    log.info(`[OrgAzureConfig] Saved ${section || 'config'} for org ${orgId} by ${req.session.user.id}`);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// ── Azure AD Group Sync Endpoints ─────────────────────────
// ═══════════════════════════════════════════════════════════

// POST /:orgId/sync-groups — trigger a sync
router.post('/:orgId/sync-groups', requireAuth, async (req, _res, next) => { await assertSyncBinding(req.params.orgId); next(); }, validate({ body: NoBody }), async (req, res) => {
    const { orgId } = req.params;
    const admin = await isOrgAdmin(req, orgId);
    if (!admin) {
        return res.status(403).json({ error: 'Only organization admins can trigger group sync' });
    }

    log.info(`[AzureGroupSync] Sync triggered for org ${orgId} by ${req.session.user.id}`);
    const result = await syncAzureGroupsToOrg(orgId);
    res.json(result);
});

// GET /:orgId/sync-groups/status — get last sync status
router.get('/:orgId/sync-groups/status', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    const admin = await isOrgAdmin(req, orgId);
    if (!admin) {
        return res.status(403).json({ error: 'Only organization admins can view sync status' });
    }

    const status = await getSyncStatus(orgId);
    const settings = await getSyncSettings(orgId);
    res.json({ status, settings });
});

// PUT /:orgId/sync-groups/settings — update sync settings
router.put('/:orgId/sync-groups/settings', requireAuth, async (req, _res, next) => { await assertSyncBinding(req.params.orgId); next(); }, validate({ body: SyncSettingsBody }), async (req, res) => {
    const { orgId } = req.params;
    const admin = await isOrgAdmin(req, orgId);
    if (!admin) {
        return res.status(403).json({ error: 'Only organization admins can manage sync settings' });
    }

    // Only the keys that were sent: the schema adds no absent ones, and
    // setSyncSettings merges over what is stored.
    const updates = { ...req.body };

    const settings = await setSyncSettings(orgId, updates);
    log.info(`[AzureGroupSync] Settings updated for org ${orgId} by ${req.session.user.id}:`, updates);
    res.json({ ok: true, settings });
});

module.exports = router;
