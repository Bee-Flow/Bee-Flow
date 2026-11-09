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

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installRunnerStoreStubs } = require('../automationRunner.testkit');

// The kit puts its in-memory store in place of stores/automationStore; this
// suite records what the runner writes to the automations and schedules rows.
const { storeStub } = installRunnerStoreStubs();
let ops = [];
Object.assign(storeStub, {
    advanceSchedule: async (id, patch) => { ops.push({ op: 'advanceSchedule', id, patch }); },
    releaseAutomation: async (id) => { ops.push({ op: 'releaseAutomation', id }); },
    updateAutomation: async (id, patch) => { ops.push({ op: 'updateAutomation', id, patch }); return true; },
    touchAutomationRunning: async () => true,
    getRunTokenMap: async () => ({}),
});

const { executeAutomation } = require('../automationRunner');

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

const AUTOMATION = {
    id: 'a1', version: 1, title: 'nightly report', userId: 'u1', organizationId: null, isActive: true,
    triggerType: 'schedule', scheduleCron: '0 7 * * *', scheduleTz: 'UTC',
    definition: {
        trigger: { id: 'trig', type: 'trigger', kind: 'schedule' },
        steps: [{ id: 's1', type: 'set', fields: { ok: { kind: 'literal', value: true } } }],
        edges: [{ from: 'trig', to: 's1' }],
    },
};

const indexOf = (pred) => ops.findIndex(pred);

test('the primary schedule is advanced before the marker is released', async () => {
    ops = [];
    await executeAutomation({ ...AUTOMATION }, { triggerKind: 'schedule', markerClaimed: true, triggerPayload: { now: new Date().toISOString() } });

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

// Only the run that CONSUMED the primary slot moves it. The advance is
// "the next match after now", so for any other run it is at best a no-op and
// at worst skips a slot: a webhook run that is busy at 09:00 keeps the tick
// from claiming the 09:00 slot (the automation is running), and when it
// finished it used to write next_run_at = tomorrow 09:00 — today's scheduled
// run never happened.
const movedPrimary = () => ops.some(o => o.op === 'updateAutomation' && o.patch && 'nextRunAt' in o.patch);

test('a webhook run of an automation with a primary schedule leaves the schedule slot alone', async () => {
    ops = [];
    await executeAutomation({ ...AUTOMATION }, { triggerKind: 'webhook', triggerPayload: { order: 1 } });
    assert.ok(ops.some(o => o.op === 'releaseAutomation'), 'the run itself completed and released');
    assert.ok(!movedPrimary(), 'a run that did not come from the scheduler moved next_run_at past a slot that may still be due');
});

test('a retry or resume of a scheduled run (no scheduler claim) leaves the slot alone too', async () => {
    ops = [];
    await executeAutomation({ ...AUTOMATION }, { triggerKind: 'schedule', triggerPayload: { now: new Date().toISOString() } });
    assert.ok(!movedPrimary());
});
