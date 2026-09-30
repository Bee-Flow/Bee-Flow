/**
 * What the notebook routes accept (routes/notebooks.js).
 *
 *   - `expectedVersion: "5"` (text) skipped the version check, so a stale tab
 *     overwrote a newer document. Digits are read as the number now; anything
 *     else is a 400.
 *   - `pinned: "false"` pinned the notebook.
 *   - `ids: "s1"` on bulk-delete answered 200 with nothing deleted.
 *   - a Drive import with `provider: "onedrive"` was filed as Google Drive.
 *   - a misspelled key was ignored under a 200.
 *
 * No refused request reaches the database; the session is checked first.
 * The list query is pinned in notebooks.list.test.js.
 *
 * Run: cd server && node --test routes/notebooks.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

// The one notebook the recording database knows: nb1, owned by the harness
// user, so a valid request passes the role gate and reaches the store.
const NB1 = { id: 'nb1', user_id: 'u1', name: 'NB', document_content: '', version: 5, source_count: 0 };
const answer = (sql, params) => (/^\s*SELECT n\.\*/.test(sql) && params && params[0] === 'nb1' && params[1] === 'u1'
    ? { rows: [NB1] } : undefined);

const { db, api } = h.routeUnderTest(test, '/api/notebooks', () => {
    const router = require('./notebooks');
    // No co-editing engine and no change feed in this test: the request's
    // own queries are what it records.
    router.seams.collab = () => null;
    router.seams.feed = () => ({ contentChanged: async () => {}, renamed: async () => {}, sourcesAdded: async () => {} });
    return router;
}, { answer });

const put = (body, user) => api.call('PUT', '/api/notebooks/nb1', { body, user });

test('a version that is not a whole number, and a pin that is not a boolean, are refused', async () => {
    h.assertRefused(assert, await put({ documentContent: '<p>x</p>', expectedVersion: 'five' }), 'body.expectedVersion', /whole-number version/);
    h.assertRefused(assert, await put({ pinned: 'yes' }), 'body.pinned', /pinned is true or false/);
    h.assertRefused(assert, await put({ knowledgeBaseIds: 'kb1' }), 'body.knowledgeBaseIds', /knowledgeBaseIds must be an array/);
    h.assertRefused(assert, await put({ documentContnet: 'x' }), 'body', /"documentContnet"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the version as digits is read as the number, so the check still runs', async () => {
    const res = await put({ documentContent: '<p>x</p>', expectedVersion: '5' });
    // No such notebook in the recording database; what matters is that the
    // compare-and-set carried the version.
    assert.strictEqual(res.status, 404, res.text);
    assert.ok(db.queries.some((q) => /UPDATE\s+notebooks/i.test(q) && /version/i.test(q)), db.queries.join(' | '));
});

test('source bodies take only what the source reads', async () => {
    const call = (path, body) => api.call('POST', `/api/notebooks/nb1${path}`, { body });
    h.assertRefused(assert, await call('/sources/bulk-delete', { ids: 's1' }), 'body.ids', /list of source ids/);
    h.assertRefused(assert, await call('/sources/drive', { files: [{ name: 'a', content: 'x' }], provider: 'onedrive' }), 'body.provider', /google or microsoft/);
    h.assertRefused(assert, await call('/sources/meeting', { meetingId: 'm1', mode: 'summry' }), 'body.mode', /full or summary/);
    h.assertRefused(assert, await call('/sources/url', {}), 'body.url', /URL required/);
    h.assertRefused(assert, await call('/sources/text', { text: 'x', title: 'y' }), 'body', /"title"/);
    h.assertRefused(assert, await call('/versions', { name: { a: 1 } }), 'body.name', /name is text/);
    // The old snapshot body (client-supplied content and label) is gone: a
    // named version is always the server's own current state.
    h.assertRefused(assert, await call('/versions', { name: 'Draft', summary: 'Before AI edit', content: '<p>x</p>' }), 'body', /"summary"/);
    h.assertRefused(assert, await call('/ai-fill', { documentContent: ['x'] }), 'body.documentContent', /No document content provided/);
    const rename = await api.call('PATCH', '/api/notebooks/nb1/sources/s1', { body: { name: { x: 1 } } });
    h.assertRefused(assert, rename, 'body.name', /Name is required/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the body', async () => {
    const res = await put({ pinned: 'yes' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid create reaches the store and answers as before', async () => {
    const res = await api.call('POST', '/api/notebooks', { body: { name: 'Plans' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.success, true);
    assert.ok(db.queries.some((q) => /INSERT INTO notebooks/i.test(q)), db.queries.join(' | '));
});
