/**
 * The folder picker's routes (routes/knowledgeBases/cloudBrowse.js): what they
 * accept, what they say when they refuse, and that a refused request never
 * reaches a storage.
 *
 *   - `provider` is one of the three storages; anything else is refused by
 *     name, in a sentence, before a storage client is built;
 *   - a query key the route does not read is refused (a typo such as `parent`
 *     would otherwise list the root and look like an empty folder);
 *   - both routes need a session.
 *
 * Run: cd server && node --test routes/knowledgeBases/cloudBrowse.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');

const { api } = h.routeUnderTest(test, '/api/kb', () => require('./cloudBrowse'));
const cloudAccess = require('./cloudAccess');

const real = { browse: cloudAccess.browse, providerStatuses: cloudAccess.providerStatuses };
const seen = [];
test.beforeEach(() => {
    seen.length = 0;
    cloudAccess.browse = async (req, q) => { seen.push(q); return { items: [], nextPageToken: null }; };
    cloudAccess.providerStatuses = async () => [{ provider: 'onedrive', connected: false, reason: 'not_connected' }];
});
test.after(() => Object.assign(cloudAccess, real));

test('an unknown provider is refused by name and no storage is touched', async () => {
    const res = await api.call('GET', '/api/kb/cloud/browse?provider=dropbox');
    h.assertRefused(assert, res, 'query.provider', /provider is one of: nextcloud_files, onedrive, google_drive\./);
    assert.deepStrictEqual(seen, []);
});

test('leaving the provider out gets the same sentence', async () => {
    const res = await api.call('GET', '/api/kb/cloud/browse');
    h.assertRefused(assert, res, 'query.provider', /provider is one of/);
});

test('a key the route does not read is refused', async () => {
    const res = await api.call('GET', '/api/kb/cloud/browse?provider=onedrive&parent=F1');
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(seen, []);
});

test('a valid query reaches the picker with exactly what was asked', async () => {
    const res = await api.call('GET', '/api/kb/cloud/browse?provider=onedrive&parentId=F1&driveId=D1&pageToken=p2&q=plan');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { items: [], nextPageToken: null });
    assert.deepStrictEqual(seen, [{ provider: 'onedrive', parentId: 'F1', driveId: 'D1', pageToken: 'p2', q: 'plan' }]);
    const nc = await api.call('GET', '/api/kb/cloud/browse?provider=nextcloud_files&path=%2FDocs');
    assert.strictEqual(nc.status, 200);
    assert.deepStrictEqual(seen[1], { provider: 'nextcloud_files', path: '/Docs' });
});

test('providers answers { providers } from the picker\'s check', async () => {
    const res = await api.call('GET', '/api/kb/cloud/providers');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { providers: [{ provider: 'onedrive', connected: false, reason: 'not_connected' }] });
});

test('both routes need a session', async () => {
    assert.strictEqual((await api.call('GET', '/api/kb/cloud/providers', { user: null })).status, 401);
    assert.strictEqual((await api.call('GET', '/api/kb/cloud/browse?provider=onedrive', { user: null })).status, 401);
    assert.deepStrictEqual(seen, []);
});
