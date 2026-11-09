/**
 * An automation the reaper gives up on is really paused.
 *
 * After REAPER_MAX_ATTEMPTS resets the store leaves the row in 'error' and the
 * owner is told it "was paused". It was not: the row stayed active, and
 * claimDueAutomations takes any due row whose last_status is not 'running' —
 * 'error' included. A scheduled automation whose run takes the worker down was
 * therefore claimed again on the very next tick, crashed again, was reaped
 * again (attempts 6, 7, 8, …) and the owner got the same urgent "was paused"
 * notification every few minutes, indefinitely.
 *
 * Giving up now switches the automation off, the way a schedule without a
 * future run is switched off (runFinalizeEffects.advancePrimarySchedule), and
 * the owner is told once. The stores are handed in (makeGiveUp), so nothing
 * here touches a database or the module system.
 *
 * Run: cd server && node --test core/automationRunner/scheduler/giveUp.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { makeGiveUp } = require('./giveUp');

function harness({ updateFails = false, resetFails = false } = {}) {
    const updates = [];
    const resets = [];
    const notifications = [];
    const giveUpOn = makeGiveUp({
        automationStore: {
            updateAutomation: async (id, patch, userId) => {
                if (updateFails) throw new Error('db down');
                updates.push({ id, patch, userId });
            },
            resetAttempts: async (id) => {
                if (resetFails) throw new Error('db down');
                resets.push(id);
            },
        },
        notificationStore: { createNotification: async (n) => { notifications.push(n); } },
    });
    return { updates, resets, notifications, giveUpOn };
}

const ROW = { id: 'auto-1', userId: 'u1', title: 'Nightly report', attempts: 5, lastStatus: 'error' };

test('giving up switches the automation off, so the scheduler cannot claim it again', async () => {
    const h = harness();
    await h.giveUpOn(ROW);
    assert.deepStrictEqual(h.updates, [{ id: 'auto-1', patch: { isActive: false }, userId: 'u1' }],
        'the owner was told the automation "was paused" but nothing paused it');
    assert.deepStrictEqual(h.resets, ['auto-1'], 'switched back on, it starts with a fresh attempt budget');
    assert.strictEqual(h.notifications.length, 1);
    assert.strictEqual(h.notifications[0].userId, 'u1');
    assert.match(h.notifications[0].message, /was paused/);
});

test('when the pause cannot be written the owner is not told it was paused', async () => {
    const h = harness({ updateFails: true });
    await h.giveUpOn(ROW);
    assert.strictEqual(h.notifications.length, 1, 'the owner still hears about the failure');
    assert.doesNotMatch(h.notifications[0].message, /was paused/);
    assert.deepStrictEqual(h.resets, [], 'an automation that is still active keeps its attempt count');
});

test('a failing attempt reset does not undo the pause or the notification', async () => {
    const h = harness({ resetFails: true });
    await h.giveUpOn(ROW);
    assert.strictEqual(h.updates.length, 1);
    assert.match(h.notifications[0].message, /was paused/);
});
