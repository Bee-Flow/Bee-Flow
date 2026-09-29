/**
 * What an app's action and chat requests accept (routes/studioAppsRun.js,
 * routes/studio/appRuntimeSchemas.js).
 *
 *   - `wait: "false"` on an action run still waited up to a minute.
 *   - `?draft=yes` ran the PUBLISHED definition while the owner was editing
 *     the draft; only `1` and `true` ever meant draft.
 *   - an `automationId` in the run body was ignored under a 200 (the wiring
 *     comes from the definition); a misspelled `formValue` ran with no values.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/studioAppsRun.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./studioAppsRun'));

const post = (path, body, user) => api.call('POST', `/api/studio-apps/app1${path}`, { body, user });

test('a run takes its values and whether to wait — as a boolean', async () => {
    h.assertRefused(assert, await post('/actions/a1/run', { formValues: {}, wait: 'false' }), 'body.wait', /wait is true or false/);
    h.assertRefused(assert, await post('/actions/a1/run', { automationId: 'other' }), 'body', /"automationId"/);
    h.assertRefused(assert, await post('/actions/a1/run', { formValue: { a: 1 } }), 'body', /"formValue"/);
    assert.deepStrictEqual(db.queries, []);
});

test('draft is 1 or true, and nothing else pretends to be', async () => {
    h.assertRefused(assert, await post('/actions/a1/step?draft=yes', { stepIndex: 0 }), 'query.draft', /draft is 1/);
    assert.deepStrictEqual(db.queries, []);
});

test('a step names its position, and a chat turn its component', async () => {
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 'first' }), 'body.stepIndex', /position of the step/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, index: -2 }), 'body.index', /loop position/);
    h.assertRefused(assert, await post('/ai/chat', { messages: [] }), 'body.nodeId', /chat component/);
    h.assertRefused(assert, await post('/ai/chat', { nodeId: 'n1', messages: 'hi' }), 'body.messages', /conversation so far/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await post('/actions/a1/run', { wait: 'false' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid step reaches the app lookup and answers as before', async () => {
    const res = await post('/actions/a1/step?draft=1', { stepIndex: 0, formValues: {}, vars: {} });
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.some((q) => /studio_apps/.test(q)), db.queries.join(' | '));
});
