/**
 * syncSchedules — additional schedule triggers ↔ automation_schedules rows.
 *
 * Run: node --test automation/scheduleSync.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { syncSchedules, scheduleFingerprint, secondarySchedules } = require('./scheduleSync');

const NEXT = new Date('2026-09-04T05:00:00.000Z');
function stubStore() {
    const calls = { upserts: [], deletes: [] };
    return {
        calls,
        store: {
            upsertSchedule: async (opts) => { calls.upserts.push(opts); return { id: `sch_${calls.upserts.length}`, ...opts }; },
            deleteSchedulesExcept: async (automationId, keep) => { calls.deletes.push({ automationId, keep }); },
        },
        cron: { nextRunAt: (c) => (c === 'broken' ? null : NEXT) },
    };
}

const DEF = {
    trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } },
    triggers: [
        { id: 'trig_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } },
        { id: 'trig_cal', kind: 'app_event', appEvent: { provider: 'google-calendar', event: 'event.upcoming' } },
        { id: 'trig_week', kind: 'schedule', schedule: { cron: '0 8 * * 1' } },
        { id: 'trig_empty', kind: 'schedule', schedule: { cron: '   ' } },
    ],
    steps: [], edges: [],
};

test('every secondary schedule with a cron gets a row; the rest are pruned', async () => {
    const { store, cron, calls } = stubStore();
    const r = await syncSchedules('auto-1', DEF, {}, { automationStore: store, cron });
    assert.deepStrictEqual(r.synced, ['trig_daily', 'trig_week']);
    assert.strictEqual(calls.upserts.length, 2);
    assert.deepStrictEqual(calls.upserts[0], { automationId: 'auto-1', triggerStepId: 'trig_daily', cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', nextRunAt: NEXT, rearm: false });
    assert.strictEqual(calls.upserts[1].tz, 'Europe/Amsterdam', 'missing tz falls back to the default');
    assert.deepStrictEqual(calls.deletes, [{ automationId: 'auto-1', keep: ['trig_daily', 'trig_week'] }]);
});

test('rearm passes through to every row, and a cron with no next slot parks the row', async () => {
    const { store, cron, calls } = stubStore();
    const def = { ...DEF, triggers: [{ id: 't1', kind: 'schedule', schedule: { cron: 'broken' } }] };
    await syncSchedules('auto-2', def, { rearm: true }, { automationStore: store, cron });
    assert.strictEqual(calls.upserts[0].rearm, true);
    assert.strictEqual(calls.upserts[0].nextRunAt, null);
});

test('a store without the aggregate is a no-op, never a throw', async () => {
    const r = await syncSchedules('auto-3', DEF, {}, { automationStore: {}, cron: { nextRunAt: () => NEXT } });
    assert.deepStrictEqual(r, { synced: [], removed: false });
});

test('the fingerprint sees only the firing config of secondary schedules', () => {
    const a = scheduleFingerprint(DEF);
    const reordered = { ...DEF, triggers: [...DEF.triggers].reverse() };
    assert.strictEqual(scheduleFingerprint(reordered), a, 'order does not matter');
    const nudged = { ...DEF, triggers: DEF.triggers.map(t => ({ ...t, position: { x: 1, y: 2 }, label: 'renamed' })) };
    assert.strictEqual(scheduleFingerprint(nudged), a, 'position/label changes do not re-anchor a schedule');
    const changedCron = { ...DEF, triggers: DEF.triggers.map(t => (t.id === 'trig_daily' ? { ...t, schedule: { ...t.schedule, cron: '30 7 * * 1-5' } } : t)) };
    assert.notStrictEqual(scheduleFingerprint(changedCron), a);
    const primaryChanged = { ...DEF, trigger: { id: 'trg', kind: 'schedule', schedule: { cron: '* * * * *' } } };
    assert.strictEqual(scheduleFingerprint(primaryChanged), a, 'the primary schedule lives on the automations row, not here');
    assert.deepStrictEqual(secondarySchedules({}), []);
});

test('skipHolidays is part of the firing config and steps over holidays', async (t) => {
    const withFlag = { ...DEF, triggers: [{ id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', skipHolidays: true } }] };
    const without = { ...DEF, triggers: [{ id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } }] };
    assert.notStrictEqual(scheduleFingerprint(withFlag), scheduleFingerprint(without), 'switching it re-syncs the row');
    assert.strictEqual(secondarySchedules(withFlag)[0].skipHolidays, true);
    assert.strictEqual(secondarySchedules(without)[0].skipHolidays, false);

    // The real cron: from the Friday before Koningsdag 2026, the next weekday
    // slot is Tuesday 28 April, not Monday the 27th.
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-24T12:00:00Z') });
    const { store, calls } = stubStore();
    await syncSchedules('auto-4', withFlag, { rearm: true }, { automationStore: store });
    assert.strictEqual(calls.upserts[0].nextRunAt, '2026-04-28T05:00:00.000Z');
    calls.upserts.length = 0;
    await syncSchedules('auto-4', without, { rearm: true }, { automationStore: store });
    assert.strictEqual(calls.upserts[0].nextRunAt, '2026-04-27T05:00:00.000Z');
});
