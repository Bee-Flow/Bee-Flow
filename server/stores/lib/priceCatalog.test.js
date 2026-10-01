/**
 * DB-free tests — the in-memory price catalogue index.
 *
 * What matters here:
 *   - a lookup answers the row whose valid_from <= at < valid_to, so a
 *     future-dated row is invisible before its start and an expired row after
 *     its end;
 *   - rows are APPEND-style: a later valid_from supersedes, the earlier one stays
 *     the answer for earlier timestamps;
 *   - rows come from an import job that fetches third-party data, so a bad row
 *     is dropped (never thrown on, never half-applied) and a hostile shape
 *     (prototype keys, NaN, negative or absurd rates) cannot get in.
 *
 * Run: cd server && node --test stores/lib/priceCatalog.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('./priceCatalog');

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

function row(over = {}) {
    return {
        provider: 'claude', model_id: 'claude-test-1', tier: 'standard', currency: 'USD',
        input: 3, output: 15, cache_read: 0.3, cache_write_5m: null, cache_write_1h: null,
        long_ctx_threshold: null, long_ctx_rates: null, multipliers: null,
        source: 'manual', catalog_version: 'v1',
        valid_from: new Date(T0).toISOString(), valid_to: null,
        ...over,
    };
}

test.beforeEach(() => { catalog.clear(); catalog.setRefresher(null); });

test('a lookup answers the row in force at the timestamp, half-open on both ends', () => {
    catalog.setRows([row({ valid_from: new Date(T0).toISOString(), valid_to: new Date(T0 + 10 * DAY).toISOString() })]);
    const q = (at) => catalog.lookup({ provider: 'claude', model: 'claude-test-1', at });
    assert.strictEqual(q(T0 - 1), null, 'before valid_from');
    assert.ok(q(T0), 'valid_from is inclusive');
    assert.ok(q(T0 + 10 * DAY - 1));
    assert.strictEqual(q(T0 + 10 * DAY), null, 'valid_to is exclusive');
});

test('a later card supersedes from its own start and never before it', () => {
    catalog.setRows([
        row({ input: 3, catalog_version: 'old', valid_from: new Date(T0).toISOString() }),
        row({ input: 4, catalog_version: 'new', valid_from: new Date(T0 + 30 * DAY).toISOString() }),
    ]);
    const at = (ms) => catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: ms }).catalog_version;
    assert.strictEqual(at(T0 + 29 * DAY), 'old');
    assert.strictEqual(at(T0 + 30 * DAY), 'new');
    assert.strictEqual(at(T0 + 90 * DAY), 'new');
    assert.strictEqual(at(T0 + 5 * DAY), 'old', 'history keeps answering with the old card');
});

test('a future-dated row exists in the index but is invisible to every earlier timestamp', () => {
    const future = Date.now() + 40 * DAY;
    catalog.setRows([row({ input: 99, valid_from: new Date(future).toISOString() })]);
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1' }), null, 'now is before it');
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: future - 1 }), null);
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: future }).input, 99);
});

test('model ids match case-insensitively, tiers and providers exactly', () => {
    catalog.setRows([row({ model_id: 'Claude-Test-1' }), row({ model_id: 'claude-test-1', tier: 'batch', input: 1.5, valid_from: new Date(T0).toISOString() })]);
    assert.ok(catalog.lookup({ provider: 'claude', model: 'CLAUDE-TEST-1', at: T0 }));
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', tier: 'batch', at: T0 }).input, 1.5);
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', tier: 'flex', at: T0 }), null);
    assert.strictEqual(catalog.lookup({ provider: 'openai', model: 'claude-test-1', at: T0 }), null, 'never another provider\'s card');
});

test('provider spellings normalise (anthropic -> claude, vertex -> google-vertex)', () => {
    assert.strictEqual(catalog.normalizeProvider('Anthropic'), 'claude');
    assert.strictEqual(catalog.normalizeProvider('vertex'), 'google-vertex');
    assert.strictEqual(catalog.normalizeProvider('gemini'), 'google');
    assert.strictEqual(catalog.normalizeProvider('local'), null, 'local is never priced from the catalogue');
    assert.strictEqual(catalog.normalizeProvider('__proto__'), null);
    assert.strictEqual(catalog.normalizeProvider('constructor'), null);
});

test('providersFor lists the providers that hold a card for a model id', () => {
    catalog.setRows([
        row({ provider: 'scaleway', model_id: 'gpt-oss-120b', currency: 'EUR' }),
        row({ provider: 'openai', model_id: 'gpt-oss-120b' }),
    ]);
    assert.deepStrictEqual(catalog.providersFor('GPT-OSS-120B').sort(), ['openai', 'scaleway']);
    assert.deepStrictEqual(catalog.providersFor('nope'), []);
});

// ─── Hostile or broken rows ──────────────────────────────────────────────────

test('invalid rows are dropped, the valid ones still load, nothing throws', () => {
    const res = catalog.setRows([
        row(),
        row({ model_id: 'nan-rate', input: NaN }),
        row({ model_id: 'neg-rate', output: -1 }),
        row({ model_id: 'huge-rate', input: 1e12 }),
        row({ model_id: 'string-rate', input: 'abc' }),
        row({ model_id: 'bad-provider', provider: 'evil' }),
        row({ model_id: 'bad-tier', tier: 'free' }),
        row({ model_id: 'bad-currency', currency: 'dollars' }),
        row({ model_id: 'reversed', valid_from: '2026-02-01T00:00:00Z', valid_to: '2026-01-01T00:00:00Z' }),
        row({ model_id: 'bad-date', valid_from: 'not a date' }),
        row({ model_id: 'no source', source: '' }),
        row({ model_id: 'ctl\u0000char' }),
        null, 'string', 42,
    ]);
    assert.strictEqual(res.loaded, 1);
    assert.strictEqual(res.dropped, 14);
    assert.ok(catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: T0 }));
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'nan-rate', at: T0 }), null);
});

test('multipliers are whitelisted, bounded and built without a prototype', () => {
    const evil = JSON.parse('{"batch":0.5,"__proto__":{"polluted":1},"constructor":{"x":1},"geo":{"us":1.1,"__proto__":2},"unknown":9}');
    const v = catalog.validateRow(row({ multipliers: evil }));
    // "__proto__" as a geo key is refused outright, so the whole row is.
    assert.ok(v.error, 'a prototype key in geo rejects the row');
    assert.strictEqual({}.polluted, undefined, 'Object.prototype untouched');

    const ok = catalog.validateRow(row({ multipliers: { batch: 0.5, flex: 0.5, priority: 2, regional: 1.1, geo: { us: 1.1 }, junk: 5 } }));
    assert.ok(ok.row);
    assert.strictEqual(ok.row.multipliers.batch, 0.5);
    assert.strictEqual(ok.row.multipliers.geo.us, 1.1);
    assert.strictEqual(Object.getPrototypeOf(ok.row.multipliers), null);
    assert.strictEqual(ok.row.multipliers.junk, undefined, 'only whitelisted keys survive');
});

test('multiplier values outside (0, 100] and too many geo keys are refused', () => {
    for (const bad of [0, -1, 101, NaN, 'x', Infinity]) {
        assert.ok(catalog.validateRow(row({ multipliers: { batch: bad } })).error, `batch ${bad}`);
    }
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`g${i}`, 1.1]));
    assert.ok(catalog.validateRow(row({ multipliers: { geo: many } })).error);
});

test('long-context rates need a threshold, sane numbers and a prototype-free map', () => {
    assert.ok(catalog.validateRow(row({ long_ctx_threshold: 200000 })).error, 'threshold without rates');
    assert.ok(catalog.validateRow(row({ long_ctx_threshold: -5, long_ctx_rates: { input: 6 } })).error);
    assert.ok(catalog.validateRow(row({ long_ctx_threshold: 200000, long_ctx_rates: { input: -6 } })).error);
    assert.ok(catalog.validateRow(row({ long_ctx_threshold: 200000, long_ctx_rates: { cache_read: 1 } })).error, 'needs input or output');
    const ok = catalog.validateRow(row({ long_ctx_threshold: 200000, long_ctx_rates: JSON.stringify({ input: 6, output: 22.5, evil: 1 }) }));
    assert.ok(ok.row);
    assert.deepStrictEqual({ ...ok.row.long_ctx_rates }, { input: 6, output: 22.5 });
});

test('JSON columns arrive as text from a database and are parsed; broken JSON drops the row', () => {
    const ok = catalog.validateRow(row({ multipliers: '{"batch":0.5}' }));
    assert.strictEqual(ok.row.multipliers.batch, 0.5);
    assert.ok(catalog.validateRow(row({ multipliers: '{not json' })).error);
});

test('validity dates accept Date objects (what node-postgres returns) and default to the epoch', () => {
    const v = catalog.validateRow(row({ valid_from: new Date(T0), valid_to: new Date(T0 + DAY) }));
    assert.strictEqual(v.row.validFromMs, T0);
    const open = catalog.validateRow(row({ valid_from: undefined }));
    assert.strictEqual(open.row.validFromMs, 0);
    assert.strictEqual(open.row.valid_to, null);
});

// ─── Refresh ─────────────────────────────────────────────────────────────────

test('a stale snapshot is refreshed in the background and a failing refresh keeps the last good one', async () => {
    catalog.setRows([row({ input: 3 })]);
    let calls = 0;
    let fail = false;
    catalog.setRefresher(async () => {
        calls += 1;
        if (fail) throw new Error('db down');
        return [row({ input: 4 })];
    }, -1); // every lookup considers the snapshot stale

    const first = catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: T0 });
    assert.strictEqual(first.input, 3, 'a lookup never waits for the refresh');
    await catalog.refreshNow();
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: T0 }).input, 4);

    fail = true;
    await catalog.refreshNow();
    assert.strictEqual(catalog.lookup({ provider: 'claude', model: 'claude-test-1', at: T0 }).input, 4, 'last good snapshot stays');
    assert.ok(calls >= 2);
    await catalog.refreshNow(); // settle any background refresh before the test ends
});

test('listActive: one standard row per model, the one in force at the time (donors for an estimate)', () => {
    catalog.setRows([
        row({ model_id: 'm-a', input: 1, valid_from: new Date(T0).toISOString() }),
        row({ model_id: 'm-a', input: 2, valid_from: new Date(T0 + 30 * DAY).toISOString() }),
        row({ model_id: 'm-b', provider: 'openai', valid_from: new Date(T0 + 60 * DAY).toISOString() }),
        row({ model_id: 'm-c', valid_from: new Date(T0).toISOString(), valid_to: new Date(T0 + 10 * DAY).toISOString() }),
        row({ model_id: 'm-a', tier: 'batch', input: 0.5, valid_from: new Date(T0).toISOString() }),
    ]);
    const ids = (at) => catalog.listActive({ at }).map((r) => `${r.model_id}:${r.input}`).sort();
    assert.deepStrictEqual(ids(T0 + 5 * DAY), ['m-a:1', 'm-c:3']);
    assert.deepStrictEqual(ids(T0 + 40 * DAY), ['m-a:2'], 'm-c expired, m-b not yet started, the batch card is not a donor');
    assert.deepStrictEqual(ids(T0 + 70 * DAY), ['m-a:2', 'm-b:3']);
    assert.deepStrictEqual(catalog.listActive({ at: T0 - DAY }), []);
});
