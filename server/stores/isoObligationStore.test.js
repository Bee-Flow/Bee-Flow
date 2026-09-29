/**
 * ISO obligation store tests — recur-roll on completion, field whitelisting,
 * reminder-tier arithmetic, markNotified params.
 * Fake db injected via require.cache (same pattern as soaStore.test.js).
 *
 * Run: cd server && node --test stores/isoObligationStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const calls = { run: [], getOne: [], getAll: [] };
let oneResult = null;
let allResult = [];

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => { calls.run.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async (sql, params) => { calls.getOne.push({ sql, params }); return oneResult; },
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return allResult; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./isoObligationStore');

const DAY_MS = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

beforeEach(() => {
    calls.run.length = 0;
    calls.getOne.length = 0;
    calls.getAll.length = 0;
    oneResult = null;
    allResult = [];
});

test('completeObligation stamps who/when and recurs with the due date rolled forward', async () => {
    oneResult = {
        id: 5, organization_id: 'orgA', kind: 'internal_audit', subject: 'isms',
        title: 'Internal ISMS audit', owner_user_id: 'zoe',
        due_at: '2026-08-15T09:00:00.000Z', recur_months: 12,
        notify_offsets: [30, 7, 0], last_notified_offset: 7, completed_at: null,
    };
    await store.completeObligation('orgA', 5, 'actor1');

    const update = calls.run.find(c => c.sql.includes('completed_at = NOW()'));
    assert.ok(update, 'completion UPDATE issued');
    assert.deepEqual(update.params, ['orgA', 5, 'actor1']);
    assert.ok(update.sql.includes('completed_at IS NULL'), 'completion never re-stamps');

    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_obligations'));
    assert.ok(insert, 'next occurrence inserted');
    assert.ok(insert.sql.includes('ON CONFLICT DO NOTHING'), 'respects the open-unique index');
    // [orgId, kind, subject, title, owner, due_at, recur, offsets, actor]
    assert.deepEqual(insert.params.slice(0, 5), ['orgA', 'internal_audit', 'isms', 'Internal ISMS audit', 'zoe']);
    assert.strictEqual(insert.params[5].toISOString(), '2027-08-15T09:00:00.000Z', 'due_at rolled by recur_months');
    assert.strictEqual(insert.params[6], 12);
    assert.deepEqual(JSON.parse(insert.params[7]), [30, 7, 0]);
    assert.ok(insert.sql.includes('NULL'), 'last_notified_offset reset for the new occurrence');
});

test('completeObligation without recur_months inserts nothing', async () => {
    oneResult = {
        id: 6, organization_id: 'orgA', kind: 'pentest', subject: '',
        title: 'One-off pentest', due_at: '2026-09-01T00:00:00.000Z',
        recur_months: null, notify_offsets: [30, 7, 0], completed_at: null,
    };
    await store.completeObligation('orgA', 6, 'actor1');
    assert.strictEqual(calls.run.length, 1, 'only the completion UPDATE runs');
    assert.ok(!calls.run.some(c => c.sql.includes('INSERT INTO')), 'no next occurrence');
});

test('updateObligation whitelists fields, keeps kind, resets tiers when due_at moves', async () => {
    oneResult = {
        id: 7, organization_id: 'orgA', kind: 'policy_review', subject: 'acceptable-use',
        title: 'Review AUP', owner_user_id: 'jan', due_at: '2026-08-01T00:00:00.000Z',
        recur_months: 12, notify_offsets: [30, 7, 0], last_notified_offset: 30, completed_at: null,
    };
    await store.updateObligation('orgA', 7, {
        title: 'Review AUP v2',
        due_at: '2026-10-01T00:00:00.000Z',
        recur_months: 'not-a-number',
        kind: 'pentest',
        completed_at: '2026-01-01T00:00:00.000Z',
        evil_field: 'DROP TABLE',
    }, 'actor2');
    const update = calls.run.find(c => c.sql.includes('UPDATE iso_obligations'));
    assert.ok(update, 'UPDATE issued');
    assert.ok(!update.sql.includes('evil_field'), 'unknown fields never reach SQL');
    assert.ok(!update.sql.includes('kind ='), 'kind is not editable');
    assert.ok(!update.sql.includes('completed_at ='), 'completion stamps only via completeObligation');
    // [orgId, id, subject, title, owner, due_at, recur, offsets, last_notified_offset]
    assert.deepEqual(update.params.slice(0, 5), ['orgA', 7, 'acceptable-use', 'Review AUP v2', 'jan']);
    assert.strictEqual(update.params[5].toISOString(), '2026-10-01T00:00:00.000Z');
    assert.strictEqual(update.params[6], null, 'invalid recur_months rejected to null');
    assert.strictEqual(update.params[8], null, 'due_at change resets last_notified_offset');
});

test('updateObligation keeps last_notified_offset when due_at is untouched', async () => {
    oneResult = {
        id: 8, organization_id: 'orgA', kind: 'training', subject: '',
        title: 'Awareness training', owner_user_id: null, due_at: '2026-08-01T00:00:00.000Z',
        recur_months: 12, notify_offsets: [30, 7, 0], last_notified_offset: 7, completed_at: null,
    };
    await store.updateObligation('orgA', 8, { owner_user_id: 'zoe' }, 'actor2');
    const update = calls.run.find(c => c.sql.includes('UPDATE iso_obligations'));
    assert.strictEqual(update.params[4], 'zoe');
    assert.strictEqual(update.params[8], 7, 'reminder progress preserved');
});

test('createObligation falls back to custom kind and default offsets', async () => {
    await store.createObligation('orgA', {
        kind: 'wild-kind',
        title: 'Something bespoke',
        due_at: '2026-12-01T00:00:00.000Z',
        notify_offsets: 'nonsense',
        evil_field: 'DROP TABLE',
    }, 'actor3');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_obligations'));
    assert.ok(insert, 'INSERT issued');
    assert.ok(!insert.sql.includes('evil_field'));
    assert.strictEqual(insert.params[1], 'custom', 'unknown kind rejected to custom');
    assert.deepEqual(JSON.parse(insert.params[7]), [30, 7, 0], 'default reminder tiers');
    assert.strictEqual(insert.params[8], 'actor3');
});

test('listDueForNotification applies the shrinking-tier logic in JS', async () => {
    const base = {
        organization_id: 'orgA', kind: 'policy_review', subject: '', title: 't',
        owner_user_id: null, notify_offsets: [30, 7, 0],
    };
    allResult = [
        { ...base, id: 1, due_at: inDays(20), last_notified_offset: null }, // 30d window open, nothing sent → 30
        { ...base, id: 2, due_at: inDays(20), last_notified_offset: 30 },   // 30 already sent, 7 not reached → skip
        { ...base, id: 3, due_at: inDays(5), last_notified_offset: 30 },    // inside 7d window → 7
        { ...base, id: 4, due_at: inDays(-2), last_notified_offset: 7 },    // overdue → 0
        { ...base, id: 5, due_at: inDays(45), last_notified_offset: null }, // before any window → skip
        { ...base, id: 6, due_at: inDays(-1), last_notified_offset: 0 },    // final tier already sent → skip
        { ...base, id: 7, due_at: inDays(2), last_notified_offset: null, notify_offsets: null }, // defaults → 7
    ];
    const due = await store.listDueForNotification();
    assert.deepEqual(due.map(d => [d.id, d.notify_offset]), [[1, 30], [3, 7], [4, 0], [7, 7]]);

    const sql = calls.getAll[0].sql;
    assert.ok(sql.includes('completed_at IS NULL'), 'broad SELECT covers open rows only');
    assert.ok(sql.includes("INTERVAL '60 days'"), 'broad SELECT sweeps the 60-day horizon');
});

test('markNotified updates the tier by id', async () => {
    await store.markNotified(42, 7);
    const update = calls.run.find(c => c.sql.includes('last_notified_offset = $2'));
    assert.ok(update, 'UPDATE issued');
    assert.deepEqual(update.params, [42, 7]);
});

test('getStats returns zeroed shape when the org has no rows', async () => {
    oneResult = null;
    const stats = await store.getStats('orgA');
    assert.deepEqual(stats, { open: 0, overdue: 0, due_30d: 0 });
});
