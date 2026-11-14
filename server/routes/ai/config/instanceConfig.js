// @typecheck
/**
 * AI Config — the /config resource: general AI config CRUD, API-key and
 * setting deletion, service-email connect/test and the Azure reranker
 * connection test.
 *
 * Every write here is instance-wide, so it sits behind requireAdmin (the
 * platform-admin gate, ../requireAdminUser). GET /config is the one route that
 * answers both: a platform admin gets the whole configuration, anyone else
 * memberConfigView's cut, so it asks isAdminUser in the handler.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { getAIConfig, saveAIConfig } = require('../../../core/aiAgent');
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { requireAdminUser } = require('../requireAdminUser');
const { RegexGuardrailsBody } = require('../../../core/privacy/regexGuardrailsBody');
const { memberConfigView } = require('../../../usecases/ai/config/memberConfigView');
const { safeFetch } = require('../../../utils/ssrfGuard');
const { VALID_PII_ACTIONS } = require('../../../core/privacy/signupShield');
const { validate } = require('../../../core/http/validate');
const { HttpError } = require('../../../core/http/errors');
const { embeddingChoice, savedDimensions } = require('../../../core/embed/embeddingChoice.mts');
const { z, worded, bodyOf, flag } = require('../../../core/http/schemaParts');
const { parseAzureImageModels, AZURE_IMAGE_MODELS_KEY } = require('../../../core/media/imageModels.mts');
const { SETTING_STEPS, aiConfigToSave } = require('../../../usecases/ai/config/instanceSettingSteps');
const { AzureImageModelsBody } = require('../../../core/media/imageModelsBody');

// ── What POST /config accepts ────────────────────────────────────────
// Every key the handler reads, and nothing else: a misspelled key (the
// settings screens send one or two keys at a time) was a 200 that saved
// nothing. The on/off switches take booleans, and "true"/"false" as text read
// as what they say — `useAzureDocProcessing: "false"` used to switch Azure
// document processing ON for the whole installation (`"false" ? 'true' : ''`),
// sending every uploaded document to Azure. Text settings are text or null
// (null clears). The structured settings (guardrail rulesets, PII scope and
// categories, model allow-lists, numeric limits) keep the checks the handler
// and aiAgent.saveAIConfig already make.
const cfgText = worded('A setting is text.').max(100_000, 'A setting is at most 100000 characters.').nullish();
const cfgFlag = flag('An on/off setting is true or false.').nullish();
const ConfigBody = bodyOf({
    url: cfgText, model: cfgText, apiKey: cfgText, mistralApiKey: cfgText, openaiApiKey: cfgText,
    claudeApiKey: cfgText, googleApiKey: cfgText, eugptApiKey: cfgText, ionosApiKey: cfgText, elevenlabsApiKey: cfgText, googleVertexProject: cfgText,
    googleVertexLocation: cfgText, googleVertexServiceAccountKey: cfgText, azureEndpoint: cfgText,
    // azureApiVersion: accepted and ignored (Azure runs on v1 GA; old clients send it).
    azureApiKey: cfgText, azureApiVersion: cfgText, agentSearchUrl: cfgText, lakeraApiKey: cfgText,
    embeddingModel: cfgText, embeddingProviderId: cfgText, googleMapsApiKey: cfgText, serperApiKey: cfgText,
    azureDocIntelligenceEndpoint: cfgText, azureDocIntelligenceKey: cfgText,
    azureOpenaiEmbeddingEndpoint: cfgText, azureOpenaiEmbeddingKey: cfgText,
    azureOpenaiEmbeddingModel: cfgText, serviceEmailDisplayName: cfgText, azureSpeechKey: cfgText,
    azureSpeechRegion: cfgText, transcriptionProvider: cfgText, azureRerankerEndpoint: cfgText,
    azureRerankerKey: cfgText, azureRerankerModel: cfgText, rerankProviderId: cfgText, rerankModel: cfgText, stripeSecretKey: cfgText,
    stripeWebhookSecret: cfgText, stripePublishableKey: cfgText, stripeTaxCountry: cfgText,
    subscriptionNotifyEmail: cfgText, searchProvider: cfgText, kbProvider: cfgText, bingSearchKey: cfgText,
    bingSearchMarket: cfgText, linkedinClientId: cfgText, linkedinClientSecret: cfgText,
    withingsClientId: cfgText, withingsClientSecret: cfgText, whisperxUrl: cfgText, whisperxToken: cfgText,
    scalewayApiKey: cfgText, scalewayModel: cfgText, scalewayUrl: cfgText, pyannoteApiKey: cfgText,
    pyannoteTranscriptionModel: cfgText, piiDetectionAction: cfgText,
    useAzureDocProcessing: cfgFlag, notebooksEnabled: cfgFlag, projectsEnabled: cfgFlag,
    askAiEnabled: cfgFlag, exportEnabled: cfgFlag, openInNotebookEnabled: cfgFlag,
    notebooksMenuEnabled: cfgFlag, stripeEnabled: cfgFlag, stripeTaxEnabled: cfgFlag,
    cpuRerankerEnabled: cfgFlag, voiceprintMatchingEnabled: cfgFlag, localWhisperEnabled: cfgFlag, piiDetectionEnabled: cfgFlag,
    azureModels: z.unknown().optional(), azureImageModels: AzureImageModelsBody, regexGuardrails: RegexGuardrailsBody, piiDetectionCategories: z.unknown().optional(),
    piiDetectionConfidenceThreshold: z.unknown().optional(), piiDetectionScope: z.unknown().optional(),
    allowedModelsByAgentType: z.unknown().optional(), directChatRegexGuardrails: z.unknown().optional(),
    maxToolRoundsChat: z.unknown().optional(), pyannoteIdentifyThreshold: z.unknown().optional(),
}, 'The AI configuration');
const TestEmailBody = bodyOf({
    testRecipient: worded('Test recipient email is required').max(320, 'An e-mail address is at most 320 characters.'),
}, 'A test e-mail');

// Authentication middleware
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');
const { fallback } = require('../../../utils/bestEffort');

const requireAdmin = requireAdminUser(isAdminUser);

// ─── General AI Config ───────────────────────────────────────────

// requireAuth: the answer is an inventory of the installation (provider
// endpoint URLs, the internal search-service URL, which API keys exist, the
// DLP/PII ruleset and its bypass scope, the service mailbox) and costs ~40
// configStore round-trips, so it is neither for anonymous callers nor, whole,
// for members: a platform admin gets it all, a member memberConfigView's cut.
router.get('/config', requireAuth, async (req, res) => {
    const config = await getAIConfig();
    const payload = {
        url: config.url,
        model: config.model,
        apiKey: !!config.apiKey,
        hasApiKey: !!config.apiKey,
        hasMistralKey: !!(await configStore.getSecret('mistral_api_key')),
        // Voice Chat (Beta) — capability hint for the UI. The actual gate is
        // the `voice_chat` beta feature; this flag tells the frontend whether
        // the underlying Mistral dependency is set up so it can render a
        // helpful "configure Mistral to enable voice" state in admin.
        voiceChatReady: !!(await configStore.getSecret('mistral_api_key')),
        hasOpenaiKey: !!(await configStore.getSecret('openai_api_key')),
        hasClaudeKey: !!(await configStore.getSecret('claude_api_key')),
        hasGoogleKey: !!(await configStore.getSecret('google_api_key')),
        hasEuGptKey: !!(await configStore.getSecret('eugpt_api_key')),
        hasIonosKey: !!(await configStore.getSecret('ionos_api_key')),
        hasElevenLabsKey: !!(await configStore.getSecret('elevenlabs_api_key')),
        hasGoogleVertexProject: !!(await configStore.getConfig('google_vertex_project')),
        googleVertexLocation: await configStore.getConfig('google_vertex_location') || 'europe-west4',
        hasGoogleVertexServiceAccountKey: !!(await configStore.getSecret('google_vertex_service_account_key')),
        hasAzureEndpoint: !!(await configStore.getConfig('azure_endpoint')),
        hasAzureApiKey: !!(await configStore.getSecret('azure_api_key')),
        azureModels: await configStore.getConfig('azure_models') || '',
        azureImageModels: parseAzureImageModels(await configStore.getConfig(AZURE_IMAGE_MODELS_KEY)),
        hasFirefliesKey: !!(req.session?.user?.id && (await configStore.getSecret(`fireflies_api_key_user_${req.session.user.id}`))),
        hasAgentSearchUrl: !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url')),
        agentSearchUrl: process.env.SEARCH_SERVICE_URL || await configStore.getConfig('agent_search_url') || '',
        hasSerperKey: !!(await configStore.getSecret('serper_api_key')),
        searchProvider: await configStore.getConfig('search_provider') || 'agent-search',
        hasBingSearchKey: !!(await configStore.getSecret('bing_search_key')),
        bingSearchMarket: await configStore.getConfig('bing_search_market') || '',
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        hasWithingsConfig: !!(await configStore.getSecret('withings_client_id')) && !!(await configStore.getSecret('withings_client_secret')),
        regexGuardrails: config.regexGuardrails || null,
        piiDetectionEnabled: config.piiDetectionEnabled || false,
        piiDetectionCategories: config.piiDetectionCategories || null,
        piiDetectionConfidenceThreshold: config.piiDetectionConfidenceThreshold ?? 0.7,
        piiDetectionScope: config.piiDetectionScope || { userInput: true, agentOutput: false },
        piiDetectionAction: config.piiDetectionAction || 'block',
        embeddingModel: config.embeddingModel || null,
        embeddingProviderId: config.embeddingProviderId || null,
        embeddingDimensions: savedDimensions(await configStore.getConfig('ai')), // null: the model's own length
        allowedModelsByAgentType: await configStore.getConfig('allowedModelsByAgentType') || {},
        directChatRegexGuardrails: await configStore.getConfig('direct_chat_regex_guardrails') || null,
        // Tool-call rounds limit for chat surfaces (direct/notebook/webpage/native loop). null -> per-surface defaults.
        maxToolRoundsChat: await configStore.getConfig('max_tool_rounds_chat') || null,
        // KB provider — 'local' (in-process pgvector) or 'remote' (search-service). null -> auto.
        kbProvider: await configStore.getConfig('kb_provider') || null,
        // CPU cross-encoder reranker toggle (default on for fresh installs).
        cpuRerankerEnabled: (await configStore.getConfig('cpu_reranker_enabled')) !== false,
        // Azure Document Intelligence
        hasAzureDocIntelligenceEndpoint: !!(await configStore.getConfig('azure_doc_intelligence_endpoint')),
        hasAzureDocIntelligenceKey: !!(await configStore.getSecret('azure_doc_intelligence_key')),
        // Azure OpenAI Embeddings (for Azure-native KB pipeline)
        hasAzureOpenaiEmbeddingEndpoint: !!(await configStore.getConfig('azure_openai_embedding_endpoint')),
        hasAzureOpenaiEmbeddingKey: !!(await configStore.getSecret('azure_openai_embedding_key')),
        azureOpenaiEmbeddingModel: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
        useAzureDocProcessing: !!(await configStore.getConfig('use_azure_doc_processing')),
        // Azure AI Speech (Meeting Transcription)
        hasAzureSpeechKey: !!(await configStore.getSecret('azure_speech_key')),
        azureSpeechRegion: await configStore.getConfig('azure_speech_region') || '',
        transcriptionProvider: await configStore.getConfig('transcription_provider') || 'voxtral',
        localWhisperEnabled: (await configStore.getConfig('local_whisper_enabled')) !== false,
        // WhisperX self-hosted
        hasWhisperxUrl: !!(await configStore.getSecret('whisperx_url')),
        hasWhisperxToken: !!(await configStore.getSecret('whisperx_token')),
        // Scaleway Whisper (hybrid: cloud transcription + local diarization)
        hasScalewayKey: !!(await configStore.getSecret('scaleway_api_key')),
        scalewayModel: await configStore.getConfig('scaleway_model') || 'whisper-large-v3',
        // pyannoteAI (all-in-one diarization + transcription)
        hasPyannoteKey: !!(await configStore.getSecret('pyannote_api_key')),
        // '' = automatic (per meeting language). The UI shows that as the
        // recommended default rather than pretending a single model is pinned.
        pyannoteTranscriptionModel: await configStore.getConfig('pyannote_transcription_model') || '',
        pyannoteTranscriptionModelOptions: require('../../../core/voice/pyannoteModels').TRANSCRIPTION_MODELS,
        // Per-person voiceprint speaker identification (pyannote only).
        voiceprintMatchingEnabled: (await configStore.getConfig('voiceprint_matching_enabled')) !== false,
        pyannoteIdentifyThreshold: Number(await configStore.getConfig('pyannote_identify_threshold')) || 50,
        // Azure Cohere Reranker
        hasAzureRerankerEndpoint: !!(await configStore.getConfig('azure_reranker_endpoint')),
        hasAzureRerankerKey: !!(await configStore.getSecret('azure_reranker_key')),
        azureRerankerModel: await configStore.getConfig('azure_reranker_model') || 'Cohere-rerank-v4.0-fast',
        // Provider rerank tier: an LLM provider record + a rerank model (OpenAI/Cohere-style /v1/rerank).
        rerankProviderId: await configStore.getConfig('rerank_provider_id') || null,
        rerankModel: await configStore.getConfig('rerank_model') || null,
        // Service Email (Gmail OAuth) — "configured" means a Google account is
        // connected (token blob present), not that an App Password was saved.
        hasServiceEmail: !!(await configStore.getConfig('service_email_address')) && !!(await configStore.getSecret('service_email_oauth_tokens')),
        serviceEmailAddress: await configStore.getConfig('service_email_address') || '',
        serviceEmailDisplayName: await configStore.getConfig('service_email_display_name') || '',
        // Feature flags (runtime-togglable)
        notebooksEnabled: await (async () => {
            const val = await configStore.getConfig('feature_notebooks_enabled');
            return val !== false && val !== 'false';
        })(),
        projectsEnabled: await (async () => {
            const val = await configStore.getConfig('feature_projects_enabled');
            return val !== false && val !== 'false';
        })(),
        askAiEnabled: await (async () => {
            const val = await configStore.getConfig('feature_ask_ai_enabled');
            return val !== false && val !== 'false';
        })(),
        exportEnabled: await (async () => {
            const val = await configStore.getConfig('feature_export_enabled');
            return val !== false && val !== 'false';
        })(),
        openInNotebookEnabled: await (async () => {
            const val = await configStore.getConfig('feature_open_in_notebook_enabled');
            return val !== false && val !== 'false';
        })(),
        notebooksMenuEnabled: await (async () => {
            const val = await configStore.getConfig('feature_notebooks_menu_enabled');
            return val !== false && val !== 'false';
        })(),
        // Stripe Payment Integration
        hasStripeSecretKey: !!(await configStore.getSecret('stripe_secret_key')),
        hasStripeWebhookSecret: !!(await configStore.getSecret('stripe_webhook_secret')),
        stripePublishableKey: await configStore.getConfig('stripe_publishable_key') || '',
        stripeEnabled: !!(await configStore.getConfig('stripe_enabled')),
        stripeTaxEnabled: !!(await configStore.getConfig('stripe_tax_enabled')),
        stripeTaxCountry: await configStore.getConfig('stripe_tax_country') || 'NL',
        // Address that receives a notification email whenever a new
        // subscription is started (empty = notifications off).
        subscriptionNotifyEmail: await configStore.getConfig('subscription_notify_email') || '',
    };
    res.json(await isAdminUser(req) ? payload : memberConfigView(payload));
});

/**
 * The Stripe Tax switch. automatic_tax is per subscription, so the switch
 * only changes NEW checkouts: when it goes from off to on, the existing
 * active and trialing subscriptions are backfilled in the background
 * (idempotent; switching off and on again runs it again). The previous value
 * is read before the new one is written.
 * @param {unknown} enabled
 */
async function switchStripeTax(enabled) {
    let taxWasEnabled = false;
    try { taxWasEnabled = !!(await configStore.getConfig('stripe_tax_enabled')); } catch (err) { fallback('routes/ai/config/instanceConfig:anon', err); /* treat as off */ }
    await configStore.setConfig('stripe_tax_enabled', enabled ? 'true' : '');
    if (enabled && !taxWasEnabled) {
        const stripeService = require('../../../services/stripeService');
        stripeService.enableAutomaticTaxForExistingSubscriptions()
            .then(r => log.info(`[Config] Stripe Tax enabled — backfill updated=${r.updated} skipped=${r.skipped}`))
            .catch(e => log.warn('[Config] Stripe Tax backfill failed:', e.message));
    }
}

/**
 * Stores what one step of SETTING_STEPS answered.
 * @param {import('../../../usecases/ai/config/instanceSettingSteps').SettingWrite | import('../../../usecases/ai/config/instanceSettingSteps').StripeTaxSwitch} write
 */
async function storeSetting(write) {
    if ('stripeTax' in write) return switchStripeTax(write.stripeTax);
    if (write.secret) return configStore.setSecret(write.key, write.value);
    return configStore.setConfig(write.key, write.value);
}

router.post('/config', requireAuth, requireAdmin, validate({ body: ConfigBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof ConfigBody>, import('qs').ParsedQs>} */ req, res) => {
    const { piiDetectionAction, embeddingModel, embeddingProviderId } = req.body;
    // The instance-wide PII action: 'allow', a per-call override for trusted
    // first-party flows in piiDetection/validate, makes the scan skip
    // entirely for every org that falls back to this config. Checked before
    // anything below is written.
    if (piiDetectionAction !== undefined && !VALID_PII_ACTIONS.includes(piiDetectionAction)) {
        return res.status(400).json({ error: `piiDetectionAction is one of ${VALID_PII_ACTIONS.join(', ')}.` });
    }
    const existing = await getAIConfig();

    // Each setting is stored before the next one is looked at: a refusal
    // leaves the earlier ones saved.
    for (const step of SETTING_STEPS) {
        const outcome = step(req.body);
        if (!outcome) continue;
        if ('refuse' in outcome) return res.status(400).json({ error: outcome.refuse });
        await storeSetting(outcome);
    }

    // The vector length is decided only when the embedding model changes (core/embed/embeddingChoice.mts).
    const embedding = await embeddingChoice(existing, { embeddingModel, embeddingProviderId });
    const success = await saveAIConfig(aiConfigToSave(req.body, existing, embedding));
    if (!success) throw new Error('Failed to save configuration');
    // A new embedding model re-embeds the stored knowledge in the
    // background; the admin does not have to know the column exists.
    if (embedding.changed) {
        require('../../../core/kb/embeddingMigration').ensureKbEmbeddingsCurrent({ reason: 'config' });
    }
    res.json({ success: true, ...(embedding.changed ? { reembedding: true } : {}) });
});

// ─── Delete API Key ──────────────────────────────────────────────

// Whitelist of keys that can be deleted via this endpoint
const DELETABLE_KEYS = [
    'openai_api_key', 'claude_api_key', 'google_api_key', 'mistral_api_key', 'eugpt_api_key', 'ionos_api_key',
    'elevenlabs_api_key', 'serper_api_key', 'google_maps_api_key',
    'google_vertex_service_account_key', 'azure_api_key', 'azure_content_safety_key',
    'azure_doc_intelligence_key', 'azure_openai_embedding_key', 'azure_speech_key',
    'bing_search_key', 'linkedin_client_id', 'linkedin_client_secret',
    'withings_client_id', 'withings_client_secret',
    'service_email_password', 'service_email_oauth_tokens', 'whisperx_url', 'whisperx_token',
    'scaleway_api_key', 'pyannote_api_key',
    'azure_reranker_key', 'stripe_secret_key', 'stripe_webhook_secret',
];

router.delete('/config/key/:keyName', requireAuth, requireAdmin, async (/** @type {import('express').Request<{ keyName: string }>} */ req, res) => {
    const { keyName } = req.params;
    if (!DELETABLE_KEYS.includes(keyName)) {
        return res.status(400).json({ error: `Key "${keyName}" cannot be deleted via this endpoint` });
    }

    await configStore.deleteConfig(keyName);
    log.info(`[Config] Admin deleted key: ${keyName}`);
    res.json({ success: true, deleted: keyName });
});

// Also support deleting non-secret config keys (like vertex project/location)
const DELETABLE_CONFIG_KEYS = [
    'google_vertex_project', 'google_vertex_location',
    'azure_endpoint', 'azure_models',
    'azure_content_safety_endpoint', 'azure_doc_intelligence_endpoint',
    'azure_openai_embedding_endpoint', 'azure_openai_embedding_model',
    'azure_speech_region', 'agent_search_url', 'service_email_address',
    'service_email_display_name', 'azure_reranker_endpoint', 'azure_reranker_model',
    'rerank_provider_id', 'rerank_model',
    'stripe_publishable_key', 'stripe_tax_country', 'scaleway_url', 'scaleway_model',
    'pyannote_transcription_model', 'pyannote_identify_threshold',
];

router.delete('/config/setting/:keyName', requireAuth, requireAdmin, async (/** @type {import('express').Request<{ keyName: string }>} */ req, res) => {
    const { keyName } = req.params;
    if (!DELETABLE_CONFIG_KEYS.includes(keyName)) {
        return res.status(400).json({ error: `Setting "${keyName}" cannot be deleted via this endpoint` });
    }

    await configStore.deleteConfig(keyName);
    log.info(`[Config] Admin deleted setting: ${keyName}`);
    res.json({ success: true, deleted: keyName });
});

// ─── Test Service Email ──────────────────────────────────────────

// Admin-only: it makes the installation's own service mailbox send mail to any
// address. requireAuth alone would let any signed-in user do it.
router.post('/config/test-service-email', requireAuth, requireAdmin, validate({ body: TestEmailBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof TestEmailBody>, import('qs').ParsedQs>} */ req, res) => {
    const { testRecipient } = req.body;
    if (!testRecipient || !testRecipient.trim()) {
        return res.status(400).json({ error: 'Test recipient email is required' });
    }

    const { sendServiceEmail } = require('../../../utils/emailService');
    const result = await sendServiceEmail({
        to: testRecipient.trim(),
        subject: 'BeeFlow — Test Service Email',
        html: [
            '<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">',
            '  <h2 style="color: #1a1a1a; margin-bottom: 8px;">✅ Service Email Configured</h2>',
            '  <p style="color: #555; font-size: 14px; line-height: 1.6;">',
            '    This is a test email from your BeeFlow platform. If you received this, your service email is configured correctly.',
            '  </p>',
            '  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />',
            '  <p style="color: #999; font-size: 12px;">Sent by BeeFlow Service Email</p>',
            '</div>',
        ].join('\n'),
    });

    if (result.success) {
        res.json({ success: true, messageId: result.messageId });
    } else {
        throw new HttpError(500, 'test_email_failed', result.error || 'Failed to send test email');
    }
});

// ─── Service Email OAuth (Gmail API connect) ─────────────────────────────────
// The service account sends via the Gmail API over HTTPS (cloud hosts block
// outbound SMTP). We reuse the shared Gmail OAuth client and the ALREADY
// REGISTERED redirect URI `/api/support-inbox/oauth/callback` — so no Google
// Cloud Console change is needed, and it works identically on live and dev.
// The callback (server/routes/supportInbox.js) dispatches to this flow when it
// sees `req.session.serviceEmailConnect`.

/**
 * Resolve the OAuth redirect URI. MUST byte-match the one the support-inbox
 * callback uses, since that path is what's registered with Google. Mirrors
 * supportInbox.redirectUriFor: explicit SERVER_PUBLIC_HOST/PROTOCOL first.
 */
function _serviceEmailRedirectUri(req) {
    let host = process.env.SERVER_PUBLIC_HOST;
    let protocol = process.env.SERVER_PROTOCOL || req.protocol || 'https';
    if (!host) {
        host = req.get('X-Forwarded-Host') || null;
        if (!host) {
            const ref = req.get('Referer');
            if (ref) { try { const u = new URL(ref); host = u.host; protocol = u.protocol.replace(':', ''); } catch (err) { fallback('routes/ai/config/instanceConfig:_serviceEmailRedirectUri', err); /* ignore */ } }
        }
        if (!host) host = req.get('host');
    }
    return `${protocol}://${host}/api/support-inbox/oauth/callback`;
}

router.get('/config/service-email/oauth/start', requireAuth, requireAdmin, async (req, res) => {
    const crypto = require('crypto');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = _serviceEmailRedirectUri(req);
    req.session.serviceEmailConnect = { state, redirectUri, ts: Date.now() };
    const { buildConnectUrl } = require('../../../utils/emailService');
    const url = await buildConnectUrl({ redirectUri, state });
    await /** @type {Promise<void>} */ (new Promise((r) => req.session.save(() => r())));
    res.json({ url });
});

router.post('/config/service-email/disconnect', requireAuth, requireAdmin, validate({ body: bodyOf({}, 'Disconnecting the service mailbox') }), async (req, res) => {
    const { disconnectServiceEmail } = require('../../../utils/emailService');
    await disconnectServiceEmail();
    res.json({ success: true });
});

// ─── Test Azure Cohere Reranker ──────────────────────────────────

router.post('/config/test-reranker', requireAuth, requireAdmin, validate({ body: bodyOf({}, 'Testing the reranker') }), async (req, res) => {
    const endpoint = (await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT || '').replace(/\/+$/, '');
    const key = await configStore.getSecret('azure_reranker_key') || process.env.AZURE_RERANKER_KEY;
    const model = await configStore.getConfig('azure_reranker_model') || process.env.AZURE_RERANKER_MODEL || 'Cohere-rerank-v4.0-fast';

    if (!endpoint || !key) {
        return res.status(400).json({ error: 'Azure reranker endpoint and key are required' });
    }

    const start = Date.now();
    const requestBody = JSON.stringify({
        model,
        query: 'What is BeeFlow?',
        documents: [
            'BeeFlow is an AI-powered productivity platform.',
            'The weather today is sunny.',
            'BeeFlow helps teams collaborate with intelligent agents.',
        ],
        top_n: 2,
    });
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
    };

    // Try paths in order
    const PATHS = ['/providers/cohere/v2/rerank', '/v1/rerank', '/v2/rerank'];
    let lastError = '';
    for (const path of PATHS) {
        const url = `${endpoint}${path}`;
        const rerankerRes = await safeFetch(url, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: AbortSignal.timeout(15000),
        });

        const latencyMs = Date.now() - start;

        if (rerankerRes.ok) {
            const data = /** @type {{ results?: unknown[] }} */ (await rerankerRes.json());
            return res.json({ success: true, latencyMs, results: data.results?.length || 0, path });
        }
        lastError = await rerankerRes.text().catch(() => '');
        if (rerankerRes.status === 401 || rerankerRes.status === 403) {
            throw new HttpError(502, 'reranker_auth_failed', `Auth failed (${rerankerRes.status}): ${lastError.slice(0, 300)}`);
        }
    }
    throw new HttpError(502, 'reranker_unreachable', `All paths failed. Last: ${lastError.slice(0, 300)}`);
});

module.exports = router;
