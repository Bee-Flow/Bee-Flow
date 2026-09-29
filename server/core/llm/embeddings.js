// @typecheck
/**
 * Text → embedding vector, through whichever provider is configured for it.
 *
 * The provider is the explicit embedding provider when the admin chose one,
 * else the default provider, else the first, else the legacy single-provider
 * fields. The model is the global embedding model when set, else the
 * provider's own model if it is an embedding model, else Mistral's. Usage is
 * logged so knowledge-base ingestion shows up in cost reports.
 */

const log = require('../../telemetry/log');
const { getFullConfig, DEFAULT_CONFIG } = require('./providerConfig');

// Generate Embedding for text
// agentContext: optional { agentId, agentName, source } for cost tracking
async function generateEmbedding(text, agentContext = null) {
    log.info("[AIAgent] generateEmbedding called for text length:", text?.length);
    const config = await getFullConfig();
    log.info("[AIAgent] Config loaded. Embedding Provider ID:", config.embeddingProviderId);

    const providers = config.providers || [];
    const defaultId = config.defaultProviderId;

    // Find active provider
    let provider = null;

    // 1. Explicit embedding provider
    if (config.embeddingProviderId) {
        provider = providers.find(p => p.id === config.embeddingProviderId);
    }

    // 2. Default provider
    if (!provider && defaultId) {
        provider = providers.find(p => p.id === defaultId);
    }

    // 3. Fallback to first provider
    if (!provider && providers.length > 0) {
        provider = providers[0];
    }
    // Fallback to legacy config
    if (!provider) {
        provider = {
            url: config.url || DEFAULT_CONFIG.url,
            apiKey: config.apiKey || DEFAULT_CONFIG.apiKey,
            model: 'mistral-embed' // Default for embeddings if not specified
        };
    }

    // Default embedding model
    let model = config.embeddingModel || 'mistral-embed';

    // If provider specifies a model, use it (unless overridden by global config)
    if (!config.embeddingModel && provider.model && provider.model.includes('embedding')) {
        model = provider.model;
    }


    try {
        const headers = {
            'Content-Type': 'application/json'
        };

        const apiKey = provider.apiKey;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const baseUrl = provider.url.replace(/\/$/, '');
        // Handle providers with /v1
        const apiUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;

        //
        log.info(`[AIAgent] Sending embedding request to: ${apiUrl}/embeddings`);
        log.info(`[AIAgent] Using Model: ${model}`);
        log.info(`[AIAgent] Auth Header Present: ${!!headers['Authorization']}`);

        const response = await fetch(`${apiUrl}/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: model,
                input: text
            })
        });

        if (!response.ok) {
            const err = await response.text();
            log.error(`[AIAgent] Embedding API Error: ${response.status} - ${err}`);
            throw new Error(`Embedding API Error: ${response.status} - ${err}`);
        }

        const data = /** @type {{ data?: Array<{ embedding?: number[] }>, usage?: { prompt_tokens?: number, total_tokens?: number } }} */ (await response.json());
        log.info(`[AIAgent] Embedding Response Keys:`, Object.keys(data));
        if (data.data && data.data.length > 0) {
            log.info(`[AIAgent] Embedding 0 length:`, data.data[0].embedding?.length);
        } else {
            log.warn(`[AIAgent] Embedding data is empty!`, JSON.stringify(data));
        }

        if (!data.data || !data.data[0] || !data.data[0].embedding) {
            throw new Error("No embedding found in response: " + JSON.stringify(data));
        }

        // Log embedding usage for cost tracking
        if (data.usage) {
            try {
                const usageStore = require('../../stores/usageStore');
                await usageStore.logUsage({
                    agent_id: agentContext?.agentId || null,
                    agent_name: agentContext?.agentName || 'system',
                    model: model,
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: data.usage.total_tokens || data.usage.prompt_tokens || 0,
                    source: agentContext?.source || 'knowledge_embedding',
                });
            } catch (logErr) {
                log.warn('[AIAgent] Failed to log embedding usage:', logErr.message);
            }
        }

        return data.data[0].embedding;
    } catch (e) {
        log.error('Failed to generate embedding:', e);
        throw e;
    }
}

// A model call, not the destination of the tool that needed the vector: see
// core/embed/dispatch.js and providers/index.js.
const { outsideProbe } = require('../http/egressCapture');

module.exports = {
    generateEmbedding: (text, agentContext = null) => outsideProbe(() => generateEmbedding(text, agentContext)),
};
