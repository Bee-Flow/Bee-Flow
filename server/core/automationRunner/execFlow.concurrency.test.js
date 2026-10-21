/**
 * A "run once per item" ai_step / data_extraction runs a few items at a time
 * (AUTOMATION_FOREACH_MAX_CONCURRENCY, default 4) while the model cannot be
 * offered tools; with tools the items stay in order. Results keep their item
 * order and a pause / cancellation from one item halts the step after the
 * others have settled.
 *
 * Run: cd server && node --test core/automationRunner/execFlow.concurrency.test.js
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { execForEachStep } = require('./execFlow');
const { ApprovalRequiredError } = require('./execApproval');

const ITEMS = Array.from({ length: 12 }, (_, i) => i + 1);
const STATE = { trigger: { output: {} }, steps: { a1: { output: { items: ITEMS } } }, vars: {}, secrets: {}, loop: {} };
const forEach = { overRef: 'steps.a1.output.items', itemVar: 'x' };

let saved;
beforeEach(() => { saved = process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY; delete process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY; });
afterEach(() => {
    if (saved === undefined) delete process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY;
    else process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = saved;
});

function measuringLeaf(delayFor = () => 4) {
    const seen = { active: 0, max: 0 };
    const leaf = async (_s, _ctx, sub) => {
        seen.active += 1;
        seen.max = Math.max(seen.max, seen.active);
        await new Promise(r => setTimeout(r, delayFor(sub.loop.x)));
        seen.active -= 1;
        return { output: { n: sub.loop.x } };
    };
    return { seen, leaf };
}

test('ai_step without tools runs four items at a time and keeps the item order', async () => {
    const { seen, leaf } = measuringLeaf(x => (x % 3) * 3 + 1);
    const out = await execForEachStep({ id: 's', type: 'ai_step', forEach }, {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 4);
    assert.deepStrictEqual(out.output.results.map(r => r.output.n), ITEMS);
    assert.deepStrictEqual(out.output.results.map(r => r.index), ITEMS.map((_, i) => i));
    assert.strictEqual(out.output.succeeded, 12);
});

test('data_extraction runs in parallel too, and forEach.concurrency lowers it', async () => {
    const a = measuringLeaf();
    await execForEachStep({ id: 's', type: 'data_extraction', forEach }, {}, STATE, 'live', a.leaf);
    assert.strictEqual(a.seen.max, 4);
    const b = measuringLeaf();
    await execForEachStep({ id: 's', type: 'data_extraction', forEach: { ...forEach, concurrency: 2 } }, {}, STATE, 'live', b.leaf);
    assert.strictEqual(b.seen.max, 2);
});

test('an ai_step that can be offered tools stays one at a time', async () => {
    for (const extra of [{ allowTools: true }, { tools: ['search'] }, { agentId: 'a1', agentPermissions: { useTools: true } }]) {
        const { seen, leaf } = measuringLeaf();
        await execForEachStep({ id: 's', type: 'ai_step', forEach: { ...forEach, concurrency: 8 }, ...extra }, {}, STATE, 'live', leaf);
        assert.strictEqual(seen.max, 1);
    }
});

test('AUTOMATION_FOREACH_MAX_CONCURRENCY=1 turns the parallelism off', async () => {
    process.env.AUTOMATION_FOREACH_MAX_CONCURRENCY = '1';
    const { seen, leaf } = measuringLeaf();
    await execForEachStep({ id: 's', type: 'ai_step', forEach }, {}, STATE, 'live', leaf);
    assert.strictEqual(seen.max, 1);
});

test('a failed item is collected, the others succeed, order intact', async () => {
    const leaf = async (_s, _ctx, sub) => {
        await new Promise(r => setTimeout(r, 2));
        if (sub.loop.x === 5) throw new Error('model said no');
        return { output: { n: sub.loop.x } };
    };
    const out = await execForEachStep({ id: 's', type: 'ai_step', forEach }, {}, STATE, 'live', leaf);
    assert.strictEqual(out.output.failed, 1);
    assert.strictEqual(out.output.results[4].status, 'error');
    assert.strictEqual(out.output.results[4].output, null);
    assert.strictEqual(out.output.results[5].output.n, 6);
});

test('per-item retry still applies inside the pool', async () => {
    const tries = new Map();
    const leaf = async (_s, _ctx, sub) => {
        const n = (tries.get(sub.loop.x) || 0) + 1;
        tries.set(sub.loop.x, n);
        if (sub.loop.x === 3 && n === 1) throw new Error('flaky');
        return { output: { n: sub.loop.x } };
    };
    const out = await execForEachStep({ id: 's', type: 'ai_step', forEach, retry: { max: 1 } }, {}, STATE, 'live', leaf);
    assert.strictEqual(out.output.failed, 0);
    assert.strictEqual(tries.get(3), 2);
});

test('every item failing still ends in foreach_all_failed', async () => {
    const leaf = async () => { throw new Error('nope'); };
    await assert.rejects(
        execForEachStep({ id: 's', type: 'data_extraction', forEach }, {}, STATE, 'live', leaf),
        (e) => e.errorClass === 'foreach_all_failed' && e.foreachHandled === true,
    );
});

test('a pause thrown by one item propagates after the items in flight have settled', async () => {
    const started = [];
    const finished = [];
    const leaf = async (_s, _ctx, sub) => {
        started.push(sub.loop.x);
        if (sub.loop.x === 2) {
            await new Promise(r => setTimeout(r, 2));
            throw new ApprovalRequiredError('s', 'ok?');
        }
        await new Promise(r => setTimeout(r, 20));
        finished.push(sub.loop.x);
        return { output: { n: sub.loop.x } };
    };
    await assert.rejects(
        execForEachStep({ id: 's', type: 'ai_step', forEach }, {}, STATE, 'live', leaf),
        (e) => e instanceof ApprovalRequiredError,
    );
    assert.deepStrictEqual(started, [1, 2, 3, 4]);
    assert.deepStrictEqual(finished.sort((a, b) => a - b), [1, 3, 4]);
});

test('cancellation between items stops the fan-out', async () => {
    let cancelled = false;
    const checkCancel = async () => { if (cancelled) throw new Error('Run cancelled'); };
    const started = [];
    const leaf = async (_s, _ctx, sub) => {
        started.push(sub.loop.x);
        if (sub.loop.x === 5) cancelled = true;
        await new Promise(r => setTimeout(r, 3));
        return { output: sub.loop.x };
    };
    await assert.rejects(
        execForEachStep({ id: 's', type: 'ai_step', forEach }, {}, STATE, 'live', leaf, checkCancel),
        /Run cancelled/,
    );
    assert.ok(started.length < ITEMS.length);
});
