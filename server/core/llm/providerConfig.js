// @typecheck
/**
 * Provider configuration: the `ai` config record and the providers in it.
 *
 * Two shapes live side by side in configStore. The legacy single-provider
 * fields (url, model, apiKey) predate the providers array; getAIConfig()
 * answers from the default provider when there is one and from those fields
 * otherwise, so a caller never has to know which shape an installation is on.
 *
 * The ensure*Provider family turns a saved secret into a provider row (one
 * per vendor, fixed id), so an admin who only pasted an API key still sees
 * that vendor's models. ensureLocalProviders does the same for the runtime
 * URLs a compose profile sets in the environment.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');
const { LOCAL_RUNTIMES, isLocalProviderType } = require('../providers/localModels');
const { SCALEWAY_BASE_URL } = require('../providers/scalewayModels');
const { EUGPT_BASE_URL } = require('../providers/eugptModels');

// Self-hosted runtimes are presets too — same shape, derived from the single
// runtime table so the admin UI and the backend never disagree about which
// port Ollama listens on.
const LOCAL_PRESETS = Object.fromEntries(
    Object.entries(LOCAL_RUNTIMES).map(([type, rt]) => [type, {
        name: rt.label,
        url: rt.defaultUrl,
        needsApiKey: rt.needsApiKey,
        local: true,
        canPull: rt.canPull,
        description: rt.description,
        docsUrl: rt.docsUrl,
    }])
);

const PROVIDER_PRESETS = {
    mistral: { name: 'Mistral AI', url: 'https://api.mistral.ai/v1', needsApiKey: true },
    openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', needsApiKey: true },
    claude: { name: 'Claude', url: 'https://api.anthropic.com/v1', needsApiKey: true },
    google: { name: 'Google AI', url: 'https://generativelanguage.googleapis.com', needsApiKey: true },
    'google-vertex': { name: 'Google Vertex AI', url: 'vertex-ai', needsApiKey: false },
    azure: { name: 'Azure AI', url: 'https://your-resource.openai.azure.com', needsApiKey: true },
    scaleway: { name: 'Scaleway Generative APIs', url: SCALEWAY_BASE_URL, needsApiKey: true },
    eugpt: { name: 'EU GPT', url: EUGPT_BASE_URL, needsApiKey: true },
    ...LOCAL_PRESETS,
};

// Default configuration (backward compatible)
const DEFAULT_CONFIG = {
    url: 'https://api.mistral.ai/v1',
    model: 'ministral-8b-latest',
    apikey: '',
    lakeraApiKey: '',
    regexGuardrails: null,
    piiDetectionEnabled: false,
    piiDetectionCategories: null,
    piiDetectionConfidenceThreshold: 0.7,
    providers: [],
    defaultProviderId: null
};

// Get full config from configStore
async function getFullConfig() {
    return await configStore.getConfig('ai') || {};
}

// Get AI config (returns the default/active provider config for backward compatibility)
async function getAIConfig() {
    try {
        const ai = await configStore.getConfig('ai') || {};

        // If we have providers, return the default one
        if (ai.providers && ai.providers.length > 0 && ai.defaultProviderId) {
            const defaultProvider = ai.providers.find(p => p.id === ai.defaultProviderId);
            if (defaultProvider) {
                return {
                    url: defaultProvider.url || DEFAULT_CONFIG.url,
                    model: defaultProvider.model || DEFAULT_CONFIG.model,
                    apiKey: await configStore.getSecret('mistral_api_key') || defaultProvider.apiKey || DEFAULT_CONFIG.apiKey,
                    lakeraApiKey: ai.lakeraApiKey || DEFAULT_CONFIG.lakeraApiKey,
                    mistralOcrApiKey: ai.mistralOcrApiKey || null,
                    regexGuardrails: ai.regexGuardrails || null,
                    piiDetectionEnabled: ai.piiDetectionEnabled || false,
                    piiDetectionCategories: ai.piiDetectionCategories || null,
                    piiDetectionConfidenceThreshold: ai.piiDetectionConfidenceThreshold ?? 0.7,
                    piiDetectionAction: ai.piiDetectionAction || 'block',
                    piiDetectionScope: ai.piiDetectionScope || { userInput: true, agentOutput: false },
                    embeddingModel: ai.embeddingModel || null,
                    embeddingProviderId: ai.embeddingProviderId || null
                };
            }
        }

        // Fallback to legacy single-provider config
        return {
            url: ai.url || DEFAULT_CONFIG.url,
            model: ai.model || DEFAULT_CONFIG.model,
            apiKey: await configStore.getSecret('mistral_api_key') || ai.apiKey || DEFAULT_CONFIG.apiKey,
            lakeraApiKey: ai.lakeraApiKey || DEFAULT_CONFIG.lakeraApiKey,
            mistralOcrApiKey: ai.mistralOcrApiKey || null,
            regexGuardrails: ai.regexGuardrails || null,
            piiDetectionEnabled: ai.piiDetectionEnabled || false,
            piiDetectionCategories: ai.piiDetectionCategories || null,
            piiDetectionConfidenceThreshold: ai.piiDetectionConfidenceThreshold ?? 0.7,
            piiDetectionAction: ai.piiDetectionAction || 'block',
            piiDetectionScope: ai.piiDetectionScope || { userInput: true, agentOutput: false },
            embeddingModel: ai.embeddingModel || null,
            embeddingProviderId: ai.embeddingProviderId || null
        };
    } catch (e) {
        return DEFAULT_CONFIG;
    }
}

// Save AI config to configStore (backward compatible)
async function saveAIConfig(aiConfig) {
    try {
        // Save Mistral API key to database (legacy field)
        if (aiConfig.apiKey !== undefined) {
            await configStore.setSecret('mistral_api_key', aiConfig.apiKey || '');
        }
        // Save Mistral API key via named field (new card format)
        if (aiConfig.mistralApiKey !== undefined) {
            await configStore.setSecret('mistral_api_key', aiConfig.mistralApiKey || '');
        }

        // Save OpenAI API key to database
        if (aiConfig.openaiApiKey !== undefined) {
            await configStore.setSecret('openai_api_key', aiConfig.openaiApiKey || '');
        }

        // Save Claude API key to database
        if (aiConfig.claudeApiKey !== undefined) {
            await configStore.setSecret('claude_api_key', aiConfig.claudeApiKey || '');
        }

        // Save Google API key to database
        if (aiConfig.googleApiKey !== undefined) {
            await configStore.setSecret('google_api_key', aiConfig.googleApiKey || '');
        }

        // Save EU GPT API key to database
        if (aiConfig.eugptApiKey !== undefined) {
            await configStore.setSecret('eugpt_api_key', aiConfig.eugptApiKey || '');
        }

        // Save ElevenLabs API key to database
        if (aiConfig.elevenlabsApiKey !== undefined) {
            await configStore.setSecret('elevenlabs_api_key', aiConfig.elevenlabsApiKey || '');
        }

        // Save Google Vertex AI config to database
        if (aiConfig.googleVertexProject !== undefined) {
            await configStore.setConfig('google_vertex_project', aiConfig.googleVertexProject || '');
        }
        if (aiConfig.googleVertexLocation !== undefined) {
            await configStore.setConfig('google_vertex_location', aiConfig.googleVertexLocation || '');
        }
        if (aiConfig.googleVertexServiceAccountKey !== undefined) {
            await configStore.setSecret('google_vertex_service_account_key', aiConfig.googleVertexServiceAccountKey || '');
        }

        // Save Azure AI config to database
        if (aiConfig.azureEndpoint !== undefined) {
            await configStore.setConfig('azure_endpoint', aiConfig.azureEndpoint || '');
        }
        if (aiConfig.azureApiKey !== undefined) {
            await configStore.setSecret('azure_api_key', aiConfig.azureApiKey || '');
        }

        const ai = await configStore.getConfig('ai') || {};

        const updatedAi = {
            ...ai,
            url: aiConfig.url || DEFAULT_CONFIG.url,
            model: aiConfig.model || DEFAULT_CONFIG.model,
            lakeraApiKey: aiConfig.lakeraApiKey || '',
            regexGuardrails: aiConfig.regexGuardrails || null,
            piiDetectionEnabled: aiConfig.piiDetectionEnabled !== undefined ? aiConfig.piiDetectionEnabled : ai.piiDetectionEnabled || false,
            piiDetectionCategories: aiConfig.piiDetectionCategories !== undefined ? aiConfig.piiDetectionCategories : ai.piiDetectionCategories || null,
            piiDetectionConfidenceThreshold: aiConfig.piiDetectionConfidenceThreshold ?? ai.piiDetectionConfidenceThreshold ?? 0.7,
            piiDetectionAction: aiConfig.piiDetectionAction !== undefined ? aiConfig.piiDetectionAction : ai.piiDetectionAction || 'block',
            piiDetectionScope: aiConfig.piiDetectionScope !== undefined ? aiConfig.piiDetectionScope : ai.piiDetectionScope || { userInput: true, agentOutput: false },
            embeddingModel: aiConfig.embeddingModel || null,
            embeddingProviderId: aiConfig.embeddingProviderId || null
        };

        await configStore.setConfig('ai', updatedAi);

        // Ensure default providers exist after saving
        await ensureDefaultProvider();
        await ensureMistralProvider();
        await ensureOpenAIProvider();
        await ensureClaudeProvider();
        await ensureGoogleProvider();
        await ensureGoogleVertexProvider();
        await ensureAzureProvider();
        await ensureScalewayProvider();
        await ensureEuGptProvider();
        await ensureLocalProviders();

        return true;
    } catch (e) {
        log.error('Failed to save AI config:', e);
        return false;
    }
}

// ============ Provider Management ============

/**
 * Auto-create a default Mistral provider if API key exists but no providers are configured.
 * This bridges the gap between the legacy single-key config and the provider-based model listing.
 */
async function ensureDefaultProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const mistralApiKey = await configStore.getSecret('mistral_api_key');

    if ((!ai.providers || ai.providers.length === 0) && mistralApiKey) {
        ai.providers = [{
            id: 'mistral-default',
            name: 'Mistral AI',
            type: 'mistral',
            url: 'https://api.mistral.ai/v1',
            model: ai.model || 'ministral-8b-latest',
            apiKey: mistralApiKey
        }];
        ai.defaultProviderId = 'mistral-default';
        await configStore.setConfig('ai', ai);
        log.info('[AIAgent] Auto-created default Mistral provider');
    }
}

/**
 * Auto-create or update a Mistral provider when a Mistral API key is configured.
 * This follows the same pattern as ensureOpenAIProvider/ensureClaudeProvider.
 */
async function ensureMistralProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const mistralApiKey = await configStore.getSecret('mistral_api_key');

    if (!mistralApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'mistral-default');
    if (existing) {
        // Update key if changed
        existing.apiKey = mistralApiKey;
    } else {
        // Create new Mistral provider
        ai.providers.push({
            id: 'mistral-default',
            name: 'Mistral AI',
            type: 'mistral',
            url: 'https://api.mistral.ai/v1',
            model: '',
            apiKey: mistralApiKey
        });
        log.info('[AIAgent] Auto-created default Mistral provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update an OpenAI provider when an OpenAI API key is configured.
 */
async function ensureOpenAIProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const openaiApiKey = await configStore.getSecret('openai_api_key');

    if (!openaiApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'openai-default');
    if (existing) {
        // Update key if changed
        existing.apiKey = openaiApiKey;
    } else {
        // Create new OpenAI provider
        ai.providers.push({
            id: 'openai-default',
            name: 'OpenAI',
            type: 'openai',
            url: 'https://api.openai.com/v1',
            model: '',
            apiKey: openaiApiKey
        });
        log.info('[AIAgent] Auto-created default OpenAI provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Claude provider when a Claude API key is configured.
 */
async function ensureClaudeProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const claudeApiKey = await configStore.getSecret('claude_api_key');

    if (!claudeApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'claude-default');
    if (existing) {
        existing.apiKey = claudeApiKey;
        existing.url = 'https://api.anthropic.com/v1';  // ensure correct URL
    } else {
        ai.providers.push({
            id: 'claude-default',
            name: 'Claude',
            type: 'claude',
            url: 'https://api.anthropic.com/v1',
            model: '',
            apiKey: claudeApiKey
        });
        log.info('[AIAgent] Auto-created default Claude provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Google provider when a Google API key is configured.
 */
async function ensureGoogleProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const googleApiKey = await configStore.getSecret('google_api_key');

    if (!googleApiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'google-default');
    if (existing) {
        existing.apiKey = googleApiKey;
        existing.url = 'https://generativelanguage.googleapis.com';
    } else {
        ai.providers.push({
            id: 'google-default',
            name: 'Google AI',
            type: 'google',
            url: 'https://generativelanguage.googleapis.com',
            model: '',
            apiKey: googleApiKey
        });
        log.info('[AIAgent] Auto-created default Google provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update a Google Vertex AI provider when project config is set.
 */
async function ensureGoogleVertexProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const project = await configStore.getConfig('google_vertex_project');

    if (!project) return;

    if (!ai.providers) ai.providers = [];

    const location = await configStore.getConfig('google_vertex_location') || 'europe-west4';

    const existing = ai.providers.find(p => p.id === 'google-vertex-default');
    if (existing) {
        existing.project = project;
        existing.location = location;
        existing.serviceAccountKey = await configStore.getSecret('google_vertex_service_account_key') || '';
    } else {
        ai.providers.push({
            id: 'google-vertex-default',
            name: 'Google Vertex AI',
            type: 'google-vertex',
            url: 'vertex-ai',
            model: '',
            apiKey: '',
            project,
            location,
            serviceAccountKey: await configStore.getSecret('google_vertex_service_account_key') || ''
        });
        log.info('[AIAgent] Auto-created default Google Vertex AI provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update an Azure AI provider when endpoint + key are set.
 */
async function ensureAzureProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const endpoint = await configStore.getConfig('azure_endpoint');
    const apiKey = await configStore.getSecret('azure_api_key');

    if (!endpoint || !apiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'azure-default');
    if (existing) {
        existing.url = endpoint;
        existing.apiKey = apiKey;
        // Leftover from the dated Azure API; the adapter runs on v1 GA.
        delete existing.apiVersion;
    } else {
        ai.providers.push({
            id: 'azure-default',
            name: 'Azure AI',
            type: 'azure',
            url: endpoint,
            model: '',
            apiKey,
        });
        log.info('[AIAgent] Auto-created default Azure AI provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update the Scaleway Generative APIs provider when a Scaleway
 * API key is configured.
 *
 * The key is the same `scaleway_api_key` secret the Whisper transcription
 * integration already uses — one Scaleway secret key opens every Scaleway API —
 * so an installation that configured Scaleway for transcription gets the
 * serverless chat models on the next config save, and vice versa. `scaleway_url`
 * is likewise shared: an admin who pinned a project-scoped endpoint
 * (https://api.scaleway.ai/<project-id>) for transcription keeps that scoping
 * here rather than falling back to the account-wide one.
 */
async function ensureScalewayProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const apiKey = (await configStore.getSecret('scaleway_api_key')) || process.env.SCALEWAY_API_KEY;

    if (!apiKey) return;

    if (!ai.providers) ai.providers = [];

    const configured = (await configStore.getConfig('scaleway_url')) || process.env.SCALEWAY_URL || '';
    const url = configured
        ? `${configured.replace(/\/+$/, '')}${/\/v1$/.test(configured) ? '' : '/v1'}`
        : SCALEWAY_BASE_URL;

    // Change-aware: this also runs from getProviders() on every read, so an
    // installation that configured Scaleway for transcription months ago picks
    // the chat models up without waiting for someone to re-save AI config.
    // Writing unconditionally would mean a config write per request.
    const existing = ai.providers.find(p => p.id === 'scaleway-default');
    if (existing) {
        if (existing.url === url && existing.apiKey === apiKey) return;
        existing.url = url;
        existing.apiKey = apiKey;
    } else {
        ai.providers.push({
            id: 'scaleway-default',
            name: 'Scaleway Generative APIs',
            type: 'scaleway',
            url,
            model: '',
            apiKey,
        });
        log.info('[AIAgent] Auto-created default Scaleway Generative APIs provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create or update the EU GPT provider when an EU GPT API key is set.
 *
 * Change-aware for the same reason as Scaleway: it also runs from
 * getProviders(), so a key that boot-init wrote from the environment turns
 * into a provider on the next read, without a config write per request.
 */
async function ensureEuGptProvider() {
    const ai = await configStore.getConfig('ai') || {};
    const apiKey = (await configStore.getSecret('eugpt_api_key')) || process.env.EUGPT_API_KEY;

    if (!apiKey) return;

    if (!ai.providers) ai.providers = [];

    const existing = ai.providers.find(p => p.id === 'eugpt-default');
    if (existing) {
        // Not an authentication check: both sides are this server's own
        // config, and the answer only decides whether to write it again.
        if (existing.apiKey === apiKey) return; // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack
        existing.apiKey = apiKey;
    } else {
        ai.providers.push({
            id: 'eugpt-default',
            name: 'EU GPT',
            type: 'eugpt',
            url: EUGPT_BASE_URL,
            model: '',
            apiKey,
        });
        log.info('[AIAgent] Auto-created default EU GPT provider');
    }
    await configStore.setConfig('ai', ai);
}

/**
 * Auto-create providers for self-hosted runtimes declared through the
 * environment. This is the zero-click path for self-hosters: bring up the
 * `local-llm` compose profile (which sets OLLAMA_URL) and the runtime shows up
 * in the model tier picker on the next request — no admin form to fill in.
 *
 * Recognised env vars:
 *   OLLAMA_URL / VLLM_URL / LLAMACPP_URL / LMSTUDIO_URL / SGLANG_URL
 *   LOCAL_LLM_URL  (+ optional LOCAL_LLM_TYPE, default 'openai-compatible',
 *                   and LOCAL_LLM_API_KEY for a key-protected endpoint)
 *
 * Idempotent: the provider id is derived from the runtime type, so a restart
 * updates the URL in place rather than stacking duplicates. An admin who
 * deletes the provider in the UI gets it back on the next boot — the env var
 * is the declaration of intent, so removing the var is how you turn it off.
 */
const LOCAL_ENV_PROVIDERS = [
    { env: 'OLLAMA_URL', type: 'ollama' },
    { env: 'VLLM_URL', type: 'vllm' },
    { env: 'LLAMACPP_URL', type: 'llamacpp' },
    { env: 'LMSTUDIO_URL', type: 'lmstudio' },
    { env: 'SGLANG_URL', type: 'sglang' },
    { env: 'LOCAL_LLM_URL', type: null }, // type from LOCAL_LLM_TYPE
];

async function ensureLocalProviders() {
    const declared = LOCAL_ENV_PROVIDERS
        .map(({ env, type }) => ({
            url: (process.env[env] || '').trim(),
            type: type || (process.env.LOCAL_LLM_TYPE || 'openai-compatible').trim(),
            apiKey: env === 'LOCAL_LLM_URL' ? (process.env.LOCAL_LLM_API_KEY || '') : '',
        }))
        .filter(d => d.url && isLocalProviderType(d.type));
    if (!declared.length) return;

    const ai = await configStore.getConfig('ai') || {};
    if (!ai.providers) ai.providers = [];
    let changed = false;

    for (const { url, type, apiKey } of declared) {
        const id = `${type}-env`;
        const preset = PROVIDER_PRESETS[type] || {};
        const existing = ai.providers.find(p => p.id === id);
        if (existing) {
            if (existing.url !== url || (apiKey && existing.apiKey !== apiKey)) {
                existing.url = url;
                if (apiKey) existing.apiKey = apiKey;
                changed = true;
            }
        } else {
            ai.providers.push({ id, name: preset.name || type, type, url, model: '', apiKey });
            if (!ai.defaultProviderId) ai.defaultProviderId = id;
            changed = true;
            log.info(`[AIAgent] Auto-created ${preset.name || type} provider from the environment (${url})`);
        }
    }

    if (changed) await configStore.setConfig('ai', ai);
}

async function getProviders() {
    await ensureDefaultProvider();
    await ensureLocalProviders();
    await ensureScalewayProvider();
    await ensureEuGptProvider();
    const config = await getFullConfig();
    return {
        providers: config.providers || [],
        defaultProviderId: config.defaultProviderId || null,
        presets: PROVIDER_PRESETS
    };
}

async function addProvider(provider) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) ai.providers = [];

        const id = provider.id || `provider-${Date.now()}`;
        const newProvider = {
            id,
            name: provider.name,
            type: provider.type || 'openai-compatible',
            url: provider.url,
            model: provider.model || '',
            apiKey: provider.apiKey || '',
        };
        // Vertex AI specific fields
        if (provider.project) newProvider.project = provider.project;
        if (provider.location) newProvider.location = provider.location;
        if (provider.serviceAccountKey) newProvider.serviceAccountKey = provider.serviceAccountKey;

        ai.providers.push(newProvider);

        // Set as default if it's the first provider
        if (ai.providers.length === 1) {
            ai.defaultProviderId = id;
        }

        await configStore.setConfig('ai', ai);
        return newProvider;
    } catch (e) {
        log.error('Failed to add provider:', e);
        return null;
    }
}

async function updateProvider(providerId, updates) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) return false;

        const index = ai.providers.findIndex(p => p.id === providerId);
        if (index === -1) return false;

        // Update provider fields (don't overwrite apiKey if empty)
        const existing = ai.providers[index];
        ai.providers[index] = {
            ...existing,
            name: updates.name !== undefined ? updates.name : existing.name,
            type: updates.type !== undefined ? updates.type : existing.type,
            url: updates.url !== undefined ? updates.url : existing.url,
            model: updates.model !== undefined ? updates.model : existing.model,
            apiKey: updates.apiKey || existing.apiKey,
            project: updates.project !== undefined ? updates.project : existing.project,
            location: updates.location !== undefined ? updates.location : existing.location,
            serviceAccountKey: updates.serviceAccountKey !== undefined ? updates.serviceAccountKey : existing.serviceAccountKey,
        };

        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        log.error('Failed to update provider:', e);
        return false;
    }
}

async function deleteProvider(providerId) {
    try {
        const ai = await configStore.getConfig('ai') || {};
        if (!ai.providers) return false;

        // An id that is not in the list deletes nothing, so it must not
        // answer true: the caller would report a provider — with its key —
        // as removed while it stays. Nothing is written either.
        const remaining = ai.providers.filter(p => p.id !== providerId);
        if (remaining.length === ai.providers.length) return false;
        ai.providers = remaining;

        // If we deleted the default, set a new default
        if (ai.defaultProviderId === providerId) {
            ai.defaultProviderId = ai.providers[0]?.id || null;
        }

        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        log.error('Failed to delete provider:', e);
        return false;
    }
}

async function setDefaultProvider(providerId) {
    try {
        const ai = await configStore.getConfig('ai') || {};

        // Verify provider exists
        if (ai.providers && !ai.providers.find(p => p.id === providerId)) {
            return false;
        }

        ai.defaultProviderId = providerId;
        await configStore.setConfig('ai', ai);
        return true;
    } catch (e) {
        log.error('Failed to set default provider:', e);
        return false;
    }
}

module.exports = {
    PROVIDER_PRESETS,
    DEFAULT_CONFIG,
    getFullConfig,
    getAIConfig,
    saveAIConfig,
    ensureLocalProviders,
    ensureScalewayProvider,
    ensureEuGptProvider,
    getProviders,
    addProvider,
    updateProvider,
    deleteProvider,
    setDefaultProvider,
};
