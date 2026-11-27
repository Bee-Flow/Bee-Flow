/**
 * "After every meeting", the automation half: the tap that calls
 * jobs/kbSourceRefresh.js onMeetingProcessed sits in automation/triggerBus/dispatch,
 * which is the automation module's. The arming itself is kbSourceRefresh.meetingTap.test.js.
 *
 * Run: cd server && node --test jobs/kbSourceRefresh.meetingTap.automation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const kbSourceRefresh = require('./kbSourceRefresh');
const { installResolveStub, evictModule } = require('../testUtils/stubRequire');

test('the bus tap is wired, or none of this ever runs', async () => {
    // The tap lives beside talkAutoIngest in triggerBus/dispatch. Without the
    // wiring the event fires into subscriptions only and no source is armed.
    // Called for real: stub the subscription lookup (irrelevant here) and spy
    // on this module's own export the way dispatch.js reaches it — at call
    // time, via require('../../jobs/kbSourceRefresh') — instead of reading
    // dispatch.js as text.
    const restoreStub = installResolveStub({
        '../../stores/automationStore': { getSubscriptionsForProvider: async () => [] },
    });
    const realOnMeetingProcessed = kbSourceRefresh.onMeetingProcessed;
    const calls = [];
    kbSourceRefresh.onMeetingProcessed = (payload) => { calls.push(payload); return 0; };
    evictModule(require.resolve('../automation/triggerBus/dispatch'));
    try {
        const { dispatchEvent } = require('../automation/triggerBus/dispatch');
        // userId AND orgId: bypasses every fail-closed scope guard regardless
        // of how 'meeting-notes' is classified, so only the wiring is on test.
        await dispatchEvent({
            provider: 'meeting-notes', event: 'meeting.processed',
            payload: { tags: ['sales'] }, userId: 'u1', orgId: 'org1',
        });
        assert.deepStrictEqual(calls, [{ tags: ['sales'] }],
            'dispatchEvent must call onMeetingProcessed for meeting-notes.meeting.processed');
    } finally {
        kbSourceRefresh.onMeetingProcessed = realOnMeetingProcessed;
        restoreStub();
        evictModule(require.resolve('../automation/triggerBus/dispatch'));
    }
});
