/**
 * Which "run once per item" steps may run items side by side, and the pool that does it.
 *
 * Run: cd server && node --test core/automationRunner/forEachConcurrency.test.js
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { forEachConcurrencyFor, forEachMaxConcurrency, runIndexedPool, PARALLEL_READ_TOOLS } = require('./forEachConcurrency');

let saved;
beforeEach(() => { saved = process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY; delete process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY; });
afterEach(() => {
    if (saved === undefined) delete process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY;
    else process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = saved;
});

test('PARALLEL_READ_TOOLS keeps its values', () => {
    assert.deepStrictEqual([...PARALLEL_READ_TOOLS], [['gmail_read', 5], ['gmail_read_attachment', 3]]);
});

test('integration_action: only live, listed reads without askOnce run in parallel', () => {
    assert.strictEqual(forEachConcurrencyFor({ type: 'integration_action', tool: 'gmail_read' }, 'live'), 5);
    assert.strictEqual(forEachConcurrencyFor({ type: 'integration_action', tool: 'gmail_read_attachment' }, 'live'), 3);
    assert.strictEqual(forEachConcurrencyFor({ type: 'integration_action', tool: 'gmail_read' }, 'dry_run'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'integration_action', tool: 'gmail_read', askOnce: true }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'integration_action', tool: 'gmail_send' }, 'live'), 1);
});

test('ai_step without tools uses the platform default of 4', () => {
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step' }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', tools: [], allowTools: false }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', tools: null }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', agentId: 'a1', agentPermissions: { useTools: false } }, 'live'), 4);
});

test('ai_step stays serial whenever a tool could be offered', () => {
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', allowTools: true }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', tools: ['search'] }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', agentId: 'a1', agentPermissions: { useTools: true } }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', agentId: 'a1', agentPermissions: { startAutomations: true } }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', skillIds: ['s1'] }, 'live'), 1);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', allowTools: true, forEach: { concurrency: 8 } }, 'live'), 1);
});

test('data_extraction is always eligible', () => {
    assert.strictEqual(forEachConcurrencyFor({ type: 'data_extraction' }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'data_extraction' }, 'dry_run'), 4);
});

test('other step types stay serial', () => {
    for (const type of ['code', 'http_request', 'set', 'notification', 'datatable', 'knowledge_write']) {
        assert.strictEqual(forEachConcurrencyFor({ type, forEach: { concurrency: 9 } }, 'live'), 1);
    }
    assert.strictEqual(forEachConcurrencyFor(null, 'live'), 1);
});

test('forEach.concurrency lowers the value and is capped by the platform value', () => {
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 2 } }, 'live'), 2);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 50 } }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 0 } }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 'x' } }, 'live'), 4);
    assert.strictEqual(forEachConcurrencyFor({ type: 'data_extraction', forEach: { concurrency: 3.7 } }, 'live'), 3);
});

test('AUTOMATION_FOREACH_MAX_CONCURRENCY sets the cap; 0 lifts it', () => {
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = '10';
    assert.strictEqual(forEachMaxConcurrency(), 10);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step' }, 'live'), 10);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 50 } }, 'live'), 10);
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = '1';
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 8 } }, 'live'), 1);
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = '0';
    assert.strictEqual(forEachMaxConcurrency(), 0);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step', forEach: { concurrency: 50 } }, 'live'), 50);
    assert.strictEqual(forEachConcurrencyFor({ type: 'ai_step' }, 'live'), 1000);
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = 'nonsense';
    assert.strictEqual(forEachMaxConcurrency(), 4);
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = '';
    assert.strictEqual(forEachMaxConcurrency(), 4);
});

test('runIndexedPool never exceeds the concurrency and runs every index once', async () => {
    let active = 0;
    let max = 0;
    const seen = [];
    await runIndexedPool(20, 3, async (i) => {
        active += 1;
        max = Math.max(max, active);
        await new Promise(r => setTimeout(r, i % 3));
        seen.push(i);
        active -= 1;
    });
    assert.strictEqual(max, 3);
    assert.deepStrictEqual([...seen].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});

test('runIndexedPool: results addressed by index stay in order whatever the finishing order', async () => {
    const out = [];
    await runIndexedPool(6, 6, async (i) => {
        await new Promise(r => setTimeout(r, (6 - i) * 2));
        out[i] = i * 10;
    });
    assert.deepStrictEqual(out, [0, 10, 20, 30, 40, 50]);
});

test('runIndexedPool: a slow item does not hold back the next ones', async () => {
    const started = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const run = runIndexedPool(5, 2, async (i) => {
        started.push(i);
        if (i === 0) await gate;
    });
    await new Promise(r => setTimeout(r, 15));
    assert.deepStrictEqual(started, [0, 1, 2, 3, 4]);
    release();
    await run;
});

test('runIndexedPool: after a rejection nothing new starts, in-flight items settle, the first error is rethrown', async () => {
    const started = [];
    const finished = [];
    const boom = new Error('first');
    await assert.rejects(runIndexedPool(10, 3, async (i) => {
        started.push(i);
        if (i === 1) { await new Promise(r => setTimeout(r, 2)); throw boom; }
        if (i === 2) { await new Promise(r => setTimeout(r, 15)); finished.push(i); throw new Error('second'); }
        await new Promise(r => setTimeout(r, 15));
        finished.push(i);
    }), (e) => e === boom);
    assert.deepStrictEqual(started, [0, 1, 2]);
    assert.deepStrictEqual(finished.sort(), [0, 2]);
});

test('runIndexedPool: a falsy rejection reason is still rethrown, and an empty list is fine', async () => {
    await assert.rejects(runIndexedPool(2, 1, async () => { throw 0; }), (e) => e === 0);
    await runIndexedPool(0, 4, async () => { throw new Error('never'); });
});
