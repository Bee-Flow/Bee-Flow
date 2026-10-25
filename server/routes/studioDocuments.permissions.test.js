'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

// Keep the real authentication and permission middleware. Only persistence
// is replaced: this pins the server boundary, independent of hidden buttons.
const config = new Map();
const configStore = {
    getConfig: async (key) => config.get(key) ?? null,
    setConfig: async (key, value) => { config.set(key, value); },
};
const users = {
    member: { id: 'member', role: 'user', orgRole: 'member', organizationId: 'org-1', groups: [] },
    builder: { id: 'builder', role: 'user', orgRole: 'agent_admin', organizationId: 'org-1', groups: [] },
    admin: { id: 'admin', role: 'user', orgRole: 'org_admin', organizationId: 'org-1', groups: [] },
};
const restore = installResolveStub({
    '../stores/userStore': {
        getUser: async (id) => users[id] || null,
        getAllGroups: async () => [], getAllRoles: async () => [], touchLastSeen: async () => {},
    },
    '../db': { getRedis: () => null },
    '../stores/configStore': configStore,
    '../../stores/configStore': configStore,
    '../stores/documentStore': { listFolders: async () => [] },
    '../core/documents/renderFilledDocument': { houseStyleCssFor: async () => '', renderFilledDocument: async () => ({}) },
    '../compliance/marking': { resolveMarking: async () => null },
});
test.after(restore);
const router = require('./studioDocuments');

function dispatch(method, url, user, body = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, body, query: {}, headers: {},
            session: user ? { isAuthenticated: true, user: { ...users[user] } } : null,
        };
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; resolve(this); return this; },
        };
        router(req, res, (error) => reject(error || new Error('Route not found')));
    });
}

test('a member can use the document library without organisation management', async () => {
    const library = await dispatch('GET', '/folders', 'member');
    assert.equal(library.statusCode, 200);
    assert.deepEqual(library.body.folders, []);
    const style = await dispatch('GET', '/house-style', 'member');
    assert.equal(style.statusCode, 200);
    assert.equal(style.body.editable, false);
});

test('members and Studio builders cannot change the organisation house style', async () => {
    const before = config.get('org_document_style_org-1');
    for (const user of ['member', 'builder']) {
        const res = await dispatch('PUT', '/house-style', user, { enabled: true, companyName: 'Forbidden' });
        assert.equal(res.statusCode, 403);
        assert.match(res.body.error, /org_admin/);
    }
    assert.equal(config.get('org_document_style_org-1'), before);
});

test('organisation admins retain house-style management', async () => {
    const res = await dispatch('PUT', '/house-style', 'admin', { enabled: true, companyName: 'Bee Flow' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.style.companyName, 'Bee Flow');
    const style = await dispatch('GET', '/house-style', 'admin');
    assert.equal(style.body.editable, true);
});

test('document access still requires authentication', async () => {
    assert.equal((await dispatch('GET', '/folders', null)).statusCode, 401);
    assert.equal((await dispatch('PUT', '/house-style', null)).statusCode, 401);
});
