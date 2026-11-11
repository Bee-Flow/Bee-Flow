// @typecheck strict
/**
 * The shared FX arithmetic of core/text/currency fxFactor and
 * stores/usage/logUsage.js: USD-based rates in, a from->to factor out.
 *
 * Run: cd server && node --test utils/fxFactor.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { fxFactorVia } = require('./fxFactor.mts');

/** 1 USD buys this much of each. */
const RATES = /** @type {Record<string, number>} */ ({ USD: 1, EUR: 0.8, GBP: 0.5, BAD: 0 });

/** @type {Array<{ code: string, strict: boolean }>} */
const asked = [];
const rateOf = async (/** @type {string} */ code, /** @type {{ strict: boolean }} */ opts) => {
    asked.push({ code, strict: opts.strict });
    return RATES[code] ?? 1;
};
const close = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-12;

test('USD to a currency is that currency\'s rate, one lookup', async () => {
    asked.length = 0;
    assert.strictEqual(await fxFactorVia(rateOf, 'USD', 'EUR'), 0.8);
    assert.deepStrictEqual(asked, [{ code: 'EUR', strict: false }]);
});

test('a currency to USD is the inverse of its rate', async () => {
    assert.ok(close(await fxFactorVia(rateOf, 'EUR', 'USD'), 1.25));
});

test('between two non-USD currencies it goes through USD, both lookups with the same strict switch', async () => {
    asked.length = 0;
    assert.ok(close(await fxFactorVia(rateOf, 'EUR', 'GBP', true), 0.5 / 0.8));
    assert.deepStrictEqual(asked, [{ code: 'EUR', strict: true }, { code: 'GBP', strict: true }]);
});

test('a rate that cannot be inverted or divided is NaN, never a guess', async () => {
    assert.ok(Number.isNaN(await fxFactorVia(rateOf, 'BAD', 'USD')));
    assert.ok(Number.isNaN(await fxFactorVia(rateOf, 'BAD', 'EUR')));
    assert.ok(Number.isNaN(await fxFactorVia(rateOf, 'EUR', 'BAD')));
});

test('a strict lookup that throws is not caught', async () => {
    const failing = async () => { throw new Error('fx_rate_unavailable: USD->EUR'); };
    await assert.rejects(() => fxFactorVia(failing, 'EUR', 'USD', true), /fx_rate_unavailable/);
});
