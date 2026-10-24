// @typecheck
const { test } = require('node:test');
const assert = require('node:assert');

const configStore = require('../../stores/configStore');
const currency = require('./currency');

test('getAllConfiguredRates lists every stored rate via listKeysWithPrefix, not only the probe list', async (t) => {
    const stored = { currency_fx_usd_pln: '4.1', currency_fx_usd_eur: '0.92', currency_fx_usd_bogus1: '9' };
    t.mock.method(configStore, 'listKeysWithPrefix', async (prefix) => {
        assert.strictEqual(prefix, 'currency_fx_usd_');
        return Object.keys(stored);
    });
    t.mock.method(configStore, 'getConfig', async (k) => stored[k] ?? null);
    assert.deepStrictEqual(await currency.getAllConfiguredRates(), { pln: 4.1, eur: 0.92 });
});
