/**
 * A DPIA questionnaire cannot be saved blank (routes/compliance/dpia.js).
 *
 * Every answer used to be optional, and the DPIA drawer's "Save assessment"
 * was enabled on an empty form: one click recorded a questionnaire with no
 * purpose, no data and no oversight, and the Art. 35 check turned green on
 * it. The route now refuses a questionnaire without the three Art. 35(7)
 * answers the form asks for in words, names the missing field and says what
 * it needs; nothing reaches the database.
 *
 * The bodies that DO save (the quick attestation and a filled questionnaire)
 * are pinned beside the other attestation routes in
 * attestations.validation.test.js.
 *
 * Run: cd server && node --test routes/compliance/dpia.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/compliance', () => require('./dpia'));

const FILLED = Object.freeze({
    purpose: 'Screen applications',
    data_categories: 'CVs, contact details',
    automated_decisions: false,
    human_oversight: 'A recruiter reviews every result',
});

const post = (body) => api.call('POST', '/api/compliance/dpia/agent-7', { body });

test('a blank questionnaire is refused in words, naming the first missing answer', async () => {
    const res = await post({ mode: 'questionnaire', risk_level: 'medium', answers: {} });
    h.assertRefused(assert, res, 'body.answers.purpose', /purpose of the processing/);
    const paths = res.body.details.map((d) => d.path);
    assert.deepStrictEqual(paths, ['body.answers.purpose', 'body.answers.data_categories', 'body.answers.human_oversight']);
    assert.deepStrictEqual(db.queries, []);
});

test('a questionnaire without any answers object is refused the same way', async () => {
    const res = await post({ mode: 'questionnaire', risk_level: 'medium', mitigations: [] });
    h.assertRefused(assert, res, 'body.answers.purpose', /answers\.purpose/);
    assert.deepStrictEqual(db.queries, []);
});

test('whitespace is not an answer', async () => {
    const res = await post({ mode: 'questionnaire', answers: { ...FILLED, human_oversight: '   ' } });
    h.assertRefused(assert, res, 'body.answers.human_oversight', /who oversees the output/);
    assert.strictEqual(res.body.details.length, 1, JSON.stringify(res.body.details));
    assert.deepStrictEqual(db.queries, []);
});

test('each of the three answers is required on its own', async () => {
    const cases = [
        ['purpose', /purpose of the processing/],
        ['data_categories', /personal data involved/],
        ['human_oversight', /who oversees the output/],
    ];
    for (const [key, message] of cases) {
        const answers = { ...FILLED };
        delete answers[key];
        h.assertRefused(assert, await post({ mode: 'questionnaire', answers }), `body.answers.${key}`, message);
    }
    assert.deepStrictEqual(db.queries, []);
});

test('an answer that is not text is refused, not stored', async () => {
    const res = await post({ mode: 'questionnaire', answers: { ...FILLED, purpose: 42 } });
    h.assertRefused(assert, res, 'body.answers.purpose', /purpose of the processing/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await api.call('POST', '/api/compliance/dpia/agent-7', { body: { mode: 'questionnaire' }, user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});
