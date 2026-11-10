// @typecheck strict
const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const currency = require('./currency');

test('getAllConfiguredRates lists every stored rate via listKeysWithPrefix, not only the probe list', async (t) => {
    const stored = { currency_fx_usd_pln: '4.1', currency_fx_usd_eur: '0.92', currency_fx_usd_bogus1: '9' };
    t.mock.method(configStore, 'listKeysWithPrefix', async (/** @type {string} */ prefix) => {
        assert.strictEqual(prefix, 'currency_fx_usd_');
        return Object.keys(stored);
    });
    t.mock.method(configStore, 'getConfig', async (/** @type {string} */ k) => /** @type {Record<string, unknown>} */ (stored)[k] ?? null);
    assert.deepStrictEqual(await currency.getAllConfiguredRates(), { pln: 4.1, eur: 0.92 });
});

test('a failed rate lookup is not cached as 1.0: a strict caller still refuses, and recovery is seen at once', async (t) => {
    currency.invalidateFxCache();
    let fail = true;
    t.mock.method(configStore, 'getConfig', async () => {
        if (fail) throw new Error('db down');
        return '7.5';
    });
    assert.strictEqual(await currency.getUsdToCurrencyRate('ZZA'), 1, 'best-effort caller gets the 1.0 fallback');
    await assert.rejects(() => currency.getUsdToCurrencyRate('ZZA', { strict: true }), /fx_rate_unavailable/);
    fail = false;
    assert.strictEqual(await currency.getUsdToCurrencyRate('ZZA', { strict: true }), 7.5);
});
