// @typecheck
/**
 * Event-triggered Cowork items (trigger_kind 'app_event') in coworkStore and
 * their subscription rows in automationStore, against the real schema (pglite
 * built from the boot ladder).
 *
 * Proven: create / update / get / list carry triggerKind and the parsed trigger;
 * an event item has no clock and getDueSchedules never returns it (even with a
 * next_run_at in the past); a clock item still comes back due; a subscription
 * can belong to a schedule and is found and deleted by it; the schedule's
 * delete takes the subscription along.
 *
 * Run: cd server && node --test stores/coworkStore.trigger.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool(ladderPglite());
const coworkStore = require('./coworkStore');
const automationStore = require('./automationStore');

const TRIGGER = { provider: 'gmail', event: 'mail.new', filter: { from: 'boss@x.nl' } };

before(async () => {
    await coworkStore.initDB();
});
after(close);

test('an event item is stored without a clock and reads back with its trigger', async () => {
    const created = await coworkStore.createSchedule({
        userId: 'u1', title: 'Inbox', prompt: 'p', agentId: 'a1',
        // Even a caller that passes a time and an interval gets neither stored.
        nextRunAt: '2026-01-01T00:00:00.000Z', repeatInterval: 'daily',
        triggerKind: 'app_event', trigger: TRIGGER,
    });
    assert.strictEqual(created.triggerKind, 'app_event');
    assert.deepStrictEqual(created.trigger, TRIGGER);
    assert.strictEqual(created.nextRunAt, null);
    assert.strictEqual(created.repeatInterval, null);
    const list = await coworkStore.getSchedules('u1');
    assert.deepStrictEqual(list.find((s) => s.id === created.id)?.trigger, TRIGGER);
});

test('a clock item defaults to triggerKind schedule with no trigger', async () => {
    const s = await coworkStore.createSchedule({ userId: 'u2', title: 'Digest', prompt: 'p', nextRunAt: new Date(Date.now() - 60_000).toISOString(), repeatInterval: 'daily' });
    assert.strictEqual(s.triggerKind, 'schedule');
    assert.strictEqual(s.trigger, null);
});

test('getDueSchedules returns the due clock item and never an event item', async () => {
    const ev = await coworkStore.createSchedule({ userId: 'u3', title: 'Inbox', prompt: 'p', agentId: 'a1', triggerKind: 'app_event', trigger: TRIGGER });
    // Force the worst case: an event row that somehow carries a past next_run_at.
    await pg.query(`UPDATE cowork_schedules SET next_run_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [ev.id]);
    const clock = await coworkStore.createSchedule({ userId: 'u3', title: 'Digest', prompt: 'p', nextRunAt: new Date(Date.now() - 60_000).toISOString(), repeatInterval: 'daily' });
    const due = (await coworkStore.getDueSchedules()).map((s) => s.id);
    assert.ok(due.includes(clock.id));
    assert.ok(!due.includes(ev.id));
});

test('update switches kind and trigger both ways', async () => {
    const s = await coworkStore.createSchedule({ userId: 'u4', title: 'T', prompt: 'p', nextRunAt: new Date().toISOString() });
    await coworkStore.updateSchedule(s.id, { triggerKind: 'app_event', trigger: TRIGGER, nextRunAt: null });
    let got = await coworkStore.getSchedule(s.id);
    assert.strictEqual(got.triggerKind, 'app_event');
    assert.deepStrictEqual(got.trigger, TRIGGER);
    assert.strictEqual(got.nextRunAt, null);
    await coworkStore.updateSchedule(s.id, { triggerKind: 'schedule', trigger: null, nextRunAt: '2030-01-01T00:00:00.000Z' });
    got = await coworkStore.getSchedule(s.id);
    assert.strictEqual(got.triggerKind, 'schedule');
    assert.strictEqual(got.trigger, null);
});

test('a subscription belongs to a schedule: found, deleted, and gone with the schedule', async () => {
    const s = await coworkStore.createSchedule({ userId: 'u5', title: 'Inbox', prompt: 'p', agentId: 'a1', triggerKind: 'app_event', trigger: TRIGGER });
    const sub = await automationStore.createSubscription({ coworkScheduleId: s.id, userId: 'u5', provider: 'gmail', eventType: 'mail.new', mode: 'polling', filter: TRIGGER.filter });
    assert.strictEqual(sub.coworkScheduleId, s.id);
    assert.strictEqual(sub.automationId, null);
    assert.deepStrictEqual(sub.filter, TRIGGER.filter);
    assert.strictEqual((await automationStore.getSubscriptionsForCoworkSchedule(s.id)).length, 1);
    // Polling picks cowork rows up like any other.
    assert.ok((await automationStore.getPollingSubscriptions()).some((x) => x.id === sub.id));
    assert.ok((await automationStore.getSubscriptionsForProvider('gmail', 'mail.new')).some((x) => x.id === sub.id));

    await automationStore.deleteSubscriptionsForCoworkSchedule(s.id);
    assert.strictEqual((await automationStore.getSubscriptionsForCoworkSchedule(s.id)).length, 0);

    const again = await automationStore.createSubscription({ coworkScheduleId: s.id, userId: 'u5', provider: 'gmail', eventType: 'mail.new', mode: 'polling' });
    await coworkStore.deleteSchedule(s.id);
    assert.strictEqual(await automationStore.getSubscription(again.id), null);
});

test('a subscription with no owner is refused', async () => {
    await assert.rejects(automationStore.createSubscription({ userId: 'u1', provider: 'gmail', eventType: 'mail.new' }), /one_owner/);
});

test('resumeNeedsReauthForUser resumes a mail trigger only after its subscription sync succeeds', async () => {
    const mk = (title) => coworkStore.createSchedule({ userId: 'u9', title, prompt: 'p', agentId: 'a1', triggerKind: 'app_event', trigger: TRIGGER });
    const ok = await mk('ok');
    const bad = await mk('bad');
    const clock = await coworkStore.createSchedule({ userId: 'u9', title: 'clock', prompt: 'p', nextRunAt: new Date(Date.now() + 60_000).toISOString(), repeatInterval: 'daily' });
    for (const s of [ok, bad, clock]) await coworkStore.updateSchedule(s.id, { isActive: false, lastStatus: 'needs_reauth' });

    const synced = [];
    const resumed = await coworkStore.resumeNeedsReauthForUser('u9', async (s) => {
        synced.push(s.id);
        assert.strictEqual(s.isActive, true);
        if (s.id === bad.id) throw new Error('mail_not_connected');
    });
    assert.strictEqual(resumed, 2);
    assert.deepStrictEqual(synced.sort(), [ok.id, bad.id].sort());
    const byId = Object.fromEntries((await coworkStore.getSchedules('u9')).map((s) => [s.id, s]));
    assert.strictEqual(byId[ok.id].isActive, true);
    assert.strictEqual(byId[clock.id].isActive, true);
    assert.strictEqual(byId[bad.id].isActive, false);
    assert.strictEqual(byId[bad.id].lastStatus, 'needs_reauth');

    // With no sync wired a mail trigger is never flipped on by itself.
    assert.strictEqual(await coworkStore.resumeNeedsReauthForUser('u9', null), 0);
});
