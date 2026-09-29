/**
 * What the Word-template routes accept (routes/templates.js).
 *
 *   - `PUT /:id {"knowledgeBaseIds": [<a base of another org>]}` was stored,
 *     and template chat then searched that base: the ingest layer does no
 *     tenant filtering, the id list IS its access boundary. Now a 400 naming
 *     the id, before anything is written.
 *   - `PUT /:id {}` reached the store, built no SQL and answered 404
 *     "Template not found" for a template that exists.
 *   - a misspelled key (`{"instuctions": "…"}`) was a 200 that changed nothing.
 *   - `values` as a list or text reached the renderer.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/templates.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const usable = new Set(['kb-mine']);
const { db, api } = h.routeUnderTest(test, '/api/templates', () => {
    require('../core/entitlements/betaFeatures').requireBetaFeature = () => (req, res, next) => next();
    require('../support/kbAccess').usableKbIdsForRequest = async (_req, ids) => ids.filter((id) => usable.has(id));
    return require('./templates');
}, { answer: (sql) => (/^\s*UPDATE word_templates/i.test(sql) ? { rows: [], rowCount: 1 } : undefined) });

const put = (body, user) => api.call('PUT', '/api/templates/t1', { body, user });
const writes = () => db.queries.filter((q) => /word_templates/.test(q) && /UPDATE|INSERT|DELETE/i.test(q));

test('a knowledge base the caller may not search is refused by id, and nothing is written', async () => {
    const res = await put({ knowledgeBaseIds: ['kb-mine', 'kb-of-another-org'] });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_knowledge_bases');
    assert.deepStrictEqual(res.body.details.map((d) => d.message), ['kb-of-another-org']);
    assert.deepStrictEqual(db.queries, []);
});

test('an empty update is a 400 that says what to send, not a 404', async () => {
    const res = await put({});
    h.assertRefused(assert, res, 'body', /at least one of name, description, instructions or knowledgeBaseIds/);
    assert.deepStrictEqual(db.queries, []);
});

test('a misspelled key is refused by name', async () => {
    const res = await put({ instuctions: 'Be brief.' });
    h.assertRefused(assert, res, 'body', /"instuctions"/);
    assert.match(res.body.error, /It takes: name, description, instructions, knowledgeBaseIds/);
    assert.deepStrictEqual(db.queries, []);
});

test('a blank or oversized name and a knowledge base list that is not a list are refused', async () => {
    h.assertRefused(assert, await put({ name: '   ' }), 'body.name', /name is text of 1 to 200/);
    h.assertRefused(assert, await put({ name: 'x'.repeat(201) }), 'body.name');
    h.assertRefused(assert, await put({ knowledgeBaseIds: 'kb-mine' }), 'body.knowledgeBaseIds', /list of at most 50/);
    assert.deepStrictEqual(db.queries, []);
});

test('fill takes an object of values, not a list or text', async () => {
    for (const path of ['/api/templates/t1/fill', '/api/templates/t1/fill-and-store']) {
        h.assertRefused(assert, await api.call('POST', path, { body: { values: ['a'] } }), 'body.values', /object of placeholder values/);
        h.assertRefused(assert, await api.call('POST', path, { body: {} }), 'body.values', /Values object required/);
        h.assertRefused(assert, await api.call('POST', path, { body: { values: {}, vals: {} } }), 'body', /"vals"/);
    }
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await put({ nope: 1 }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid update with a usable base reaches the store and answers as before', async () => {
    const res = await put({ instructions: 'Be brief.', knowledgeBaseIds: ['kb-mine'] });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { success: true });
    assert.strictEqual(writes().length, 1);
    assert.match(writes()[0], /UPDATE word_templates/);
});
