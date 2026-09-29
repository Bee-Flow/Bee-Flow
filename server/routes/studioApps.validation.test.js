/**
 * What the App Studio management routes accept (routes/studioApps.js).
 *
 *   - `isPublished: "false"` on PATCH /:id/publish PUBLISHED the app, and a
 *     single group sent as text became an org-wide publish.
 *   - `enabled: "false"` put the app in the organisation's Nextcloud menu.
 *   - `?draft=yes` served the published copy to an owner asking for the draft.
 *   - a misspelled key (`descripton`) was ignored under a 200.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/studioApps.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./studioApps'));

const patch = (path, body, user) => api.call('PATCH', `/api/studio-apps/app1${path}`, { body, user });

test('publishing takes a real boolean and a list of groups', async () => {
    h.assertRefused(assert, await patch('/publish', { isPublished: 'false' }), 'body.isPublished', /isPublished is true or false/);
    h.assertRefused(assert, await patch('/publish', { isPublished: true, sharedGroups: 'g1' }), 'body.sharedGroups', /list of group ids/);
    h.assertRefused(assert, await patch('/publish', { isPublished: true, sharedGroup: ['g1'] }), 'body', /"sharedGroup"/);
    h.assertRefused(assert, await patch('/nextcloud-menu', { enabled: 'false' }), 'body.enabled', /enabled is true or false/);
    assert.deepStrictEqual(db.queries, []);
});

test('the other bodies and queries are closed', async () => {
    h.assertRefused(assert, await api.call('PUT', '/api/studio-apps/app1', { body: { descripton: 'x' } }), 'body', /"descripton"/);
    h.assertRefused(assert, await api.call('PUT', '/api/studio-apps/app1/definition', { body: { definition: {} } }), 'body.baseVersion', /version the editor loaded/);
    h.assertRefused(assert, await api.call('POST', '/api/studio-apps', { body: { name: 'A', template: 'crm' } }), 'body', /"template"/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-apps/app1/runtime?draft=yes'), 'query.draft', /draft is 1/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await patch('/publish', { isPublished: 'false' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid publish reaches the app lookup and answers as before', async () => {
    const res = await patch('/publish', { isPublished: false });
    assert.strictEqual(res.status, 404, res.text);
    assert.deepStrictEqual(res.body, { error: 'App not found' });
    assert.ok(db.queries.some((q) => /studio_apps/.test(q)));
});
