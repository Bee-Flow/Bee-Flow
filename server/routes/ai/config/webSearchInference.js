/**
 * AI Config — web-search inference routing: which backends the
 * search-service uses for its embed/rerank/cleanup tasks.
 *
 * The resolver's sanitiser (core/webSearchInferenceResolver.js) turns any
 * body into SOME config, and it was the only gate. So `method: 'disable'`
 * kept reranking ON (cosine), a misspelled `reranker` section reset the
 * saved rerank choice to the default, and a body carrying only `cleanup`
 * wiped the other two — each answered "Saved". A save REPLACES the whole
 * config, so the schema asks for all three sections, closes the method
 * vocabulary, and wants a provider and a model together or neither.
 *
 * One fallback stays, because the page states it: "Provider model" with no
 * model picked yet falls back to cosine ("without one, “Provider model”
 * falls back to cosine similarity at runtime"). An empty pair is that choice;
 * half a pair is not.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { isAdminUser } = require('./shared');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');

// ─── Web-Search Inference Routing ────────────────────────────────
// Controls how the search-service handles its 3 inference tasks:
//   - embed   → inherits the global Embeddings settings
//   - rerank  → cosine / local / disabled (provider-agnostic)
//   - cleanup → admin picks any chat model from a configured provider
const {
    readWebSearchInferenceConfig,
    writeWebSearchInferenceConfig,
    readEmbedSummary,
    resolveInferenceTargets,
    DEFAULTS: WEB_SEARCH_INFERENCE_DEFAULTS,
} = require('../../../core/webSearchInferenceResolver');

async function requireAdmin(req, res, next) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ── What an admin may send ────────────────────────────────────────────────

// The resolver's RERANK_METHODS. webSearchInference.validation.test.js runs
// every one of these through the real sanitiser, so a method dropped there
// fails here rather than being quietly rewritten to cosine.
const RERANK_METHODS = ['cosine', 'cpu', 'provider', 'local', 'disabled'];

/** { providerId, modelId }: both set, or both empty ('' is "inherit" / "off"). */
function pairOf(section, meaning) {
    const missing = `${section} is required — send { providerId: '', modelId: '' } for ${meaning}.`;
    return z.object({
        providerId: z.string({ invalid_type_error: `${section}.providerId must be text.` }).trim().default(''),
        modelId: z.string({ invalid_type_error: `${section}.modelId must be text.` }).trim().default(''),
    }, { required_error: missing, invalid_type_error: missing }).strict();
}

/** Half a pair was treated as unset — a selection that silently did nothing. */
function wholePair(section) {
    return (pair, ctx) => {
        if (!pair.providerId !== !pair.modelId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [pair.providerId ? 'modelId' : 'providerId'],
                message: `${section} needs both a provider and a model, or neither.`,
            });
        }
    };
}

const WebSearchInferenceBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    embed: pairOf('embed', 'the global Embeddings settings').superRefine(wholePair('embed')),
    rerank: z.object({
        method: z.enum(RERANK_METHODS, {
            errorMap: () => ({ message: `rerank.method is one of ${RERANK_METHODS.join(', ')}.` }),
        }),
        providerId: z.string({ invalid_type_error: 'rerank.providerId must be text.' }).trim().default(''),
        modelId: z.string({ invalid_type_error: 'rerank.modelId must be text.' }).trim().default(''),
    }, {
        required_error: "rerank is required — send { method: 'cosine' } for the default.",
        invalid_type_error: "rerank is an object, like { method: 'cosine' }.",
    }).strict().superRefine(wholePair('rerank')),
    cleanup: pairOf('cleanup', 'no cleanup').superRefine(wholePair('cleanup')),
}).strict());

router.get('/config/web-search-inference', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [config, embedSummary] = await Promise.all([
            readWebSearchInferenceConfig(),
            readEmbedSummary(),
        ]);
        res.json({ config, defaults: WEB_SEARCH_INFERENCE_DEFAULTS, embedSummary });
    } catch (e) {
        log.error('Failed to load web-search inference config:', e);
        res.status(500).json({ error: 'Failed to load config' });
    }
});

router.post('/config/web-search-inference', requireAuth, requireAdmin, validate({ body: WebSearchInferenceBody }), async (req, res) => {
    try {
        const saved = await writeWebSearchInferenceConfig(req.body);
        res.json({ success: true, config: saved });
    } catch (e) {
        log.error('Failed to save web-search inference config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Read-only debugging view — what backend each task will actually hit.
// Flags `unresolved` when something the admin selected can't be resolved
// (e.g. provider deleted after cleanup selection was saved).
router.get('/config/web-search-inference/effective', requireAuth, requireAdmin, async (req, res) => {
    try {
        const resolved = await resolveInferenceTargets();
        res.json({ resolved });
    } catch (e) {
        log.error('Failed to resolve web-search inference targets:', e);
        res.status(500).json({ error: 'Failed to resolve targets' });
    }
});

module.exports = router;
