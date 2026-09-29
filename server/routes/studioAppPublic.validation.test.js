/**
 * What a PUBLIC app page may send (routes/studioAppPublic.js) — the same
 * runtime requests the signed-in routes take (routes/studio/appRuntimeSchemas.js),
 * rewritten onto /api/public-app/<token>/… by the public transport.
 *
 *   - `?filter=` that is not JSON was dropped: the visitor's list showed every
 *     row their role may read, unfiltered.
 *   - a step with a misspelled key, or without its position, reached the app
 *     lookup and answered 404 "Step not found".
 *
 * No refused request reaches the database; the visitor token is checked first.
 *
 * Run: cd server && node --test routes/studioAppPublic.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { issueVisitorToken } = require('../auth/publicShareToken');

// No session gates here: the visitor token is the credential.
const { db, api } = h.routeUnderTest(test, '/api/public-app', () => require('./studioAppPublic'), { gates: false, user: null });

const PAGE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const visitor = { authorization: `Bearer ${issueVisitorToken({ pageToken: PAGE, appId: 'app1', viewerId: 'anon-1' })}` };
const call = (method, path, body, headers = visitor) => api.call(method, `/api/public-app/${PAGE}${path}`, { body, headers });

test('a step names its position and takes only the runtime keys', async () => {
    h.assertRefused(assert, await call('POST', '/actions/a1/step', { formValues: {} }), 'body.stepIndex', /position of the step/);
    h.assertRefused(assert, await call('POST', '/actions/a1/step', { stepIndex: 0, viewerId: 'someone-else' }), 'body', /"viewerId"/);
    assert.deepStrictEqual(db.queries, []);
});

test('a list filter that is not JSON is refused, not dropped', async () => {
    h.assertRefused(assert, await call('GET', '/data/tables/t1/records?filter=all'), 'query.filter', /filter is JSON/);
    h.assertRefused(assert, await call('POST', '/data/batch', { reads: [], all: true }), 'body', /"all"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the visitor token is checked before the body', async () => {
    const res = await call('POST', '/actions/a1/step', { viewerId: 'x' }, {});
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid step reaches the page lookup and answers as before', async () => {
    const res = await call('POST', '/actions/a1/step', { stepIndex: 0, formValues: {}, vars: {} });
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.some((q) => /public_pages/.test(q)), db.queries.join(' | '));
});
