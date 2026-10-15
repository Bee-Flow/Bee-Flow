'use strict';

/**
 * routes/projects/resources.js on its own: the factory router served with a
 * fake kind registry, filing service and graph loader behind a real express
 * app and the real terminal error handler. The same routes are covered
 * through the composed router, with the real registry, in
 * routes/projects.resources.test.js and routes/projects.graph.test.js.
 *
 * Proven:
 *   - the listing shows only the sections the project's kind holds, and a
 *     section whose store fails is `null` ("unavailable"), not `[]`;
 *   - filing in must fit the container, taking out always may; a kind that is
 *     not movable is a 400; a refusal a kind states on purpose keeps its
 *     status; a move that matched nothing is a 404;
 *   - "what comes along" refuses a kind the container does not hold;
 *   - the completeness failure path is the contract: `blocked: true`.
 *
 * Run: cd server && node --test routes/projects/resources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');
const { makeResourcesRouter } = require('./resources');

const fx = {};
function reset() {
    fx.project = { id: 'p1', kind: 'workspace' };
    fx.filed = [];
    fx.fileResult = true;
    fx.fileError = null;
    fx.graphError = null;
}
reset();

// Two kinds: documents belong in a project, automations in a Solution.
const HOLDS = { workspace: ['documents'], solution: ['automations'] };
const membership = {
    listKinds: () => [
        { kind: 'document', section: 'documents', list: async () => [{ id: 'd1' }] },
        { kind: 'automation', section: 'automations', list: async () => { throw new Error('store down'); } },
    ],
    sectionsFor: (containerKind) => (containerKind ? HOLDS[containerKind] : ['documents', 'automations']),
    isAllowedIn: (kind, containerKind) => !containerKind || HOLDS[containerKind].includes(`${kind}s`),
    getKind: (kind) => ({ document: { setProject: () => {} }, automation: { setProject: () => {} }, approval: {} })[kind] || null,
    movableKinds: () => [{ kind: 'document' }, { kind: 'automation' }],
};

const router = makeResourcesRouter({
    requireProjectRole: fakeRequireProjectRole({ p1: { alice: 'owner', bob: 'editor', carol: 'viewer' } }),
    projectStore: { getProject: async (id) => (id === fx.project.id ? { ...fx.project } : null) },
    membership,
    itemFiling: {
        fileItem: async ({ kind, id, attach }) => {
            if (fx.fileError) throw fx.fileError;
            fx.filed.push([kind, id, attach]);
            return fx.fileResult;
        },
    },
    buildGraphForProject: async () => {
        if (fx.graphError) throw fx.graphError;
        return { graph: { nodes: [], edges: [] }, members: {}, unavailable: [] };
    },
    completeness: () => ({ collectCompleteness: async () => ({ blocked: false, complete: true, findings: [], unavailable: [] }) }),
    getUserId: (req) => req.session?.user?.id,
    getUserGroups: async () => [],
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    req.session = who ? { user: { id: who, organizationId: 'org1' } } : {};
    next();
});
app.use('/api/projects', router);
app.use(terminalErrorHandler);
const server = http.createServer(app);
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
test.beforeEach(reset);

async function call(method, path, user, body) {
    await ready;
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('the listing shows the sections this kind holds, and an unavailable one as null', async () => {
    const workspace = await call('GET', '/p1/resources', 'carol');
    assert.deepStrictEqual(workspace.body, { role: 'viewer', kind: 'workspace', documents: [{ id: 'd1' }] });

    fx.project.kind = null;
    const legacy = await call('GET', '/p1/resources', 'carol');
    assert.deepStrictEqual(legacy.body, { role: 'viewer', kind: null, documents: [{ id: 'd1' }], automations: null });
});

test('filing in must fit the container; taking out always may', async () => {
    const refused = await call('PUT', '/p1/resources', 'bob', { kind: 'automation', id: 'a1', attach: true });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'KIND_NOT_ALLOWED');

    const out = await call('PUT', '/p1/resources', 'bob', { kind: 'automation', id: 'a1', attach: false });
    assert.deepStrictEqual(out.body, { success: true });
    assert.deepStrictEqual(fx.filed, [['automation', 'a1', false]]);
});

test('a kind that is not movable, a move that matched nothing, and a refusal a kind states on purpose', async () => {
    const approval = await call('PUT', '/p1/resources', 'bob', { kind: 'approval', id: 'x1' });
    assert.strictEqual(approval.status, 400);
    assert.match(approval.body.error, /kind must be one of: document, automation/);

    fx.fileResult = false;
    const missing = await call('PUT', '/p1/resources', 'bob', { kind: 'document', id: 'd9' });
    assert.strictEqual(missing.status, 404);

    fx.fileError = Object.assign(new Error('That project is full.'), { status: 409, code: 'CAP' });
    const capped = await call('PUT', '/p1/resources', 'bob', { kind: 'document', id: 'd9' });
    assert.deepStrictEqual([capped.status, capped.body], [409, { error: 'That project is full.', code: 'CAP' }]);

    fx.fileError = new Error('relation "x" does not exist');
    const broken = await call('PUT', '/p1/resources', 'bob', { kind: 'document', id: 'd9' });
    assert.strictEqual(broken.status, 500);
    assert.strictEqual(broken.body.error, 'Internal server error', 'no SQL text reaches the client');
    assert.doesNotMatch(JSON.stringify(broken.body), /does not exist/);

    assert.strictEqual((await call('PUT', '/p1/resources', 'carol', { kind: 'document', id: 'd1' })).status, 403);
});

test('"what comes along" refuses a kind the container does not hold', async () => {
    const res = await call('POST', '/p1/resources/related', 'bob', { items: [{ kind: 'automation', id: 'a1' }] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'KIND_NOT_ALLOWED');
});

test('the graph and completeness answer over the loader, and completeness fails shut', async () => {
    const graph = await call('GET', '/p1/graph', 'carol');
    assert.deepStrictEqual(graph.body, { nodes: [], edges: [], role: 'viewer' });
    const clean = await call('GET', '/p1/completeness', 'carol');
    assert.strictEqual(clean.body.complete, true);
    assert.strictEqual(clean.body.role, 'viewer');

    fx.graphError = new Error('db down');
    const failed = await call('GET', '/p1/completeness', 'carol');
    assert.strictEqual(failed.status, 500);
    // The blocked shape rides in `details` of the terminal handler's body.
    assert.strictEqual(failed.body.error, 'Request failed');
    assert.strictEqual(failed.body.code, 'completeness_failed');
    assert.ok(failed.body.correlationId);
    assert.deepStrictEqual(failed.body.details, {
        blocked: true, complete: false, findings: [], unavailable: ['all'],
    });
    const graphFailed = await call('GET', '/p1/graph', 'carol');
    assert.strictEqual(graphFailed.status, 500);
    assert.strictEqual(graphFailed.body.error, 'Internal server error');
});
