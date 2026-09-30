/**
 * The project store's change feed (stores/projectChanges.js) against a real
 * Postgres (@electric-sql/pglite): the store is `makeProjectStore` over a
 * pglite facade and the schema is its own `applyProjectSchema`, so what runs
 * here is the production SQL with no module replaced.
 *
 * Pinned:
 *   - the schema applies twice, and a row from before the change feed still
 *     reads (actor kind 'user', updatedAt = createdAt);
 *   - the audit row and its event are written together with ONE seq, and
 *     nothing is written for a project that is gone;
 *   - an editing session folds saves of one person on one item into one row,
 *     re-emits only when the last event is old enough, and starts a new row
 *     after a pause or for another person;
 *   - a visit after a pause moves the "last visit" line, a ping inside a
 *     visit does not; "mark all seen" and per-item reads are recorded, the
 *     latter with the latest version when none is given;
 *   - the change rows leave out the reader's own changes and anything
 *     outside the window, and include filing of followed item kinds only;
 *   - erasure removes a member's marks; old events are pruned;
 *   - a cursor into a pruned stretch is told to resync (once), never handed
 *     the survivors as if nothing were missing.
 *
 * Run: cd server && node --test stores/projectChanges.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { makeProjectStore, applyProjectSchema } = require('./projectStore');

function asPgResult(r) {
    const rows = r.rows || [];
    return { rows, rowCount: typeof r.affectedRows === 'number' ? r.affectedRows : rows.length };
}

function facadeFor(pg) {
    const query = async (sql, params) => asPgResult(
        params && params.length ? await pg.query(sql, params) : await pg.query(sql),
    );
    return {
        run: query,
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        getClient: async () => ({ query, release() {} }),
        exec: (sql) => pg.exec(sql),
    };
}

async function applySchema(pg) {
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (_tag, statements) => {
            for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
        },
    });
}

let pg;
let store;

before(async () => {
    pg = new PGlite();
    await applySchema(pg);
    await applySchema(pg);
    store = makeProjectStore(facadeFor(pg));
});

after(async () => { await pg.close(); });

async function newProject(name = 'P') {
    const p = await store.createProject({ name, ownerId: 'owner' });
    return p.id;
}

const count = async (sql, params) => Number((await pg.query(sql, params)).rows[0].n);

/** Move a row's clock back, the way a pause would. */
async function age(table, where, params, minutes, cols) {
    const sets = cols.map((c) => `${c} = ${c} - INTERVAL '${minutes} minutes'`).join(', ');
    await pg.query(`UPDATE ${table} SET ${sets} WHERE ${where}`, params);
}

const edit = (overrides = {}) => ({
    itemType: 'document',
    itemId: 'd1',
    actorId: 'anna',
    actorKind: 'user',
    versionId: 'v1',
    sessionGapMs: 10 * 60 * 1000,
    emitEveryMs: 2 * 60 * 1000,
    merge: (prev) => ({ changes: (prev?.changes || 0) + 1 }),
    eventOf: (details, activityId) => ({ kind: 'content.edited', payload: { activityId, changes: details.changes } }),
    ...overrides,
});

test('a row from before the change feed still reads', async () => {
    const pid = await newProject();
    await pg.query(
        `INSERT INTO project_activity (id, project_id, actor_id, action, details, created_at, updated_at)
         VALUES ('old1', $1, 'anna', 'member_added', '{}', NOW() - INTERVAL '1 day', NULL)`,
        [pid],
    );
    const [row] = await store.listActivity(pid, 10, 0);
    assert.strictEqual(row.actorKind, 'user');
    assert.strictEqual(row.itemId, null);
    assert.deepStrictEqual(row.updatedAt, row.createdAt);
});

test('writes the audit row and its event together, with one seq', async () => {
    const pid = await newProject();
    const out = await store.recordActivityEvent(pid, {
        action: 'member_added', actorId: 'owner', targetType: 'user', targetId: 'bob', details: { role: 'editor' },
    });
    assert.ok(out.activityId);
    assert.strictEqual(out.event.seq, 1);
    assert.strictEqual(out.event.kind, 'member_added');
    const ev = (await pg.query('SELECT * FROM project_events WHERE project_id = $1', [pid])).rows;
    const act = (await pg.query('SELECT * FROM project_activity WHERE project_id = $1', [pid])).rows;
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(act.length, 1);
    assert.strictEqual(Number(act[0].seq), Number(ev[0].seq));
    assert.deepStrictEqual(ev[0].payload, { role: 'editor' });

    assert.strictEqual(await store.recordActivityEvent('gone', { action: 'member_added', actorId: 'x' }), null);
    assert.strictEqual(await count(`SELECT COUNT(*) AS n FROM project_activity WHERE project_id = 'gone'`), 0);
    assert.strictEqual(await store.recordActivityEvent(pid, { actorId: 'x' }), null);
});

test('folds the saves of one person on one item into one session row', async () => {
    const pid = await newProject();
    const first = await store.recordContentSession(pid, edit());
    assert.strictEqual(first.folded, false);
    assert.strictEqual(first.event.seq, 1);
    assert.deepStrictEqual(first.event.payload, { activityId: first.activityId, changes: 1 });

    // A second save a moment later: same row, no new event (emitted recently).
    const second = await store.recordContentSession(pid, edit({ versionId: 'v2' }));
    assert.strictEqual(second.folded, true);
    assert.strictEqual(second.activityId, first.activityId);
    assert.strictEqual(second.event, null);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_events WHERE project_id = $1', [pid]), 1);

    // Once the last event is older than emitEveryMs, the next fold re-emits and re-stamps seq.
    await age('project_activity', 'id = $1', [first.activityId], 3, ['emitted_at']);
    const third = await store.recordContentSession(pid, edit({ versionId: 'v3' }));
    assert.strictEqual(third.folded, true);
    assert.strictEqual(third.event.seq, 2);
    const row = (await pg.query('SELECT * FROM project_activity WHERE id = $1', [first.activityId])).rows[0];
    assert.deepStrictEqual(row.details, { changes: 3 });
    assert.strictEqual(row.version_id, 'v3');
    assert.strictEqual(Number(row.seq), 2);
    assert.strictEqual(row.action, 'content.edited');
    assert.strictEqual(row.item_type, 'document');
    assert.strictEqual(row.target_id, 'd1');

    // Another person on the same item: their own row.
    const bob = await store.recordContentSession(pid, edit({ actorId: 'bob' }));
    assert.strictEqual(bob.folded, false);
    assert.notStrictEqual(bob.activityId, first.activityId);

    // The AI on nobody's behalf: its own row, actor NULL.
    const ai = await store.recordContentSession(pid, edit({ actorId: null, actorKind: 'ai' }));
    assert.strictEqual(ai.folded, false);
    const again = await store.recordContentSession(pid, edit({ actorId: null, actorKind: 'ai' }));
    assert.strictEqual(again.activityId, ai.activityId);

    // After a pause longer than the session gap, a new session starts.
    await age('project_activity', 'id = $1', [first.activityId], 11, ['updated_at', 'created_at', 'emitted_at']);
    const later = await store.recordContentSession(pid, edit());
    assert.strictEqual(later.folded, false);
    assert.notStrictEqual(later.activityId, first.activityId);

    assert.strictEqual(await store.recordContentSession('gone', edit()), null);
});

test('a failing merge writes nothing', async () => {
    const pid = await newProject();
    const out = await store.recordContentSession(pid, edit({ merge: () => { throw new Error('boom'); } }));
    assert.strictEqual(out, null);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_activity WHERE project_id = $1', [pid]), 0);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_events WHERE project_id = $1', [pid]), 0);
});

test('a visit after a pause moves the last-visit line; a ping inside a visit does not', async () => {
    const pid = await newProject();
    const first = await store.recordVisit(pid, 'vera');
    assert.strictEqual(first.prevVisitAt, null);
    assert.ok(first.firstVisitAt);
    assert.ok(first.visitStartedAt);

    const ping = await store.recordVisit(pid, 'vera');
    assert.strictEqual(ping.prevVisitAt, null);
    assert.strictEqual(ping.visitStartedAt, first.visitStartedAt);

    await store.recordActivityEvent(pid, { action: 'kb_added', actorId: 'owner' });
    await age('project_member_state', 'project_id = $1 AND user_id = $2', [pid, 'vera'], 45, ['last_visit_at', 'visit_started_at']);
    const aged = await store.getMemberState(pid, 'vera');
    const next = await store.recordVisit(pid, 'vera');
    assert.strictEqual(next.prevVisitAt, aged.lastVisitAt);
    assert.strictEqual(next.prevVisitSeq, 0);
    assert.ok(Date.parse(next.visitStartedAt) > Date.parse(aged.visitStartedAt));

    assert.strictEqual(await store.recordVisit('gone', 'vera'), null);
    assert.strictEqual(await store.recordVisit(pid, ''), null);
});

test('records "mark everything as seen" and what a member last saw of an item', async () => {
    const pid = await newProject();
    await store.recordActivityEvent(pid, { action: 'kb_added', actorId: 'owner' });
    const seen = await store.markAllSeen(pid, 'vera');
    assert.ok(seen.seenAt);
    assert.strictEqual(seen.seenSeq, 1);

    await store.recordContentSession(pid, edit({ itemId: 'd9', versionId: 'v-latest' }));
    const implicit = await store.markItemSeen(pid, 'vera', 'document', 'd9');
    assert.strictEqual(implicit.seenVersionId, 'v-latest');
    const explicit = await store.markItemSeen(pid, 'vera', 'document', 'd9', 'v-shown');
    assert.strictEqual(explicit.seenVersionId, 'v-shown');
    const kept = await store.markItemSeen(pid, 'vera', 'notebook', 'n-without-versions');
    assert.strictEqual(kept.seenVersionId, null);

    const reads = await store.listItemReads(pid, 'vera', [{ type: 'document', id: 'd9' }, { type: 'notebook', id: 'nope' }]);
    assert.deepStrictEqual([...reads.keys()], ['document:d9']);
    assert.strictEqual(reads.get('document:d9').seenVersionId, 'v-shown');
    assert.strictEqual((await store.listItemReads(pid, 'vera', [])).size, 0);
});

test('lists change rows without the reader’s own, inside the window, for followed kinds only', async () => {
    const pid = await newProject();
    const since = new Date(Date.now() - 60_000).toISOString();
    await store.recordContentSession(pid, edit({ actorId: 'anna', itemId: 'd1' }));
    await store.recordContentSession(pid, edit({ actorId: 'vera', itemId: 'd1' }));
    await store.recordActivityEvent(pid, { action: 'resource_added', actorId: 'bob', targetType: 'notebook', targetId: 'n1', details: {} });
    await store.recordActivityEvent(pid, { action: 'resource_added', actorId: 'bob', targetType: 'automation', targetId: 'a1', details: {} });
    await store.recordActivityEvent(pid, { action: 'member_added', actorId: 'bob', targetType: 'user', targetId: 'x', details: {} });
    const old = await store.recordContentSession(pid, edit({ actorId: 'carl', itemId: 'd2' }));
    await age('project_activity', 'id = $1', [old.activityId], 90, ['updated_at', 'created_at']);

    const rows = await store.listChangeRows(pid, { sinceAt: since, excludeActorId: 'vera' });
    assert.deepStrictEqual(rows.map((r) => [r.action, r.actorId, r.itemId || r.targetId]).sort(), [
        ['content.edited', 'anna', 'd1'],
        ['resource_added', 'bob', 'n1'],
    ]);
    assert.deepStrictEqual(await store.listChangeRows(pid, {}), []);

    const log = await store.listChangeLog(pid, { limit: 10 });
    assert.deepStrictEqual(log.map((r) => r.actorId).sort(), ['anna', 'bob', 'carl', 'vera']);
    assert.strictEqual((await store.listChangeLog(pid, { limit: 2, offset: 0 })).length, 2);
});

test('erasure removes a member’s marks; old events are pruned', async () => {
    const pid = await newProject();
    await store.recordVisit(pid, 'erased');
    await store.markItemSeen(pid, 'erased', 'document', 'd1');
    assert.deepStrictEqual(await store.eraseUserChangeState('erased'), { memberState: 1, itemReads: 1 });
    assert.strictEqual(await store.getMemberState(pid, 'erased'), null);

    await store.recordActivityEvent(pid, { action: 'kb_added', actorId: 'owner' });
    await pg.query(`UPDATE project_events SET created_at = NOW() - INTERVAL '8 days' WHERE project_id = $1`, [pid]);
    assert.ok(await store.pruneProjectEvents(7) >= 1);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_events WHERE project_id = $1', [pid]), 0);
    // The audit row stays.
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_activity WHERE project_id = $1', [pid]), 1);
});

test('a reader whose cursor points into a pruned stretch is told to resync, once', async () => {
    const pid = await newProject();
    for (let i = 0; i < 4; i += 1) await store.recordActivityEvent(pid, { action: 'kb_added', actorId: 'owner' });
    const all = (await store.listProjectEvents(pid, 0)).events.map((e) => e.seq);
    assert.deepStrictEqual((await store.listProjectEvents(pid, all[1])).truncated, false, 'no hole: a plain replay');

    // A tab hidden for more than a week: its cursor sits at the first event,
    // and the prune took the next two.
    await pg.query('DELETE FROM project_events WHERE project_id = $1 AND seq = ANY($2::bigint[])', [pid, [all[1], all[2]]]);
    const survivors = await store.listProjectEvents(pid, all[0]);
    assert.deepStrictEqual(survivors.events.map((e) => e.seq), [all[3]]);
    assert.strictEqual(survivors.truncated, true, 'the survivors come with a resync');

    // Everything after the cursor pruned, nothing new since: one durable
    // resync at the head, so the cursor moves past the hole.
    await pg.query('DELETE FROM project_events WHERE project_id = $1', [pid]);
    const gone = await store.listProjectEvents(pid, all[0]);
    assert.deepStrictEqual(gone.events.map((e) => [e.kind, e.seq]), [['resync', all[3]]]);
    assert.strictEqual(gone.truncated, false);
    assert.deepStrictEqual(await store.listProjectEvents(pid, all[3]), { events: [], truncated: false }, 'at the head: nothing more');
    assert.deepStrictEqual((await store.listProjectEvents(pid, 0)).events, [], 'a new reader starts at the head anyway');
    assert.deepStrictEqual(await store.listProjectEvents('no-such-project', 3), { events: [], truncated: false });
});

test('deleting the project takes its marks with it', async () => {
    const pid = await newProject();
    await store.recordVisit(pid, 'vera');
    await store.markItemSeen(pid, 'vera', 'document', 'd1');
    await store.deleteProject(pid);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_member_state WHERE project_id = $1', [pid]), 0);
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM project_item_reads WHERE project_id = $1', [pid]), 0);
});
