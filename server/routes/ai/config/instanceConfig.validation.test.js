/**
 * What the AI configuration accepts (routes/ai/config/instanceConfig.js).
 *
 *   - `useAzureDocProcessing: "false"` switched Azure document processing ON
 *     for the whole installation (`"false" ? 'true' : ''`); the same for every
 *     other on/off switch on this form.
 *   - a misspelled key was a 200 that saved nothing.
 *   - POST /config/test-service-email took a session only: any signed-in user
 *     could make the installation's service mailbox mail any address.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/ai/config/instanceConfig.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../core/http/routeHarness');

// hasPermission answers false: a plain member unless the session says admin.
const statements = [];
const { db, api } = h.routeUnderTest(test, '/ai', () => require('./instanceConfig'), {
    gates: { hasPermission: async () => false },
    answer: (sql, params) => { statements.push({ sql, params }); },
});
const ADMIN = { ...h.USER, role: 'admin' };
const post = (path, body, user = ADMIN) => api.call('POST', `/ai${path}`, { body, user });
const writes = () => db.queries.filter((q) => /INSERT|UPDATE|DELETE/i.test(q));

test('an on/off setting is a boolean, or "true"/"false" read as what they say', async () => {
    h.assertRefused(assert, await post('/config', { useAzureDocProcessing: 'yes' }), 'body.useAzureDocProcessing', /true or false/);
    h.assertRefused(assert, await post('/config', { notebooksEnabled: 1 }), 'body.notebooksEnabled', /true or false/);
    assert.deepStrictEqual(db.queries, []);

    statements.length = 0;
    const res = await post('/config', { useAzureDocProcessing: 'false' });
    assert.strictEqual(res.status, 200, res.text);
    const write = statements.find((q) => (q.params || []).includes('use_azure_doc_processing') && /INSERT|UPDATE/i.test(q.sql));
    assert.ok(write, 'the switch was written');
    assert.ok(!JSON.stringify(write.params).includes('"true"'), `"false" switched it off: ${JSON.stringify(write.params)}`);
});

test('a misspelled setting is refused by name', async () => {
    h.assertRefused(assert, await post('/config', { serperApikey: 'k' }), 'body', /"serperApikey"/);
    h.assertRefused(assert, await post('/config', { openaiApiKey: 42 }), 'body.openaiApiKey', /A setting is text/);
    assert.deepStrictEqual(db.queries, []);
});

test('only an admin may send a test e-mail from the service mailbox', async () => {
    const res = await post('/config/test-service-email', { testRecipient: 'someone@example.org' }, h.USER);
    assert.strictEqual(res.status, 403, res.text);
    assert.deepStrictEqual(writes(), []);
    h.assertRefused(assert, await post('/config/test-service-email', { to: 'someone@example.org' }), 'body', /Test recipient email is required/);
});

test('the session is checked before the body', async () => {
    const res = await post('/config', { useAzureDocProcessing: 'yes' }, null);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});
