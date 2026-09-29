/**
 * What the Learning Center routes accept (routes/ai/learning.js).
 *
 *   - `makePublic: "false"` issued a PUBLIC certificate — a verify link that
 *     shows the learner's name and organisation to anyone holding it.
 *   - a misspelled `mode` on the coach ran the hint path instead of grading.
 *   - misspelled keys (`choiceId`, `lessonID`) were ignored under a 200.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/ai/learning.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/ai/learning', () => require('./learning'));
const post = (path, body, user) => api.call('POST', `/ai/learning${path}`, { body, user });

test('a certificate is public only for the boolean true', async () => {
    h.assertRefused(assert, await post('/certificate', { certificateId: 'c1', makePublic: 'false' }), 'body.makePublic', /makePublic is true or false/);
    assert.deepStrictEqual(db.queries, []);
});

test('the coach grades or hints, and nothing else', async () => {
    h.assertRefused(assert, await post('/coach', { exerciseId: 'e1', mode: 'grde', submission: 'x' }), 'body.mode', /grade or hint/);
    assert.deepStrictEqual(db.queries, []);
});

test('misspelled keys are refused by name', async () => {
    h.assertRefused(assert, await post('/quiz/grade', { lessonId: 'l1', stepId: 's1', choiceId: ['a'] }), 'body', /"choiceId"/);
    h.assertRefused(assert, await post('/practice/generate', { lessonID: ['l1'] }), 'body', /"lessonID"/);
    h.assertRefused(assert, await api.call('PUT', '/ai/learning/training-rules', { body: { area: {} } }), 'body', /areas must be an object/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await post('/certificate', { makePublic: 'false' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid certificate request answers as before', async () => {
    const res = await post('/certificate', { certificateId: 'no-such-certificate', makePublic: false });
    assert.strictEqual(res.status, 404, res.text);
    assert.deepStrictEqual(res.body, { error: 'Unknown certificate' });
});
