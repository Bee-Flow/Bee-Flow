const express = require('express');
require('../../stores/agentStore');
const agentRuntime = require('../../core/agentRuntime');
const { getAIConfig } = require('../../core/aiAgent');
require('../../stores/configStore');
require('../../auth');
require('../../stores/memoryStore');
require('../../auth');
require('../../utils/routeHelpers');

require('../../stores/userStore');
require('../../stores/usageStore');
require('../../core/entitlements/limits');
require('../../core/http/sseHelpers');
const log = require('../../telemetry/log');
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const router = express.Router();

// Neither route reads the query, and that is said out loud rather than left
// implicit: /meta/models answers for EVERY configured provider, so a
// `?providerId=` that looks like it narrows the list was answered with all of
// them under a 200. A parameter here is a typo or a wish; both deserve a
// refusal that names it.
const NoQuery = z.object({}).strict();

// The file is exempted from the app-wide gate sweep as "metadata for the
// (guest) chat UI" (auth/accessRegistry.sweep.test.js), and /meta/components
// is exactly that. /meta/models is not: it is not metadata this server holds
// but a live `GET /v1/models` to EVERY configured provider, sent with the
// installation's own API key, on every request — and nothing but the agent
// designer (signed in) has ever asked for it. Open, it let anybody on the
// internet learn which vendors and models an installation runs, and make it
// call each of them with its keys once per request, with no limit in this
// server. It now asks for a session like every other part of the designer.

// ============ Meta endpoints (must be before /:id routes) ============

// Get available components for tool selection
router.get('/meta/components', validate({ query: NoQuery }), async (req, res) => {
    const components = await agentRuntime.getAvailableComponents();
    res.json(components);
});

// Get available models from ALL configured providers
router.get('/meta/models', requireAuth, validate({ query: NoQuery }), async (req, res) => {
    const { getProviders } = require('../../core/aiAgent');
    const config = await getAIConfig();
    const providerData = await getProviders();

    let allModels = [];

    // Fetch models from all providers in parallel
    const results = await Promise.all(
        providerData.providers.map(async (provider) => {
            try {
                const headers = { 'Content-Type': 'application/json' };
                const apiKey = provider.apiKey;
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                let baseUrl = (provider.url || '').replace(/\/$/, '');

                // Skip SDK-based providers that don't have HTTP model endpoints
                if (!baseUrl || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
                    return [];
                }

                let models = [];

                // Standard OpenAI-compatible API
                let modelsUrl = baseUrl.endsWith('/v1')
                    ? `${baseUrl}/models`
                    : `${baseUrl}/v1/models`;

                const response = await fetch(modelsUrl, { headers });
                if (response.ok) {
                    const data = await response.json();
                    models = (data.data || []).map(m => ({
                        id: m.id,
                        name: m.id,
                        providerId: provider.id,
                        providerName: provider.name
                    }));
                }
                return models;
            } catch (e) {
                log.error(`Failed to fetch models from ${provider.name}:`, e.message);
                return [];
            }
        })
    );

    allModels = results.flat();

    res.json({
        models: allModels,
        currentModel: config.model,
        defaultProviderId: providerData.defaultProviderId
    });
});


module.exports = router;
