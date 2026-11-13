'use strict';

/**
 * A call with a price of its own (one generated image at the price the admin
 * entered): the cost is that price, in its currency, whatever the model and
 * whatever tokens came along. Every other call is rated the normal way.
 *
 * Run: cd server && node --test stores/usage/unitPrice.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { withUnitPrice } = require('./unitPrice');

/** A rateUsage stand-in that records what reached it. */
function rater() {
    const seen = [];
    const rate = withUnitPrice((entry) => { seen.push(entry); return { cost: 42, source: 'card' }; });
    return { seen, rate };
}

test('the unit price is the cost, in its own currency, and no price card is consulted', () => {
    const { seen, rate } = rater();
    const rated = rate({ model: 'gpt-image-1.5', provider_type: 'azure', prompt_tokens: 12, completion_tokens: 4160, timestamp: '2026-11-13T12:00:00.000Z', unit_cost: { amount: 0.05, currency: 'EUR' } });
    assert.strictEqual(rated.cost, 0.05);
    assert.strictEqual(rated.currency, 'EUR');
    assert.strictEqual(rated.source, 'unit-price');
    assert.strictEqual(rated.cost_basis, 'exact');
    assert.strictEqual(rated.model, 'gpt-image-1.5');
    assert.strictEqual(rated.provider, 'azure');
    assert.strictEqual(rated.at, '2026-11-13T12:00:00.000Z');
    assert.deepStrictEqual(rated.notes, ['unit_price']);
    assert.strictEqual(rated.price_input, 0);
    assert.strictEqual(rated.price_output, 0);
    assert.deepStrictEqual(seen, []);
});

test('a free image costs nothing', () => {
    const { seen, rate } = rater();
    assert.strictEqual(rate({ model: 'some-image-deployment', unit_cost: { amount: 0, currency: 'EUR' } }).cost, 0);
    assert.deepStrictEqual(seen, []);
});

test('a call without a unit price, or with a damaged one, is rated the normal way', () => {
    for (const unit_cost of [undefined, { amount: -1, currency: 'EUR' }, { amount: NaN }, { amount: '0.05' }, 'x', null]) {
        const { seen, rate } = rater();
        const rated = rate({ model: 'gpt-5', prompt_tokens: 1000, unit_cost });
        assert.strictEqual(rated.source, 'card');
        assert.strictEqual(seen.length, 1);
    }
});
