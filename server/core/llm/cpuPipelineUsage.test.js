// @typecheck
'use strict';

/**
 * core/llm/cpuPipelineUsage.js — the last-used markers of the CPU models.
 *
 * Run: cd server && node --test core/llm/cpuPipelineUsage.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const usage = require('./cpuPipelineUsage');

const DAY = 24 * 60 * 60 * 1000;

/** A configStore double: mutateConfig applies the mutator to the held value. */
function fakeStore() {
    /** @type {Record<string, unknown>} */
    const values = {};
    let writes = 0;
    return {
        values,
        get writes() { return writes; },
        async getConfig(/** @type {string} */ key) { return values[key]; },
        async mutateConfig(/** @type {string} */ key, /** @type {(cur: unknown) => unknown} */ fn) {
            writes++;
            values[key] = fn(values[key]);
            return values[key];
        },
    };
}

beforeEach(() => usage._resetForTests());

test('markUsed stamps the pipeline and keeps the others', async () => {
    const store = fakeStore();
    store.values[usage.CONFIG_KEY] = { embed: '2026-01-01T00:00:00.000Z' };
    const now = Date.parse('2026-10-30T07:00:00.000Z');
    await usage.markUsed('rerank', { store, now: () => now });
    assert.deepStrictEqual(store.values[usage.CONFIG_KEY], {
        embed: '2026-01-01T00:00:00.000Z',
        rerank: '2026-10-30T07:00:00.000Z',
    });
});

test('one write per pipeline per hour, whatever the call rate', async () => {
    const store = fakeStore();
    let now = 1_000_000;
    const deps = { store, now: () => now };
    await usage.markUsed('whisper', deps);
    now += 10 * 60 * 1000;
    await usage.markUsed('whisper', deps);
    await usage.markUsed('whisper', deps);
    assert.strictEqual(store.writes, 1);
    now += 60 * 60 * 1000;
    await usage.markUsed('whisper', deps);
    assert.strictEqual(store.writes, 2);
});

test('a failed write never throws and is tried again on the next call', async () => {
    let fail = true;
    const store = fakeStore();
    const mutate = store.mutateConfig.bind(store);
    store.mutateConfig = async (key, fn) => { if (fail) throw new Error('timeout'); return mutate(key, fn); };
    const deps = { store, now: () => 5_000_000 };
    await usage.markUsed('embed', deps);
    assert.strictEqual(store.values[usage.CONFIG_KEY], undefined);
    fail = false;
    await usage.markUsed('embed', deps);
    assert.ok(store.values[usage.CONFIG_KEY], 'the retry after a failure is not throttled');
});

test('an unknown pipeline name is ignored', async () => {
    const store = fakeStore();
    // @ts-expect-error — the guard under test
    await usage.markUsed('gpu', { store });
    assert.strictEqual(store.writes, 0);
});

test('readLastUsed parses timestamps and treats junk as never', async () => {
    const store = fakeStore();
    store.values[usage.CONFIG_KEY] = { rerank: '2026-10-01T00:00:00.000Z', embed: 'yesterday', whisper: 42 };
    const got = await usage.readLastUsed({ store });
    assert.deepStrictEqual(got, { rerank: Date.parse('2026-10-01T00:00:00.000Z'), embed: null, whisper: null });
    assert.deepStrictEqual(usage.parseLastUsed(null), { rerank: null, embed: null, whisper: null });
});

test('usedWithin is inclusive of the window and false for never', () => {
    const now = Date.parse('2026-10-30T00:00:00.000Z');
    const lastUsed = { rerank: now - 30 * DAY, embed: now - 31 * DAY, whisper: null };
    assert.strictEqual(usage.usedWithin(lastUsed, 'rerank', 30, now), true);
    assert.strictEqual(usage.usedWithin(lastUsed, 'embed', 30, now), false);
    assert.strictEqual(usage.usedWithin(lastUsed, 'whisper', 30, now), false);
});
