/**
 * project_tasks against a real Postgres (@electric-sql/pglite, in-process),
 * through makeProjectTaskStore.
 *
 * Proven: the DDL runs twice; a task is found only through its own project;
 * moving to done stamps completedAt and moving away clears it; only the keys
 * of a patch change; assignees and links are kept as ids and kinds only; a
 * person can be taken off every task; a link can be dropped; deleting the
 * project removes its tasks.
 *
 * Run: cd server && node --test stores/projectTaskStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb, createProjectScopedSchema } = require('../testUtils/pgliteDb');
const { makeProjectTaskStore, DDL } = require('./projectTaskStore');

const { pg, db } = pgliteDb();
const store = makeProjectTaskStore(db);
let n = 0;
const make = (projectId, extra = {}) => store.createTask({
    id: `t-${++n}`, projectId, title: 'sealed-title', description: 'sealed-desc', createdBy: 'ann', ...extra,
});

before(() => createProjectScopedSchema(pg, DDL));
after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
    assert.strictEqual((await pg.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'project_tasks'`)).rows[0].n, 1);
});

test('a task is read through its own project only', async () => {
    const t = await make('p1', { dueDate: '2026-11-05', assigneeIds: ['ben'], links: [{ kind: 'chat', id: 'c1' }] });
    assert.strictEqual(t.status, 'todo');
    assert.strictEqual(t.dueDate, '2026-11-05');
    assert.deepStrictEqual(t.assigneeIds, ['ben']);
    assert.ok(await store.getTask('p1', t.id));
    assert.strictEqual(await store.getTask('p2', t.id), null);
    assert.ok((await store.listTasks('p1')).some((x) => x.id === t.id));
    assert.strictEqual((await store.listTasks('p2')).length, 0);
});

test('done stamps completedAt, leaving done clears it, and only the patched keys change', async () => {
    const t = await make('p1', { links: [{ kind: 'document', id: 'd1' }] });
    const done = await store.updateTask('p1', t.id, { status: 'done' });
    assert.ok(done.completedAt);
    assert.strictEqual(done.title, 'sealed-title');
    assert.deepStrictEqual(done.links, [{ kind: 'document', id: 'd1' }]);
    const again = await store.updateTask('p1', t.id, { description: 'sealed-2' });
    assert.strictEqual(again.completedAt, done.completedAt, 'a later edit keeps the completion time');
    const back = await store.updateTask('p1', t.id, { status: 'doing' });
    assert.strictEqual(back.completedAt, null);
    await assert.rejects(store.updateTask('p1', t.id, { status: 'nope' }), { code: 'INVALID_STATUS' });
    assert.strictEqual(await store.updateTask('p2', t.id, { status: 'todo' }), null);
});

test('links keep a thread with its chat, and drop anything unknown', async () => {
    const t = await make('p1', { links: [{ kind: 'thread', id: 'm1', chatId: 'c1', junk: 1 }, { kind: 'bogus', id: 'x' }] });
    assert.deepStrictEqual(t.links, [{ kind: 'thread', id: 'm1', chatId: 'c1' }]);
});

test('a person is taken off every task, and a link can be dropped', async () => {
    const a = await make('p1', { assigneeIds: ['zed', 'amy'], links: [{ kind: 'document', id: 'dz' }, { kind: 'chat', id: 'cz' }] });
    const b = await make('p1', { assigneeIds: ['amy'] });
    assert.strictEqual(await store.unassignUser('p1', 'zed'), 1);
    assert.deepStrictEqual((await store.getTask('p1', a.id)).assigneeIds, ['amy']);
    assert.deepStrictEqual((await store.getTask('p1', b.id)).assigneeIds, ['amy']);
    assert.strictEqual(await store.dropLinksTo('p1', 'document', 'dz'), 1);
    assert.deepStrictEqual((await store.getTask('p1', a.id)).links, [{ kind: 'chat', id: 'cz' }]);
});

test('deleting a task, and the project, removes tasks', async () => {
    const t = await make('p2');
    assert.strictEqual(await store.deleteTask('p1', t.id), false);
    assert.strictEqual(await store.deleteTask('p2', t.id), true);
    await make('p2');
    await pg.query('DELETE FROM projects WHERE id = $1', ['p2']);
    assert.strictEqual((await store.listTasks('p2')).length, 0);
});

test('new tasks go to the end of their column, and a move puts a task exactly where asked', async () => {
    const a = await make('p1', { status: 'doing' });
    const b = await make('p1', { status: 'doing' });
    const c = await make('p1', { status: 'doing' });
    assert.ok(a.sortOrder < b.sortOrder && b.sortOrder < c.sortOrder);
    const order = async () => (await store.listTasks('p1')).filter((t) => [a.id, b.id, c.id].includes(t.id)).map((t) => t.id);
    await store.moveTask('p1', c.id, { status: 'doing', beforeId: a.id });
    assert.deepStrictEqual(await order(), [c.id, a.id, b.id]);
    await store.moveTask('p1', a.id, { status: 'doing', beforeId: null });
    assert.deepStrictEqual(await order(), [c.id, b.id, a.id]);
    assert.strictEqual(await store.moveTask('p1', c.id, { status: 'todo', beforeId: a.id }), null, 'the neighbour is in another column');
    assert.strictEqual(await store.moveTask('p2', c.id, { status: 'doing' }), null);
});

test('moving between the same two neighbours again and again keeps the order', async () => {
    const first = await make('p1', { status: 'todo' });
    const last = await make('p1', { status: 'todo' });
    const moving = [];
    for (let i = 0; i < 14; i++) moving.push(await make('p1', { status: 'todo' }));
    // Each one is put right before `last`, then right before `first`: the room between ranks runs out and the column is numbered again.
    for (const t of moving) await store.moveTask('p1', t.id, { status: 'todo', beforeId: last.id });
    for (const t of moving) await store.moveTask('p1', t.id, { status: 'todo', beforeId: first.id });
    const ids = (await store.listTasks('p1')).map((t) => t.id);
    assert.deepStrictEqual(ids.filter((id) => moving.some((t) => t.id === id)), moving.map((t) => t.id), 'the run keeps its order');
    assert.ok(ids.indexOf(moving[13].id) < ids.indexOf(first.id), 'and sits before the first');
    const ranks = (await store.listTasks('p1')).filter((t) => t.status === 'todo').map((t) => t.sortOrder);
    assert.strictEqual(new Set(ranks).size, ranks.length, 'no two in a column share a rank');
});

test('priority is checked, a new due date starts the reminders over, and a meeting item is found by its source', async () => {
    const t = await make('p1', { priority: 'urgent', source: { kind: 'meeting', id: 'mt-9', itemId: 'ai-4' } });
    assert.strictEqual(t.priority, 'urgent');
    assert.deepStrictEqual(t.source, { kind: 'meeting', id: 'mt-9', itemId: 'ai-4' });
    assert.strictEqual((await store.tasksFromMeeting('p1', 'mt-9')).get('ai-4'), t.id);
    assert.strictEqual((await store.tasksFromMeeting('p2', 'mt-9')).size, 0);
    await pg.query(`UPDATE project_tasks SET notified_due_tier = 'due_1d' WHERE id = $1`, [t.id]);
    assert.strictEqual((await store.getTask('p1', t.id)).notifiedDueTier, 'due_1d');
    assert.strictEqual((await store.updateTask('p1', t.id, { dueDate: '2027-01-01' })).notifiedDueTier, null);
    await assert.rejects(store.updateTask('p1', t.id, { priority: 'asap' }), { code: 'INVALID_PRIORITY' });
    await assert.rejects(make('p1', { priority: 'asap' }), { code: 'INVALID_PRIORITY' });
});

test('the board keeps every to-do and doing task; only the oldest done ones are left out, and it says so', async () => {
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p3', 'p3', 'owner')`);
    await pg.query(
        `INSERT INTO project_tasks (id, project_id, title, status, created_by, sort_order, completed_at, created_at)
         SELECT 'bulk-' || s, 'p3', 'x', CASE WHEN s <= 505 THEN 'done' WHEN s % 2 = 0 THEN 'todo' ELSE 'doing' END,
                'ann', s, CASE WHEN s <= 505 THEN NOW() - (s || ' minutes')::interval END, NOW()
           FROM generate_series(1, 1100) s`,
    );
    const board = await store.listBoard('p3');
    assert.strictEqual(board.truncated, true);
    assert.strictEqual(board.tasks.filter((t) => t.status === 'todo').length, 298, 'every to-do task');
    assert.strictEqual(board.tasks.filter((t) => t.status === 'doing').length, 297, 'every doing task');
    const done = board.tasks.filter((t) => t.status === 'done');
    assert.strictEqual(done.length, 500);
    assert.ok(done.some((t) => t.id === 'bulk-1') && !done.some((t) => t.id === 'bulk-505'), 'the most recently finished stay');
    assert.strictEqual((await store.listTasks('p3')).length, 1095);
    const fresh = await make('p3');
    assert.ok((await store.listBoard('p3')).tasks.some((t) => t.id === fresh.id), 'a new task is on the board, however many there are');
    assert.strictEqual((await store.listBoard('p1')).truncated, false);
});

test('a meeting item becomes a task once: the same item and text is refused, another text is another item', async () => {
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p2', 'p2', 'owner') ON CONFLICT DO NOTHING`);
    const src = { kind: 'meeting', id: 'mt-u', itemId: 'ai-1', textHash: 'aaaa' };
    const first = await make('p1', { source: src });
    assert.deepStrictEqual(first.source, src, 'the text hash is kept');
    assert.strictEqual(await make('p1', { source: src }), null, 'a second one for the same item and text is not stored');
    assert.ok(await make('p1', { source: { ...src, textHash: 'bbbb' } }), 'after a regenerate the same position can hold a new item');
    assert.ok(await make('p2', { source: src }), 'in another project');
    const map = await store.tasksFromMeeting('p1', 'mt-u');
    assert.strictEqual(map.get('ai-1#aaaa'), first.id);
    assert.strictEqual(map.has('ai-1'), false, 'a hashed task is not found by its bare id');
    assert.ok(await make('p1', { source: { kind: 'meeting', id: 'mt-u', itemId: 'ai-9' } }), 'a task without a hash is still allowed');
});

test('rows an earlier race doubled lose their claim on the item when the schema is created again, and no task is lost', async () => {
    await pg.query('DROP INDEX idx_project_tasks_source_item');
    const a = await make('p1', { source: { kind: 'meeting', id: 'mt-d', itemId: 'ai-1' } });
    const b = await make('p1', { source: { kind: 'meeting', id: 'mt-d', itemId: 'ai-1' } });
    await pg.query(`UPDATE project_tasks SET created_at = created_at + interval '1 second' WHERE id = $1`, [b.id]);
    await pg.exec(DDL);
    assert.deepStrictEqual((await store.getTask('p1', a.id)).source, { kind: 'meeting', id: 'mt-d', itemId: 'ai-1' });
    assert.strictEqual((await store.getTask('p1', b.id)).source, null);
    assert.strictEqual(await make('p1', { source: { kind: 'meeting', id: 'mt-d', itemId: 'ai-1' } }), null, 'the index is back');
});

test('dropLinksTo with no project drops the link in every project', async () => {
    const a = await make('p1', { links: [{ kind: 'meeting', id: 'mt-gone' }, { kind: 'chat', id: 'keep' }] });
    const b = await make('p2', { links: [{ kind: 'meeting', id: 'mt-gone' }] });
    assert.strictEqual(await store.dropLinksTo(null, 'meeting', 'mt-gone'), 2);
    assert.deepStrictEqual((await store.getTask('p1', a.id)).links, [{ kind: 'chat', id: 'keep' }]);
    assert.deepStrictEqual((await store.getTask('p2', b.id)).links, []);
});

test('the database prevents a partial date update from crossing the other endpoint', async () => {
    const task = await make('p1', { startDate: '2026-10-01', dueDate: '2026-10-10' });
    await store.updateTask('p1', task.id, { startDate: '2026-10-08' });
    // A second editor still holds the old start date, but cannot commit an invalid pair.
    await assert.rejects(() => store.updateTask('p1', task.id, { dueDate: '2026-10-05' }), error => error.code === '23514');
    const kept = await store.getTask('p1', task.id);
    assert.strictEqual(kept.startDate, '2026-10-08');
    assert.strictEqual(kept.dueDate, '2026-10-10');
});
