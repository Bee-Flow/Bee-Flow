'use strict';

/**
 * K4 — the gmail label.added poller read ONE history.list page, kept at most
 * 20 messages and then moved the cursor to the newest historyId anyway: more
 * than 20 labelled messages between two polls, or a history spanning several
 * pages, and those automations never ran. Both gmail pollers now share the
 * paginated walk in gmailHistory.js.
 *
 * The end-to-end test drives label.added through runPollingPass with a fake
 * Gmail of 25 labelled messages over 2 pages and asserts all 25 are
 * dispatched across two ticks (before the fix: 15, the rest lost).
 *
 * Run: node --test automation/triggerBus/pollers/gmailHistory.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

// ── Fake Gmail history: records with numeric ids, PAGE records per page ──
const PAGE = 15;
const NEWEST = '999';
function fakeGmail(records, listCalls = []) {
    return {
        users: {
            history: {
                list: async (params) => {
                    listCalls.push(params);
                    const after = records.filter(r => Number(r.id) > Number(params.startHistoryId));
                    const offset = Number(params.pageToken || 0);
                    const page = after.slice(offset, offset + PAGE);
                    const more = offset + PAGE < after.length;
                    return { data: { historyId: NEWEST, history: page, ...(more ? { nextPageToken: String(offset + PAGE) } : {}) } };
                },
            },
            messages: {
                get: async () => { throw new Error('metadata not needed in this test'); },
                list: async () => ({ data: { messages: [] } }),
            },
            getProfile: async () => ({ data: { historyId: NEWEST } }),
        },
    };
}
const labelRecords = (n) => Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    labelsAdded: [{ message: { id: `m${i + 1}`, threadId: `t${i + 1}` }, labelIds: ['Label_1'] }],
}));

// ── Fakes for runPollingPass, injected through triggerBus._setDepsForTests ──
let SUBS = [];
let GMAIL = null;
const dispatched = [];
const fakeAutomationStore = {
    getPollingSubscriptions: async () => SUBS,
    updateSubscription: async (id, updates) => {
        const row = SUBS.find(s => s.id === id);
        if (row && updates.lastCursor !== undefined) row.lastCursor = updates.lastCursor;
        return true;
    },
    incrementSubscriptionFailures: async () => ({ consecutiveFailures: 1, errorNotifiedAt: null }),
    resetSubscriptionFailures: async () => {},
    getAutomation: async () => null,
    getExpiringSubscriptions: async () => [],
    getSubscriptionsForProvider: async () => [],
};

const { runPollingPass, _setDepsForTests } = require('../../triggerBus');
const { walkGmailHistory } = require('./gmailHistory');

_setDepsForTests({
    automationStore: fakeAutomationStore,
    userStore: () => ({ getUser: async () => ({ provider: 'local' }) }),
    automationAuth: () => ({
        buildUserAuth: async () => ({ accessToken: 'tok', refreshToken: null, oauthProvider: 'google', automationProviders: {} }),
    }),
    googleClient: () => ({ createGoogleApiClient: async () => GMAIL }),
    dispatchToSubscription: () => (sub, ev) => { dispatched.push(ev.payload); },
});
test.after(() => _setDepsForTests());

test('label.added: 25 labelled messages over 2 pages are all dispatched, none lost', async () => {
    GMAIL = fakeGmail(labelRecords(25));
    dispatched.length = 0;
    SUBS = [{
        id: 'sub-label', userId: 'u1', automationId: 'a1', provider: 'gmail', eventType: 'label.added',
        mode: 'polling', filter: null, lastCursor: '0', consecutiveFailures: 0,
    }];

    await runPollingPass();
    assert.strictEqual(dispatched.length, 20, 'tick 1 stops at the per-tick cap of 20 messages');
    assert.strictEqual(SUBS[0].lastCursor, '20', 'capped: the cursor stops at the last record drained, not the newest historyId');

    await runPollingPass();
    assert.strictEqual(SUBS[0].lastCursor, NEWEST, 'caught up: the cursor moves to the newest historyId');
    const ids = dispatched.map(e => e.messageId);
    assert.deepStrictEqual(ids, Array.from({ length: 25 }, (_, i) => `m${i + 1}`), 'every message fires exactly once');
    assert.deepStrictEqual(dispatched[0].addedLabelIds, ['Label_1']);
});

test('label.added: labels on one message in several records fire once, aggregated', async () => {
    GMAIL = fakeGmail([
        { id: '1', labelsAdded: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['A'] }] },
        { id: '2', labelsAdded: [{ message: { id: 'm1', threadId: 't1' }, labelIds: ['B', 'A'] }] },
    ]);
    dispatched.length = 0;
    SUBS = [{ id: 's2', userId: 'u1', automationId: 'a1', provider: 'gmail', eventType: 'label.added', mode: 'polling', filter: null, lastCursor: '0', consecutiveFailures: 0 }];
    await runPollingPass();
    assert.strictEqual(dispatched.length, 1);
    assert.deepStrictEqual(dispatched[0].addedLabelIds, ['A', 'B']);
    assert.strictEqual(SUBS[0].lastCursor, NEWEST);
});

test('mail.new still walks every page via the shared helper', async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({
        id: String(i + 1), messagesAdded: [{ message: { id: `n${i + 1}`, threadId: `t${i + 1}` } }],
    }));
    GMAIL = fakeGmail(records);
    dispatched.length = 0;
    SUBS = [{ id: 's3', userId: 'u1', automationId: 'a1', provider: 'gmail', eventType: 'mail.new', mode: 'polling', filter: null, lastCursor: '0', consecutiveFailures: 0 }];
    await runPollingPass();
    assert.strictEqual(dispatched.length, 25);
    assert.strictEqual(SUBS[0].lastCursor, NEWEST);
});

test('walkGmailHistory: follows nextPageToken and passes the history type through', async () => {
    const calls = [];
    const seen = [];
    const r = await walkGmailHistory(fakeGmail(labelRecords(25), calls), {
        startHistoryId: '0', historyTypes: ['labelAdded'], maxEvents: 100,
        onRecord: (h) => { seen.push(h.id); return seen.length; },
    });
    assert.strictEqual(seen.length, 25);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls.map(c => c.pageToken), [undefined, '15']);
    assert.deepStrictEqual(calls[0].historyTypes, ['labelAdded']);
    assert.deepStrictEqual(r, { nextCursor: NEWEST, capped: false, latestHistoryId: NEWEST, lastProcessedHistoryId: '25' });
});

test('walkGmailHistory: the page cap stops early and keeps the cursor at the last drained record', async () => {
    const r = await walkGmailHistory(fakeGmail(labelRecords(40)), {
        startHistoryId: '0', historyTypes: ['labelAdded'], maxEvents: 1000, maxPages: 2,
        onRecord: () => 0,
    });
    assert.strictEqual(r.capped, true);
    assert.strictEqual(r.nextCursor, '30');
});
