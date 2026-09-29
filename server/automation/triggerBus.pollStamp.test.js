'use strict';

/**
 * W1/FIX4 — a failing subscription must not starve the polling fleet.
 *
 * runPollingPass stamped `lastPolledAt` on the success path and on the
 * no-credentials path, but the catch only escalated the failure counter — it
 * never stamped. getPollingSubscriptions
 * (stores/automationStore/subscriptions.js) selects
 *   `last_polled_at IS NULL OR last_polled_at < NOW() - olderThanMs`
 * and orders
 *   `last_polled_at ASC NULLS FIRST LIMIT 50`
 * so a chronically failing subscription (one expired refresh token is enough)
 * was re-polled on EVERY tick and sorted to the front of the window forever.
 * Once ~50 of them existed, healthy subscriptions were never reached again.
 *
 * The second test models that ORDER BY with a two-row window and asserts the
 * healthy subscription gets its turn.
 *
 * Run: node --test automation/triggerBus.pollStamp.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// ── Fake subscription store ─────────────────────────────────────────────
// `polledSeq` stands in for the last_polled_at timestamp: a monotonic counter
// keeps the ordering deterministic where real timestamps would tie inside one
// test run. Selection mirrors the real ORDER BY (NULLS FIRST) with a small
// window so starvation is observable.
let SUBS = [];
let WINDOW = 50;
let seq = 0;
const calls = { increments: [], resets: [], updates: [] };

function selectDue() {
    return SUBS.slice()
        .sort((a, b) => {
            if (a.polledSeq === null && b.polledSeq === null) return 0;
            if (a.polledSeq === null) return -1;
            if (b.polledSeq === null) return 1;
            return a.polledSeq - b.polledSeq;
        })
        .slice(0, WINDOW);
}

mock(path.join(SERVER, 'stores/automationStore'), {
    getPollingSubscriptions: async () => selectDue(),
    updateSubscription: async (id, updates) => {
        calls.updates.push({ id, updates });
        const row = SUBS.find(s => s.id === id);
        if (row && updates.lastPolledAt !== undefined) { row.lastPolledAt = updates.lastPolledAt; row.polledSeq = ++seq; }
        if (row && updates.lastCursor !== undefined) row.lastCursor = updates.lastCursor;
        return true;
    },
    incrementSubscriptionFailures: async (id) => {
        calls.increments.push(id);
        const row = SUBS.find(s => s.id === id);
        row.consecutiveFailures = (row.consecutiveFailures || 0) + 1;
        // Stay under POLL_FAILURE_THRESHOLD so escalation never reaches the
        // notification store — the counter itself is what we assert on.
        return { consecutiveFailures: row.consecutiveFailures, errorNotifiedAt: null };
    },
    resetSubscriptionFailures: async (id) => { calls.resets.push(id); },
    getAutomation: async () => null,
    getExpiringSubscriptions: async () => [],
    getSubscriptionsForProvider: async () => [],
});
mock(path.join(SERVER, 'stores/userStore'), { getUser: async () => ({ provider: 'local' }) });
mock(path.join(SERVER, 'auth/routineAuth'), {
    buildUserAuth: async (userId) => ({ accessToken: `tok-${userId}`, refreshToken: null, oauthProvider: 'google', routineProviders: {} }),
});
// The gmail poller resolves its client before any try/catch, so this is where
// a dead OAuth token surfaces in production.
mock(path.join(SERVER, 'integrations/googleClient'), {
    createGoogleApiClient: async (session) => {
        if (String(session.accessToken).startsWith('tok-broken')) {
            throw new Error('invalid_grant: token has been expired or revoked');
        }
        return {
            users: {
                history: { list: async () => ({ data: { historyId: '101', history: [] } }) },
                messages: { list: async () => ({ data: { messages: [] } }) },
                getProfile: async () => ({ data: { historyId: '101' } }),
            },
        };
    },
});

const { runPollingPass } = require('./triggerBus');

function sub(id, userId, { failing = false } = {}) {
    return {
        id, userId, automationId: `auto-${id}`, provider: 'gmail', eventType: 'mail.new',
        mode: 'polling', filter: null, lastCursor: '100',
        lastPolledAt: null, polledSeq: null, consecutiveFailures: 0, _failing: failing,
    };
}

function reset(subs, window = 50) {
    SUBS = subs;
    WINDOW = window;
    seq = 0;
    calls.increments = []; calls.resets = []; calls.updates = [];
}

const stampsFor = (id) => calls.updates.filter(u => u.id === id && u.updates.lastPolledAt !== undefined);

test('a failing subscription still gets its lastPolledAt stamped', async () => {
    reset([sub('broken', 'broken1'), sub('ok', 'healthy')]);
    await runPollingPass();

    assert.strictEqual(stampsFor('broken').length, 1,
        'without the stamp this row is re-polled every tick and never leaves the head of the queue');
    assert.deepStrictEqual(calls.increments, ['broken'], 'failure escalation is still intact');
    assert.strictEqual(stampsFor('ok').length, 1, 'the success path stamps exactly once');
    assert.deepStrictEqual(calls.resets, ['ok'], 'a successful poll still resets its failure counter');
});

test('two broken subscriptions no longer monopolise the polling window', async () => {
    // Window of 2 with 2 permanently-broken rows: with NULLS FIRST ordering and
    // no stamp on failure, `healthy` never reached the front of the queue.
    reset([sub('broken-a', 'broken1'), sub('broken-b', 'broken2'), sub('healthy', 'healthy')], 2);

    await runPollingPass();
    assert.strictEqual(stampsFor('healthy').length, 0, 'tick 1 is filled by the two oldest (never-polled) rows');

    await runPollingPass();
    assert.strictEqual(stampsFor('healthy').length, 1, 'tick 2 must reach the healthy subscription');
    assert.deepStrictEqual(calls.resets, ['healthy']);
});
