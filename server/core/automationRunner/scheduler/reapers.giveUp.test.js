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
 * the owner is told once.
 *
 * Run: cd server && node --test core/automationRunner/scheduler/reapers.giveUp.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const updates = [];
const notifications = [];
const resets = [];
let reaped = [];
let updateFails = false;

mock('../../../stores/automationStore', {
    reapStuckAutomations: async () => reaped,
    updateAutomation: async (id, patch, userId) => {
        if (updateFails) throw new Error('db down');
        updates.push({ id, patch, userId });
    },
    resetAttempts: async (id) => { resets.push(id); },
    reapExpiredApprovals: async () => [],
    reapExpiredFormWaits: async () => [],
    reapStuckRuns: async () => [],
    cancelOrphanedPendingApprovals: async () => [],
});
mock('../../../stores/notificationStore', { createNotification: async (n) => { notifications.push(n); } });
mock('../approvalLifecycle', {
    expireApprovalsForReapedRuns: async () => {},
    expireOverdueAppApprovals: async () => {},
    remindAndEscalateDueApprovals: async () => {},
});
require('../featurePorts').registerRunnerPorts({
    approvals: { pollTalkReactions: async () => ({ counted: 0 }), dispatchApprovalDecided: () => {} },
});

const { reapStuckAutomations } = require('./reapers');
const { REAPER_MAX_ATTEMPTS } = require('../shared');

beforeEach(() => { updates.length = 0; notifications.length = 0; resets.length = 0; reaped = []; updateFails = false; });

const row = (attempts) => ({ id: 'auto-1', userId: 'u1', title: 'Nightly report', attempts, lastStatus: attempts >= REAPER_MAX_ATTEMPTS ? 'error' : 'pending' });

test('a row that is only reset stays active and nobody is notified', async () => {
    reaped = [row(2)];
    await reapStuckAutomations();
    assert.deepStrictEqual(updates, []);
    assert.deepStrictEqual(notifications, []);
});

test('giving up switches the automation off, so the scheduler cannot claim it again', async () => {
    reaped = [row(REAPER_MAX_ATTEMPTS)];
    await reapStuckAutomations();
    assert.strictEqual(updates.length, 1, 'the automation was told to be "paused" but nothing paused it');
    assert.strictEqual(updates[0].id, 'auto-1');
    assert.strictEqual(updates[0].userId, 'u1');
    assert.strictEqual(updates[0].patch.isActive, false);
    assert.deepStrictEqual(resets, ['auto-1'], 'switched back on, it starts with a fresh attempt budget');
    assert.strictEqual(notifications.length, 1);
    assert.match(notifications[0].message, /was paused/);
});

test('when the pause cannot be written the owner is not told it was paused', async () => {
    updateFails = true;
    reaped = [row(REAPER_MAX_ATTEMPTS)];
    await reapStuckAutomations();
    assert.strictEqual(notifications.length, 1, 'the owner still hears about the failure');
    assert.doesNotMatch(notifications[0].message, /was paused/);
});
