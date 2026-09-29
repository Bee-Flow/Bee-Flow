/**
 * Wait step vs the run deadline — node-audit A8.
 *
 * The form offers minutes/hours ("Up to 24 hours"), but the default run
 * budget is ~5 minutes and execWait used to be one un-cancellable setTimeout:
 * any Wait over the budget GUARANTEED "Run hard timeout", and a cancel had to
 * sit out the full sleep. Now the step extends the (re-armable) deadline by
 * its planned sleep and sleeps in cancellable chunks.
 *
 * Run: node --test core/automationRunner/execWait.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const engine = require('./engine');
const { execWait } = engine;

// execWait sleeps on UNREF'd timers by design — a pending Wait must never hold
// a draining worker open. That makes it unobservable under real timers: with
// nothing ref'd, `node --test` drains the event loop in the middle of the very
// first await and reports every case here as cancelledByParent ("Promise
// resolution is still pending but the event loop has already resolved"). This
// file used to buy its way out of that with a ref'd 250ms ticker and then sit
// out 8 REAL seconds of product sleep.
//
// It now drives the sleeps instead: execWait reads only global setTimeout and
// Date.now, so node:test's own mock timers are a complete substitute, and the
// 5s chunking the product deliberately does (execControl.js:41) is exercised by
// ticking 5s at a time rather than by waiting 5s. Mock handles carry .unref, so
// execControl's `if (t.unref) t.unref()` branch still runs.
//
// TWO RULES IF YOU EDIT THIS FILE:
//   1. Do not go back to real timers. The `realMs` budget in test.after() below
//      exists to make that revert fail instead of merely costing 8 seconds.
//   2. If a change to execWait leaves one of these promises un-driven, the test
//      does NOT time out — the loop drains and the case is reported as
//      CANCELLED, which prints "# fail 0" but still exits nonzero (verified).
//      The per-test { timeout: 5000 } is belt-and-braces for the case where
//      something does keep a real handle alive.
const TIMER_APIS = { apis: ['setTimeout', 'Date'] };

// This file must not sleep. A real-timer regression here is invisible — every
// test still passes, it just costs 8 seconds again — so the budget is asserted.
const REAL_T0 = process.hrtime.bigint(); // real clock; t.mock.timers cannot move it
test.after(() => {
    const realMs = Number(process.hrtime.bigint() - REAL_T0) / 1e6;
    assert.ok(realMs < 2000,
        `this file spent ${Math.round(realMs)}ms of REAL time — execWait's sleeps must be `
        + 'driven by t.mock.timers, not waited out (see the mock-timer note above)');
});

/** Let every already-scheduled continuation run before the clock moves again. */
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

/** Advance `ms` of mocked time in <=5s steps — the chunk size execWait sleeps in. */
async function drive(t, ms, step = 5_000) {
    for (let left = ms; left > 0; left -= step) {
        await settle();
        t.mock.timers.tick(Math.min(step, left));
    }
    await settle();
}

test('a live wait extends the run deadline by its planned sleep', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable(TIMER_APIS);
    const grants = [];
    const ctx = { extendRunDeadline: (ms) => grants.push(ms) };
    let settled = false;
    const p = execWait({ seconds: 1 }, ctx, {}, 'live').then(v => { settled = true; return v; });
    await settle();
    assert.deepStrictEqual(grants, [1000], 'the deadline is extended before the sleep begins');
    // A Wait that returns without sleeping would satisfy every other assertion
    // in this file. It is the whole step.
    assert.strictEqual(settled, false, 'a live wait must actually sleep, not return immediately');
    await drive(t, 1000);
    const r = await p;
    assert.strictEqual(r.output.waitedSeconds, 1);
});

test('dry-run returns immediately and does not touch the deadline', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable(TIMER_APIS);
    const grants = [];
    const ctx = { extendRunDeadline: (ms) => grants.push(ms) };
    // No time is advanced anywhere in this test: a dry run that slept at all
    // would never resolve and the case would be reported as cancelled.
    const r = await execWait({ seconds: 3600 }, ctx, {}, 'dry_run');
    assert.deepStrictEqual(grants, []);
    assert.strictEqual(r.output.plannedSeconds, 3600);
});

test('an aborted cancel signal stops the sleep within one chunk', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable(TIMER_APIS);
    const controller = new AbortController();
    const ctx = { extendRunDeadline: () => {}, cancelSignal: controller.signal };
    const rejected = assert.rejects(() => execWait({ seconds: 60 }, ctx, {}, 'live'), /Run cancelled/);
    await drive(t, 5_000);   // one chunk of a 60s wait
    controller.abort();
    await drive(t, 5_000);   // the next chunk boundary must see it and throw
    await rejected;          // NOT after the full 60s
});

test('seconds are clamped to the 1..86400 contract', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable(TIMER_APIS);
    const grants = [];
    const ctx = { extendRunDeadline: (ms) => grants.push(ms) };
    const p = execWait({ seconds: 0 }, ctx, {}, 'live'); // clamps to 1
    await drive(t, 1000);
    await p;
    assert.deepStrictEqual(grants, [1000]);
});

test('a wait with no ctx hooks still completes (layer/legacy call sites)', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable(TIMER_APIS);
    const p = execWait({ seconds: 1 }, {}, {}, 'live');
    await drive(t, 1000);
    const r = await p;
    assert.strictEqual(r.output.waitedSeconds, 1);
});
