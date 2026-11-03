/**
 * startCapped: the one answer of the routes that start or continue a run.
 * Run: cd server && node --test core/automationRunner/startCapped.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startCapped, runResponseCapMs, pendingRunBody, DEFAULT_RUN_RESPONSE_CAP_MS } from './startCapped.mts';

const require = createRequire(import.meta.url);
const { HttpError } = require('../http/errors');

const quietLog = () => {
    const lines = [];
    return { lines, error: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')) };
};
const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('a run that ends within the cap is answered finished, with the run', async () => {
    const out = await startCapped(async (onRunCreated) => {
        onRunCreated({ id: 'run1' });
        return { id: 'run1', status: 'success' };
    }, { capMs: 1000 });
    assert.deepEqual(out, { kind: 'finished', run: { id: 'run1', status: 'success' } });
});

test('a run that outlives the cap is answered pending WITH its id, and keeps running', async () => {
    let finished = false;
    const out = await startCapped(async (onRunCreated) => {
        onRunCreated({ id: 'run2' });
        await later(80);
        finished = true;
        return { id: 'run2' };
    }, { capMs: 20 });
    assert.deepEqual(out, { kind: 'pending', runId: 'run2' });
    assert.equal(finished, false, 'the answer came before the run ended');
    await later(120);
    assert.equal(finished, true, 'the runner promise went on after the answer');
});

test('respond "created" answers as soon as the run row exists', async () => {
    const started = Date.now();
    const out = await startCapped(async (onRunCreated) => {
        onRunCreated({ id: 'run3' });
        await later(200);
        return { id: 'run3' };
    }, { capMs: 0, respond: 'created' });
    assert.deepEqual(out, { kind: 'pending', runId: 'run3' });
    assert.ok(Date.now() - started < 150, 'did not wait for the run');
});

test('past the cap without an id yet, the answer waits for the id (never a 202 without one)', async () => {
    const out = await startCapped(async (onRunCreated) => {
        await later(40);
        onRunCreated({ id: 'run4' });
        await later(200);
        return { id: 'run4' };
    }, { capMs: 5 });
    assert.deepEqual(out, { kind: 'pending', runId: 'run4' });
});

test('past the cap with a runner that never names the run, the answer is the finished run', async () => {
    const out = await startCapped(async () => { await later(30); return { id: 'run5' }; }, { capMs: 5 });
    assert.deepEqual(out, { kind: 'finished', run: { id: 'run5' } });
});

test('cap 0 waits for the end', async () => {
    const out = await startCapped(async (onRunCreated) => {
        onRunCreated({ id: 'run6' });
        await later(30);
        return { id: 'run6', status: 'error' };
    }, { capMs: 0 });
    assert.equal(out.kind, 'finished');
});

test('a start that resolves null without a run id is an error, not a 202', async () => {
    await assert.rejects(startCapped(async () => null, { capMs: 1000 }), /returned no run/);
});

test('a start that resolves null after creating the run is followed by its id', async () => {
    const out = await startCapped(async (onRunCreated) => { onRunCreated({ id: 'run7' }); return null; }, { capMs: 1000 });
    assert.deepEqual(out, { kind: 'pending', runId: 'run7' });
});

test('an HttpError refusal passes through, even after the run row exists', async () => {
    await assert.rejects(
        startCapped(async () => { throw new HttpError(409, 'not_published', 'This automation has not been published yet.'); }, { capMs: 1000 }),
        (e) => e instanceof HttpError && e.status === 409,
    );
    await assert.rejects(
        startCapped(async (onRunCreated) => { onRunCreated({ id: 'r' }); throw new HttpError(409, 'x', 'refused'); }, { capMs: 1000 }),
        (e) => e instanceof HttpError,
    );
    const managed = Object.assign(new Error('not deployed'), { errorClass: 'managed_part_not_deployed' });
    await assert.rejects(startCapped(async () => { throw managed; }, { capMs: 1000 }), (e) => e === managed);
});

test('a crash before the run exists is thrown; after it exists the caller follows the id', async () => {
    await assert.rejects(startCapped(async () => { throw new Error('boom'); }, { capMs: 1000, log: quietLog() }), /boom/);
    const log = quietLog();
    const out = await startCapped(async (onRunCreated) => { onRunCreated({ id: 'run8' }); throw new Error('db gone'); }, { capMs: 1000, log });
    assert.deepEqual(out, { kind: 'pending', runId: 'run8' });
    assert.match(log.lines.join('\n'), /run8 failed: db gone/);
});

test('a failure after the pending answer is logged, never unhandled', async () => {
    const log = quietLog();
    const out = await startCapped(async (onRunCreated) => {
        onRunCreated({ id: 'run9' });
        await later(20);
        throw new Error('late failure');
    }, { capMs: 0, respond: 'created', log });
    assert.deepEqual(out, { kind: 'pending', runId: 'run9' });
    await later(50);
    assert.match(log.lines.join('\n'), /run9 failed after the response was sent: late failure/);
});

test('a start that throws synchronously is a rejection, not a crash', async () => {
    await assert.rejects(startCapped(() => { throw new HttpError(404, 'nope', 'Not found'); }, { capMs: 10 }), (e) => e instanceof HttpError);
});

test('the cap comes from AUTOMATION_RUN_RESPONSE_CAP_MS: default 50 s, 0 = wait, junk = default', () => {
    assert.equal(DEFAULT_RUN_RESPONSE_CAP_MS, 50_000);
    assert.equal(runResponseCapMs({}), 50_000);
    assert.equal(runResponseCapMs({ AUTOMATION_RUN_RESPONSE_CAP_MS: '0' }), 0);
    assert.equal(runResponseCapMs({ AUTOMATION_RUN_RESPONSE_CAP_MS: '1500' }), 1500);
    assert.equal(runResponseCapMs({ AUTOMATION_RUN_RESPONSE_CAP_MS: ' ' }), 50_000);
    assert.equal(runResponseCapMs({ AUTOMATION_RUN_RESPONSE_CAP_MS: 'soon' }), 50_000);
    assert.equal(runResponseCapMs({ AUTOMATION_RUN_RESPONSE_CAP_MS: '-1' }), 50_000);
});

test('the pending body always names the run', () => {
    const body = pendingRunBody('run10');
    assert.equal(body.runId, 'run10');
    assert.equal(body.pending, true);
    assert.equal(body.accepted, true);
});
