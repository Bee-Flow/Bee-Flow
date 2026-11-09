/**
 * A scheduled run moves its PRIMARY schedule forward before it lets go of the
 * running marker.
 *
 * claimDueAutomations takes every row with `next_run_at <= NOW()` whose
 * last_status is not 'running'. The finalisation used to release the marker
 * (last_status = the run's result), then send the run notifications — an
 * e-mail and a Talk card, seconds on a slow relay — and only then write the
 * next next_run_at. For that whole stretch the row was due AND free, so the
 * next tick of any instance claimed the same slot again: one schedule slot,
 * two runs. The secondary schedules were already advanced before the release
 * (runFinalizeEffects.advanceSecondarySchedule); the primary now is too.
 *
 * Run: cd server && node --test core/automationRunner/runFinalize.scheduleOrder.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'test';

let ops = [];
const storeStub = {
    createRun: async (row) => ({ id: 'run-1', ...row }),
    updateRun: async (id, patch) => ({ id, ...patch }),
    getRun: async (id) => ({ id, status: 'success' }),
    getAutomation: async () => null,
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    getRunsForAutomation: async () => [],
    markRunning: async () => true,
    advanceSchedule: async (id, patch) => { ops.push({ op: 'advanceSchedule', id, patch }); },
    getRunTokenMap: async () => ({}),
    recordRunStep: async () => ({ id: 'step-1' }),
    releaseAutomation: async (id) => { ops.push({ op: 'releaseAutomation', id }); },
    resetAttempts: async () => {},
    touchAutomationRunning: async () => true,
    touchRunHeartbeat: async () => {},
    updateAutomation: async (id, patch) => { ops.push({ op: 'updateAutomation', id, patch }); },
};

const storePath = require.resolve('../../stores/automationStore');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: storeStub };

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));

const AUTOMATION = {
    id: 'a1', title: 'nightly report', userId: 'u1', organizationId: null, isActive: true,
    triggerType: 'schedule', scheduleCron: '0 7 * * *', scheduleTz: 'UTC',
    definition: { trigger: { type: 'schedule' }, steps: [{ id: 's1', type: 'set', fields: { greeting: 'hi' } }] },
};

const indexOf = (pred) => ops.findIndex(pred);

test('the primary schedule is advanced before the marker is released', async () => {
    ops = [];
    await executeAutomation({ ...AUTOMATION }, { triggerKind: 'schedule', triggerPayload: { now: new Date().toISOString() } });

    const advanced = indexOf(o => o.op === 'updateAutomation' && o.patch && o.patch.nextRunAt);
    const statusWritten = indexOf(o => o.op === 'updateAutomation' && o.patch && o.patch.lastStatus && o.patch.lastStatus !== 'running');
    const released = indexOf(o => o.op === 'releaseAutomation');
    assert.ok(advanced > -1, 'the run never advanced next_run_at');
    assert.ok(released > -1, 'the run never released its marker');
    assert.ok(new Date(ops[advanced].patch.nextRunAt).getTime() > Date.now(), 'the new slot must lie in the future');
    assert.ok(advanced < statusWritten && advanced < released,
        'the row was free (last_status off "running") while next_run_at was still in the past — the next tick claims the same slot again');
});

test('a run through a secondary schedule still leaves the primary slot alone', async () => {
    ops = [];
    await executeAutomation({ ...AUTOMATION }, {
        triggerKind: 'schedule', rootStepId: null, triggerPayload: { now: new Date().toISOString() },
        schedule: { id: 'sch_1', cron: '0 9 * * *', tz: 'UTC', scheduledFor: '2026-09-03T09:00:00.000Z' },
    });
    assert.ok(!ops.some(o => o.op === 'updateAutomation' && o.patch && 'nextRunAt' in o.patch), 'the primary next_run_at moved for a secondary schedule run');
    const advanced = indexOf(o => o.op === 'advanceSchedule' && o.id === 'sch_1');
    assert.ok(advanced > -1 && advanced < indexOf(o => o.op === 'releaseAutomation'), 'the secondary schedule advances before the release');
});
