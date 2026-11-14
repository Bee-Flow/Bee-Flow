// @typecheck
/**
 * ISO obligation store tests — recur-roll on completion, field whitelisting,
 * reminder-tier arithmetic, markNotified — against a real Postgres (PGlite
 * behind db.js's pool, testUtils/pglitePool.js) with the store's own schema.
 *
 * Run: cd server && node --test stores/isoObligationStore.test.js
 */

const { test, beforeEach, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const store = require('./isoObligationStore');

const DAY_MS = 86400000;
const inDays = (/** @type {number} */ n) => new Date(Date.now() + n * DAY_MS).toISOString();

before(async () => { await store.initDB(); });
after(close);
beforeEach(async () => { await pg.exec('TRUNCATE iso_obligations RESTART IDENTITY'); });

/** @param {Record<string, unknown>} over */
const seed = (over) => insertRow(pg, 'iso_obligations', {
    organization_id: 'orgA', kind: 'custom', subject: '', title: 't', due_at: inDays(10), ...over,
});
/** @param {string} where @param {unknown[]} [params] */
const rows = async (where = 'TRUE', params = []) => (await pg.query(`SELECT * FROM iso_obligations WHERE ${where} ORDER BY id`, params)).rows;

test('completeObligation stamps who/when and recurs with the due date rolled forward', async () => {
    const o = await seed({
        kind: 'internal_audit', subject: 'isms', title: 'Internal ISMS audit', owner_user_id: 'zoe',
        due_at: '2026-08-15T09:00:00.000Z', recur_months: 12, notify_offsets: [30, 7, 0], last_notified_offset: 7,
    });
    const out = await store.completeObligation('orgA', o.id, 'actor1');
    const [done, next] = await rows();
    assert.ok(done.completed_at, 'completion stamped');
    assert.strictEqual(done.completed_by, 'actor1');
    assert.ok(next, 'next occurrence inserted');
    assert.deepEqual([next.organization_id, next.kind, next.subject, next.title, next.owner_user_id],
        ['orgA', 'internal_audit', 'isms', 'Internal ISMS audit', 'zoe']);
    assert.strictEqual(new Date(next.due_at).toISOString(), '2027-08-15T09:00:00.000Z', 'due_at rolled by recur_months');
    assert.strictEqual(next.recur_months, 12);
    assert.deepEqual(next.notify_offsets, [30, 7, 0]);
    assert.strictEqual(next.last_notified_offset, null, 'last_notified_offset reset for the new occurrence');
    assert.strictEqual(next.completed_at, null);
    assert.strictEqual(next.created_by, 'actor1');
    assert.strictEqual(out?.next?.id, next.id);

    // Completing again never re-stamps the completion.
    const stamp = done.completed_at;
    await pg.query("UPDATE iso_obligations SET completed_by = 'kept' WHERE id = $1", [o.id]);
    const again = await store.completeObligation('orgA', o.id, 'actor2');
    assert.strictEqual(again?.next, null);
    const [same] = await rows('id = $1', [o.id]);
    assert.strictEqual(same.completed_by, 'kept');
    assert.deepStrictEqual(same.completed_at, stamp);
    assert.strictEqual((await rows()).length, 2, 'no third occurrence');
});

test('completeObligation respects the open-unique index: an open duplicate created meanwhile wins, no error', async () => {
    const o = await seed({ kind: 'pentest', subject: 's', due_at: '2026-08-15T09:00:00.000Z', recur_months: 6 });
    // Someone re-creates the open obligation by hand between the completion UPDATE and the roll INSERT.
    const db = require('../db');
    const saved = db.pool.query;
    db.pool.query = /** @type {any} */ (async (/** @type {any} */ sql, /** @type {any} */ params) => {
        const out = await saved(sql, params);
        if (String(sql).includes('completed_at = NOW()')) await seed({ kind: 'pentest', subject: 's', title: 'by hand' });
        return out;
    });
    let out;
    try { out = await store.completeObligation('orgA', o.id, 'actor1'); } finally { db.pool.query = saved; }
    assert.strictEqual(out?.next, null, 'the roll stood back');
    const open = await rows('completed_at IS NULL');
    assert.deepEqual(open.map(r => r.title), ['by hand']);
});

test('completeObligation without recur_months inserts nothing', async () => {
    const o = await seed({ kind: 'pentest', title: 'One-off pentest', due_at: '2026-09-01T00:00:00.000Z', recur_months: null });
    const out = await store.completeObligation('orgA', o.id, 'actor1');
    assert.strictEqual(out?.next, null);
    const all = await rows();
    assert.strictEqual(all.length, 1, 'no next occurrence');
    assert.ok(all[0].completed_at);
});

test('completeObligation of another org\'s obligation touches nothing', async () => {
    const o = await seed({ organization_id: 'orgB', recur_months: 1 });
    assert.strictEqual(await store.completeObligation('orgA', o.id, 'actor1'), null);
    const [row] = await rows();
    assert.strictEqual(row.completed_at, null);
});

test('updateObligation whitelists fields, keeps kind, resets tiers when due_at moves', async () => {
    const o = await seed({
        kind: 'policy_review', subject: 'acceptable-use', title: 'Review AUP', owner_user_id: 'jan',
        due_at: '2026-08-01T00:00:00.000Z', recur_months: 12, notify_offsets: [30, 7, 0], last_notified_offset: 30,
    });
    const out = await store.updateObligation('orgA', o.id, /** @type {any} */ ({
        title: 'Review AUP v2',
        due_at: '2026-10-01T00:00:00.000Z',
        recur_months: 'not-a-number',
        kind: 'pentest',
        completed_at: '2026-01-01T00:00:00.000Z',
        evil_field: 'DROP TABLE',
    }), 'actor2');
    const [row] = await rows();
    assert.strictEqual(row.kind, 'policy_review', 'kind is not editable');
    assert.strictEqual(row.completed_at, null, 'completion stamps only via completeObligation');
    assert.deepEqual([row.subject, row.title, row.owner_user_id], ['acceptable-use', 'Review AUP v2', 'jan']);
    assert.strictEqual(new Date(row.due_at).toISOString(), '2026-10-01T00:00:00.000Z');
    assert.strictEqual(row.recur_months, null, 'invalid recur_months rejected to null');
    assert.strictEqual(row.last_notified_offset, null, 'due_at change resets last_notified_offset');
    assert.strictEqual(out?.title, 'Review AUP v2', 'returns the updated row');
});

test('updateObligation keeps last_notified_offset when due_at is untouched', async () => {
    const o = await seed({ kind: 'training', title: 'Awareness training', due_at: '2026-08-01T00:00:00.000Z', recur_months: 12, last_notified_offset: 7 });
    await store.updateObligation('orgA', o.id, { owner_user_id: 'zoe' }, 'actor2');
    const [row] = await rows();
    assert.strictEqual(row.owner_user_id, 'zoe');
    assert.strictEqual(row.last_notified_offset, 7, 'reminder progress preserved');
    assert.strictEqual(row.recur_months, 12);
});

test('updateObligation of another org\'s obligation returns null and writes nothing', async () => {
    const o = await seed({ organization_id: 'orgB', title: 'theirs' });
    assert.strictEqual(await store.updateObligation('orgA', o.id, { title: 'mine' }), null);
    assert.strictEqual((await rows())[0].title, 'theirs');
});

test('createObligation falls back to custom kind and default offsets', async () => {
    const row = await store.createObligation('orgA', /** @type {any} */ ({
        kind: 'wild-kind',
        title: 'Something bespoke',
        due_at: '2026-12-01T00:00:00.000Z',
        notify_offsets: 'nonsense',
        evil_field: 'DROP TABLE',
    }), 'actor3');
    assert.ok(row);
    assert.strictEqual(row.kind, 'custom', 'unknown kind rejected to custom');
    assert.deepEqual(row.notify_offsets, [30, 7, 0], 'default reminder tiers');
    assert.strictEqual(row.created_by, 'actor3');
    assert.ok(!('evil_field' in row));
});

test('listDueForNotification: open rows within 60 days, then the shrinking-tier logic in JS', async () => {
    const base = { kind: 'policy_review', notify_offsets: [30, 7, 0] };
    const ids = [];
    ids.push((await seed({ ...base, subject: '1', due_at: inDays(20), last_notified_offset: null })).id); // 30d window open → 30
    ids.push((await seed({ ...base, subject: '2', due_at: inDays(20), last_notified_offset: 30 })).id);   // 30 sent, 7 not reached → skip
    ids.push((await seed({ ...base, subject: '3', due_at: inDays(5), last_notified_offset: 30 })).id);    // inside 7d → 7
    ids.push((await seed({ ...base, subject: '4', due_at: inDays(-2), last_notified_offset: 7 })).id);    // overdue → 0
    ids.push((await seed({ ...base, subject: '5', due_at: inDays(45), last_notified_offset: null })).id); // before any window → skip
    ids.push((await seed({ ...base, subject: '6', due_at: inDays(-1), last_notified_offset: 0 })).id);    // final tier sent → skip
    ids.push((await seed({ ...base, subject: '7', due_at: inDays(2), last_notified_offset: null, notify_offsets: [] })).id); // defaults → 7
    await seed({ ...base, subject: 'done', due_at: inDays(1), completed_at: inDays(-1) });              // completed: not swept
    await seed({ ...base, subject: 'far', due_at: inDays(90), notify_offsets: [365] });                 // beyond the 60-day horizon
    const due = await store.listDueForNotification();
    const label = new Map(ids.map((id, i) => [id, i + 1]));
    assert.deepEqual(due.map(d => [label.get(d.id), d.notify_offset]).sort((a, b) => Number(a[0]) - Number(b[0])),
        [[1, 30], [3, 7], [4, 0], [7, 7]]);
});

test('markNotified updates the tier by id', async () => {
    const o = await seed({});
    const other = await seed({ subject: 'other' });
    await store.markNotified(o.id, 7);
    const all = await rows();
    assert.strictEqual(all.find(r => r.id === o.id).last_notified_offset, 7);
    assert.strictEqual(all.find(r => r.id === other.id).last_notified_offset, null);
});

test('getStats returns zeroed shape when the org has no rows, and counts open/overdue/due-30d', async () => {
    assert.deepEqual(await store.getStats('orgA'), { open: 0, overdue: 0, due_30d: 0 });
    await seed({ subject: 'a', due_at: inDays(-3) });
    await seed({ subject: 'b', due_at: inDays(10) });
    await seed({ subject: 'c', due_at: inDays(50) });
    await seed({ subject: 'd', due_at: inDays(5), completed_at: inDays(0) });
    await seed({ organization_id: 'orgB', subject: 'e', due_at: inDays(5) });
    assert.deepEqual(await store.getStats('orgA'), { open: 3, overdue: 1, due_30d: 1 });
});
