/**
 * What an app's data routes accept (routes/studioAppData.js,
 * routes/studio/appRuntimeSchemas.js).
 *
 *   - `?filter=` that is not JSON was dropped, so a filtered list showed every
 *     row the viewer may read, as if they were the filtered ones.
 *   - `?refresh=yes` served the cache; `cacheTtlSeconds: "60"` kept the default.
 *   - a member added with a misspelled `role` became a plain `member`.
 *
 * Record writes and read descriptors stay open (their keys are the app's own
 * columns; the compilers refuse what the table does not have). No refused
 * request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/studioAppData.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./studioAppData'));

const records = (qs, user) => api.call('GET', `/api/studio-apps/app1/data/tables/t1/records${qs}`, { user });

test('a list filter that is not JSON is refused, not dropped', async () => {
    h.assertRefused(assert, await records('?filter=status%3Dopen'), 'query.filter', /filter is JSON/);
    h.assertRefused(assert, await records('?limit=0'), 'query.limit', /1 or more/);
    h.assertRefused(assert, await records('?page=2'), 'query', /"page"/);
    assert.deepStrictEqual(db.queries, []);
});

test('datasets, members, the schema and the cache switch are closed', async () => {
    const post = (path, body) => api.call('POST', `/api/studio-apps/app1${path}`, { body });
    h.assertRefused(assert, await post('/datasets', { name: 'View', cacheTtlSeconds: 'soon' }), 'body.cacheTtlSeconds', /whole number of seconds/);
    h.assertRefused(assert, await post('/members', { userId: 'u2', role: 'editor' }), 'body', /"role"/);
    h.assertRefused(assert, await api.call('PUT', '/api/studio-apps/app1/schema', { body: { tables: [] } }), 'body', /model \(object\) is required/);
    h.assertRefused(assert, await post('/data/query?refresh=yes', { datasetId: 'd1' }), 'query.refresh', /refresh is 1/);
    h.assertRefused(assert, await post('/data/batch', { reads: [], parallel: true }), 'body', /"parallel"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the query', async () => {
    const res = await records('?filter=nope', null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid page request reaches the app lookup and answers as before', async () => {
    const res = await records(`?filter=${encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]))}&limit=20`);
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.some((q) => /studio_apps/.test(q)), db.queries.join(' | '));
});
