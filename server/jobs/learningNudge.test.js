// @typecheck
const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T00:00:00Z');
const lapsed = { 'c1': { completedAt: new Date(NOW - 20 * DAY).toISOString() } };

const store = new Map();
const notified = [];
const fakeConfig = {
    listKeysWithPrefix: async (prefix) => [...store.keys()].filter(k => k.startsWith(prefix)),
    getConfig: async (k) => store.get(k) ?? null,
    setConfig: async (k, v) => { store.set(k, v); },
};
const restore = installResolveStub({
    '../db': { pool: {} },
    '../stores/configStore': fakeConfig,
    '../stores/notificationStore': { createNotification: async (n) => { notified.push(n.userId); } },
});
const job = require('./learningNudge');
after(() => restore());

function seed(n) {
    store.clear(); notified.length = 0;
    // one existing marker so the job is not in first-run (seeding) mode
    store.set(`${job.MARKER_PREFIX}someone`, new Date(NOW - DAY).toISOString());
    for (let i = 0; i < n; i++) store.set(`learning_progress_user_u${String(i).padStart(4, '0')}`, lapsed);
}

test('BFSF-418: learners beyond the first 500 keys are still reached', async () => {
    seed(620);
    let total = 0;
    for (let tick = 0; tick < 20 && total < 620; tick++) {
        const r = await job.run({ now: NOW });
        assert.ok(r.notified <= job.MAX_NUDGES_PER_TICK);
        total += r.notified;
    }
    assert.equal(total, 620);
    assert.ok(notified.includes('u0619'));
    assert.equal(new Set(notified).size, 620, 'nobody is nudged twice');
});

test('a tick never sends more than MAX_NUDGES_PER_TICK notifications', async () => {
    seed(120);
    const r = await job.run({ now: NOW });
    assert.equal(r.notified, job.MAX_NUDGES_PER_TICK);
});
