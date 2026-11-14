// @typecheck strict
/**
 * What saving the instance-wide AI configuration (POST /ai/config) does with
 * each setting of the request, as data: SETTING_STEPS holds one step per
 * setting, in the order they are written. A step reads the request body and
 * answers what to store, a refusal, or nothing when the setting was not sent.
 *
 * Nothing here writes: the route (routes/ai/config/instanceConfig.js, behind
 * the platform-admin gate) runs the steps one by one and does each write
 * before it asks the next step, so a refusal leaves the earlier settings saved.
 */

'use strict';

const { parseAzureImageModels, AZURE_IMAGE_MODELS_KEY } = require('../../../core/media/imageModels.mts');

/**
 * @typedef {{ [setting: string]: unknown }} ConfigBody  the validated request body
 * @typedef {{ key: string, value: unknown, secret?: true }} SettingWrite  one row of the config store
 * @typedef {{ refuse: string }} SettingRefusal  the request ends with a 400 and this sentence
 * @typedef {{ stripeTax: unknown }} StripeTaxSwitch  the Stripe Tax switch, which the route handles itself
 * @typedef {(body: ConfigBody) => SettingWrite | SettingRefusal | StripeTaxSwitch | null} SettingStep
 */

/** @param {string} value an absolute http:// or https:// address */
const isHttpUrl = (value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

/** The setting as text, without the space around it; empty when cleared. @param {unknown} value */
const trimmed = (value) => /** @type {string} */ (value || '').trim();

/**
 * A step that runs only when its setting was sent.
 * @param {string} field
 * @param {(value: unknown) => ReturnType<SettingStep>} whenSent
 * @returns {SettingStep}
 */
const sent = (field, whenSent) => (body) => (body[field] === undefined ? null : whenSent(body[field]));

/** Stored as sent. @param {string} field @param {string} key */
const asSent = (field, key) => sent(field, (value) => ({ key, value }));

/** A plain setting: cleared means `whenEmpty`. @param {string} field @param {string} key */
const setting = (field, key, whenEmpty = '') => sent(field, (value) => ({ key, value: value || whenEmpty }));

/** A secret: cleared means the empty text. @param {string} field @param {string} key */
const secret = (field, key) => sent(field, (value) => ({ key, value: value || '', secret: true }));

/** A switch stored as true / false. @param {string} field @param {string} key */
const toggle = (field, key) => sent(field, (value) => ({ key, value: !!value }));

/** A switch stored as 'true' / ''. @param {string} field @param {string} key */
const textToggle = (field, key) => sent(field, (value) => ({ key, value: value ? 'true' : '' }));

/** A plain setting stored without the space around it. @param {string} field @param {string} key */
const trimmedSetting = (field, key) => sent(field, (value) => ({ key, value: trimmed(value) }));

/**
 * One of a fixed set, else `otherwise`.
 * @param {string} field @param {string} key @param {string[]} allowed @param {string | null} otherwise
 */
const oneOf = (field, key, allowed, otherwise) => sent(field, (value) => (
    { key, value: allowed.includes(/** @type {string} */ (value)) ? value : otherwise }
));

/**
 * An address that must be http(s) when given.
 * @param {string} field @param {string} key @param {string} refusal @param {boolean} [isSecret]
 */
const httpAddress = (field, key, refusal, isSecret) => sent(field, (value) => {
    const address = trimmed(value);
    if (address && !isHttpUrl(address)) return { refuse: refusal };
    return isSecret ? { key, value: address, secret: true } : { key, value: address };
});

/** The tool-call rounds limit of the chat surfaces: empty clears it, a number is kept between 1 and 50, anything else is left alone. */
const maxToolRoundsChat = sent('maxToolRoundsChat', (raw) => {
    if (raw === null || raw === '' || raw === false) return { key: 'max_tool_rounds_chat', value: null };
    const rounds = parseInt(String(raw), 10);
    if (!Number.isFinite(rounds)) return null;
    return { key: 'max_tool_rounds_chat', value: Math.min(Math.max(rounds, 1), 50) };
});

const azureSpeechRegion = sent('azureSpeechRegion', (value) => {
    const region = trimmed(value).toLowerCase();
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, one class with a bounded count (at most 32), no nesting: linear
    if (region && !/^[a-z0-9-]{2,32}$/.test(region)) {
        return { refuse: 'Invalid Azure Speech region format. Use a region like "westeurope" or "eastus".' };
    }
    return { key: 'azure_speech_region', value: region };
});

// '' means "choose per meeting language", the default. Anything else must be
// a model pyannoteAI accepts: one typo stored here would fail every pyannote
// transcription with a 400.
const pyannoteTranscriptionModel = sent('pyannoteTranscriptionModel', (value) => {
    const requested = String(value || '').trim();
    const { TRANSCRIPTION_MODELS, isValidTranscriptionModel } = require('../../../core/voice/pyannoteModels');
    if (requested && !isValidTranscriptionModel(requested)) {
        return { refuse: `Unknown pyannoteAI transcription model. Use one of: ${TRANSCRIPTION_MODELS.join(', ')} — or leave it empty to pick automatically per meeting language.` };
    }
    return { key: 'pyannote_transcription_model', value: requested };
});

const pyannoteIdentifyThreshold = sent('pyannoteIdentifyThreshold', (value) => {
    const threshold = Number(value);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        return { refuse: 'Speaker-identification threshold must be between 0 and 100.' };
    }
    return { key: 'pyannote_identify_threshold', value: Math.round(threshold) };
});

const TRANSCRIPTION_PROVIDERS = ['voxtral', 'azure', 'whisperx', 'scaleway', 'whisper_azure', 'pyannote', 'local'];

const transcriptionProvider = sent('transcriptionProvider', (value) => {
    if (value && !TRANSCRIPTION_PROVIDERS.includes(/** @type {string} */ (value))) {
        return { refuse: `Invalid transcription provider. Allowed: ${TRANSCRIPTION_PROVIDERS.join(', ')}` };
    }
    return { key: 'transcription_provider', value: value || 'voxtral' };
});

/** @type {SettingStep[]} */
const SETTING_STEPS = [
    asSent('allowedModelsByAgentType', 'allowedModelsByAgentType'),
    asSent('directChatRegexGuardrails', 'direct_chat_regex_guardrails'),
    setting('azureModels', 'azure_models'),
    sent('azureImageModels', (value) => ({ key: AZURE_IMAGE_MODELS_KEY, value: parseAzureImageModels(value) })),
    setting('agentSearchUrl', 'agent_search_url'),
    secret('serperApiKey', 'serper_api_key'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the name of a setting, not its value
    oneOf('searchProvider', 'search_provider', ['agent-search', 'node-search', 'bing', 'disabled'], 'agent-search'),
    maxToolRoundsChat,
    oneOf('kbProvider', 'kb_provider', ['local', 'remote'], null),
    toggle('cpuRerankerEnabled', 'cpu_reranker_enabled'),
    secret('bingSearchKey', 'bing_search_key'),
    setting('bingSearchMarket', 'bing_search_market'),
    secret('googleMapsApiKey', 'google_maps_api_key'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the name of a setting, not its value
    secret('linkedinClientId', 'linkedin_client_id'),
    secret('linkedinClientSecret', 'linkedin_client_secret'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the name of a setting, not its value
    // Withings health connector: one developer app per deployment, like
    // LinkedIn. Per-user tokens live in the automation vault, never here.
    secret('withingsClientId', 'withings_client_id'),
    secret('withingsClientSecret', 'withings_client_secret'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the name of a setting, not its value
    // Azure Document Intelligence
    setting('azureDocIntelligenceEndpoint', 'azure_doc_intelligence_endpoint'),
    secret('azureDocIntelligenceKey', 'azure_doc_intelligence_key'),
    // Azure OpenAI Embeddings
    setting('azureOpenaiEmbeddingEndpoint', 'azure_openai_embedding_endpoint'),
    secret('azureOpenaiEmbeddingKey', 'azure_openai_embedding_key'),
    setting('azureOpenaiEmbeddingModel', 'azure_openai_embedding_model', 'text-embedding-3-small'),
    textToggle('useAzureDocProcessing', 'use_azure_doc_processing'),
    // Azure AI Speech (meeting transcription)
    secret('azureSpeechKey', 'azure_speech_key'),
    azureSpeechRegion,
    // WhisperX self-hosted
    httpAddress('whisperxUrl', 'whisperx_url', 'WhisperX URL must be a valid http:// or https:// address.', true),
    secret('whisperxToken', 'whisperx_token'),
    // Scaleway Whisper (hybrid). Diarization reuses the WhisperX URL above.
    secret('scalewayApiKey', 'scaleway_api_key'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the name of a setting, not its value
    trimmedSetting('scalewayModel', 'scaleway_model'),
    httpAddress('scalewayUrl', 'scaleway_url', 'Scaleway URL must be a valid http:// or https:// address.'),
    // pyannoteAI (all-in-one diarization + transcription; hosts its own media).
    secret('pyannoteApiKey', 'pyannote_api_key'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- the name of a setting, not its value
    pyannoteTranscriptionModel,
    // Voiceprint speaker identification. The kill switch is instance-level on
    // purpose: the pyannote API key is instance-global, so the cost of the
    // second job it submits is an instance-level concern, not a per-org one.
    toggle('voiceprintMatchingEnabled', 'voiceprint_matching_enabled'),
    pyannoteIdentifyThreshold,
    transcriptionProvider,
    // In-process Whisper-base CPU transcription, the admin's opt-out. When
    // false, the per-upload "Local CPU" picker disappears and a request with
    // provider='local' falls back to the configured cloud one.
    toggle('localWhisperEnabled', 'local_whisper_enabled'),
    // Service Email (Gmail OAuth): the address is set by the OAuth connect
    // flow (the connected Google account), so only the display name is saved here.
    setting('serviceEmailDisplayName', 'service_email_display_name'),
    // Feature flags (runtime-togglable)
    toggle('notebooksEnabled', 'feature_notebooks_enabled'),
    toggle('projectsEnabled', 'feature_projects_enabled'),
    toggle('askAiEnabled', 'feature_ask_ai_enabled'),
    toggle('exportEnabled', 'feature_export_enabled'),
    toggle('openInNotebookEnabled', 'feature_open_in_notebook_enabled'),
    toggle('notebooksMenuEnabled', 'feature_notebooks_menu_enabled'),
    // Azure Cohere Reranker
    setting('azureRerankerEndpoint', 'azure_reranker_endpoint'),
    secret('azureRerankerKey', 'azure_reranker_key'),
    setting('azureRerankerModel', 'azure_reranker_model', 'Cohere-rerank-v4.0-fast'),
    // Provider rerank tier (both empty = off)
    setting('rerankProviderId', 'rerank_provider_id'),
    setting('rerankModel', 'rerank_model'),
    // Stripe payment integration
    secret('stripeSecretKey', 'stripe_secret_key'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the name of a setting, not its value
    secret('stripeWebhookSecret', 'stripe_webhook_secret'), // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the name of a setting, not its value
    setting('stripePublishableKey', 'stripe_publishable_key'),
    textToggle('stripeEnabled', 'stripe_enabled'),
    sent('stripeTaxEnabled', (value) => ({ stripeTax: value })),
    setting('stripeTaxCountry', 'stripe_tax_country', 'NL'),
    trimmedSetting('subscriptionNotifyEmail', 'subscription_notify_email'),
];

/** The settings saveAIConfig stores when sent and leaves alone otherwise. */
const SAVED_WHEN_SENT = [
    'apiKey', 'mistralApiKey', 'openaiApiKey', 'claudeApiKey', 'googleApiKey', 'eugptApiKey', 'ionosApiKey', 'elevenlabsApiKey',
    'googleVertexProject', 'googleVertexLocation', 'googleVertexServiceAccountKey', 'azureEndpoint', 'azureApiKey', 'lakeraApiKey',
];

/** The settings of the stored `ai` record: what was sent, else what is stored. */
const KEPT_WHEN_NOT_SENT = [
    'regexGuardrails', 'piiDetectionEnabled', 'piiDetectionCategories', 'piiDetectionConfidenceThreshold', 'piiDetectionScope', 'piiDetectionAction',
];

/**
 * What saveAIConfig gets: the sent provider settings, the stored value of
 * every `ai` setting that was not sent, and the embedding choice.
 * @param {ConfigBody} body
 * @param {{ [setting: string]: unknown }} existing  the stored AI configuration
 * @param {{ modelId: unknown, providerId: unknown, output: unknown }} embedding
 * @returns {{ [setting: string]: unknown }}
 */
function aiConfigToSave(body, existing, embedding) {
    const sentOrStored = (/** @type {string} */ field) => (body[field] !== undefined ? body[field] : existing[field]);
    return {
        url: sentOrStored('url'),
        model: sentOrStored('model'),
        ...Object.fromEntries(SAVED_WHEN_SENT.map((field) => [field, body[field]])),
        ...Object.fromEntries(KEPT_WHEN_NOT_SENT.map((field) => [field, sentOrStored(field)])),
        embeddingModel: embedding.modelId,
        embeddingProviderId: embedding.providerId,
        embeddingOutput: embedding.output,
    };
}

module.exports = { SETTING_STEPS, aiConfigToSave };
