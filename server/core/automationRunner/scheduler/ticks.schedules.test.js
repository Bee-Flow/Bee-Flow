/**
 * Additional schedule triggers ride the 60s schedule tick.
 *
 * processDueAutomations claims the primary schedules (claimDueAutomations) and
 * then the ADDITIONAL ones (claimDueSchedules). A claimed additional row is
 * dispatched from ITS trigger node, with the schedule row in hand so the runner
 * advances that row and not the primary's next_run_at. A row whose owner lost
 * the capability is released and advanced, never run — and never left in the
 * past to re-qualify every tick.
 *
 * Same require.cache stub idiom as ticks.test.js.
 *
 * Run: node --test --test-force-exit core/automationRunner/scheduler/ticks.schedules.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const calls = { exec: [], advance: [], release: [], update: [], touch: [], claimPrimary: 0 };
// The batch keep-alive (claimedBatches.js): ids whose claim the reaper took
// back while they waited, and a hook at the start of every run.
let reaped = new Set();
let onExec = () => {};
let dueSchedules = [];
let duePrimary = [];
let capabilityOk = true;
const NEXT = new Date('2026-09-04T05:00:00.000Z');

mock('../../../stores/automationStore', {
    claimDueAutomations: async () => { calls.claimPrimary += 1; const d = duePrimary; duePrimary = []; return d; },
    claimDueSchedules: async () => dueSchedules,
    touchAutomationRunning: async (id, instanceId) => { calls.touch.push({ id, instanceId, execsSoFar: calls.exec.length }); return !reaped.has(id); },
    advanceSchedule: async (id, patch) => { calls.advance.push({ id, ...patch }); },
    releaseAutomation: async (id) => { calls.release.push(id); },
    updateAutomation: async (id, u) => { calls.update.push({ id, ...u }); },
    deleteExpiredFormSessions: async () => 0,
});
mock('../../../db', { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release() {} }) } });
mock('../engine', { INSTANCE_ID: 'runner-test' });
mock('../execution', { executeAutomation: async (a, opts) => { calls.exec.push({ id: a.id, ...opts }); onExec(a); return {}; } });
mock('../cancellation', { ACTIVE_RUNS: new Map() });
// partsInTz stays real: the holiday check (schedule.skipHolidays) reads the
// slot's local date through it.
const { partsInTz } = require('../../scheduling/cron');
mock('../../scheduling/cron', { nextRunAt: () => NEXT, partsInTz });
mock('./reapers', {
    reapStuckAutomations: async () => {},
    reapOrphanFormUploads: async () => {},
    reapExpiredGeneratedFiles: async () => {},
    reapStuckTranscriptions: async () => {},
});
mock('../../integrations/integrationLogging', { flushEgressLogs: async () => {} });
mock('../../entitlements/entitlements', { hasCapability: async () => capabilityOk });
mock('../../../modules', { moduleGatedTick: (moduleId, fn) => fn });
// The owner's account row: a schedule only fires for an owner who still has
// an active account (null = the account is gone).
let ownerRow = { id: 'u1', status: 'active' };
mock('../../../stores/userStore', { getUser: async () => ownerRow });

const ticks = require('./ticks');

beforeEach(() => {
    calls.exec.length = 0; calls.advance.length = 0; calls.release.length = 0; calls.update.length = 0; calls.claimPrimary = 0;
    calls.touch.length = 0; reaped = new Set(); onExec = () => {}; duePrimary = [];
    dueSchedules = [];
    capabilityOk = true;
    ownerRow = { id: 'u1', status: 'active' };
});

const AUTO = { id: 'auto-1', userId: 'u1', organizationId: 'org-1', title: 'Assistant' };
const ROW = { id: 'sch_1', automationId: 'auto-1', triggerStepId: 'trig_daily', cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', nextRunAt: '2026-09-03T05:00:00.000Z' };

test('a due additional schedule runs from its own trigger node with the schedule in hand', async () => {
    dueSchedules = [{ automation: AUTO, schedule: ROW }];
    await ticks.processDueAutomations();
    assert.strictEqual(calls.claimPrimary, 1, 'the primary pass still runs first');
    assert.strictEqual(calls.exec.length, 1);
    const e = calls.exec[0];
    assert.strictEqual(e.id, 'auto-1');
    assert.strictEqual(e.triggerKind, 'schedule');
    assert.strictEqual(e.rootStepId, 'trig_daily');
    assert.deepStrictEqual(e.schedule, { id: 'sch_1', cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: '2026-09-03T05:00:00.000Z' });
    assert.ok(typeof e.triggerPayload?.now === 'string', 'the advertised `now` field is real');
    assert.deepStrictEqual(calls.advance, [], 'advancing after a run is the runner\'s job, not the tick\'s');
});

test('without the capability the row is released and advanced, never run', async () => {
    capabilityOk = false;
    dueSchedules = [{ automation: AUTO, schedule: ROW }];
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec, []);
    assert.deepStrictEqual(calls.release, ['auto-1']);
    assert.ok(calls.update.some(u => u.id === 'auto-1' && u.lastStatus === 'pending'));
    assert.deepStrictEqual(calls.advance, [{ id: 'sch_1', nextRunAt: NEXT, lastStatus: 'skipped' }]);
});

test('a suspended owner\'s additional schedule is released and advanced, never run', async () => {
    ownerRow = { id: 'u1', status: 'suspended' };
    dueSchedules = [{ automation: AUTO, schedule: ROW }];
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec, [], 'the owner\'s standing is gone, so the routine does not act');
    assert.deepStrictEqual(calls.release, ['auto-1']);
    assert.deepStrictEqual(calls.advance, [{ id: 'sch_1', nextRunAt: NEXT, lastStatus: 'skipped' }]);
});

test('a PRIMARY schedule whose owner account is gone is released and moved on, not run', async () => {
    ownerRow = null;
    duePrimary = [{ ...AUTO, triggerType: 'schedule', scheduleCron: '0 7 * * 1-5', scheduleTz: 'Europe/Amsterdam', nextRunAt: '2026-04-28T05:00:00.000Z' }];
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec, []);
    assert.deepStrictEqual(calls.release, ['auto-1']);
    assert.deepStrictEqual(calls.update, [{ id: 'auto-1', lastStatus: 'pending', nextRunAt: NEXT }], 'advanced to the next slot, not left in the past');
});

test('nothing due → nothing dispatched, and a claim error never breaks the tick', async () => {
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec, []);
    dueSchedules = null;   // a store returning nothing usable
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec, []);
});

test('a slot on a public holiday is skipped when the live schedule says so', async () => {
    const def = {
        trigger: { id: 'trig_main', kind: 'manual' },
        triggers: [{ id: 'trig_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', skipHolidays: true } }],
        steps: [], edges: [],
    };
    // 07:00 on Koningsdag 2026 in Amsterdam.
    dueSchedules = [{ automation: { ...AUTO, definition: def }, schedule: { ...ROW, nextRunAt: '2026-04-27T05:00:00.000Z' } }];
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 0, 'not run on a holiday');
    assert.deepStrictEqual(calls.release, ['auto-1'], 'the automation is released');
    assert.deepStrictEqual(calls.advance, [{ id: 'sch_1', nextRunAt: NEXT, lastStatus: 'skipped' }]);
});

test('the same slot runs when the schedule does not skip holidays', async () => {
    const def = {
        trigger: { id: 'trig_main', kind: 'manual' },
        triggers: [{ id: 'trig_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } }],
        steps: [], edges: [],
    };
    dueSchedules = [{ automation: { ...AUTO, definition: def }, schedule: { ...ROW, nextRunAt: '2026-04-27T05:00:00.000Z' } }];
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 1);
});

test('a PRIMARY schedule slot on a public holiday is released and moved on, not run', async () => {
    const def = { trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', skipHolidays: true } }, steps: [], edges: [] };
    duePrimary = [{ ...AUTO, definition: def, triggerType: 'schedule', scheduleCron: '0 7 * * 1-5', scheduleTz: 'Europe/Amsterdam', nextRunAt: '2026-04-27T05:00:00.000Z' }];
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 0);
    assert.deepStrictEqual(calls.release, ['auto-1']);
    assert.deepStrictEqual(calls.update, [{ id: 'auto-1', lastStatus: 'pending', nextRunAt: NEXT }]);
});

test('a PRIMARY slot on an ordinary day runs as before', async () => {
    const def = { trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', skipHolidays: true } }, steps: [], edges: [] };
    duePrimary = [{ ...AUTO, definition: def, triggerType: 'schedule', scheduleCron: '0 7 * * 1-5', scheduleTz: 'Europe/Amsterdam', nextRunAt: '2026-04-28T05:00:00.000Z' }];
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 1);
    assert.strictEqual(calls.exec[0].triggerKind, 'schedule');
});

// ── claimed rows that wait for their batch (claimedBatches.js) ──────────────
//
// The tick claims up to 20 due automations at once (last_status='running',
// running_started_at = the claim moment) and runs them five at a time. Only a
// row that is actually running has a heartbeat that refreshes its marker; a
// row in batch three or four just sat there. When the earlier batches took
// longer than the reaper's stale window (six minutes by default), the reaper
// reset the waiting rows, another instance claimed and ran them, and this
// instance — which still held them in memory — ran them as well: one schedule
// slot, two runs.

const primaryRow = (n) => ({ id: `auto-${n}`, userId: 'u1', organizationId: 'org-1', triggerType: 'schedule', scheduleCron: '0 7 * * *', scheduleTz: 'UTC', nextRunAt: '2026-09-03T07:00:00.000Z', definition: {} });

test('rows waiting for a later batch get their marker refreshed before every batch', async () => {
    duePrimary = Array.from({ length: 12 }, (_, i) => primaryRow(i + 1));
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 12, 'every claimed row still runs');
    assert.ok(calls.exec.every(e => e.markerClaimed === true), 'the tick tells the run it holds the claim');
    const touchedAfterFirstBatch = calls.touch.filter(t => t.execsSoFar === 5).map(t => t.id);
    assert.deepStrictEqual(touchedAfterFirstBatch, ['auto-6', 'auto-7', 'auto-8', 'auto-9', 'auto-10', 'auto-11', 'auto-12'],
        'the rows still waiting after the first batch were not kept alive');
    assert.ok(calls.touch.every(t => t.instanceId === 'runner-test'), 'the refresh must be scoped to this instance');
});

test('a row the reaper took back while it waited is not run by this instance', async () => {
    duePrimary = Array.from({ length: 7 }, (_, i) => primaryRow(i + 1));
    // The first batch outlasts the stale window: auto-7 is reset (and may be claimed elsewhere).
    onExec = (a) => { if (a.id === 'auto-1') reaped.add('auto-7'); };
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec.map(e => e.id), ['auto-1', 'auto-2', 'auto-3', 'auto-4', 'auto-5', 'auto-6'],
        'a row that lost its claim ran anyway — a second instance runs it too');
});

test('additional schedules waiting for a batch get the same protection', async () => {
    dueSchedules = Array.from({ length: 7 }, (_, i) => ({
        automation: { id: `auto-${i + 1}`, userId: 'u1', organizationId: 'org-1', definition: {} },
        schedule: { id: `sch_${i + 1}`, automationId: `auto-${i + 1}`, triggerStepId: 'trig', cron: '0 7 * * *', tz: 'UTC', nextRunAt: '2026-09-03T07:00:00.000Z' },
    }));
    onExec = (a) => { if (a.id === 'auto-1') reaped.add('auto-6'); };
    await ticks.processDueAutomations();
    assert.deepStrictEqual(calls.exec.map(e => e.id), ['auto-1', 'auto-2', 'auto-3', 'auto-4', 'auto-5', 'auto-7']);
});

test('a store without the marker refresh, or a failing refresh, still runs every claimed row', async () => {
    const store = require('../../../stores/automationStore');
    const original = store.touchAutomationRunning;
    try {
        store.touchAutomationRunning = async () => { throw new Error('db down'); };
        duePrimary = Array.from({ length: 6 }, (_, i) => primaryRow(i + 1));
        await ticks.processDueAutomations();
        assert.strictEqual(calls.exec.length, 6, 'an infra error on the refresh must not drop claimed work');
        calls.exec.length = 0;
        delete store.touchAutomationRunning;
        duePrimary = Array.from({ length: 6 }, (_, i) => primaryRow(i + 1));
        await ticks.processDueAutomations();
        assert.strictEqual(calls.exec.length, 6);
    } finally {
        store.touchAutomationRunning = original;
    }
});
