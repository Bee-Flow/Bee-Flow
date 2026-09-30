/**
 * jobs/aiParticipation.js with an in-memory store and engine (the engine and
 * the store have their own tests; engine.test.js runs this job over PGlite).
 *
 * Proven:
 *   - a tick reaps stuck claims, claims only as many watches as there are
 *     free slots, only for the surfaces the engine serves, and closes every
 *     claim it processed — also when processing throws;
 *   - the per-replica bound holds while answers are still being written;
 *   - nothing is claimed while the engine's breaker is open;
 *   - pruning runs at most once an hour;
 *   - a tick never throws, and start() goes through the module gate.
 *
 * Run: cd server && node --test jobs/aiParticipation.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeParticipationJob } = require('./aiParticipation');

function world({ due = 0, breaker = false, processing = null, failClaim = false } = {}) {
    const log = { claims: [], finished: [], processed: [], reaps: 0, prunes: 0 };
    let queue = Array.from({ length: due }, (_, i) => ({ id: `w${i}`, containerId: `c${i}`, surface: 'chat' }));
    const store = {
        async reapStuck() { log.reaps += 1; return 0; },
        async prune() { log.prunes += 1; return { decisions: 0, watches: 0, feedback: 0 }; },
        async claimDue(limit, { surfaces, claimId }) {
            if (failClaim) throw new Error('db down');
            log.claims.push({ limit, surfaces });
            const taken = queue.slice(0, limit).map((w) => ({ ...w, claimId }));
            queue = queue.slice(limit);
            return taken;
        },
        async finishWatch(id, claimId) { log.finished.push([id, claimId]); return true; },
    };
    const engine = {
        breakerOpen: () => breaker,
        surfaceNames: () => ['chat', 'comment'],
        async processWatch(w) {
            log.processed.push(w.id);
            if (processing) return processing(w);
            return { decision: 'silent' };
        },
    };
    let clock = 0;
    const job = makeParticipationJob({ store, engine, concurrency: 2, now: () => clock, newId: () => 'claim', recordJobRun: () => {} });
    return { job, log, tick: (ms) => { clock += ms; }, add: (n) => { for (let i = 0; i < n; i++) queue.push({ id: `x${i}`, containerId: `x${i}`, surface: 'chat' }); } };
}

test('claims what the free slots allow, for the served surfaces, and closes every claim', async () => {
    const w = world({ due: 3 });
    const first = await w.job.tick();
    assert.strictEqual(first.claimed, 2, 'two slots');
    assert.deepStrictEqual(w.log.claims[0], { limit: 2, surfaces: ['chat', 'comment'] });
    await w.job.drain();
    assert.deepStrictEqual(w.log.finished, [['w0', 'claim'], ['w1', 'claim']]);
    assert.strictEqual((await w.job.tick()).claimed, 1);
    await w.job.drain();
    assert.strictEqual(w.log.finished.length, 3);
    assert.strictEqual(w.log.reaps, 2, 'the reaper runs every tick');
});

test('the bound holds while answers are still being written', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const w = world({ due: 5, processing: () => gate });
    assert.strictEqual((await w.job.tick()).claimed, 2);
    assert.strictEqual(w.job.inFlight(), 2);
    assert.strictEqual((await w.job.tick()).claimed, 0, 'no free slot, no claim');
    release({ decision: 'replied' });
    await w.job.drain();
    assert.strictEqual(w.job.inFlight(), 0);
    assert.strictEqual((await w.job.tick()).claimed, 2);
    await w.job.drain();
});

test('a watch whose processing throws is still closed, and the tick survives', async () => {
    const w = world({ due: 1, processing: () => { throw new Error('boom'); } });
    await w.job.tick();
    await w.job.drain();
    assert.deepStrictEqual(w.log.finished, [['w0', 'claim']]);
    const broken = world({ failClaim: true });
    assert.deepStrictEqual(await broken.job.tick(), { claimed: 0, error: true }, 'never throws');
});

test('an open breaker claims nothing', async () => {
    const w = world({ due: 2, breaker: true });
    const out = await w.job.tick();
    assert.strictEqual(out.paused, true);
    assert.strictEqual(w.log.claims.length, 0);
});

test('pruning at most once an hour', async () => {
    const w = world();
    await w.job.tick();
    await w.job.tick();
    assert.strictEqual(w.log.prunes, 1, "the first tick prunes, the second does not");
    w.tick(60 * 60_000);
    await w.job.tick();
    assert.strictEqual(w.log.prunes, 2);
});

test('start() ticks through the module gate and never keeps the process alive', async () => {
    let wrapped = 0;
    const job = makeParticipationJob({
        store: { reapStuck: async () => 0, prune: async () => ({}), claimDue: async () => [], finishWatch: async () => true },
        engine: { breakerOpen: () => false, surfaceNames: () => ['chat'], processWatch: async () => ({}) },
        gate: (tick) => { wrapped += 1; return tick; },
        recordJobRun: () => {},
    });
    job.start();
    job.start();
    assert.strictEqual(wrapped, 1, 'started once');
    job.stop();
});
