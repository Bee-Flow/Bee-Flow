// @typecheck
'use strict';

/**
 * Failure escalation: count, notify once at the threshold, debounce for 24h.
 *
 * Run: node --test automation/triggerBus/escalation.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

// The notification store comes in through ctx; a recorder stands in for it,
// so no database is reached.
const notifications = [];

const { escalateSubscriptionFailure, POLL_FAILURE_THRESHOLD, RENEW_FAILURE_THRESHOLD, FAILURE_NOTIFY_DEBOUNCE_MS } = require('./escalation');

function escCtx({ failures, errorNotifiedAt = null, automation = { title: 'Invoices' } }) {
    const updates = [];
    const ctx = {
        store: () => ({
            incrementSubscriptionFailures: async () => ({ consecutiveFailures: failures, errorNotifiedAt }),
            getAutomation: async () => automation,
            updateSubscription: async (id, u) => { updates.push({ id, ...u }); },
        }),
        notificationStore: () => ({ createNotification: async (n) => { notifications.push(n); } }),
    };
    return { ctx, updates };
}

const SUB = { id: 's1', userId: 'u1', automationId: 'a1', provider: 'gmail', eventType: 'mail.new' };

test('thresholds are unchanged: polling 5, renewal 2, debounce 24h', () => {
    assert.strictEqual(POLL_FAILURE_THRESHOLD, 5);
    assert.strictEqual(RENEW_FAILURE_THRESHOLD, 2);
    assert.strictEqual(FAILURE_NOTIFY_DEBOUNCE_MS, 24 * 60 * 60_000);
});

test('below the threshold nothing is notified', async () => {
    notifications.length = 0;
    const { ctx, updates } = escCtx({ failures: POLL_FAILURE_THRESHOLD - 1 });
    await escalateSubscriptionFailure(ctx, SUB, POLL_FAILURE_THRESHOLD, 'boom');
    assert.strictEqual(notifications.length, 0);
    assert.deepStrictEqual(updates, []);
});

test('at the threshold the user is notified once and errorNotifiedAt is stamped', async () => {
    notifications.length = 0;
    const { ctx, updates } = escCtx({ failures: POLL_FAILURE_THRESHOLD });
    await escalateSubscriptionFailure(ctx, SUB, POLL_FAILURE_THRESHOLD, 'invalid_grant');
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].userId, 'u1');
    assert.strictEqual(notifications[0].category, 'urgent');
    assert.match(notifications[0].message, /invalid_grant/);
    assert.strictEqual(updates.length, 1);
    assert.ok(updates[0].errorNotifiedAt);
});

test('a notification inside the debounce window is not repeated', async () => {
    notifications.length = 0;
    const { ctx, updates } = escCtx({ failures: 9, errorNotifiedAt: new Date(Date.now() - 60_000).toISOString() });
    await escalateSubscriptionFailure(ctx, SUB, POLL_FAILURE_THRESHOLD, 'boom');
    assert.strictEqual(notifications.length, 0);
    assert.deepStrictEqual(updates, []);
});
