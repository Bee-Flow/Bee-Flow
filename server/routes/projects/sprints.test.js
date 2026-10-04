/**
 * routes/projects/sprints.js over a real Express app (core/http/routeHarness),
 * with the real sprint and task stores over PGlite, real sealing with an
 * injected project key, and a fake role gate and feed.
 *
 * Proven: the role ladder (viewer reads, editor writes); name and goal stored
 * sealed and served opened; a key that cannot be produced is a 503 and writes
 * nothing; the rollup (items, points, done) rides along; a patch validates the
 * date range against the endpoint it does not change; only one sprint is
 * active at a time; items must be tasks of the project; deleting a sprint
 * frees its tasks instead of deleting them; a sprint of another project is a
 * 404; the feed carries ids only.
 *
 * Run: cd server && node --test routes/projects/sprints.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { serve } = require('../../core/http/routeHarness');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { fakeRequireProjectRole, projectUser } = require('../../testUtils/projectRoleGate');
const taskStoreModule = require('../../stores/projectTaskStore');
const sprintStoreModule = require('../../stores/projectSprintStore');
const { makeChatCrypto } = require('../../projects/chatCrypto');
const { makeProjectSprintsRouter } = require('./sprints');

const who = projectUser;
const EDITOR = who('ed');
const VIEWER = who('vic');
const STRANGER = who('sam');
const ROLES = {
    p1: { ed: 'editor', vic: 'viewer' },
    p2: { ed: 'editor' },
    sol: { ed: 'editor' },
    nokey: { ed: 'editor' },
};
const PROJECTS = {
    p1: { id: 'p1', name: 'Launch', organizationId: 'org1', kind: 'workspace' },
    p2: { id: 'p2', name: 'Other', organizationId: 'org1', kind: 'workspace' },
    sol: { id: 'sol', name: 'Bundle', organizationId: 'org1', kind: 'solution' },
    nokey: { id: 'nokey', name: 'Broken vault', organizationId: 'org1', kind: 'workspace' },
};

const KEYS = new Map();
const { pg, db } = pgliteDb();
const store = sprintStoreModule.makeProjectSprintStore(db);
const taskStore = taskStoreModule.makeProjectTaskStore(db);
const chatCrypto = makeChatCrypto({
    getProjectKey: async (projectId) => {
        if (projectId === 'nokey') throw new Error('vault locked');
        if (!KEYS.has(projectId)) KEYS.set(projectId, crypto.randomBytes(32));
        return KEYS.get(projectId);
    },
});

let events;
let activity;

const api = serve('/api/projects', makeProjectSprintsRouter({
    requireProjectRole: fakeRequireProjectRole(ROLES),
    getProjectRole: async (userId, projectId) => ROLES[projectId]?.[userId] || null,
    getProject: async (id) => (PROJECTS[id] ? { ...PROJECTS[id] } : null),
    store,
    taskStore,
    chatCrypto,
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
    logActivity: async (projectId, actorId, action, details) => { activity.push({ projectId, actorId, action, details }); },
}), { user: EDITOR });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(taskStoreModule.DDL);
    await pg.exec(sprintStoreModule.DDL);
    for (const id of Object.keys(PROJECTS)) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'ed']);
});
after(async () => { await api.close(); await pg.close(); });
beforeEach(() => { events = []; activity = []; });

const call = (method, url, opts = {}) => api.call(method, url, opts);
async function makeSprint(body = {}, user = EDITOR, projectId = 'p1') {
    const res = await call('POST', `/api/projects/${projectId}/sprints`, { body: { name: 'Sprint 1', ...body }, user });
    assert.strictEqual(res.status, 201, res.text);
    return res.body.sprint;
}

let taskN = 0;
/** A task straight in the store; the title need not be really sealed, sprints never open it. */
async function makeTask(projectId = 'p1', extra = {}) {
    const task = await taskStore.createTask({
        id: `task-${++taskN}`, projectId, title: 'sealed-title', description: '', createdBy: 'ed', ...extra,
    });
    assert.ok(task);
    return task;
}

test('no session is 401, no role is 404; a viewer reads but cannot write', async () => {
    const sprint = await makeSprint();
    const task = await makeTask();
    assert.strictEqual((await call('GET', '/api/projects/p1/sprints', { user: null })).status, 401);
    assert.strictEqual((await call('GET', '/api/projects/p1/sprints', { user: STRANGER })).status, 404);
    assert.strictEqual((await call('GET', '/api/projects/p1/sprints', { user: VIEWER })).status, 200);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints', { body: { name: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/sprints/${sprint.id}`, { body: { name: 'y' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${sprint.id}`, { user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [task.id] }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${sprint.id}/items/${task.id}`, { user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${sprint.id}/start`, { user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${sprint.id}/complete`, { user: VIEWER })).status, 403);
});

test('name and goal are stored sealed and served opened, with dates and capacity', async () => {
    const sprint = await makeSprint({ name: 'Secret sprint', goal: 'Ship quietly', startDate: '2026-10-05', endDate: '2026-10-16', capacityPoints: 21 });
    assert.strictEqual(sprint.name, 'Secret sprint');
    assert.strictEqual(sprint.goal, 'Ship quietly');
    assert.deepStrictEqual([sprint.startDate, sprint.endDate, sprint.capacityPoints, sprint.status], ['2026-10-05', '2026-10-16', 21, 'planned']);
    const stored = (await pg.query('SELECT name, goal FROM project_sprints WHERE id = $1', [sprint.id])).rows[0];
    assert.ok(!stored.name.includes('Secret'), 'name is not plaintext');
    assert.ok(!stored.goal.includes('quietly'), 'goal is not plaintext');
    const listed = (await call('GET', '/api/projects/p1/sprints')).body.sprints.find((s) => s.id === sprint.id);
    assert.strictEqual(listed.name, 'Secret sprint');
    assert.strictEqual(listed.goal, 'Ship quietly');
});

test('a key that cannot be produced is a 503 and nothing is written', async () => {
    const beforeRows = (await pg.query('SELECT COUNT(*)::int AS n FROM project_sprints')).rows[0].n;
    const res = await call('POST', '/api/projects/nokey/sprints', { body: { name: 'x' }, user: EDITOR });
    assert.strictEqual(res.status, 503);
    assert.match(res.body.error, /^Sprints cannot be used right now/, 'names sprints, not team chat');
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM project_sprints')).rows[0].n, beforeRows);
});

test('a Studio Solution holds no sprints, and bodies are closed', async () => {
    assert.strictEqual((await call('POST', '/api/projects/sol/sprints', { body: { name: 'x' }, user: EDITOR })).status, 409);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints', { body: { name: 'x', nme: 'y' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints', { body: { name: '   ' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints', { body: { name: 'x', startDate: '2026-13-40' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints', { body: { name: 'x', capacityPoints: -3 } })).status, 400);
});

test('a patch changes only what it names, and the date range holds against the unchanged endpoint', async () => {
    const sprint = await makeSprint({ startDate: '2026-10-05', endDate: '2026-10-16' });
    const path = `/api/projects/p1/sprints/${sprint.id}`;
    const renamed = await call('PATCH', path, { body: { name: 'Sprint 2', goal: 'Now with a goal' } });
    assert.strictEqual(renamed.status, 200, renamed.text);
    assert.deepStrictEqual([renamed.body.sprint.name, renamed.body.sprint.goal, renamed.body.sprint.endDate], ['Sprint 2', 'Now with a goal', '2026-10-16']);
    assert.strictEqual((await call('PATCH', path, { body: { startDate: '2026-10-20' } })).status, 400, 'crosses the end date it keeps');
    assert.strictEqual((await store.getSprint('p1', sprint.id)).startDate, '2026-10-05');
    const moved = await call('PATCH', path, { body: { startDate: null, endDate: null, capacityPoints: null } });
    assert.strictEqual(moved.status, 200, moved.text);
    assert.deepStrictEqual([moved.body.sprint.startDate, moved.body.sprint.endDate], [null, null]);
    assert.strictEqual((await call('PATCH', '/api/projects/p1/sprints/nope', { body: { name: 'x' } })).status, 404);
    assert.ok(events.some((e) => e.kind === 'sprint.updated' && e.payload.sprintId === sprint.id));
});

test('the rollup counts the items and their points, done apart', async () => {
    const sprint = await makeSprint();
    const a = await makeTask('p1', { storyPoints: 5, status: 'done' });
    const b = await makeTask('p1', { storyPoints: 8 });
    const c = await makeTask('p1');
    await makeTask('p1', { storyPoints: 13 });
    await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [a.id, b.id, c.id] } });
    const listed = (await call('GET', '/api/projects/p1/sprints', { user: VIEWER })).body.sprints.find((s) => s.id === sprint.id);
    assert.deepStrictEqual([listed.itemCount, listed.pointsTotal, listed.pointsDone, listed.doneCount], [3, 13, 5, 1]);
});

test('starting a sprint demotes the one that was active, and complete closes it', async () => {
    const one = await makeSprint({ name: 'One' });
    const two = await makeSprint({ name: 'Two' });
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${one.id}/start`)).body.sprint.status, 'active');
    const started = await call('POST', `/api/projects/p1/sprints/${two.id}/start`);
    assert.strictEqual(started.status, 200, started.text);
    assert.strictEqual(started.body.sprint.status, 'active');
    const sprints = (await call('GET', '/api/projects/p1/sprints')).body.sprints;
    assert.strictEqual(sprints.find((s) => s.id === one.id).status, 'planned', 'only one active sprint per project');
    assert.strictEqual(sprints.filter((s) => s.status === 'active').length, 1);
    const closed = await call('POST', `/api/projects/p1/sprints/${two.id}/complete`);
    assert.strictEqual(closed.body.sprint.status, 'closed');
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints/nope/start')).status, 404);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints/nope/complete')).status, 404);
});

test('the status only moves forward: a closed sprint is not started again or filled, a planned one is not completed', async () => {
    const one = await makeSprint({ name: 'Forward' });
    const other = await makeSprint({ name: 'Running' });
    const task = await makeTask('p1');
    const early = await call('POST', `/api/projects/p1/sprints/${one.id}/complete`);
    assert.strictEqual(early.status, 409);
    assert.strictEqual(early.body.code, 'sprint_not_active');
    assert.strictEqual((await store.getSprint('p1', one.id)).status, 'planned');

    await call('POST', `/api/projects/p1/sprints/${one.id}/start`);
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${one.id}/complete`)).body.sprint.status, 'closed');
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${one.id}/complete`)).body.code, 'sprint_closed');

    await call('POST', `/api/projects/p1/sprints/${other.id}/start`);
    const restart = await call('POST', `/api/projects/p1/sprints/${one.id}/start`);
    assert.strictEqual(restart.status, 409);
    assert.strictEqual(restart.body.code, 'sprint_closed');
    assert.strictEqual((await store.getSprint('p1', other.id)).status, 'active', 'a refused start demotes nothing');

    const fill = await call('POST', `/api/projects/p1/sprints/${one.id}/items`, { body: { taskIds: [task.id] } });
    assert.strictEqual(fill.status, 409);
    assert.strictEqual((await taskStore.getTask('p1', task.id)).sprintId ?? null, null);
    assert.strictEqual(await store.startSprint('p1', one.id), null, 'the store refuses on its own too');
    assert.deepStrictEqual(await store.assignTasks('p1', one.id, [task.id]), []);
});

test('the database keeps one active sprint per project even when the route is bypassed', async () => {
    const a = await makeSprint({}, EDITOR, 'p2');
    const b = await makeSprint({}, EDITOR, 'p2');
    await pg.query(`UPDATE project_sprints SET status = 'active' WHERE id = $1`, [a.id]);
    await assert.rejects(pg.query(`UPDATE project_sprints SET status = 'active' WHERE id = $1`, [b.id]), /uq_project_sprints_one_active|duplicate key/);
    await pg.query(`UPDATE project_sprints SET status = 'planned' WHERE id = $1`, [a.id]);
});

test('items must be tasks of the project: an unknown one refuses the whole assignment', async () => {
    const sprint = await makeSprint();
    const a = await makeTask('p1');
    const b = await makeTask('p1');
    const refused = await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [a.id, 'no-such-task'] } });
    assert.strictEqual(refused.status, 404);
    assert.strictEqual(refused.body.code, 'task_not_found');
    assert.strictEqual((await store.getSprint('p1', sprint.id)).itemCount, 0, 'nothing half assigned');
    const assigned = await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [a.id, b.id, a.id] } });
    assert.strictEqual(assigned.status, 200, assigned.text);
    assert.strictEqual(assigned.body.sprint.itemCount, 2, 'a task named twice is in it once');
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [] } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/sprints/nope/items', { body: { taskIds: [a.id] } })).status, 404);
});

test('unassigning takes one task out, and only one that is in', async () => {
    const sprint = await makeSprint();
    const a = await makeTask('p1');
    await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [a.id] } });
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${sprint.id}/items/${a.id}`)).status, 200);
    assert.strictEqual((await store.getSprint('p1', sprint.id)).itemCount, 0);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${sprint.id}/items/${a.id}`)).status, 404, 'not in it anymore');
});

test('deleting a sprint frees its tasks instead of deleting them', async () => {
    const sprint = await makeSprint();
    const a = await makeTask('p1');
    await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [a.id] } });
    const res = await call('DELETE', `/api/projects/p1/sprints/${sprint.id}`);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(await store.getSprint('p1', sprint.id), null);
    assert.ok(await taskStore.getTask('p1', a.id), 'the task is still there');
    assert.strictEqual((await pg.query('SELECT sprint_id FROM project_tasks WHERE id = $1', [a.id])).rows[0].sprint_id, null);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${sprint.id}`)).status, 404);
    assert.ok(activity.some((x) => x.action === 'sprint.deleted'));
});

test('a sprint of another project is not found here, and its items are not either', async () => {
    const sprint = await makeSprint({}, EDITOR, 'p1');
    const foreign = await makeSprint({}, EDITOR, 'p2');
    const taskInP2 = await makeTask('p2');
    assert.strictEqual((await call('GET', `/api/projects/p1/sprints`)).body.sprints.some((s) => s.id === foreign.id), false);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/sprints/${foreign.id}`, { body: { name: 'x' } })).status, 404);
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${foreign.id}/start`)).status, 404);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/sprints/${foreign.id}`)).status, 404);
    // A task of p2 cannot be put into a sprint of p1.
    assert.strictEqual((await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [taskInP2.id] } })).status, 404);
});

test('the feed carries ids, never the sealed words', async () => {
    const sprint = await makeSprint({ name: 'Codename Apricot', goal: 'Do not tell' });
    const task = await makeTask('p1');
    await call('PATCH', `/api/projects/p1/sprints/${sprint.id}`, { body: { goal: 'Still secret' } });
    await call('POST', `/api/projects/p1/sprints/${sprint.id}/items`, { body: { taskIds: [task.id] } });
    await call('POST', `/api/projects/p1/sprints/${sprint.id}/start`);
    await call('DELETE', `/api/projects/p1/sprints/${sprint.id}`);
    assert.deepStrictEqual(events.map((e) => e.kind), ['sprint.created', 'sprint.updated', 'sprint.updated', 'sprint.updated', 'sprint.deleted']);
    for (const e of events) {
        assert.strictEqual(e.targetType, 'project_sprint');
        assert.strictEqual(e.payload.sprintId, sprint.id);
        assert.ok(!JSON.stringify(e).includes('Apricot') && !JSON.stringify(e).includes('secret'), 'no content in the feed');
    }
});
