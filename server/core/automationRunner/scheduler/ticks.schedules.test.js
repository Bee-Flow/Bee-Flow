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

const calls = { exec: [], advance: [], release: [], update: [], claimPrimary: 0 };
let dueSchedules = [];
let duePrimary = [];
let capabilityOk = true;
const NEXT = new Date('2026-09-04T05:00:00.000Z');

mock('../../../stores/automationStore', {
    claimDueAutomations: async () => { calls.claimPrimary += 1; const d = duePrimary; duePrimary = []; return d; },
    claimDueSchedules: async () => dueSchedules,
    advanceSchedule: async (id, patch) => { calls.advance.push({ id, ...patch }); },
    releaseAutomation: async (id) => { calls.release.push(id); },
    updateAutomation: async (id, u) => { calls.update.push({ id, ...u }); },
    deleteExpiredFormSessions: async () => 0,
});
mock('../../../db', { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release() {} }) } });
mock('../engine', { INSTANCE_ID: 'runner-test' });
mock('../execution', { executeAutomation: async (a, opts) => { calls.exec.push({ id: a.id, ...opts }); return {}; } });
mock('../cancellation', { ACTIVE_RUNS: new Map() });
// partsInTz stays real: the holiday check (schedule.skipHolidays) reads the
// slot's local date through it.
const { partsInTz } = require('../../../automation/cron');
mock('../../../automation/cron', { nextRunAt: () => NEXT, partsInTz });
mock('./reapers', {
    reapStuckAutomations: async () => {},
    reapOrphanFormUploads: async () => {},
    reapExpiredGeneratedFiles: async () => {},
    reapStuckTranscriptions: async () => {},
});
mock('../../integrations/integrationLogging', { flushEgressLogs: async () => {} });
mock('../../entitlements/entitlements', { hasCapability: async () => capabilityOk });
mock('../../../modules', { moduleGatedTick: (moduleId, fn) => fn });

const ticks = require('./ticks');

beforeEach(() => {
    calls.exec.length = 0; calls.advance.length = 0; calls.release.length = 0; calls.update.length = 0; calls.claimPrimary = 0;
    dueSchedules = [];
    capabilityOk = true;
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
