/**
 * A run whose SETUP throws must not keep the automation busy forever.
 *
 * Between "the heartbeat started" and "the DAG is racing its deadline" the run
 * builds its state, vault, identity and context and scans the trigger payload.
 * None of that sat in a try/finally: an unexpected exception there left the
 * 15-second heartbeat running, and that heartbeat refreshes the automations
 * row's running marker — so the reaper (which only resets a marker that went
 * stale) never recovered it, the run row stayed 'running', and every later
 * trigger was skipped as "already running" until the process restarted.
 *
 * Run: cd server && node --test core/automationRunner/execution.setupFailure.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

// The kit puts its in-memory store in place of stores/automationStore; this
// suite records what the runner writes to it.
const { storeStub } = installRunnerStoreStubs();
let ops = [];
const kitUpdateRun = storeStub.updateRun;
Object.assign(storeStub, {
    updateRun: async (id, patch) => { ops.push({ op: 'updateRun', id, patch }); return kitUpdateRun(id, patch); },
    releaseAutomation: async (id) => { ops.push({ op: 'releaseAutomation', id }); },
    updateAutomation: async (id, patch) => { ops.push({ op: 'updateAutomation', id, patch }); return true; },
    touchAutomationRunning: async () => true,
    getRunTokenMap: async () => ({}),
});

const { executeAutomation } = require('../automationRunner');
const safety = require('./safety');
const { getActiveController } = require('./cancellation');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const AUTOMATION = {
    id: 'a1', version: 1, title: 'test automation', userId: 'u1', organizationId: null, isActive: true, triggerType: 'webhook',
    definition: {
        trigger: { id: 'trig', type: 'trigger', kind: 'webhook' },
        steps: [{ id: 's1', type: 'set', fields: { ok: { kind: 'literal', value: true } } }],
        edges: [{ from: 'trig', to: 's1' }],
    },
};

test('an exception in the run setup stops the heartbeat, fails the run and frees the marker', async (t) => {
    ops = [];
    // The trigger-payload scan is the last setup stage; an error there that is
    // not a guardrail block is rethrown as-is.
    t.mock.method(safety, 'resolveAutomationPolicy', async () => { throw new Error('policy store exploded'); });

    const live = new Set();
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    t.mock.method(global, 'setInterval', (fn, ms, ...rest) => {
        const timer = realSet(fn, ms, ...rest);
        if (ms === 15_000) live.add(timer);
        return timer;
    });
    t.mock.method(global, 'clearInterval', (timer) => { live.delete(timer); return realClear(timer); });
    t.after(() => { for (const timer of live) realClear(timer); });

    await assert.rejects(
        executeAutomation({ ...AUTOMATION }, { triggerKind: 'webhook', triggerPayload: { order: 42 } }),
        /policy store exploded/,
    );

    assert.strictEqual(live.size, 0, 'the heartbeat is still running: it keeps the marker fresh, so the reaper never frees the automation');
    assert.ok(![...ops].some(o => o.op === 'updateRun' && getActiveController(o.id)), 'the cancel controller of the dead run is still registered');
    const terminal = ops.findLast(o => o.op === 'updateRun' && o.patch.finishedAt);
    assert.ok(terminal, 'the run row was left non-terminal');
    assert.strictEqual(terminal.patch.status, 'error');
    assert.ok(ops.some(o => o.op === 'releaseAutomation' && o.id === 'a1'), 'the running marker was never released');
});
