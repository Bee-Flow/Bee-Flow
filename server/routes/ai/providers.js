const { getProviders, addProvider, updateProvider, deleteProvider, setDefaultProvider, getModelsForProvider, invalidateModelCache } = require('../../core/aiAgent');
const { getAdapter, baseAdapter } = require('../../core/providers');

const router = require('express').Router();
const { z } = require('zod');
const { validate } = require('../../core/http/validate');

// Middleware
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { isAdminUser } = require('./config/shared');
const log = require('../../telemetry/log');

// Providers are INSTANCE-WIDE config (one shared `ai` config row) and each
// entry carries a real API key. Mutating them is therefore admin work, exactly
// like the sibling /config and /local-runtimes routes: until 2026-09-05 these
// mutations only required requireAuth, so any signed-in user could repoint a
// provider URL at their own host — and updateProvider keeps the stored key
// when none is supplied, so the instance would then send its real key there.
// Same middleware shape as localRuntimes.js, same gate as config/shared.
async function requireAdmin(req, res, next) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ── What a caller may send ────────────────────────────────────────────────
// Every schema runs AFTER requireAdmin: only an admin learns what it refuses.
//
// The provider TYPE is what the rest of the server reads. It picks the
// adapter, and it is the one thing `modelCache` trusts to mark a provider's
// models as self-hosted — priced at €0. Three silent fallbacks lived here:
//
//   - no type at all: addProvider stored 'openai-compatible', which IS a
//     self-hosted flavour, so a paid endpoint added without a type was
//     billed at €0 from its first request;
//   - a misspelled type ('olama') was stored as-is; the adapter came from a
//     URL guess and the Local Models card could no longer see the provider;
//   - a misspelled field on PUT (`apikey`) answered success and kept the OLD
//     key — a rotation that did not happen.
//
// "Known" is asked of the adapter factory itself (core/providers/index.js),
// so a provider added there is accepted here without a second list to keep.

const isKnownProviderType = (type) => getAdapter(type) !== baseAdapter;
const TYPE_TEXT = 'A provider type names the adapter that serves it — for example openai, claude, mistral, azure, google-vertex, ollama or openai-compatible.';
const ProviderType = z.string({ required_error: `Pick a provider type. ${TYPE_TEXT}`, invalid_type_error: TYPE_TEXT })
    .refine(isKnownProviderType, (t) => ({ message: `Unknown provider type '${String(t).slice(0, 40)}'. ${TYPE_TEXT}` }));

const text = (what) => z.string({ invalid_type_error: `${what} must be text.` });
const NAME_TEXT = 'Name and URL are required';

// GET hands every secret out masked ('••••1234', '••••(configured)'). Sent
// back — the natural GET → edit → PUT — the mask is truthy, so it REPLACED
// the real credential, and the provider failed on its next request.
const MASK = '••••';
const secret = (what) => text(what).refine((v) => !v.startsWith(MASK),
    `${what} is the masked value GET returns — send the real key, or leave it out to keep the stored one.`);

/** The fields a provider record has (providerConfig.addProvider / updateProvider). */
const providerFields = {
    url: text('The provider URL').trim(),
    model: text('The default model'),
    // Empty keeps the stored key on an update, as before.
    apiKey: secret('The API key'),
    // Vertex AI. The store has always kept a service-account key; this route
    // dropped it on the floor, with a 201. Empty keeps the stored one, the
    // same rule as apiKey (the store alone would have cleared it).
    project: text('The Vertex project'),
    location: text('The Vertex location'),
    serviceAccountKey: secret('The service-account key').transform((v) => v || undefined),
    // Azure OpenAI.
    apiVersion: text('The Azure API version'),
};
const optional = (shape) => Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.optional()]));

/** An absent body is an empty one, so each missing field gets its sentence rather than "Required". */
const bodyOf = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

const CreateProviderBody = bodyOf(z.object({
    name: z.string({ required_error: NAME_TEXT, invalid_type_error: NAME_TEXT }).trim().min(1, NAME_TEXT),
    type: ProviderType,
    ...optional(providerFields),
}).strict());

const UpdateProviderBody = bodyOf(z.object({
    name: z.string({ invalid_type_error: 'A provider name is text.' }).trim().min(1, 'A provider needs a name.').optional(),
    type: ProviderType.optional(),
    ...optional(providerFields),
}).strict());

const REGION_TEXT = "region must be 'eu' or 'default'";
const RegionBody = bodyOf(z.object({
    // A closed pair on purpose: a typo in a free-text URL would fail open,
    // back to US processing.
    region: z.enum(['eu', 'default'], { errorMap: () => ({ message: REGION_TEXT }) }),
}).strict());

const ModelsQuery = z.object({
    // `=== 'true'` read `?refresh=1` as "use the cache".
    refresh: z.enum(['true', 'false'], { errorMap: () => ({ message: 'refresh is true or false.' }) }).optional(),
}).strict();

// GET /ai/providers
router.get('/providers', requireAuth, async (req, res) => {
    try {
        const providerData = await getProviders();
        const maskedProviders = providerData.providers.map(p => ({
            ...p,
            apiKey: p.apiKey ? '••••' + p.apiKey.slice(-4) : '',
            serviceAccountKey: p.serviceAccountKey ? '••••(configured)' : '',
        }));
        res.json({
            providers: maskedProviders,
            defaultProvider: providerData.defaultProvider
        });
    } catch (e) {
        log.error('Failed to get providers:', e);
        res.status(500).json({ error: 'Failed to fetch providers' });
    }
});

// POST /ai/providers
router.post('/providers', requireAuth, requireAdmin, validate({ body: CreateProviderBody }), async (req, res) => {
    try {
        const { name, type, url, model, apiKey, project, location, apiVersion, serviceAccountKey } = req.body;
        if (!url && type !== 'google-vertex' && type !== 'azure') {
            return res.status(400).json({ error: NAME_TEXT });
        }
        const provider = await addProvider({ name, type, url: url || (type === 'azure' ? '' : 'vertex-ai'), model, apiKey, project, location, apiVersion, serviceAccountKey });
        if (provider) {
            invalidateModelCache(); // Clear all cache since new provider added
            res.status(201).json({
                ...provider,
                apiKey: provider.apiKey ? '••••' + provider.apiKey.slice(-4) : '',
                serviceAccountKey: provider.serviceAccountKey ? '••••(configured)' : '',
            });
        } else {
            res.status(500).json({ error: 'Failed to add provider' });
        }
    } catch (e) {
        log.error('Failed to add provider:', e);
        res.status(500).json({ error: 'Failed to add provider' });
    }
});

// PUT /ai/providers/:id — a partial update: a field left out keeps its value
// (updateProvider merges), which is why a misspelled one must not pass.
router.put('/providers/:id', requireAuth, requireAdmin, validate({ body: UpdateProviderBody }), async (req, res) => {
    try {
        const { name, type, url, model, apiKey, project, location, apiVersion, serviceAccountKey } = req.body;
        const success = await updateProvider(req.params.id, { name, type, url, model, apiKey, project, location, apiVersion, serviceAccountKey });
        if (success) {
            invalidateModelCache(req.params.id); // Invalidate this provider's cache
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        log.error('Failed to update provider:', e);
        res.status(500).json({ error: 'Failed to update provider' });
    }
});

// PUT /ai/providers/:id/region
//
// Switch an OpenAI provider between the default endpoint and EU regional
// processing. A dedicated route rather than "PUT the url field": the URL is the
// mechanism, but the DECISION is where inference runs, and that is a privacy
// choice an admin should be able to make (and an auditor to read back) without
// knowing OpenAI's domain scheme. It also keeps the two legal values closed —
// a typo in a free-text URL would fail open, back to US processing.
router.put('/providers/:id/region', requireAuth, requireAdmin, validate({ body: RegionBody }), async (req, res) => {
    try {
        const { region } = req.body;

        const providerData = await getProviders();
        const provider = (providerData.providers || []).find(p => p.id === req.params.id);
        if (!provider) return res.status(404).json({ error: 'Provider not found' });
        if (provider.type !== 'openai') {
            return res.status(400).json({ error: 'Regional processing is an OpenAI setting' });
        }

        const { OPENAI_BASE_URL, OPENAI_EU_BASE_URL } = require('../../core/providers/openaiModels');
        const url = region === 'eu' ? OPENAI_EU_BASE_URL : OPENAI_BASE_URL;
        const success = await updateProvider(req.params.id, { ...provider, url });
        if (!success) return res.status(404).json({ error: 'Provider not found' });

        invalidateModelCache(req.params.id);
        log.info(`[Providers] ${provider.name} now uses ${region === 'eu' ? 'EU regional processing' : 'the default endpoint'}`);
        res.json({ success: true, region, url });
    } catch (e) {
        log.error('Failed to set provider region:', e);
        res.status(500).json({ error: 'Failed to update provider' });
    }
});

// DELETE /ai/providers/:id
//
// Asked first, because deleteProvider filters the list and answers true
// whether or not the id was in it: a mistyped id was "deleted" with a 200,
// and the provider that was meant — with its key — stayed.
router.delete('/providers/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { providers } = await getProviders();
        if (!(providers || []).some((p) => p.id === req.params.id)) {
            return res.status(404).json({ error: 'Provider not found' });
        }
        const success = await deleteProvider(req.params.id);
        if (success) {
            invalidateModelCache(req.params.id); // Remove from cache
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        log.error('Failed to delete provider:', e);
        res.status(500).json({ error: 'Failed to delete provider' });
    }
});

// PUT /ai/providers/:id/default
router.put('/providers/:id/default', requireAuth, requireAdmin, async (req, res) => {
    try {
        const success = await setDefaultProvider(req.params.id);
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Provider not found' });
        }
    } catch (e) {
        log.error('Failed to set default provider:', e);
        res.status(500).json({ error: 'Failed to set default provider' });
    }
});

// GET /ai/providers/:id/models — uses cached getModelsForProvider (60s TTL)
router.get('/providers/:id/models', requireAuth, validate({ query: ModelsQuery }), async (req, res) => {
    const providerData = await getProviders();
    const provider = providerData.providers.find(p => p.id === req.params.id);

    if (!provider) {
        return res.status(404).json({ error: 'Provider not found' });
    }

    const forceRefresh = req.query.refresh === 'true';
    const models = await getModelsForProvider(provider.id, forceRefresh);
    log.info(`[Models] Returning ${models.length} models for ${provider.name}${forceRefresh ? ' (forced refresh)' : ''}`);

    res.json({ models, providerId: provider.id, providerName: provider.name });
});

module.exports = router;
