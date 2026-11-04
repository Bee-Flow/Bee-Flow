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
const h = require('../testUtils/routeHarness');

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

test('a step inside a called action: callPath is at most 3 whole numbers, params an object', async () => {
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, callPath: [0, 1, 2, 3] }), 'body.callPath', /call_action step positions/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, callPath: [1.5] }), 'body.callPath.0', /call_action step positions/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, params: 'x' }), 'body.params', /params/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, callpath: [0] }), 'body', /"callpath"/);
    assert.deepStrictEqual(db.queries, []);
    const res = await post('/actions/a1/step?draft=1', { stepIndex: 0, callPath: [0, 1, 2], params: { n: 1 } });
    assert.strictEqual(res.status, 404, res.text);
});

test('a step inside an onError handler: error is { message ≤500, step ≤60, code?, attempts 1..4, stepIndex? }', async () => {
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, error: { message: 'x'.repeat(501), step: 'ai_generate', attempts: 1 } }), 'body.error.message', /onError handler/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, error: { message: 'm', step: 'ai_generate', attempts: 5 } }), 'body.error.attempts', /onError handler/);
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, error: 'boom' }), 'body.error', /onError handler/);
    assert.deepStrictEqual(db.queries, []);
    const res = await post('/actions/a1/step?draft=1', { stepIndex: 0, error: { message: 'm', step: 'ai_generate', code: null, attempts: 4, stepIndex: 2 } });
    assert.strictEqual(res.status, 404, res.text);
});

test('a background start takes the click scope only; a job id is sar_ + 32 hex; the job list its filters', async () => {
    h.assertRefused(assert, await post('/actions/a1/background', { stepIndex: 0 }), 'body', /"stepIndex"/);
    h.assertRefused(assert, await post('/actions/a1/background', { index: -1 }), 'body.index', /loop position/);
    h.assertRefused(assert, await api.call('GET', `/api/studio-apps/app1/actions/jobs/sar_${'a'.repeat(80)}`, {}), 'params.jobId', /sar_ and 32 hex/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-apps/app1/actions/jobs?active=yes', {}), 'query.active', /active is 1/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-apps/app1/actions/jobs?actionId=a%20b', {}), 'query.actionId', /id of an action/);
    assert.deepStrictEqual(db.queries, []);
});

test('the run log: a step\'s runKey and the end report are bounded; an empty end body still reaches the app gate', async () => {
    h.assertRefused(assert, await post('/actions/a1/step', { stepIndex: 0, runKey: 'not-a-key' }), 'body.runKey', /run key the app made/);
    h.assertRefused(assert, await post('/actions/a1/runs/end', { runKey: 'rk_short' }), 'body.runKey', /run key the app made/);
    h.assertRefused(assert, await post('/actions/a1/runs/end', { status: 'done' }), 'body.status', /success, error or cancelled/);
    h.assertRefused(assert, await post('/actions/a1/runs/end', { error: 'x'.repeat(301) }), 'body.error', /at most 300/);
    h.assertRefused(assert, await post('/actions/a1/runs/end', { handled: 'yes' }), 'body.handled', /onError handler/);
    h.assertRefused(assert, await post('/actions/a1/runs/end', { result: {} }), 'body', /"result"/);
    assert.deepStrictEqual(db.queries, []);
    const res = await post('/actions/a1/runs/end', {});
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.some((q) => /studio_apps/.test(q)), db.queries.join(' | '));
});
