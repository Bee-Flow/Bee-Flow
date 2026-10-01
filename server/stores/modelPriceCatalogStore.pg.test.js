/**
 * model_price_catalog against a REAL Postgres (@electric-sql/pglite behind db.js's
 * pool, testUtils/pglitePool.js). The store runs its own schema init and SQL;
 * nothing is mocked.
 *
 * Proven:
 *   - the schema init is idempotent (boot runs it on every start) and loads the
 *     in-memory index modelCosts reads;
 *   - a card is appended; the same (provider, model, tier, valid_from) a second
 *     time is left untouched (append-only), a new valid_from is a new row;
 *   - a write refreshes the index at once, and a lookup returns the row in force
 *     at the asked timestamp, future-dated rows included;
 *   - closeRow only ends an open row, only after its start, and never moves a
 *     closed one, so a past call's price cannot change;
 *   - a poisoned card is refused at the door, and one that reaches the table by
 *     another route (a direct INSERT) is dropped from the index, not applied;
 *   - NUMERIC rates keep their digits.
 *
 * Run: cd server && node --test stores/modelPriceCatalogStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./modelPriceCatalogStore');
const catalog = require('./lib/priceCatalog');

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function card(over = {}) {
    return {
        provider: 'scaleway', model_id: 'qwen3.6-35b-a3b', tier: 'standard', currency: 'EUR',
        input: 0.25, output: 1.5, cache_read: null,
        source: 'scaleway-product-catalog', catalog_version: '2026-10-01',
        valid_from: iso(NOW - 30 * DAY),
        ...over,
    };
}

before(async () => { await store.initDB(); });
after(close);

test('the schema init is idempotent and the table has the planned columns', async () => {
    await store.initDB();
    const { rows } = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'model_price_catalog'`);
    const cols = rows.map((r) => r.column_name);
    for (const c of ['provider', 'model_id', 'tier', 'currency', 'input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h',
        'long_ctx_threshold', 'long_ctx_rates', 'multipliers', 'source', 'catalog_version', 'valid_from', 'valid_to']) {
        assert.ok(cols.includes(c), `column ${c}`);
    }
});

test('adding a card refreshes the index at once; the lookup is time-correct', async () => {
    const added = await store.addPrice(card());
    assert.strictEqual(added.inserted, true);
    const q = (at) => catalog.lookup({ provider: 'scaleway', model: 'qwen3.6-35b-a3b', at });
    const row = q(NOW);
    assert.strictEqual(row.currency, 'EUR');
    assert.strictEqual(row.input, 0.25);
    assert.strictEqual(q(NOW - 31 * DAY), null, 'before its valid_from');
});

test('append-only: the same card twice is one row; a changed rate is a NEW row with a later start', async () => {
    const again = await store.addPrice(card({ input: 99 }));
    assert.strictEqual(again.inserted, false, 'same (provider, model, tier, valid_from): untouched');
    assert.strictEqual(catalog.lookup({ provider: 'scaleway', model: 'qwen3.6-35b-a3b', at: NOW }).input, 0.25);

    const stepUp = NOW + 20 * DAY;
    const next = await store.addPrice(card({ input: 0.4, output: 2, catalog_version: '2026-10-15', valid_from: iso(stepUp) }));
    assert.strictEqual(next.inserted, true);
    const q = (at) => catalog.lookup({ provider: 'scaleway', model: 'qwen3.6-35b-a3b', at });
    assert.strictEqual(q(NOW).input, 0.25, 'a future-dated row does not touch today');
    assert.strictEqual(q(stepUp - 1).input, 0.25);
    assert.strictEqual(q(stepUp).input, 0.4);
    assert.strictEqual(q(NOW - 5 * DAY).input, 0.25, 'the old row is still the answer for the past');

    const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM model_price_catalog WHERE model_id = 'qwen3.6-35b-a3b'`);
    assert.strictEqual(rows[0].n, 2);
});

test('NUMERIC keeps the digits of a small per-million rate', async () => {
    await store.addPrice(card({ model_id: 'tiny-embed', input: 0.0123456789, output: 0, source: 'scaleway-product-catalog' }));
    const { rows } = await pg.query(`SELECT input::text AS input FROM model_price_catalog WHERE model_id = 'tiny-embed'`);
    assert.strictEqual(rows[0].input, '0.0123456789');
    assert.strictEqual(catalog.lookup({ provider: 'scaleway', model: 'tiny-embed', at: NOW }).input, 0.0123456789);
});

test('tier cards, long-context rates and multipliers survive the JSONB round trip', async () => {
    await store.addPrice({
        provider: 'claude', model_id: 'claude-store-1', currency: 'USD', input: 5, output: 25, cache_read: 0.5,
        cache_write_5m: 6.25, cache_write_1h: 10,
        long_ctx_threshold: 200000, long_ctx_rates: { input: 10, output: 37.5 },
        multipliers: { batch: 0.5, geo: { us: 1.1 } },
        source: 'anthropic-pricing', catalog_version: 'v1', valid_from: iso(NOW - DAY),
    });
    const row = catalog.lookup({ provider: 'claude', model: 'claude-store-1', at: NOW });
    assert.strictEqual(row.long_ctx_threshold, 200000);
    assert.strictEqual(row.long_ctx_rates.output, 37.5);
    assert.strictEqual(row.multipliers.batch, 0.5);
    assert.strictEqual(row.multipliers.geo.us, 1.1);
    assert.strictEqual(row.cache_write_1h, 10);
});

test('closeRow ends an open row once, after its start, and never moves a closed one', async () => {
    const { id } = await store.addPrice(card({ model_id: 'promo-model', valid_from: iso(NOW - 10 * DAY) }));
    assert.strictEqual((await store.closeRow(id, iso(NOW - 20 * DAY))).closed, false, 'cannot close before it started');
    const end = NOW - 2 * DAY;
    assert.strictEqual((await store.closeRow(id, iso(end))).closed, true);
    assert.strictEqual((await store.closeRow(id, iso(NOW + DAY))).closed, false, 'a closed row is not moved');
    const q = (at) => catalog.lookup({ provider: 'scaleway', model: 'promo-model', at });
    assert.ok(q(NOW - 5 * DAY), 'a call during the promo still finds it');
    assert.strictEqual(q(NOW), null, 'after the end it no longer applies');
});

test('a poisoned card is refused before it reaches the table', async () => {
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM model_price_catalog')).rows[0].n;
    for (const bad of [
        card({ model_id: 'x1', input: -1 }),
        card({ model_id: 'x2', input: 1e12 }),
        card({ model_id: 'x3', provider: 'not-a-provider' }),
        card({ model_id: 'x4', tier: 'free' }),
        card({ model_id: 'x5', source: 'a\u0000b' }),
        card({ model_id: 'x6', multipliers: { batch: 0 } }),
        card({ model_id: "x7'; DROP TABLE model_price_catalog; --" }),
    ]) {
        await assert.rejects(store.addPrice(bad), /model_price_catalog/);
    }
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM model_price_catalog')).rows[0].n, before);
});

test('a hostile model id that passes validation is stored as data, never as SQL', async () => {
    const id = "gpt-x');DROP-TABLE-model_price_catalog;--";
    const res = await store.addPrice(card({ provider: 'openai', model_id: id, currency: 'USD' }));
    assert.strictEqual(res.inserted, true);
    const { rows } = await pg.query('SELECT model_id FROM model_price_catalog WHERE model_id = $1', [id]);
    assert.strictEqual(rows.length, 1);
    await pg.query('SELECT 1 FROM model_price_catalog LIMIT 1'); // the table is still there
});

test('the table itself refuses a negative rate, and a row that bypassed the API is dropped from the index', async () => {
    await assert.rejects(pg.query(
        `INSERT INTO model_price_catalog (provider, model_id, input, output, source, catalog_version) VALUES ('openai', 'neg', -1, 1, 's', 'v')`));
    // A row written by something else with a value the index will not accept
    // (an unknown tier) must be skipped when the index loads, not applied.
    await pg.query(
        `INSERT INTO model_price_catalog (provider, model_id, tier, input, output, source, catalog_version) VALUES ('openai', 'rogue-tier', 'free', 0, 0, 's', 'v')`);
    const res = await store.refreshIndex();
    assert.ok(res.dropped >= 1);
    assert.strictEqual(catalog.lookup({ provider: 'openai', model: 'rogue-tier', at: NOW }), null);
});

test('listPrices answers the history of one model, newest start first', async () => {
    const rows = await store.listPrices({ provider: 'scaleway', modelId: 'QWEN3.6-35B-A3B' });
    assert.strictEqual(rows.length, 2);
    assert.ok(Date.parse(rows[0].valid_from) > Date.parse(rows[1].valid_from));
});
