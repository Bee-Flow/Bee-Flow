/**
 * The deploy runner's job: a 15-second tick over the runner, never
 * overlapping in one process and never throwing.
 *
 * Run: cd server && node --test jobs/solutionDeployRunner.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const job = require('./solutionDeployRunner');

test('a tick runs the runner once and answers its summary', async () => {
    let ticks = 0;
    const out = await job.tick({ runner: { tick: async () => { ticks += 1; return { ran: 2 }; } } });
    assert.deepStrictEqual(out, { ran: 2 });
    assert.strictEqual(ticks, 1);
});

test('ticks never overlap: a tick that starts while one runs does nothing', async () => {
    let release;
    let ticks = 0;
    const runner = { tick: () => { ticks += 1; return new Promise((resolve) => { release = resolve; }); } };
    const first = job.tick({ runner });
    assert.strictEqual(await job.tick({ runner }), null);
    release({ ran: 0 });
    assert.deepStrictEqual(await first, { ran: 0 });
    assert.strictEqual(ticks, 1);
});

test('a failing runner never throws out of the tick', async () => {
    assert.strictEqual(await job.tick({ runner: { tick: async () => { throw new Error('db down'); } } }), null);
    // The next tick runs again.
    assert.deepStrictEqual(await job.tick({ runner: { tick: async () => ({ ran: 0 }) } }), { ran: 0 });
});

test('start schedules the tick every 15 seconds by default and stop clears it', async () => {
    assert.strictEqual(job.TICK_MS, 15_000);
    let ticks = 0;
    job.start({ runner: { tick: async () => { ticks += 1; return {}; } }, intervalMs: 5 });
    job.start({ runner: { tick: async () => { ticks += 100; return {}; } }, intervalMs: 5 });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    job.stop();
    const seen = ticks;
    assert.ok(seen >= 1 && seen < 100, 'started once');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.strictEqual(ticks, seen, 'stopped');
});
