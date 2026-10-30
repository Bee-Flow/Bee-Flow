// @typecheck
'use strict';

/**
 * boot/cpuPipelineWarmup.js — which CPU models boot warms, when, and one at a
 * time. Everything injected: no model, no database, no real timer.
 *
 * Run: cd server && node --test boot/cpuPipelineWarmup.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    planCpuWarmups, runCpuWarmups, readPrewarmSettings, warmCpuPipelinesNow, startCpuPipelineWarmups,
    DEFAULT_DELAY_MS, DEFAULT_DAYS,
} = require('./cpuPipelineWarmup');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-30T07:00:00.000Z');
const quiet = { info() {}, warn() {} };
const allReachable = { rerank: true, embed: true, whisper: true };

test('auto: a model is warmed only when reachable AND used lately', () => {
    const { warm, skipped } = planCpuWarmups({
        mode: 'auto', days: 30, now: NOW,
        reachable: { rerank: true, embed: false, whisper: true },
        lastUsed: { rerank: NOW - 2 * DAY, embed: NOW - DAY, whisper: null },
    });
    assert.deepStrictEqual(warm, ['rerank']);
    assert.strictEqual(skipped.embed, 'another provider is configured');
    assert.strictEqual(skipped.whisper, 'never used');
});

test('auto: use older than the window does not count', () => {
    const { warm, skipped } = planCpuWarmups({
        mode: 'auto', days: 30, now: NOW, reachable: allReachable,
        lastUsed: { rerank: NOW - 31 * DAY, embed: NOW - 30 * DAY, whisper: NOW },
    });
    assert.deepStrictEqual(warm, ['embed', 'whisper']);
    assert.strictEqual(skipped.rerank, 'not used in the last 30 days');
});

test('all: every reachable model, used or not; off: none', () => {
    const never = { rerank: null, embed: null, whisper: null };
    const all = planCpuWarmups({ mode: 'all', days: 30, now: NOW, reachable: { ...allReachable, whisper: false }, lastUsed: never });
    assert.deepStrictEqual(all.warm, ['rerank', 'embed']);
    const off = planCpuWarmups({ mode: 'off', days: 30, now: NOW, reachable: allReachable, lastUsed: never });
    assert.deepStrictEqual(off.warm, []);
    assert.strictEqual(off.skipped.rerank, 'CPU_PIPELINES_PREWARM=false');
});

test('readPrewarmSettings: defaults, the off spellings, and bad numbers fall back', () => {
    assert.deepStrictEqual(readPrewarmSettings({}), { mode: 'auto', delayMs: DEFAULT_DELAY_MS, days: DEFAULT_DAYS });
    for (const v of ['false', '0', 'off', 'none', 'FALSE']) {
        assert.strictEqual(readPrewarmSettings({ CPU_PIPELINES_PREWARM: v }).mode, 'off', v);
    }
    assert.strictEqual(readPrewarmSettings({ CPU_PIPELINES_PREWARM: 'all' }).mode, 'all');
    assert.strictEqual(readPrewarmSettings({ CPU_PIPELINES_PREWARM: 'true' }).mode, 'all');
    assert.strictEqual(readPrewarmSettings({ CPU_PIPELINES_PREWARM: 'whatever' }).mode, 'auto');
    const s = readPrewarmSettings({ CPU_PIPELINES_PREWARM_DELAY_MS: '0', CPU_PIPELINES_PREWARM_DAYS: '-3' });
    assert.strictEqual(s.delayMs, 0);
    assert.strictEqual(s.days, DEFAULT_DAYS);
    assert.strictEqual(readPrewarmSettings({ CPU_PIPELINES_PREWARM_DELAY_MS: 'soon' }).delayMs, DEFAULT_DELAY_MS);
});

test('runCpuWarmups runs one model at a time, in order, and a failure does not stop the next', async () => {
    /** @type {string[]} */
    const events = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const warmer = (/** @type {string} */ name, fail = false) => async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        events.push(`end ${name}`);
        if (fail) throw new Error(`${name} broke`);
    };
    const warned = [];
    const logger = { info() {}, warn: (/** @type {string} */ m) => { warned.push(m); } };
    await runCpuWarmups(['rerank', 'embed', 'whisper'], {
        rerank: warmer('rerank'), embed: warmer('embed', true), whisper: warmer('whisper'),
    }, logger);
    assert.deepStrictEqual(events, ['start rerank', 'end rerank', 'start embed', 'end embed', 'start whisper', 'end whisper']);
    assert.strictEqual(maxInFlight, 1);
    assert.strictEqual(warned.length, 1);
    assert.match(warned[0], /embed warmup failed: embed broke/);
});

test('warmCpuPipelinesNow: reads reachability and use, warms the plan, and warms nothing when a read fails', async () => {
    const warmed = [];
    const warmers = {
        rerank: async () => { warmed.push('rerank'); },
        embed: async () => { warmed.push('embed'); },
        whisper: async () => { warmed.push('whisper'); },
    };
    const result = await warmCpuPipelinesNow({
        env: {}, now: () => NOW, log: quiet, warmers,
        reachable: async () => ({ rerank: true, embed: true, whisper: false }),
        lastUsed: async () => ({ rerank: NOW - DAY, embed: null, whisper: NOW }),
    });
    assert.deepStrictEqual(result, ['rerank']);
    assert.deepStrictEqual(warmed, ['rerank']);

    warmed.length = 0;
    const onError = await warmCpuPipelinesNow({
        env: {}, now: () => NOW, log: quiet, warmers,
        reachable: async () => { throw new Error('timeout exceeded when trying to connect'); },
        lastUsed: async () => ({ rerank: NOW, embed: NOW, whisper: NOW }),
    });
    assert.deepStrictEqual(onError, []);
    assert.deepStrictEqual(warmed, []);

    const off = await warmCpuPipelinesNow({ env: { CPU_PIPELINES_PREWARM: 'false' }, log: quiet, warmers });
    assert.deepStrictEqual(off, []);
});

test('startCpuPipelineWarmups waits the configured delay on an unref\'d timer', () => {
    /** @type {{ fn: () => void, ms: number } | null} */
    let scheduled = null;
    let unrefd = false;
    startCpuPipelineWarmups({
        env: { CPU_PIPELINES_PREWARM_DELAY_MS: '4500' },
        setTimer: (fn, ms) => { scheduled = { fn, ms }; return { unref: () => { unrefd = true; } }; },
    });
    assert.ok(scheduled);
    assert.strictEqual(/** @type {{ ms: number }} */ (scheduled).ms, 4500);
    assert.strictEqual(unrefd, true);
});
