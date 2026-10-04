'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeDiscoveryRouter } = require('./discovery');
const { fakeRequireProjectRole } = require('../../testUtils/projectRoleGate');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
let saved = [], items = [], reads = 0;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { user: { id: req.headers['x-user'] || 'viewer' } }; next(); });
app.use('/api/projects', makeDiscoveryRouter({
    requireProjectRole: fakeRequireProjectRole({ p: { viewer: 'viewer', editor: 'editor' } }),
    publish: async () => {},
    getProject: async id => id === 'p' ? { id } : null,
    catalogue: async () => { reads++; return items; },
    pins: { list: async () => saved, put: async (p, type, id) => { saved.push({ type, id }); }, remove: async (p, type, id) => { saved = saved.filter(x => x.type !== type || x.id !== id); } },
}));
app.use(terminalErrorHandler);
const server = app.listen(0, '127.0.0.1');
const ready = new Promise(resolve => server.once('listening', resolve));
test.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
test.beforeEach(() => { items = [{ type: 'task', id: 't', title: 'Launch', description: 'Internal context' }]; saved = []; reads = 0; });
async function call(path, method = 'GET', body, user = 'viewer') {
    await ready;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/p${path}`, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
}
test('viewer searches but cannot pin; nonmembers cannot read the catalogue', async () => {
    assert.equal((await call('/search?q=context')).body.items[0].id, 't');
    assert.equal((await call('/pins', 'PUT', { type: 'task', id: 't' })).status, 403);
    const before = reads;
    assert.equal((await call('/search', 'GET', null, 'stranger')).status, 404);
    assert.equal(reads, before);
});
test('pins resolve current titles and hide removed or inaccessible content', async () => {
    assert.equal((await call('/pins', 'PUT', { type: 'task', id: 't' }, 'editor')).status, 200);
    assert.equal((await call('/pins')).body.items[0].title, 'Launch');
    assert.equal('description' in (await call('/pins')).body.items[0], false);
    items = [];
    assert.deepEqual((await call('/pins')).body.items, []);
    assert.equal((await call('/pins', 'PUT', { type: 'task', id: 'foreign' }, 'editor')).status, 404);
    assert.equal((await call('/pins/task/t', 'DELETE', null, 'editor')).status, 200);
    assert.equal(saved.length, 0);
});
test('search rejects invalid type, cursor and unknown fields', async () => {
    for (const q of ['type=secret', 'cursor=-1', 'cursor=1.1', 'projectId=other']) assert.equal((await call(`/search?${q}`)).status, 400);
    assert.equal(reads, 0);
});
