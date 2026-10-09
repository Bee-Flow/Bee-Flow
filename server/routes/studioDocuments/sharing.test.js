'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../core/http/routeHarness');
const { HttpError } = require('../../core/http/errors');
const { makeDocumentSharingRouter } = require('./sharing');
const calls = [];
const router = makeDocumentSharingRouter({
    auth: (req, _res, next) => req.session?.user ? next() : next(new HttpError(401, 'unauthorized', 'Not authenticated')),
    notebookGate: (req, _res, next) => req.session.user.id === 'blocked' ? next(new HttpError(403, 'notebooks_disabled', 'Notebooks disabled')) : next(),
    store: {
        getSharing: async (...args) => { calls.push(['get', ...args]); return { audience: 'private' }; },
        sharingDirectory: async (...args) => { calls.push(['directory', ...args]); return { users: [], groups: [] }; },
        setSharing: async (...args) => { calls.push(['set', ...args]); return args[3]; },
    },
});
const api = h.serve('/api/studio-documents', router);
after(api.close);

test('strict audience and recipient validation refuses invalid requests before reaching storage', async () => {
    for (const body of [{ audience: 'groups' }, { audience: 'restricted', sharedGroups: 'finance' }, { audience: 'organisation', unknown: true }, { audience: 'organisation', access: 'admin' }, { audience: 'restricted', sharedUserIds: [42] }]) {
        calls.length = 0;
        const res = await api.call('PUT', '/api/studio-documents/d1/sharing', { body });
        assert.equal(res.status, 400);
        assert.deepEqual(calls, []);
    }
});

test('documents and notebooks dispatch to their resource type with the signed-in user', async () => {
    for (const [prefix, type] of [['', 'document'], ['/notebooks', 'notebook']]) {
        const res = await api.call('PUT', `/api/studio-documents${prefix}/d1/sharing`, { body: { audience: 'restricted', sharedUserIds: ['bob'], sharedGroups: ['finance'] } });
        assert.equal(res.status, 200);
        assert.deepEqual(calls.at(-1), ['set', type, 'd1', 'u1', { audience: 'restricted', sharedUserIds: ['bob'], sharedGroups: ['finance'], access: 'view' }]);
    }
});

test('access edit is accepted and passed on; it defaults to view', async () => {
    const res = await api.call('PUT', '/api/studio-documents/d1/sharing', { body: { audience: 'organisation', access: 'edit' } });
    assert.equal(res.status, 200);
    assert.equal(calls.at(-1)[4].access, 'edit');
});

test('the notebook gate covers sharing reads, writes and its people directory', async () => {
    for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['GET', '/principals']]) {
        calls.length = 0;
        const res = await api.call(method, `/api/studio-documents/notebooks/d1/sharing${suffix}`, { user: { id: 'blocked' }, body: method === 'PUT' ? { audience: 'private' } : undefined });
        assert.equal(res.status, 403);
        assert.deepEqual(calls, []);
    }
});
