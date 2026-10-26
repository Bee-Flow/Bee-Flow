// @typecheck
/**
 * The run summary's reuse counters — and the branch that used to delete them.
 *
 * "N look-up(s) answered from earlier in the run" is the ONLY place a person
 * looking at a finished run can see that an answer was replayed instead of
 * asked for. It was built inside the `else` of `if (runErrorMsg)`, so a run
 * that answered from an earlier run and then blew up at step 9 reported
 * neither counter — deleting the evidence from exactly the runs somebody opens
 * asking "why did this act on yesterday's data and then fail?".
 *
 * The third counter is the same argument one step further: a REFUSED store
 * (the answer was too big to keep) must not read the same as a run where
 * nobody asked for reuse at all.
 *
 * The memo is stubbed rather than driven through a real integration_action:
 * this pins the summary line, not the memo (toolMemo.test.js does that).
 *
 * Run: node --test --test-force-exit core/automationRunner.reuseSummary.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const { resetRuns, stub } = require('./automationRunner.testkit').installRunnerStoreStubs();

// The memo the runner puts on ctx — the counters are whatever this says.
let memoStats = { hits: 0, misses: 0, durableHits: 0, refused: 0, entries: 0, bytes: 0 };
const realToolMemo = require('./automationRunner/toolMemo');
stub('./automationRunner/toolMemo', {
    ...realToolMemo,
    createToolMemo: () => ({
        peek: () => undefined,
        store: () => false,
        clear: () => {},
        recordDurableHit: () => {},
        hasSlept: () => false,
        stats: () => memoStats,
    }),
});

const runner = require('./automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    resetRuns();
    memoStats = { hits: 0, misses: 0, durableHits: 0, refused: 0, entries: 0, bytes: 0 };
});

function automation(/** @type {unknown[]} */ steps, /** @type {unknown[]} */ edges) {
    return {
        id: 'auto-reuse', version: 1, userId: 'user-1', organizationId: null,
        title: 'reuse summary', triggerType: 'manual',
        definition: { trigger: { id: 'trig', type: 'trigger' }, steps, edges },
    };
}

/** manual → set → stop_error. Ends 'error' with a message. */
const failing = () => automation(
    [
        { id: 'first', type: 'set', fields: { stage: { kind: 'literal', value: 'one' } } },
        { id: 'boom', type: 'stop_error', message: 'Upstream said no' },
    ],
    [{ from: 'trig', to: 'first' }, { from: 'first', to: 'boom' }],
);

/** manual → set. Ends 'success'. */
const succeeding = () => automation(
    [{ id: 'first', type: 'set', fields: { stage: { kind: 'literal', value: 'one' } } }],
    [{ from: 'trig', to: 'first' }],
);

test('a FAILED run still reports what it reused', async () => {
    memoStats = { ...memoStats, hits: 7, durableHits: 2 };
    const r = await runner.executeAutomation(failing(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(r.status, 'error');
    assert.match(r.summary, /^Failed: /, 'the failure still leads the line');
    assert.match(r.summary, /7 look-up\(s\) answered from earlier in the run/);
    assert.match(r.summary, /2 answered from an earlier run/,
        'the run that acted on yesterday\'s data and then failed is the one that needs this');
});

test('a refused store is reported, not silently identical to no reuse at all', async () => {
    memoStats = { ...memoStats, refused: 3 };
    const r = await runner.executeAutomation(succeeding(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(r.status, 'success');
    assert.match(r.summary, /3 answer\(s\) too big to reuse/);
});

test('a run that reused nothing says nothing about reuse', async () => {
    const ok = await runner.executeAutomation(succeeding(), { triggerKind: 'manual', mode: 'live' });
    assert.ok(!/reuse|earlier/.test(ok.summary), `summary was "${ok.summary}"`);

    // A stop_error carries no generic remediation (the author's message is the
    // cause); what must NOT appear is a trailing reuse clause on a run that
    // reused nothing.
    const bad = await runner.executeAutomation(failing(), { triggerKind: 'manual', mode: 'live' });
    assert.match(bad.summary, /^Failed: Upstream said no$/);
    assert.ok(!/answered from/.test(bad.summary), `summary was "${bad.summary}"`);
});
