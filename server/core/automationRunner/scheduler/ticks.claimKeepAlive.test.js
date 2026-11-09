/**
 * A claimed schedule row that WAITS for its batch must stay claimed — and a row
 * that lost its claim while waiting must not run.
 *
 * The tick claims up to 20 due automations at once (last_status='running',
 * running_started_at = the claim moment) and then runs them five at a time,
 * batch after batch. Only a row that is actually running has a heartbeat that
 * refreshes its marker; a row in batch three or four just sits there. When the
 * earlier batches take longer than the reaper's stale window (six minutes by
 * default), the reaper resets the waiting rows to 'pending'. Another instance
 * then claims and runs them, and this instance — which still holds them in
 * memory — runs them as well: one schedule slot, two runs, two mails.
 *
 * Run: cd server && node --test core/automationRunner/scheduler/ticks.claimKeepAlive.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const calls = { exec: [], touch: [] };
let duePrimary = [];
let dueSchedules = [];
/** Ids whose claim the reaper took away while they waited. */
let reaped = new Set();
/** Called at the start of every executeAutomation, to let time pass "during" a batch. */
let onExec = () => {};

mock('../../../stores/automationStore', {
    claimDueAutomations: async () => { const d = duePrimary; duePrimary = []; return d; },
    claimDueSchedules: async () => { const d = dueSchedules; dueSchedules = []; return d; },
    touchAutomationRunning: async (id, instanceId) => { calls.touch.push({ id, instanceId, execsSoFar: calls.exec.length }); return !reaped.has(id); },
    advanceSchedule: async () => {},
    releaseAutomation: async () => {},
    updateAutomation: async () => {},
    deleteExpiredFormSessions: async () => 0,
});
mock('../../../db', { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release() {} }) } });
mock('../engine', { INSTANCE_ID: 'runner-test' });
mock('../execution', { executeAutomation: async (a, opts) => { calls.exec.push({ id: a.id, ...opts }); onExec(a); return {}; } });
mock('../cancellation', { ACTIVE_RUNS: new Map() });
const { partsInTz } = require('../../scheduling/cron');
mock('../../scheduling/cron', { nextRunAt: () => new Date('2026-09-04T05:00:00.000Z'), partsInTz });
mock('./reapers', {
    reapStuckAutomations: async () => {},
    reapOrphanFormUploads: async () => {},
    reapExpiredGeneratedFiles: async () => {},
    reapStuckTranscriptions: async () => {},
});
mock('../../integrations/integrationLogging', { flushEgressLogs: async () => {} });
mock('../../entitlements/entitlements', { hasCapability: async () => true });
mock('../../../modules', { moduleGatedTick: (moduleId, fn) => fn });
mock('../../../stores/userStore', { getUser: async () => ({ id: 'u1', status: 'active' }) });

const ticks = require('./ticks');

beforeEach(() => {
    calls.exec.length = 0; calls.touch.length = 0;
    duePrimary = []; dueSchedules = [];
    reaped = new Set();
    onExec = () => {};
});

const primary = (n) => ({ id: `auto-${n}`, userId: 'u1', organizationId: 'org-1', triggerType: 'schedule', scheduleCron: '0 7 * * *', scheduleTz: 'UTC', nextRunAt: '2026-09-03T07:00:00.000Z', definition: {} });

test('rows waiting for a later batch get their marker refreshed before every batch', async () => {
    duePrimary = Array.from({ length: 12 }, (_, i) => primary(i + 1));
    await ticks.processDueAutomations();
    assert.strictEqual(calls.exec.length, 12, 'every claimed row still runs');
    // Before the 2nd batch (5 runs done) rows 6..12 are waiting; before the 3rd, rows 11..12.
    const touchedAfterFirstBatch = calls.touch.filter(t => t.execsSoFar === 5).map(t => t.id);
    assert.deepStrictEqual(touchedAfterFirstBatch, ['auto-6', 'auto-7', 'auto-8', 'auto-9', 'auto-10', 'auto-11', 'auto-12'],
        'the rows still waiting after the first batch were not kept alive');
    assert.ok(calls.touch.every(t => t.instanceId === 'runner-test'), 'the refresh must be scoped to this instance');
});

test('a row the reaper took back while it waited is not run by this instance', async () => {
    duePrimary = Array.from({ length: 7 }, (_, i) => primary(i + 1));
    // The first batch outlasts the stale window: auto-7 is reset (and may be claimed elsewhere).
    onExec = (a) => { if (a.id === 'auto-1') reaped.add('auto-7'); };
    await ticks.processDueAutomations();
    const ran = calls.exec.map(e => e.id);
    assert.ok(!ran.includes('auto-7'), 'a row that lost its claim ran anyway — a second instance runs it too');
    assert.deepStrictEqual(ran, ['auto-1', 'auto-2', 'auto-3', 'auto-4', 'auto-5', 'auto-6']);
});

test('additional schedules get the same protection', async () => {
    dueSchedules = Array.from({ length: 7 }, (_, i) => ({
        automation: { id: `auto-${i + 1}`, userId: 'u1', organizationId: 'org-1', definition: {} },
        schedule: { id: `sch_${i + 1}`, automationId: `auto-${i + 1}`, triggerStepId: 'trig', cron: '0 7 * * *', tz: 'UTC', nextRunAt: '2026-09-03T07:00:00.000Z' },
    }));
    onExec = (a) => { if (a.id === 'auto-1') reaped.add('auto-6'); };
    await ticks.processDueAutomations();
    const ran = calls.exec.map(e => e.id);
    assert.deepStrictEqual(ran, ['auto-1', 'auto-2', 'auto-3', 'auto-4', 'auto-5', 'auto-7']);
});

test('a store without the marker refresh, or a failing refresh, keeps the old behaviour', async () => {
    const store = require('../../../stores/automationStore');
    const original = store.touchAutomationRunning;
    try {
        store.touchAutomationRunning = async () => { throw new Error('db down'); };
        duePrimary = Array.from({ length: 6 }, (_, i) => primary(i + 1));
        await ticks.processDueAutomations();
        assert.strictEqual(calls.exec.length, 6, 'an infra error on the refresh must not drop claimed work');
        calls.exec.length = 0;
        delete store.touchAutomationRunning;
        duePrimary = Array.from({ length: 6 }, (_, i) => primary(i + 1));
        await ticks.processDueAutomations();
        assert.strictEqual(calls.exec.length, 6);
    } finally {
        store.touchAutomationRunning = original;
    }
});
