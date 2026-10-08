'use strict';
process.env.NODE_ENV = 'test';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../core/http/routeHarness');
const recording = h.recordDb();
const router = require('./microsoftBindingRoutes');
const api = h.serve('/auth', router);
after(api.close);
const endpoints = [
    ['GET','/microsoft/link-requests'], ['PUT','/microsoft/users/local/identity'],
    ['DELETE','/microsoft/users/local/identity'], ['GET','/microsoft/sync-binding'], ['PUT','/microsoft/sync-binding'],
];
test('anonymous, members and organization administrators cannot link, unlink or configure global directory sync', async () => {
    await recording.settle();
    for (const user of [null, { id: 'member', role: 'user' }, { id: 'org-admin', role: 'user', orgRole: 'org_admin' }]) {
        for (const [method, path] of endpoints) {
            recording.reset();
            const response = await api.call(method, `/auth${path}`, { user, body: method === 'PUT' ? {} : undefined });
            assert.equal(response.status, user ? 403 : 401, response.text);
            assert.deepEqual(recording.queries, [], 'a refused operation must never reach storage');
        }
    }
});
test('platform administrators can inspect pending identities but cannot save a non-GUID sync tenant', async () => {
    const user = { id: 'platform-admin', role: 'admin' };
    const requests = await api.call('GET', '/auth/microsoft/link-requests', { user });
    assert.equal(requests.status, 200);
    recording.reset();
    const response = await api.call('PUT', '/auth/microsoft/sync-binding', { user, body: { syncOrganizationId: 'org-B', syncTenantId: 'common' } });
    assert.equal(response.status, 400);
    assert.deepEqual(recording.queries, []);
});
