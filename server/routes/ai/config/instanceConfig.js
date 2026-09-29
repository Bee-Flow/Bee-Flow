/**
 * AI Config — the /config resource: general AI config CRUD, API-key and
 * setting deletion, service-email connect/test and the Azure reranker
 * connection test.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const {
    getAIConfig,
    saveAIConfig,
} = require('../../../core/aiAgent');
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { VALID_PII_ACTIONS } = require('../../../core/privacy/signupShield');
const { validate } = require('../../../core/http/validate');
const { z, worded, bodyOf, flag } = require('../../../core/http/schemaParts');

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
    claudeApiKey: cfgText, googleApiKey: cfgText, eugptApiKey: cfgText, elevenlabsApiKey: cfgText, googleVertexProject: cfgText,
    googleVertexLocation: cfgText, googleVertexServiceAccountKey: cfgText, azureEndpoint: cfgText,
    azureApiKey: cfgText, azureApiVersion: cfgText, agentSearchUrl: cfgText, lakeraApiKey: cfgText,
    embeddingModel: cfgText, embeddingProviderId: cfgText, googleMapsApiKey: cfgText, serperApiKey: cfgText,
    azureDocIntelligenceEndpoint: cfgText, azureDocIntelligenceKey: cfgText,
    azureOpenaiEmbeddingEndpoint: cfgText, azureOpenaiEmbeddingKey: cfgText,
    azureOpenaiEmbeddingModel: cfgText, serviceEmailDisplayName: cfgText, azureSpeechKey: cfgText,
    azureSpeechRegion: cfgText, transcriptionProvider: cfgText, azureRerankerEndpoint: cfgText,
    azureRerankerKey: cfgText, azureRerankerModel: cfgText, stripeSecretKey: cfgText,
    stripeWebhookSecret: cfgText, stripePublishableKey: cfgText, stripeTaxCountry: cfgText,
    subscriptionNotifyEmail: cfgText, searchProvider: cfgText, kbProvider: cfgText, bingSearchKey: cfgText,
    bingSearchMarket: cfgText, linkedinClientId: cfgText, linkedinClientSecret: cfgText,
    withingsClientId: cfgText, withingsClientSecret: cfgText, whisperxUrl: cfgText, whisperxToken: cfgText,
    scalewayApiKey: cfgText, scalewayModel: cfgText, scalewayUrl: cfgText, pyannoteApiKey: cfgText,
    pyannoteTranscriptionModel: cfgText, piiDetectionAction: cfgText,
    useAzureDocProcessing: cfgFlag, notebooksEnabled: cfgFlag, projectsEnabled: cfgFlag,
    askAiEnabled: cfgFlag, exportEnabled: cfgFlag, openInNotebookEnabled: cfgFlag,
    notebooksMenuEnabled: cfgFlag, stripeEnabled: cfgFlag, stripeTaxEnabled: cfgFlag,
    cpuRerankerEnabled: cfgFlag, voiceprintMatchingEnabled: cfgFlag, localWhisperEnabled: cfgFlag,
    piiDetectionEnabled: cfgFlag,
    azureModels: z.unknown(), regexGuardrails: z.unknown(), piiDetectionCategories: z.unknown(),
    piiDetectionConfidenceThreshold: z.unknown(), piiDetectionScope: z.unknown(),
    allowedModelsByAgentType: z.unknown(), directChatRegexGuardrails: z.unknown(),
    maxToolRoundsChat: z.unknown(), pyannoteIdentifyThreshold: z.unknown(),
}, 'The AI configuration');
const TestEmailBody = bodyOf({
    testRecipient: worded('Test recipient email is required').max(320, 'An e-mail address is at most 320 characters.'),
}, 'A test e-mail');

// Authentication middleware
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');

// ─── General AI Config ───────────────────────────────────────────

// requireAuth: the only route on this router that lacked it. The response is
// an inventory of the installation — provider endpoint URLs, the internal
// search-service URL, which API keys exist, the DLP/PII guardrail ruleset and
// its bypass scope, the service mailbox address — and it was readable
// anonymously. Every frontend caller is an authenticated admin surface, so no
// pre-login consumer breaks. It also issues ~40 configStore round-trips per
// request, which made it a cheap DB-pool amplifier for unauthenticated load.
router.get('/config', requireAuth, async (req, res) => {
    const config = await getAIConfig();
    res.json({
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
        hasElevenLabsKey: !!(await configStore.getSecret('elevenlabs_api_key')),
        hasGoogleVertexProject: !!(await configStore.getConfig('google_vertex_project')),
        googleVertexLocation: await configStore.getConfig('google_vertex_location') || 'europe-west4',
        hasGoogleVertexServiceAccountKey: !!(await configStore.getSecret('google_vertex_service_account_key')),
        hasAzureEndpoint: !!(await configStore.getConfig('azure_endpoint')),
        hasAzureApiKey: !!(await configStore.getSecret('azure_api_key')),
        azureApiVersion: await configStore.getConfig('azure_api_version') || '2025-04-01-preview',
        azureModels: await configStore.getConfig('azure_models') || '',
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
    });
});

router.post('/config', requireAuth, validate({ body: ConfigBody }), async (req, res) => {
    if (!(await isAdminUser(req))) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    const { url, model, apiKey, mistralApiKey, openaiApiKey, claudeApiKey, googleApiKey, eugptApiKey, elevenlabsApiKey, googleVertexProject, googleVertexLocation, googleVertexServiceAccountKey, azureEndpoint, azureApiKey, azureApiVersion, azureModels, agentSearchUrl, lakeraApiKey, regexGuardrails, piiDetectionEnabled, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionScope, piiDetectionAction, embeddingModel, embeddingProviderId, allowedModelsByAgentType, directChatRegexGuardrails, googleMapsApiKey, serperApiKey, azureDocIntelligenceEndpoint, azureDocIntelligenceKey, azureOpenaiEmbeddingEndpoint, azureOpenaiEmbeddingKey, azureOpenaiEmbeddingModel, useAzureDocProcessing, serviceEmailDisplayName, azureSpeechKey, azureSpeechRegion, transcriptionProvider, notebooksEnabled, projectsEnabled, askAiEnabled, exportEnabled, openInNotebookEnabled, notebooksMenuEnabled, azureRerankerEndpoint, azureRerankerKey, azureRerankerModel, stripeSecretKey, stripeWebhookSecret, stripePublishableKey, stripeEnabled, stripeTaxEnabled, stripeTaxCountry, subscriptionNotifyEmail } = req.body;
    // The instance-wide PII action. It was stored as given, and 'allow' — a
    // per-call override for trusted first-party flows in piiDetection/validate
    // — makes the scan skip entirely, for every org that falls back to this
    // config. Checked before anything below is written.
    if (piiDetectionAction !== undefined && !VALID_PII_ACTIONS.includes(piiDetectionAction)) {
        return res.status(400).json({ error: `piiDetectionAction is one of ${VALID_PII_ACTIONS.join(', ')}.` });
    }
    const existing = await getAIConfig();

    if (allowedModelsByAgentType !== undefined) {
        await configStore.setConfig('allowedModelsByAgentType', allowedModelsByAgentType);
    }
    if (directChatRegexGuardrails !== undefined) {
        await configStore.setConfig('direct_chat_regex_guardrails', directChatRegexGuardrails);
    }
    if (azureModels !== undefined) {
        await configStore.setConfig('azure_models', azureModels || '');
    }
    if (agentSearchUrl !== undefined) {
        await configStore.setConfig('agent_search_url', agentSearchUrl || '');
    }
    if (serperApiKey !== undefined) {
        await configStore.setSecret('serper_api_key', serperApiKey || '');
    }
    if (req.body.searchProvider !== undefined) {
        const allowed = new Set(['agent-search', 'node-search', 'bing', 'disabled']);
        const value = allowed.has(req.body.searchProvider) ? req.body.searchProvider : 'agent-search';
        await configStore.setConfig('search_provider', value);
    }
    if (req.body.maxToolRoundsChat !== undefined) {
        const raw = req.body.maxToolRoundsChat;
        if (raw === null || raw === '' || raw === false) {
            await configStore.setConfig('max_tool_rounds_chat', null);
        } else {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) {
                const clamped = Math.min(Math.max(n, 1), 50);
                await configStore.setConfig('max_tool_rounds_chat', clamped);
            }
        }
    }
    if (req.body.kbProvider !== undefined) {
        const allowed = new Set(['local', 'remote']);
        const value = allowed.has(req.body.kbProvider) ? req.body.kbProvider : null;
        await configStore.setConfig('kb_provider', value);
    }
    if (req.body.cpuRerankerEnabled !== undefined) {
        await configStore.setConfig('cpu_reranker_enabled', !!req.body.cpuRerankerEnabled);
    }
    if (req.body.bingSearchKey !== undefined) {
        await configStore.setSecret('bing_search_key', req.body.bingSearchKey || '');
    }
    if (req.body.bingSearchMarket !== undefined) {
        await configStore.setConfig('bing_search_market', req.body.bingSearchMarket || '');
    }
    if (googleMapsApiKey !== undefined) {
        await configStore.setSecret('google_maps_api_key', googleMapsApiKey || '');
    }
    if (req.body.linkedinClientId !== undefined) {
        await configStore.setSecret('linkedin_client_id', req.body.linkedinClientId || '');
    }
    if (req.body.linkedinClientSecret !== undefined) {
        await configStore.setSecret('linkedin_client_secret', req.body.linkedinClientSecret || '');
    }
    // Withings health connector — one developer app per deployment, the same
    // admin-global shape LinkedIn uses. Per-user tokens live in the routine
    // vault, never here.
    if (req.body.withingsClientId !== undefined) {
        await configStore.setSecret('withings_client_id', req.body.withingsClientId || '');
    }
    if (req.body.withingsClientSecret !== undefined) {
        await configStore.setSecret('withings_client_secret', req.body.withingsClientSecret || '');
    }
    // Azure Document Intelligence
    if (azureDocIntelligenceEndpoint !== undefined) {
        await configStore.setConfig('azure_doc_intelligence_endpoint', azureDocIntelligenceEndpoint || '');
    }
    if (azureDocIntelligenceKey !== undefined) {
        await configStore.setSecret('azure_doc_intelligence_key', azureDocIntelligenceKey || '');
    }
    // Azure OpenAI Embeddings
    if (azureOpenaiEmbeddingEndpoint !== undefined) {
        await configStore.setConfig('azure_openai_embedding_endpoint', azureOpenaiEmbeddingEndpoint || '');
    }
    if (azureOpenaiEmbeddingKey !== undefined) {
        await configStore.setSecret('azure_openai_embedding_key', azureOpenaiEmbeddingKey || '');
    }
    if (azureOpenaiEmbeddingModel !== undefined) {
        await configStore.setConfig('azure_openai_embedding_model', azureOpenaiEmbeddingModel || 'text-embedding-3-small');
    }
    if (useAzureDocProcessing !== undefined) {
        await configStore.setConfig('use_azure_doc_processing', useAzureDocProcessing ? 'true' : '');
    }
    // Azure AI Speech (Meeting Transcription)
    if (azureSpeechKey !== undefined) {
        await configStore.setSecret('azure_speech_key', azureSpeechKey || '');
    }
    if (azureSpeechRegion !== undefined) {
        const region = (azureSpeechRegion || '').trim().toLowerCase();
        if (region && !/^[a-z0-9-]{2,32}$/.test(region)) {
            return res.status(400).json({ error: 'Invalid Azure Speech region format. Use a region like "westeurope" or "eastus".' });
        }
        await configStore.setConfig('azure_speech_region', region);
    }
    // WhisperX self-hosted
    if (req.body.whisperxUrl !== undefined) {
        const rawUrl = (req.body.whisperxUrl || '').trim();
        if (rawUrl) {
            try {
                const p = new URL(rawUrl);
                if (!['http:', 'https:'].includes(p.protocol)) throw new Error('bad protocol');
            } catch (_) {
                return res.status(400).json({ error: 'WhisperX URL must be a valid http:// or https:// address.' });
            }
        }
        await configStore.setSecret('whisperx_url', rawUrl);
    }
    if (req.body.whisperxToken !== undefined) {
        await configStore.setSecret('whisperx_token', req.body.whisperxToken || '');
    }
    // Scaleway Whisper (hybrid). Diarization reuses the WhisperX URL above.
    if (req.body.scalewayApiKey !== undefined) {
        await configStore.setSecret('scaleway_api_key', req.body.scalewayApiKey || '');
    }
    if (req.body.scalewayModel !== undefined) {
        await configStore.setConfig('scaleway_model', (req.body.scalewayModel || '').trim());
    }
    if (req.body.scalewayUrl !== undefined) {
        const rawUrl = (req.body.scalewayUrl || '').trim();
        if (rawUrl) {
            try {
                const p = new URL(rawUrl);
                if (!['http:', 'https:'].includes(p.protocol)) throw new Error('bad protocol');
            } catch (_) {
                return res.status(400).json({ error: 'Scaleway URL must be a valid http:// or https:// address.' });
            }
        }
        await configStore.setConfig('scaleway_url', rawUrl);
    }
    // pyannoteAI (all-in-one diarization + transcription; hosts its own media).
    if (req.body.pyannoteApiKey !== undefined) {
        await configStore.setSecret('pyannote_api_key', req.body.pyannoteApiKey || '');
    }
    if (req.body.pyannoteTranscriptionModel !== undefined) {
        // '' means "choose per meeting language", which is the default and the
        // best answer for most instances. Anything else must be a model
        // pyannoteAI actually accepts — this used to store whatever string
        // arrived, so a single typo made EVERY pyannote transcription fail with
        // a 400 until someone noticed.
        const requested = String(req.body.pyannoteTranscriptionModel || '').trim();
        const { TRANSCRIPTION_MODELS, isValidTranscriptionModel } = require('../../../core/voice/pyannoteModels');
        if (requested && !isValidTranscriptionModel(requested)) {
            return res.status(400).json({
                error: `Unknown pyannoteAI transcription model. Use one of: ${TRANSCRIPTION_MODELS.join(', ')} — or leave it empty to pick automatically per meeting language.`,
            });
        }
        await configStore.setConfig('pyannote_transcription_model', requested);
    }
    // Voiceprint speaker identification. The kill switch is instance-level on
    // purpose: the pyannote API key is instance-global, so the cost of the
    // second job it submits is an instance-level concern, not a per-org one.
    if (req.body.voiceprintMatchingEnabled !== undefined) {
        await configStore.setConfig('voiceprint_matching_enabled', !!req.body.voiceprintMatchingEnabled);
    }
    if (req.body.pyannoteIdentifyThreshold !== undefined) {
        const n = Number(req.body.pyannoteIdentifyThreshold);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
            return res.status(400).json({ error: 'Speaker-identification threshold must be between 0 and 100.' });
        }
        await configStore.setConfig('pyannote_identify_threshold', Math.round(n));
    }
    if (transcriptionProvider !== undefined) {
        const allowed = ['voxtral', 'azure', 'whisperx', 'scaleway', 'whisper_azure', 'pyannote', 'local'];
        if (transcriptionProvider && !allowed.includes(transcriptionProvider)) {
            return res.status(400).json({ error: `Invalid transcription provider. Allowed: ${allowed.join(', ')}` });
        }
        await configStore.setConfig('transcription_provider', transcriptionProvider || 'voxtral');
    }
    // In-process Whisper-base CPU transcription — admin opt-out toggle.
    // When false, the per-upload "Local CPU" picker disappears and any
    // request with provider='local' falls back to the configured cloud one.
    if (req.body.localWhisperEnabled !== undefined) {
        await configStore.setConfig('local_whisper_enabled', !!req.body.localWhisperEnabled);
    }
    // Service Email (Gmail OAuth) — the address is set by the OAuth connect flow
    // (the connected Google account), so only the display name is editable here.
    // serviceEmailAddress/serviceEmailPassword are legacy SMTP fields, ignored.
    if (serviceEmailDisplayName !== undefined) {
        await configStore.setConfig('service_email_display_name', serviceEmailDisplayName || '');
    }
    // Feature flags (runtime-togglable)
    if (notebooksEnabled !== undefined) {
        await configStore.setConfig('feature_notebooks_enabled', notebooksEnabled ? true : false);
    }
    if (projectsEnabled !== undefined) {
        await configStore.setConfig('feature_projects_enabled', projectsEnabled ? true : false);
    }
    if (askAiEnabled !== undefined) {
        await configStore.setConfig('feature_ask_ai_enabled', askAiEnabled ? true : false);
    }
    if (exportEnabled !== undefined) {
        await configStore.setConfig('feature_export_enabled', exportEnabled ? true : false);
    }
    if (openInNotebookEnabled !== undefined) {
        await configStore.setConfig('feature_open_in_notebook_enabled', openInNotebookEnabled ? true : false);
    }
    if (notebooksMenuEnabled !== undefined) {
        await configStore.setConfig('feature_notebooks_menu_enabled', notebooksMenuEnabled ? true : false);
    }
    // Azure Cohere Reranker
    if (azureRerankerEndpoint !== undefined) {
        await configStore.setConfig('azure_reranker_endpoint', azureRerankerEndpoint || '');
    }
    if (azureRerankerKey !== undefined) {
        await configStore.setSecret('azure_reranker_key', azureRerankerKey || '');
    }
    if (azureRerankerModel !== undefined) {
        await configStore.setConfig('azure_reranker_model', azureRerankerModel || 'Cohere-rerank-v4.0-fast');
    }
    // Stripe Payment Integration
    if (stripeSecretKey !== undefined) {
        await configStore.setSecret('stripe_secret_key', stripeSecretKey || '');
    }
    if (stripeWebhookSecret !== undefined) {
        await configStore.setSecret('stripe_webhook_secret', stripeWebhookSecret || '');
    }
    if (stripePublishableKey !== undefined) {
        await configStore.setConfig('stripe_publishable_key', stripePublishableKey || '');
    }
    if (stripeEnabled !== undefined) {
        await configStore.setConfig('stripe_enabled', stripeEnabled ? 'true' : '');
    }
    if (stripeTaxEnabled !== undefined) {
        // BFSF-250: automatic_tax is per-subscription — flipping the toggle
        // only affects NEW checkouts. On a false→true transition, backfill
        // the existing active/trialing subscriptions (fire-and-forget, same
        // style as syncSeatQuantityForOrg; idempotent + re-triggerable by
        // toggling off/on again). Read the PREVIOUS value before writing.
        let taxWasEnabled = false;
        try { taxWasEnabled = !!(await configStore.getConfig('stripe_tax_enabled')); } catch (_) { /* treat as off */ }
        await configStore.setConfig('stripe_tax_enabled', stripeTaxEnabled ? 'true' : '');
        if (stripeTaxEnabled && !taxWasEnabled) {
            const stripeService = require('../../../services/stripeService');
            stripeService.enableAutomaticTaxForExistingSubscriptions()
                .then(r => log.info(`[Config] Stripe Tax enabled — backfill updated=${r.updated} skipped=${r.skipped}`))
                .catch(e => log.warn('[Config] Stripe Tax backfill failed:', e.message));
        }
    }
    if (stripeTaxCountry !== undefined) {
        await configStore.setConfig('stripe_tax_country', stripeTaxCountry || 'NL');
    }
    if (subscriptionNotifyEmail !== undefined) {
        await configStore.setConfig('subscription_notify_email', (subscriptionNotifyEmail || '').trim());
    }

    const success = await saveAIConfig({
        url: url !== undefined ? url : existing.url,
        model: model !== undefined ? model : existing.model,
        apiKey: apiKey !== undefined ? apiKey : undefined,
        mistralApiKey: mistralApiKey !== undefined ? mistralApiKey : undefined,
        openaiApiKey: openaiApiKey !== undefined ? openaiApiKey : undefined,
        claudeApiKey: claudeApiKey !== undefined ? claudeApiKey : undefined,
        googleApiKey: googleApiKey !== undefined ? googleApiKey : undefined,
        eugptApiKey: eugptApiKey !== undefined ? eugptApiKey : undefined,
        elevenlabsApiKey: elevenlabsApiKey !== undefined ? elevenlabsApiKey : undefined,
        googleVertexProject: googleVertexProject !== undefined ? googleVertexProject : undefined,
        googleVertexLocation: googleVertexLocation !== undefined ? googleVertexLocation : undefined,
        googleVertexServiceAccountKey: googleVertexServiceAccountKey !== undefined ? googleVertexServiceAccountKey : undefined,
        azureEndpoint: azureEndpoint !== undefined ? azureEndpoint : undefined,
        azureApiKey: azureApiKey !== undefined ? azureApiKey : undefined,
        azureApiVersion: azureApiVersion !== undefined ? azureApiVersion : undefined,
        lakeraApiKey: lakeraApiKey !== undefined ? lakeraApiKey : undefined,
        regexGuardrails: regexGuardrails !== undefined ? regexGuardrails : existing.regexGuardrails,
        piiDetectionEnabled: piiDetectionEnabled !== undefined ? piiDetectionEnabled : existing.piiDetectionEnabled,
        piiDetectionCategories: piiDetectionCategories !== undefined ? piiDetectionCategories : existing.piiDetectionCategories,
        piiDetectionConfidenceThreshold: piiDetectionConfidenceThreshold !== undefined ? piiDetectionConfidenceThreshold : existing.piiDetectionConfidenceThreshold,
        piiDetectionScope: piiDetectionScope !== undefined ? piiDetectionScope : existing.piiDetectionScope,
        piiDetectionAction: piiDetectionAction !== undefined ? piiDetectionAction : existing.piiDetectionAction,
        embeddingModel: embeddingModel !== undefined ? embeddingModel : existing.embeddingModel,
        embeddingProviderId: embeddingProviderId !== undefined ? embeddingProviderId : existing.embeddingProviderId,
    });

    if (success) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// ─── Delete API Key ──────────────────────────────────────────────

// Whitelist of keys that can be deleted via this endpoint
const DELETABLE_KEYS = [
    'openai_api_key', 'claude_api_key', 'google_api_key', 'mistral_api_key', 'eugpt_api_key',
    'elevenlabs_api_key', 'serper_api_key', 'google_maps_api_key',
    'google_vertex_service_account_key', 'azure_api_key', 'azure_content_safety_key',
    'azure_doc_intelligence_key', 'azure_openai_embedding_key', 'azure_speech_key',
    'bing_search_key', 'linkedin_client_id', 'linkedin_client_secret',
    'withings_client_id', 'withings_client_secret',
    'service_email_password', 'service_email_oauth_tokens', 'whisperx_url', 'whisperx_token',
    'scaleway_api_key', 'pyannote_api_key',
    'azure_reranker_key', 'stripe_secret_key', 'stripe_webhook_secret',
];

router.delete('/config/key/:keyName', requireAuth, async (req, res) => {
    try {
        if (!(await isAdminUser(req))) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { keyName } = req.params;
        if (!DELETABLE_KEYS.includes(keyName)) {
            return res.status(400).json({ error: `Key "${keyName}" cannot be deleted via this endpoint` });
        }

        await configStore.deleteConfig(keyName);
        log.info(`[Config] Admin deleted key: ${keyName}`);
        res.json({ success: true, deleted: keyName });
    } catch (err) {
        log.error('[Config] Delete key error:', err);
        res.status(500).json({ error: 'Failed to delete key' });
    }
});

// Also support deleting non-secret config keys (like vertex project/location)
const DELETABLE_CONFIG_KEYS = [
    'google_vertex_project', 'google_vertex_location',
    'azure_endpoint', 'azure_api_version', 'azure_models',
    'azure_content_safety_endpoint', 'azure_doc_intelligence_endpoint',
    'azure_openai_embedding_endpoint', 'azure_openai_embedding_model',
    'azure_speech_region', 'agent_search_url', 'service_email_address',
    'service_email_display_name', 'azure_reranker_endpoint', 'azure_reranker_model',
    'stripe_publishable_key', 'stripe_tax_country', 'scaleway_url', 'scaleway_model',
    'pyannote_transcription_model', 'pyannote_identify_threshold',
];

router.delete('/config/setting/:keyName', requireAuth, async (req, res) => {
    try {
        if (!(await isAdminUser(req))) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { keyName } = req.params;
        if (!DELETABLE_CONFIG_KEYS.includes(keyName)) {
            return res.status(400).json({ error: `Setting "${keyName}" cannot be deleted via this endpoint` });
        }

        await configStore.deleteConfig(keyName);
        log.info(`[Config] Admin deleted setting: ${keyName}`);
        res.json({ success: true, deleted: keyName });
    } catch (err) {
        log.error('[Config] Delete setting error:', err);
        res.status(500).json({ error: 'Failed to delete setting' });
    }
});

// ─── Test Service Email ──────────────────────────────────────────

// Admin-only: it makes the installation's own service mailbox send mail to any
// address. It used to take requireAuth alone, so any signed-in user could.
router.post('/config/test-service-email', requireAuth, validate({ body: TestEmailBody }), async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
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
        res.status(500).json({ error: result.error || 'Failed to send test email' });
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
            if (ref) { try { const u = new URL(ref); host = u.host; protocol = u.protocol.replace(':', ''); } catch { /* ignore */ } }
        }
        if (!host) host = req.get('host');
    }
    return `${protocol}://${host}/api/support-inbox/oauth/callback`;
}

router.get('/config/service-email/oauth/start', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    const crypto = require('crypto');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = _serviceEmailRedirectUri(req);
    req.session.serviceEmailConnect = { state, redirectUri, ts: Date.now() };
    const { buildConnectUrl } = require('../../../utils/emailService');
    const url = await buildConnectUrl({ redirectUri, state });
    await new Promise((r) => req.session.save(() => r()));
    res.json({ url });
});

router.post('/config/service-email/disconnect', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    const { disconnectServiceEmail } = require('../../../utils/emailService');
    await disconnectServiceEmail();
    res.json({ success: true });
});

// ─── Test Azure Cohere Reranker ──────────────────────────────────

router.post('/config/test-reranker', requireAuth, async (req, res) => {
    if (!(await isAdminUser(req))) {
        return res.status(403).json({ error: 'Admin access required' });
    }

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
        const rerankerRes = await fetch(url, {
            method: 'POST',
            headers,
            body: requestBody,
            signal: AbortSignal.timeout(15000),
        });

        const latencyMs = Date.now() - start;

        if (rerankerRes.ok) {
            const data = await rerankerRes.json();
            return res.json({ success: true, latencyMs, results: data.results?.length || 0, path });
        }
        lastError = await rerankerRes.text().catch(() => '');
        if (rerankerRes.status === 401 || rerankerRes.status === 403) {
            return res.status(502).json({ error: `Auth failed (${rerankerRes.status}): ${lastError.slice(0, 300)}` });
        }
    }
    res.status(502).json({ error: `All paths failed. Last: ${lastError.slice(0, 300)}` });
});

module.exports = router;
