/**
 * POST /api/projects/:id/archive and /restore, the includeArchived list filter, and the read-only gate
 * (through the REAL projectAccess gate, with the store mocked).
 *
 * Run: cd server && node --test routes/projects.archive.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const fx = { project: null, roles: {}, setCalls: [], activity: [], listOpts: [], teardown: [] };

const MOCKS = {
    '../stores/projectStore': {
        getProject: async () => fx.project,
        getProjectShares: async () => [],
        getProjectRole: async (userId) => fx.roles[userId] || null,
        countSharedThreads: async () => 0,
        deleteProject: async (id) => { fx.teardown.push(id); return true; },
        setArchived: async (id, userId) => {
            fx.setCalls.push({ id, userId });
            if (userId && !fx.project.archivedAt) Object.assign(fx.project, { archivedAt: '2026-10-10T00:00:00.000Z', archivedBy: userId });
            if (!userId) Object.assign(fx.project, { archivedAt: null, archivedBy: null });
            return fx.project;
        },
        listUserProjects: async (u, g, opts) => { fx.listOpts.push(opts); return []; },
        recordActivityEvent: async (projectId, entry) => { fx.activity.push(entry); return null; },
        normalizePermission: (p) => p,
    },
    '../stores/userStore': { getUser: async () => null, getGroup: async () => null, getAllGroups: async () => [] },
    '../stores/automationStore': { countGroupMembers: async () => new Map() },
    '../stores/knowledgeBases': { getKB: async () => null },
    '../support/kbAccess': { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) },
    '../auth': { resolveUserGroups: async () => [] },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
};
// Dependencies are injected by patching the exports the router reads (restored after the run); no module-system hooks.
const patched = [];
function inject(request, overrides) {
    const real = require(request);
    for (const [key, value] of Object.entries(overrides)) {
        patched.push([real, key, real[key]]);
        real[key] = value;
    }
}
for (const [request, exportsObj] of Object.entries(MOCKS)) inject(request, exportsObj);
inject('../auth/audience', { resolveUserGroups: async () => [] });

const router = require('./projects');
// The tasks sub-router with the REAL role gate (it reads the patched store) and a task store that only lists.
const tasksRouter = require('./projects/tasks').makeProjectTasksRouter({
    getProject: async () => fx.project,
    store: { listBoard: async () => ({ tasks: [], truncated: false }) },
    chatCrypto: { forProject: async () => ({}) },
});
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
test.after(() => { for (const [mod, key, orig] of patched.reverse()) mod[key] = orig; });

function call(method, url, body, userId, query, target = router) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body: body || {}, headers: { 'content-type': 'application/json' }, session: { user: { id: userId, organizationId: 'org1' } }, query: query || {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            set() { return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        target(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${url}`));
            return terminalErrorHandler(err, req, res, () => reject(err));
        });
    });
}

function reset(archivedAt = null) {
    fx.project = { id: 'p1', name: 'P1', ownerId: 'alice', organizationId: 'org1', archivedAt, archivedBy: archivedAt ? 'alice' : null };
    fx.roles = { alice: 'owner', ed: 'editor', vw: 'viewer' };
    fx.setCalls.length = 0;
    fx.activity.length = 0;
    fx.listOpts.length = 0;
    fx.teardown.length = 0;
}

test('the owner archives: row stamped, activity project_archived', async () => {
    reset();
    const res = await call('POST', '/p1/archive', {}, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.setCalls, [{ id: 'p1', userId: 'alice' }]);
    assert.strictEqual(res.body.archivedAt, '2026-10-10T00:00:00.000Z');
    assert.deepStrictEqual(fx.activity.map(a => a.action), ['project_archived']);
});

test('archiving twice is a 200 with the same archivedAt and no second activity row', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('POST', '/p1/archive', {}, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.archivedAt, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(fx.activity.length, 0);
});

test('an editor cannot archive (403)', async () => {
    reset();
    const res = await call('POST', '/p1/archive', {}, 'ed');
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.setCalls.length, 0);
});

test('the owner restores: archived_at cleared, activity project_restored', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('POST', '/p1/restore', {}, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.setCalls, [{ id: 'p1', userId: null }]);
    assert.strictEqual(res.body.archivedAt, null);
    assert.deepStrictEqual(fx.activity.map(a => a.action), ['project_restored']);
});

test('restoring a live project is a 200 and writes nothing', async () => {
    reset();
    const res = await call('POST', '/p1/restore', {}, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.activity.length, 0);
});

test('an editor writing into an archived project gets 409 project_archived', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('PUT', '/p1', { name: 'New' }, 'ed');
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'project_archived');
});

test('a viewer still reads an archived project', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('GET', '/p1', null, 'vw');
    assert.strictEqual(res.statusCode, 200);
});

test('the owner can delete an archived project', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('DELETE', '/p1', null, 'alice');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.teardown, ['p1']);
});

test('GET / passes includeArchived only when asked', async () => {
    reset();
    await call('GET', '/', null, 'alice', {});
    await call('GET', '/', null, 'alice', { includeArchived: '1' });
    assert.deepStrictEqual(fx.listOpts.map(o => !!o.includeArchived), [false, true]);
});

test('a viewer still reads the tasks of an archived project (200)', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('GET', '/p1/tasks', null, 'vw', {}, tasksRouter);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.tasks, []);
});

test('an editor cannot create a task in an archived project (409 project_archived)', async () => {
    reset('2026-10-01T00:00:00.000Z');
    const res = await call('POST', '/p1/tasks', { title: 'x' }, 'ed', {}, tasksRouter);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'project_archived');
});
