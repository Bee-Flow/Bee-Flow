/**
 * What an app's connector calls accept (routes/studioAppConnectors.js).
 *
 * A run or inspect takes the connector's `params` and nothing else. A
 * misspelled `parms` used to run the connector with no parameters at all,
 * under a 200 — a search without its query, a lookup without its id.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/studioAppConnectors.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./studioAppConnectors'));

const post = (path, body, user) => api.call('POST', `/api/studio-apps/app1/data/connectors/c1${path}`, { body, user });

test('a misspelled params key is refused by name', async () => {
    for (const path of ['/run', '/inspect']) {
        h.assertRefused(assert, await post(path, { parms: { q: 'x' } }), 'body', /"parms"/);
        h.assertRefused(assert, await post(path, { params: ['x'] }), 'body.params', /object of the connector/);
    }
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await post('/run', { parms: {} }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid run reaches the app lookup and answers as before', async () => {
    const res = await post('/run', { params: { q: 'x' } });
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.length > 0);
});

test('refreshing and verifying a connector take no fields: one sent is refused by name before the app is looked up', async () => {
    h.assertRefused(assert, await post('/sync', { force: true }), 'body', /does not take "force"/);
    h.assertRefused(assert, await post('/verify', { mailbox: 'x' }), 'body', /does not take "mailbox"/);
    h.assertRefused(assert, await api.call('POST', '/api/studio-apps/app1/runtime/connectors/c1/refresh', { body: { force: true } }), 'body', /does not take "force"/);
    assert.deepStrictEqual(db.queries, []);
    assert.strictEqual((await post('/sync', {})).status, 404, 'an empty body still reaches the app lookup');
});
