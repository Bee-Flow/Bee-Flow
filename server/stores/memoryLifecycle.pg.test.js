'use strict';

/**
 * memoryLifecycle against a real Postgres (pglite, in-process). The module
 * takes its db as a parameter, so no module mocking is needed.
 *
 * Run: cd server && node --test stores/memoryLifecycle.pg.test.js
 */

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { createLifecycle } = require('./memoryLifecycle');

const pg = new PGlite();
const db = {
    async run(sql, params) {
        const r = await pg.query(sql, params || []);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
};
const lc = createLifecycle(db);

async function seed(id, over = {}) {
    const r = { user_id: 'u1', project_id: null, type: 'fact', status: 'active', origin: 'inferred', importance: 0.5, ...over };
    await pg.query(
        `INSERT INTO user_memories (id, user_id, project_id, type, status, origin, importance, confidence, created_at, last_used_at, superseded_by, valid_to, key_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0.8, COALESCE($8::timestamptz, NOW()), $9::timestamptz, $10, $11::timestamptz, $12)`,
        [id, r.user_id, r.project_id, r.type, r.status, r.origin, r.importance, r.created_at || null, r.last_used_at || null, r.superseded_by || null, r.valid_to || null, r.key_hash || null]);
}
const row = async (id) => (await pg.query('SELECT * FROM user_memories WHERE id = $1', [id])).rows[0];
const statusOf = async (id) => (await row(id))?.status;

before(async () => {
    await pg.exec(`CREATE TABLE user_memories (
        id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, type TEXT, status TEXT, origin TEXT,
        importance REAL, confidence REAL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ, last_confirmed_at TIMESTAMPTZ, archived_at TIMESTAMPTZ,
        valid_to TIMESTAMPTZ, superseded_by TEXT, key_hash TEXT, agent_id TEXT, replaces_id TEXT)`);
});
beforeEach(async () => { await pg.exec('DELETE FROM user_memories'); });

describe('supersede and its undo', () => {
    test('supersede closes the old row; restorePredecessorOf reopens it', async () => {
        await seed('old'); await seed('new');
        assert.equal(await lc.supersede('old', 'new'), 1);
        const o = await row('old');
        assert.equal(o.status, 'superseded');
        assert.equal(o.superseded_by, 'new');
        assert.ok(o.valid_to);

        assert.equal(await lc.restorePredecessorOf('new'), 1);
        const back = await row('old');
        assert.equal(back.status, 'active');
        assert.equal(back.valid_to, null);
        assert.equal(back.superseded_by, null);
    });

    test('restorePredecessorOf of a row that replaced nothing does nothing, also after the new row is deleted', async () => {
        await seed('a');
        assert.equal(await lc.restorePredecessorOf('a'), 0);
        await seed('old'); await seed('new');
        await lc.supersede('old', 'new');
        assert.equal(await lc.restorePredecessorOf('new'), 1, 'called before the delete');
        await pg.query(`DELETE FROM user_memories WHERE id = 'new'`);
        assert.equal(await statusOf('old'), 'active');
        assert.equal(await lc.restorePredecessorOf('gone'), 0, 'a row that no longer exists restores nothing');
    });

    test('chain A -> B -> C: deleting the superseded middle row reactivates nothing and re-points A at C', async () => {
        await seed('A', { key_hash: 'k' }); await seed('B', { key_hash: 'k' }); await seed('C', { key_hash: 'k' });
        await lc.supersede('A', 'B');
        await lc.supersede('B', 'C');
        assert.equal(await lc.restorePredecessorOf('B'), 0);
        await pg.query(`DELETE FROM user_memories WHERE id = 'B'`);
        const a = await row('A');
        assert.equal(a.status, 'superseded');
        assert.equal(a.superseded_by, 'C');
        assert.equal(await statusOf('C'), 'active');
        const actives = (await pg.query(`SELECT id FROM user_memories WHERE status = 'active'`)).rows;
        assert.deepEqual(actives.map((r) => r.id), ['C']);
    });

    test('the active head C of A -> B -> C: undo brings B back, A stays superseded', async () => {
        await seed('A', { key_hash: 'k' }); await seed('B', { key_hash: 'k' }); await seed('C', { key_hash: 'k' });
        await lc.supersede('A', 'B');
        await lc.supersede('B', 'C');
        assert.equal(await lc.restorePredecessorOf('C'), 1);
        await pg.query(`DELETE FROM user_memories WHERE id = 'C'`);
        assert.equal(await statusOf('B'), 'active');
        assert.equal(await statusOf('A'), 'superseded');
    });

    test('never two active rows for one key: another active row with the key blocks the restore', async () => {
        await seed('old', { key_hash: 'k' }); await seed('new', { key_hash: 'k' });
        await lc.supersede('old', 'new');
        await seed('rival', { key_hash: 'k' });
        assert.equal(await lc.restorePredecessorOf('new'), 0);
        assert.equal(await statusOf('old'), 'superseded');
    });

    test('ownership guard', async () => {
        await seed('old'); await seed('new');
        await lc.supersede('old', 'new');
        assert.equal(await lc.restorePredecessorOf('new', 'someone-else'), 0);
        assert.equal(await statusOf('old'), 'superseded');
    });

    test('only an active row can be superseded', async () => {
        await seed('arch', { status: 'archived' });
        assert.equal(await lc.supersede('arch', 'x'), 0);
    });
});

describe('archive, restore, approve, confirm', () => {
    test('archive then restore', async () => {
        await seed('a'); await seed('b');
        assert.equal(await lc.archive(['a', 'b']), 2);
        assert.equal(await statusOf('a'), 'archived');
        assert.ok((await row('a')).archived_at);
        assert.equal(await lc.restore('a'), 1);
        const a = await row('a');
        assert.equal(a.status, 'active');
        assert.equal(a.archived_at, null);
        assert.equal(await lc.restore('a'), 0, 'only archived rows restore');
    });

    test('archive is user-scoped when asked', async () => {
        await seed('a', { user_id: 'u2' });
        assert.equal(await lc.archive(['a'], 'u1'), 0);
        assert.equal(await statusOf('a'), 'active');
    });

    test('approve moves pending_review to active only', async () => {
        await seed('p', { status: 'pending_review' }); await seed('x', { status: 'archived' });
        assert.equal(await lc.approve('p'), 1);
        assert.equal(await statusOf('p'), 'active');
        assert.equal(await lc.approve('x'), 0);
    });

    test('approve supersedes the active row with the same key in the same scope only', async () => {
        await seed('old', { key_hash: 'k1' });
        await seed('other-user', { key_hash: 'k1', user_id: 'u2' });
        await seed('other-key', { key_hash: 'k2' });
        await seed('new', { status: 'pending_review', key_hash: 'k1' });
        assert.equal(await lc.approve('new'), 1);
        assert.equal(await statusOf('new'), 'active');
        const old = await row('old');
        assert.equal(old.status, 'superseded');
        assert.equal(old.superseded_by, 'new');
        assert.ok(old.valid_to);
        assert.equal(await statusOf('other-user'), 'active');
        assert.equal(await statusOf('other-key'), 'active');
    });

    test('approve supersedes the row named in replaces_id (pending row parked against an explicit memory, no key)', async () => {
        await seed('explicit', { origin: 'explicit' });
        await seed('bystander');
        await seed('pend', { status: 'pending_review' });
        await pg.query(`UPDATE user_memories SET replaces_id = 'explicit' WHERE id = 'pend'`);
        assert.equal(await lc.approve('pend'), 1);
        const actives = (await pg.query(`SELECT id FROM user_memories WHERE status = 'active' ORDER BY id`)).rows.map((r) => r.id);
        assert.deepEqual(actives, ['bystander', 'pend']);
        const old = await row('explicit');
        assert.equal(old.status, 'superseded');
        assert.equal(old.superseded_by, 'pend');
    });

    test('approve with replaces_id of another user does nothing to that row', async () => {
        await seed('theirs', { user_id: 'u2' });
        await seed('pend', { status: 'pending_review' });
        await pg.query(`UPDATE user_memories SET replaces_id = 'theirs' WHERE id = 'pend'`);
        await lc.approve('pend');
        assert.equal(await statusOf('theirs'), 'active');
    });

    test('confirm adds confidence, capped at 1', async () => {
        await seed('a');
        await lc.confirm('a');
        const a = await row('a');
        assert.ok(Math.abs(a.confidence - 0.85) < 1e-6);
        assert.ok(a.last_confirmed_at);
        await pg.query(`UPDATE user_memories SET confidence = 0.99 WHERE id = 'a'`);
        await lc.confirm('a');
        assert.equal((await row('a')).confidence, 1);
    });
});

describe('enforceCap', () => {
    const active = async () => (await pg.query(`SELECT id FROM user_memories WHERE status = 'active' ORDER BY id`)).rows.map((r) => r.id);

    test('archives the lowest-value inferred rows beyond the cap', async () => {
        await seed('low', { importance: 0.1 });
        await seed('mid', { importance: 0.5 });
        await seed('high', { importance: 0.9 });
        assert.equal(await lc.enforceCap('u1', 2), 1);
        assert.deepEqual(await active(), ['high', 'mid']);
        assert.equal(await lc.enforceCap('u1', 2), 0, 'idempotent');
    });

    test('recency counts: a long-unused row loses to a fresh one of equal importance', async () => {
        await seed('stale', { importance: 0.5, created_at: '2020-01-01T00:00:00Z' });
        await seed('fresh', { importance: 0.5 });
        await lc.enforceCap('u1', 1);
        assert.deepEqual(await active(), ['fresh']);
    });

    test('explicit rows and instructions are never archived, even over the cap', async () => {
        await seed('e', { origin: 'explicit', importance: 0 });
        await seed('i', { type: 'instruction', importance: 0 });
        await seed('x', { importance: 0.9 });
        await lc.enforceCap('u1', 1);
        assert.deepEqual(await active(), ['e', 'i']);
    });

    test('other users and project pools are untouched', async () => {
        await seed('a', { importance: 0.1 }); await seed('b', { importance: 0.2 });
        await seed('o', { user_id: 'u2', importance: 0.1 });
        await seed('p', { project_id: 'p1', importance: 0.1 });
        await lc.enforceCap('u1', 1);
        assert.deepEqual(await active(), ['b', 'o', 'p']);
    });

    test('a bad cap does nothing', async () => {
        await seed('a');
        assert.equal(await lc.enforceCap('u1', NaN), 0);
        assert.equal(await lc.enforceCap('', 1), 0);
    });
});
