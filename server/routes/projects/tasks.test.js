/**
 * routes/projects/tasks.js over a real Express app (core/http/routeHarness),
 * with the real task and chat stores over PGlite, real sealing with an
 * injected project key, and a fake role gate and feed.
 *
 * Proven: the role ladder (viewer reads, editor writes, only the author or the
 * owner deletes); title and description stored sealed and served opened; a key
 * that cannot be produced is a 503 and writes nothing; assignees must be
 * members; links must point into the project (documents and notebooks filed in
 * it, its chats, a thread root of its own chat); a Solution holds no tasks;
 * closed bodies; the feed carries ids only and names new assignees.
 *
 * Run: cd server && node --test routes/projects/tasks.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { serve } = require('../../core/http/routeHarness');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const taskStoreModule = require('../../stores/projectTaskStore');
const chatStoreModule = require('../../stores/projectChatStore');
const { makeChatCrypto } = require('../../projects/chatCrypto');
const { makeProjectTasksRouter } = require('./tasks');

const ORDER = { viewer: 0, editor: 1, owner: 2 };
const who = (id) => ({ id, organizationId: 'org1', role: 'user', email: `${id}@example.test` });
const OWNER = who('olga');
const EDITOR = who('ed');
const EDITOR2 = who('eve');
const VIEWER = who('vic');
const STRANGER = who('sam');
const ROLES = {
    p1: { olga: 'owner', ed: 'editor', eve: 'editor', vic: 'viewer' },
    sol: { olga: 'owner', ed: 'editor' },
    nokey: { olga: 'owner', ed: 'editor' },
};
const PROJECTS = {
    p1: { id: 'p1', name: 'Launch', organizationId: 'org1', kind: 'workspace' },
    sol: { id: 'sol', name: 'Bundle', organizationId: 'org1', kind: 'solution' },
    nokey: { id: 'nokey', name: 'Broken vault', organizationId: 'org1', kind: 'workspace' },
};
const FILED = { document: new Set(['doc-1']), notebook: new Set(['nb-1']), meeting: new Set(['mt-1']) };
const NOTE = {
    id: 'mt-1', title: 'Weekly', projectId: 'p1',
    actionItems: [
        { id: 'ai-1', text: 'Send the offer', assignee: 'ed', due: '2026-11-03', timestamp: 65, done: false },
        { id: 'ai-2', text: 'Book a room', assignee: 'Niet toegewezen', done: false },
    ],
};

const KEYS = new Map();
const { pg, db } = pgliteDb();
const store = taskStoreModule.makeProjectTaskStore(db);
const chatStore = chatStoreModule.makeProjectChatStore(db);
const chatCrypto = makeChatCrypto({
    getProjectKey: async (projectId) => {
        if (projectId === 'nokey') throw new Error('vault locked');
        if (!KEYS.has(projectId)) KEYS.set(projectId, crypto.randomBytes(32));
        return KEYS.get(projectId);
    },
});

let events;
let activity;
let bell;
let asked;

function requireProjectRole(minRole) {
    return function requireProjectRoleMw(req, res, next) {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const role = ROLES[req.params.id]?.[userId];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        return next();
    };
}

const api = serve('/api/projects', makeProjectTasksRouter({
    requireProjectRole,
    getProjectRole: async (userId, projectId) => ROLES[projectId]?.[userId] || null,
    getProject: async (id) => (PROJECTS[id] ? { ...PROJECTS[id] } : null),
    store,
    chatStore,
    chatCrypto,
    filedIds: async (projectId, kind) => (projectId === 'p1' ? FILED[kind] : new Set()),
    readMeeting: async (req, project, id) => (id === NOTE.id && project.id === 'p1' ? NOTE : null),
    listPeople: async () => [{ id: 'olga', name: 'Olga' }, { id: 'ed', name: 'Ed Editor' }, { id: 'eve', name: 'Eve' }],
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
    notifier: { assigned: async (a) => { bell.push(a); } },
    resolveOrgs: async () => ({ orgId: 'org1', limitOrgId: 'org1' }),
    improveLimiter: function rateLimitMiddleware(req, res, next) { next(); },
    assistant: {
        forMeeting: async (a) => { asked.push(['meeting', a.userId, a.items.map((i) => i.id), a.people.map((p) => p.id)]); return a.items.map((i) => ({ itemId: i.id, title: i.text, description: 'more', priority: 'normal', labels: [], checklist: [], assigneeId: null })); },
        forTask: async (a) => { asked.push(['task', a.userId, a.task.title, a.task.labels]); if (a.task.title === 'boom') { throw new (require('../../core/http/errors').HttpError)(503, 'ai_unavailable', 'The AI is not available right now.'); } return { title: a.task.title, description: 'better', priority: 'high', labels: ['x'], checklist: [], assigneeId: null }; },
    },
    commentStore: { deleteForTarget: async () => 0 },
    logActivity: async (projectId, actorId, action, details) => { activity.push({ projectId, actorId, action, details }); },
}), { user: EDITOR });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(chatStoreModule.DDL);
    await pg.exec(taskStoreModule.DDL);
    for (const id of Object.keys(PROJECTS)) await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'olga']);
});
after(async () => { await api.close(); await pg.close(); });
beforeEach(() => { events = []; activity = []; bell = []; asked = []; });

const call = (method, url, opts = {}) => api.call(method, url, opts);
async function make(body = {}, user = EDITOR, projectId = 'p1') {
    const res = await call('POST', `/api/projects/${projectId}/tasks`, { body: { title: 'Write the brief', ...body }, user });
    assert.strictEqual(res.status, 201, res.text);
    return res.body.task;
}

test('no session is 401, no role is 404; a viewer reads but cannot write', async () => {
    const task = await make();
    assert.strictEqual((await call('GET', '/api/projects/p1/tasks', { user: null })).status, 401);
    assert.strictEqual((await call('GET', '/api/projects/p1/tasks', { user: STRANGER })).status, 404);
    assert.strictEqual((await call('GET', '/api/projects/p1/tasks', { user: VIEWER })).status, 200);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { status: 'done' }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/tasks/${task.id}`, { user: VIEWER })).status, 403);
});

test('title and description are stored sealed and served opened', async () => {
    const task = await make({ title: 'Secret plan', description: 'Details nobody outside should read' });
    assert.strictEqual(task.title, 'Secret plan');
    assert.strictEqual(task.description, 'Details nobody outside should read');
    const stored = (await pg.query('SELECT title, description FROM project_tasks WHERE id = $1', [task.id])).rows[0];
    assert.ok(!stored.title.includes('Secret'), 'title is not plaintext');
    assert.ok(!stored.description.includes('Details'), 'description is not plaintext');
    const list = (await call('GET', '/api/projects/p1/tasks')).body.tasks.find((t) => t.id === task.id);
    assert.strictEqual(list.title, 'Secret plan');
});

test('a key that cannot be produced is a 503 and nothing is written', async () => {
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n;
    const res = await call('POST', '/api/projects/nokey/tasks', { body: { title: 'x' }, user: EDITOR });
    assert.strictEqual(res.status, 503);
    assert.match(res.body.error, /^Tasks cannot be used right now/, 'names tasks, not team chat');
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n, before);
});

test('assignees must be members of the project', async () => {
    const task = await make({ assigneeIds: ['eve'] });
    assert.deepStrictEqual(task.assigneeIds, ['eve']);
    const res = await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', assigneeIds: ['sam'] }, user: EDITOR });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'assignee_not_member');
    assert.ok(events.some((e) => e.kind === 'task.assigned' && e.payload.assigneeIds.join() === 'eve'));
});

test('a hand-over names only the people newly given the task', async () => {
    const task = await make({ assigneeIds: ['eve'] });
    events = [];
    const res = await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { assigneeIds: ['eve', 'vic'] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(events.find((e) => e.kind === 'task.assigned').payload.assigneeIds, ['vic']);
    for (const e of events) assert.ok(!JSON.stringify(e).includes('Write the brief'), 'no content in the feed');
});

test('links must point into this project', async () => {
    const chat = await chatStore.createChat({ id: 'c-1', projectId: 'p1', title: 'sealed', createdBy: 'ed' });
    const root = (await chatStore.appendMessage({ id: 'm-1', projectId: 'p1', chatId: chat.id, authorKind: 'user', authorUserId: 'ed', content: 'sealed' })).message;
    const reply = (await chatStore.appendMessage({ id: 'm-2', projectId: 'p1', chatId: chat.id, authorKind: 'user', authorUserId: 'ed', content: 'sealed', threadId: root.id })).message;
    const links = [
        { kind: 'document', id: 'doc-1' }, { kind: 'notebook', id: 'nb-1' }, { kind: 'chat', id: chat.id },
        { kind: 'thread', id: root.id, chatId: chat.id },
    ];
    const task = await make({ links });
    assert.deepStrictEqual(task.links, links);
    const refused = async (link) => {
        const res = await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', links: [link] } });
        assert.strictEqual(res.status, 400, JSON.stringify(link));
        assert.strictEqual(res.body.code, 'link_not_in_project');
    };
    await refused({ kind: 'document', id: 'someone-elses' });
    await refused({ kind: 'notebook', id: 'someone-elses' });
    await refused({ kind: 'chat', id: 'nope' });
    await refused({ kind: 'thread', id: reply.id, chatId: chat.id });
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', links: [{ kind: 'thread', id: root.id }] } })).status, 400, 'a thread needs its chat');
});

test('status moves and a task is finished', async () => {
    const task = await make();
    const done = await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { status: 'done' }, user: EDITOR2 });
    assert.strictEqual(done.body.task.status, 'done');
    assert.ok(done.body.task.completedAt);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { status: 'later' } })).status, 400);
    assert.strictEqual((await call('PATCH', `/api/projects/p1/tasks/nope`, { body: { status: 'done' } })).status, 404);
});

test('only the author or the owner deletes a task', async () => {
    const task = await make({}, EDITOR);
    const other = await call('DELETE', `/api/projects/p1/tasks/${task.id}`, { user: EDITOR2 });
    assert.strictEqual(other.status, 403);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/tasks/${task.id}`, { user: EDITOR })).status, 200);
    const again = await make({}, EDITOR);
    assert.strictEqual((await call('DELETE', `/api/projects/p1/tasks/${again.id}`, { user: OWNER })).status, 200);
    assert.ok(activity.some((a) => a.action === 'task.deleted'));
});

test('a Studio Solution holds no tasks, and bodies are closed', async () => {
    assert.strictEqual((await call('POST', '/api/projects/sol/tasks', { body: { title: 'x' }, user: EDITOR })).status, 409);
    const res = await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', assignee: 'eve' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: '   ' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', dueDate: '2026-13-40' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', dueDate: '2026-12-24' } })).status, 201);
});

test('priority, labels and the checklist are stored sealed and served opened', async () => {
    const checklist = [{ id: 'c1', text: 'Draft', done: true }, { id: 'c2', text: 'Review', done: false }];
    const task = await make({ priority: 'high', labels: ['launch', 'launch', 'legal'], checklist });
    assert.strictEqual(task.priority, 'high');
    assert.deepStrictEqual(task.labels, ['launch', 'legal']);
    assert.deepStrictEqual(task.checklist, checklist);
    const stored = (await pg.query('SELECT labels, checklist FROM project_tasks WHERE id = $1', [task.id])).rows[0];
    assert.ok(!stored.labels.includes('launch') && !stored.checklist.includes('Draft'), 'sealed');
    const changed = await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { labels: [], priority: 'low' } });
    assert.deepStrictEqual(changed.body.task.labels, []);
    assert.strictEqual(changed.body.task.priority, 'low');
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', priority: 'now' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', checklist: [{ id: 'a', text: 'y' }] } })).status, 400);
});

test('a task moves to a column and to a place in it', async () => {
    const a = await make({ title: 'A' });
    const b = await make({ title: 'B' });
    const c = await make({ title: 'C' });
    const move = (task, body) => call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body });
    const moved = await move(c, { status: 'todo', beforeId: a.id });
    assert.strictEqual(moved.status, 200, moved.text);
    const order = (await call('GET', '/api/projects/p1/tasks')).body.tasks.filter((t) => [a.id, b.id, c.id].includes(t.id)).map((t) => t.title);
    assert.deepStrictEqual(order, ['C', 'A', 'B']);
    const toDoing = await move(b, { status: 'doing', beforeId: null });
    assert.strictEqual(toDoing.body.task.status, 'doing');
    const wrong = await move(a, { status: 'doing', beforeId: c.id });
    assert.strictEqual(wrong.status, 400, 'the neighbour is in another column');
    assert.strictEqual(wrong.body.code, 'move_target_not_found');
});

test('a meeting\'s action items come as suggestions with a member and a due date', async () => {
    const res = await call('GET', '/api/projects/p1/meetings/mt-1/task-suggestions', { user: VIEWER });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.meeting.title, 'Weekly');
    assert.deepStrictEqual(res.body.suggestions.map((x) => [x.itemId, x.suggestedAssigneeId, x.dueDate, x.at, x.createdTaskId]), [
        ['ai-1', 'ed', '2026-11-03', '1:05', null],
        ['ai-2', null, null, '', null],
    ]);
    assert.strictEqual((await call('GET', '/api/projects/p1/meetings/nope/task-suggestions')).status, 404);
    assert.strictEqual((await call('GET', '/api/projects/p1/meetings/mt-1/task-suggestions', { user: STRANGER })).status, 404);
});

test('a batch makes the tasks, links the meeting, and never makes the same item twice', async () => {
    const items = [
        { title: 'Send the offer', description: 'At 1:05', assigneeIds: ['ed'], dueDate: '2026-11-03', source: { kind: 'meeting', id: 'mt-1', itemId: 'bi-1' } },
        { title: 'Book a room', source: { kind: 'meeting', id: 'mt-1', itemId: 'bi-2' } },
    ];
    const first = await call('POST', '/api/projects/p1/tasks/batch', { body: { items } });
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual(first.body.tasks.length, 2);
    assert.deepStrictEqual(first.body.tasks[0].links, [{ kind: 'meeting', id: 'mt-1' }]);
    assert.deepStrictEqual(first.body.tasks[0].source, { kind: 'meeting', id: 'mt-1', itemId: 'bi-1' });
    assert.strictEqual(events.filter((e) => e.kind === 'task.created').length, 2);
    const again = await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [...items, { title: 'New one', source: { kind: 'meeting', id: 'mt-1', itemId: 'bi-3' } }] } });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(again.body.skipped, 2);
    assert.strictEqual(again.body.tasks.length, 1);
    const twice = await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [items[0], items[0]] } });
    assert.strictEqual(twice.body.tasks.length, 0, 'already made, and twice in one request');
});

test('a batch is refused as a whole when one task is not valid, and needs an editor', async () => {
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n;
    const bad = await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [{ title: 'fine' }, { title: 'bad', assigneeIds: ['sam'] }] } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n, before, 'nothing half made');
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [{ title: 'x' }] }, user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [] } })).status, 400);
    const foreign = await call('POST', '/api/projects/p1/tasks', { body: { title: 'x', links: [{ kind: 'meeting', id: 'other' }] } });
    assert.strictEqual(foreign.body.code, 'link_not_in_project');
});

test('the people given a task get a bell, from create, batch and hand-over', async () => {
    const task = await make({ assigneeIds: ['eve'] });
    assert.deepStrictEqual(bell.map((b) => [b.assigneeIds, b.actorId, b.taskId]), [[['eve'], 'ed', task.id]]);
    bell = [];
    await call('PATCH', `/api/projects/p1/tasks/${task.id}`, { body: { assigneeIds: ['eve', 'vic'] } });
    assert.deepStrictEqual(bell.map((b) => b.assigneeIds), [['vic']]);
    bell = [];
    await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [{ title: 'a', assigneeIds: ['olga'] }, { title: 'b' }] } });
    assert.deepStrictEqual(bell.map((b) => b.assigneeIds), [['olga']]);
});

test('the AI expands a meeting\'s action items as the asker, also the ones already made (marked), and stores nothing', async () => {
    await call('POST', '/api/projects/p1/tasks/batch', { body: { items: [{ title: 'Send the offer', source: { kind: 'meeting', id: 'mt-1', itemId: 'ai-1' } }] } });
    const before = (await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n;
    const res = await call('POST', '/api/projects/p1/meetings/mt-1/task-suggestions/improve', { user: EDITOR });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body.items.map((i) => [i.itemId, !!i.createdTaskId]), [['ai-1', true], ['ai-2', false]]);
    assert.deepStrictEqual(asked[0], ['meeting', 'ed', ['ai-1', 'ai-2'], ['olga', 'ed', 'eve']]);
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM project_tasks')).rows[0].n, before);
});

test('improving needs an editor, a meeting of this project, and reports the AI\'s own refusals', async () => {
    assert.strictEqual((await call('POST', '/api/projects/p1/meetings/mt-1/task-suggestions/improve', { user: VIEWER })).status, 403);
    assert.strictEqual((await call('POST', '/api/projects/p1/meetings/mt-1/task-suggestions/improve', { user: STRANGER })).status, 404);
    assert.strictEqual((await call('POST', '/api/projects/p1/meetings/nope/task-suggestions/improve')).status, 404);
});

test('one task can be improved: the AI reads it opened, and the answer is a suggestion, not a change', async () => {
    const task = await make({ title: 'Fix the login', description: 'It fails.', labels: ['auth'] });
    const res = await call('POST', `/api/projects/p1/tasks/${task.id}/improve`);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.suggestion.description, 'better');
    assert.deepStrictEqual(asked.at(-1), ['task', 'ed', 'Fix the login', ['auth']]);
    const stored = (await call('GET', '/api/projects/p1/tasks')).body.tasks.find((t) => t.id === task.id);
    assert.strictEqual(stored.description, 'It fails.', 'nothing was saved');
    assert.strictEqual((await call('POST', '/api/projects/p1/tasks/nope/improve')).status, 404);
    assert.strictEqual((await call('POST', `/api/projects/p1/tasks/${task.id}/improve`, { user: VIEWER })).status, 403);
    const boom = await make({ title: 'boom' });
    const failed = await call('POST', `/api/projects/p1/tasks/${boom.id}/improve`);
    assert.strictEqual(failed.status, 503);
    assert.strictEqual(failed.body.code, 'ai_unavailable');
});
