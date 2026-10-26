// @typecheck strict
'use strict';
/**
 * The community pricing file behind the REAL core/llm/pricingService, for a
 * test of cost code (modelCosts, priceCatalog) that must not touch the network.
 *
 * The boundary is `fetch`, the one pricingService uses: it is answered with a
 * litellm-shaped table built from rates in USD per 1M tokens (what the test
 * wants to read back), pricingService caches it and answers its own lookups
 * (prefix match, fuzzy match, exact key, detail), so nothing is put in the
 * module cache.
 *
 *   await loadPricing({ 'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 } });
 *   const { computeCost } = require('./modelCosts');
 *
 * An entry may also carry `tiers` (batch / flex / priority rates) and `longCtx`
 * (the rate above a context threshold), written as the file writes them
 * (`input_cost_per_token_flex`, `input_cost_per_token_above_200k_tokens`, ...),
 * or a litellm `extra` object merged into the file entry as it is.
 */

const PRICING_URL_RE = /model_prices_and_context_window\.json/;

/**
 * A per-token cost that pricingService turns back into exactly `perMillion`
 * (x * 1e6 in floating point), so a test can assert the number it wrote.
 * @param {number} perMillion
 */
function perToken(perMillion) {
    const buf = new DataView(new ArrayBuffer(8));
    let x = perMillion / 1e6;
    if (x * 1e6 === perMillion) return x;
    buf.setFloat64(0, x);
    const base = buf.getBigUint64(0);
    for (let d = 1n; d <= 8n; d++) {
        for (const delta of [d, -d]) {
            buf.setBigUint64(0, base + delta);
            x = buf.getFloat64(0);
            if (x * 1e6 === perMillion) return x;
        }
    }
    throw new Error(`pricingFeed: ${perMillion} per 1M tokens does not survive the per-token round trip`);
}

const TIER_SUFFIX = { batch: '_batches', flex: '_flex', priority: '_priority' };

/** @param {any} r the entry's tiers / longCtx, as litellm field names */
function tierFields(r) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [tier, rate] of Object.entries(r.tiers || {})) {
        const suffix = TIER_SUFFIX[/** @type {keyof typeof TIER_SUFFIX} */ (tier)];
        out[`input_cost_per_token${suffix}`] = perToken(rate.input);
        out[`output_cost_per_token${suffix}`] = perToken(rate.output);
        if (rate.cacheRead) out[`cache_read_input_token_cost${suffix}`] = perToken(rate.cacheRead);
    }
    if (r.longCtx) {
        const k = `${r.longCtx.threshold / 1000}k`;
        out[`input_cost_per_token_above_${k}_tokens`] = perToken(r.longCtx.input);
        out[`output_cost_per_token_above_${k}_tokens`] = perToken(r.longCtx.output);
        if (r.longCtx.cacheRead) out[`cache_read_input_token_cost_above_${k}_tokens`] = perToken(r.longCtx.cacheRead);
    }
    return out;
}

/**
 * @typedef {{ input: number, output: number, cacheRead?: number }} Rate
 * @param {Record<string, Rate & { provider?: string, extra?: Record<string, unknown>,
 *   tiers?: Partial<Record<'batch' | 'flex' | 'priority', Rate>>,
 *   longCtx?: Rate & { threshold: number } }>} rates USD per 1M tokens, keyed as the file keys them
 */
async function loadPricing(rates) {
    /** @type {Record<string, any>} */
    const file = {};
    for (const [key, r] of Object.entries(rates)) {
        file[key] = {
            input_cost_per_token: perToken(r.input),
            output_cost_per_token: perToken(r.output),
            ...(r.cacheRead ? { cache_read_input_token_cost: perToken(r.cacheRead) } : {}),
            ...(r.provider ? { litellm_provider: r.provider } : {}),
            ...tierFields(r),
            ...(r.extra || {}),
        };
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (async (/** @type {unknown} */ url) => {
        if (!PRICING_URL_RE.test(String(url))) throw new Error(`pricingFeed: unexpected fetch ${String(url)}`);
        return { ok: true, status: 200, json: async () => structuredClone(file) };
    });
    try {
        await require('../core/llm/pricingService').fetchAllPricing(true);
    } finally {
        globalThis.fetch = realFetch;
    }
}

module.exports = { loadPricing };
