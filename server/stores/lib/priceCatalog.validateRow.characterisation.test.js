// @typecheck
'use strict';

/**
 * Characterisation (golden) test for priceCatalog.validateRow: the cleaned
 * card or the first error, for rows that reach every check in order (provider,
 * model id, tier, currency, the two required rates, the cache rates, the
 * validity window, the long-context threshold and its rates, the multiplier
 * whitelist with regional and geo, source and catalogue version) and the
 * defaults a row may leave out. The maps of a card carry no prototype; the
 * test checks that too.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test stores/lib/priceCatalog.validateRow.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateRow } = require('./priceCatalog');

const GOLDEN = path.join(__dirname, 'priceCatalog.validateRow.characterisation.golden.json');

const OK = { provider: 'claude', model_id: 'claude-x', input: 3, output: 15, source: 'anthropic-pricing', catalog_version: '2026-09-01' };
const geo = (/** @type {number} */ n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, 1.1]));

/** @type {Record<string, unknown>} */
const CASES = {
    notAnObject: null,
    aString: 'row',
    minimal: OK,
    full: {
        ...OK, id: 42, provider: ' Anthropic ', model_id: '  claude-x  ', tier: 'BATCH', currency: 'eur',
        cache_read: '0.3', cache_write_5m: 3.75, cache_write_1h: '', valid_from: new Date(Date.UTC(2026, 0, 1)), valid_to: '2027-01-01T00:00:00Z',
        long_ctx_threshold: '200000.7', long_ctx_rates: JSON.stringify({ input: 6, output: '22.5', cache_read: null, junk: 1 }),
        multipliers: { batch: 0.5, flex: '0.6', priority: null, junk: 9, regional: 1.1, geo: { eu: 1.2, 'us-east': 1 } },
        source: '  anthropic-pricing-feed-with-a-really-long-name-that-goes-on-and-on-and-on-and-on  ',
    },
    unknownProvider: { ...OK, provider: 'local' },
    providerNotString: { ...OK, provider: 7 },
    providerProtoKey: { ...OK, provider: 'constructor' },
    modelIdEmpty: { ...OK, model_id: '  ' },
    modelIdSpace: { ...OK, model_id: 'a b' },
    modelIdNotString: { ...OK, model_id: 5 },
    modelIdTooLong: { ...OK, model_id: 'x'.repeat(201) },
    tierUnknown: { ...OK, tier: 'gold' },
    tierNotString: { ...OK, tier: 3 },
    tierNull: { ...OK, tier: null },
    currencyBad: { ...OK, currency: 'EURO' },
    currencyNumber: { ...OK, currency: 123 },
    inputMissing: { ...OK, input: null },
    outputEmpty: { ...OK, output: '' },
    inputNegative: { ...OK, input: -1 },
    inputTooHigh: { ...OK, input: 1_000_001 },
    inputAtCap: { ...OK, input: 1_000_000 },
    inputText: { ...OK, input: 'cheap' },
    cacheBad: { ...OK, cache_write_1h: 'x' },
    validFromBad: { ...OK, valid_from: 'soon' },
    validToBad: { ...OK, valid_to: {} },
    validToBeforeFrom: { ...OK, valid_from: '2026-02-01', valid_to: '2026-01-01' },
    validToEqualFrom: { ...OK, valid_from: '2026-02-01', valid_to: '2026-02-01' },
    longCtxEmptyThreshold: { ...OK, long_ctx_threshold: '', long_ctx_rates: 'not json' },
    longCtxThresholdZero: { ...OK, long_ctx_threshold: 0, long_ctx_rates: { input: 1 } },
    longCtxThresholdTooHigh: { ...OK, long_ctx_threshold: 100_000_001, long_ctx_rates: { input: 1 } },
    longCtxThresholdText: { ...OK, long_ctx_threshold: 'big', long_ctx_rates: { input: 1 } },
    longCtxNoRates: { ...OK, long_ctx_threshold: 1000 },
    longCtxBrokenJson: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: '{oops' },
    longCtxRatesArray: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: [1] },
    longCtxRateBad: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: { input: 1, cache_write_5m: -2 } },
    longCtxOnlyCache: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: { cache_read: 1 } },
    longCtxOnlyOutput: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: { output: 2 } },
    longCtxProtoRates: { ...OK, long_ctx_threshold: 1000, long_ctx_rates: Object.assign(Object.create({ input: 9 }), { output: 2 }) },
    multipliersNull: { ...OK, multipliers: null },
    multipliersBrokenJson: { ...OK, multipliers: '{' },
    multipliersArray: { ...OK, multipliers: [] },
    multipliersNumber: { ...OK, multipliers: 5 },
    multipliersJsonText: { ...OK, multipliers: JSON.stringify({ flex: 0.5, geo: { eu: 2 } }) },
    multipliersEmpty: { ...OK, multipliers: {} },
    multiplierZero: { ...OK, multipliers: { batch: 0 } },
    multiplierTooHigh: { ...OK, multipliers: { priority: 101 } },
    multiplierAtCap: { ...OK, multipliers: { priority: 100 } },
    regionalBad: { ...OK, multipliers: { regional: 'x' } },
    regionalNull: { ...OK, multipliers: { regional: null, geo: null } },
    geoArray: { ...OK, multipliers: { geo: [] } },
    geoString: { ...OK, multipliers: { geo: 'eu' } },
    geoSixteen: { ...OK, multipliers: { geo: geo(16) } },
    geoSeventeen: { ...OK, multipliers: { geo: geo(17) } },
    geoBadKey: { ...OK, multipliers: { geo: { 'EU!': 1 } } },
    geoBadValue: { ...OK, multipliers: { geo: { eu: -1 } } },
    sourceMissing: { ...OK, source: undefined },
    sourceBlank: { ...OK, source: '   ' },
    sourceNonAscii: { ...OK, source: 'prijs€' },
    versionMissing: { ...OK, catalog_version: 7 },
    versionNonAscii: { ...OK, catalog_version: 'v\n1' },
    idZero: { ...OK, id: 0 },
    idUndefined: { ...OK, id: undefined },
};

/** The result as plain data, with each map's prototype made visible. */
function described(/** @type {unknown} */ v) {
    const out = JSON.parse(JSON.stringify(v));
    const row = /** @type {any} */ (v)?.row;
    if (row) {
        out.prototypes = Object.fromEntries(['long_ctx_rates', 'multipliers'].map(k => [k, row[k] ? Object.getPrototypeOf(row[k]) === null : 'none']));
        if (row.multipliers?.geo) out.prototypes.geo = Object.getPrototypeOf(row.multipliers.geo) === null;
    }
    return out;
}

test('validateRow: every row matches the golden card or error', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, raw]) => [name, described(validateRow(raw))]));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});
