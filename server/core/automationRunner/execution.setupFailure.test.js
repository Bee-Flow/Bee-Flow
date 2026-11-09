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

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'test';

let ops = [];
const storeStub = {
    createRun: async (row) => { const r = { id: 'run-1', ...row }; ops.push({ op: 'createRun', row: r }); return r; },
    updateRun: async (id, patch) => { ops.push({ op: 'updateRun', id, patch }); return { id, ...patch }; },
    getRun: async (id) => {
        const last = [...ops].reverse().find(o => o.op === 'updateRun');
        return last ? { id, ...last.patch } : { id, status: 'queued' };
    },
    getAutomation: async () => AUTOMATION,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async () => {},
    getRunTokenMap: async () => ({}),
    recordRunStep: async () => ({ id: 'step-1' }),
    releaseAutomation: async (id) => { ops.push({ op: 'releaseAutomation', id }); },
    resetAttempts: async () => {},
    touchAutomationRunning: async () => {},
    touchRunHeartbeat: async () => {},
    updateAutomation: async (id, patch) => { ops.push({ op: 'updateAutomation', id, patch }); },
};

const storePath = require.resolve('../../stores/automationStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: storeStub };

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));
const safety = require('./safety');
const { getActiveController } = require('./cancellation');

const AUTOMATION = {
    id: 'a1', title: 'test automation', userId: 'u1', organizationId: null, isActive: true,
    definition: { trigger: { type: 'webhook' }, steps: [{ id: 's1', type: 'set', fields: { greeting: 'hi' } }] },
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
    assert.strictEqual(getActiveController('run-1'), null, 'the cancel controller of the dead run is still registered');
    const terminal = ops.findLast(o => o.op === 'updateRun' && o.patch.finishedAt);
    assert.ok(terminal, 'the run row was left non-terminal');
    assert.strictEqual(terminal.patch.status, 'error');
    assert.ok(ops.some(o => o.op === 'releaseAutomation' && o.id === 'a1'), 'the running marker was never released');
});
