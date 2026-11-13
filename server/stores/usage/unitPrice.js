// @typecheck strict
/**
 * The rating of a call that carries a price of its own: one generated image at
 * the price the admin entered for its deployment (core/media/imageGeneration.mts).
 * The cost is that price, in its currency; no tokens are rated and no price
 * card is looked up, so an image deployment is never reported as an unknown
 * model. Every other call goes to modelCosts.rateUsage unchanged. usageStore
 * puts this in front of the rating of every usage row.
 */

'use strict';

/** @typedef {typeof import('../../core/llm/modelCosts').rateUsage} RateUsage */

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' && v ? v : null);

/**
 * The price a usage entry carries, or null when it carries none (or a damaged one).
 * @param {unknown} unit  `{ amount, currency }` as the caller logged it
 * @returns {{ amount: number, currency: string } | null}
 */
function unitPriceOf(unit) {
    if (!unit || typeof unit !== 'object') return null;
    const { amount, currency } = /** @type {{ amount?: unknown, currency?: unknown }} */ (unit);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
    return { amount, currency: typeof currency === 'string' && currency ? currency : 'USD' };
}

/**
 * rateUsage with the unit price in front of it.
 * @param {RateUsage} rateUsage
 * @returns {RateUsage}
 */
function withUnitPrice(rateUsage) {
    return /** @type {RateUsage} */ ((/** @type {Record<string, unknown>} */ entry = {}) => {
        const unit = unitPriceOf(entry.unit_cost);
        if (!unit) return rateUsage(entry);
        const stamp = entry.timestamp ?? entry.at;
        const at = stamp instanceof Date || typeof stamp === 'string' || typeof stamp === 'number' ? new Date(stamp) : new Date();
        return {
            model: text(entry.model) || '',
            provider: text(entry.provider_type) || text(entry.provider),
            at: (Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
            tier: 'standard',
            inference_geo: null,
            cost: unit.amount, input_cost: 0, output_cost: unit.amount,
            currency: unit.currency, long_context: false,
            source: 'unit-price', catalog_version: null, valid_from: null, cost_basis: 'exact',
            rates: { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
            multiplier: { tier_input: 1, tier_output: 1, geo: 1, regional: 1, total: 1 },
            price_input: 0, price_output: 0, price_cache_read: 0, price_cache_write: 0,
            notes: ['unit_price'],
        };
    });
}

module.exports = { withUnitPrice, unitPriceOf };
