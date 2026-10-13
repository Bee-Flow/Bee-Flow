/**
 * What the tenant Support studio's tag, canned-reply and SLA writes tell the
 * client when something goes wrong (routes/supportInbox.js).
 *
 * Every failure used to answer `400 { error: err.message }`: a database that
 * was down read as the caller's mistake, and a unique violation handed the
 * client the index name and the query text. The refusals a caller can cause
 * keep their 400 and their sentence; anything else is the terminal handler's
 * generic 500 with a correlationId.
 *
 * Run: cd server && node --test routes/supportInbox.errors.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// The store derives its token key from this at load; any 32 characters will do.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

/** @type {null | ((sql: string) => Error | null)} */
let failWith = null;
const { api } = h.routeUnderTest(test, '/api/support-inbox', () => require('./supportInbox'), {
    gates: { resolveUserOrgIds: async () => new Set(['org1']) },
    answer: (sql) => {
        // Only the reads and writes a request makes; the stores' schema set-up is left alone.
        const err = failWith && /^\s*(INSERT|UPDATE|DELETE|SELECT)\b/i.test(sql) && failWith(sql);
        if (err) throw err;
        return undefined;
    },
});
test.afterEach(() => { failWith = null; });

const pgError = (code, message) => Object.assign(new Error(message), { code, severity: 'ERROR' });
const DOWN = () => pgError('57P01', 'terminating connection due to administrator command on db-primary.internal:5432');
const LEAKS = /terminating|db-primary|5432|uq_|duplicate key|invalid input syntax|support_/;

function assertGeneric500(res) {
    assert.strictEqual(res.status, 500, res.text);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the client can quote a correlationId');
    assert.doesNotMatch(res.text, LEAKS);
}

test('a database failure is a 500 without its text, not a 400 echoing it', async () => {
    failWith = (sql) => (/support_tag_taxonomy|support_canned_responses|support_sla_policies/.test(sql) ? DOWN() : null);
    assertGeneric500(await api.call('POST', '/api/support-inbox/tags', { body: { name: 'billing' } }));
    assertGeneric500(await api.call('DELETE', '/api/support-inbox/tags/5b0a7c1e-0000-4000-8000-000000000001'));
    assertGeneric500(await api.call('POST', '/api/support-inbox/canned', { body: { title: 'Hi', body: 'Hello' } }));
    assertGeneric500(await api.call('PUT', '/api/support-inbox/canned/5b0a7c1e-0000-4000-8000-000000000001', { body: { title: 'Hi' } }));
    assertGeneric500(await api.call('DELETE', '/api/support-inbox/canned/5b0a7c1e-0000-4000-8000-000000000001'));
    assertGeneric500(await api.call('PUT', '/api/support-inbox/sla-policies', { body: { priority: 'high', firstResponseMinutes: 60, resolutionMinutes: 600 } }));
});

test('a duplicate keeps its 400, in a sentence instead of the index name', async () => {
    failWith = (sql) => (/INSERT INTO support_tag_taxonomy/.test(sql)
        ? pgError('23505', 'duplicate key value violates unique constraint "uq_tag_org_name"') : null);
    let res = await api.call('POST', '/api/support-inbox/tags', { body: { name: 'billing' } });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error, 'tag already exists');
    assert.doesNotMatch(res.text, LEAKS);

    failWith = (sql) => (/support_canned_responses/.test(sql) && /INSERT|UPDATE/.test(sql)
        ? pgError('23505', 'duplicate key value violates unique constraint "uq_support_canned_shortcut"') : null);
    res = await api.call('POST', '/api/support-inbox/canned', { body: { title: 'Hi', body: 'Hello', shortcut: '/hi' } });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error, 'shortcut already in use');
    res = await api.call('PUT', '/api/support-inbox/canned/5b0a7c1e-0000-4000-8000-000000000001', { body: { shortcut: '/hi' } });
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error, 'shortcut already in use');
    assert.doesNotMatch(res.text, LEAKS);
});

test('an id that is not a uuid keeps its 400, without echoing the query error', async () => {
    failWith = (sql) => (/support_tag_taxonomy|support_canned_responses/.test(sql)
        ? pgError('22P02', 'invalid input syntax for type uuid: "nope"') : null);
    for (const [method, url, body] of [
        ['DELETE', '/api/support-inbox/tags/nope'],
        ['PUT', '/api/support-inbox/canned/nope', { title: 'Hi' }],
        ['DELETE', '/api/support-inbox/canned/nope'],
    ]) {
        const res = await api.call(method, url, body ? { body } : {});
        assert.strictEqual(res.status, 400, `${method} ${url}: ${res.text}`);
        assert.strictEqual(res.body.error, 'Invalid id');
        assert.doesNotMatch(res.text, LEAKS);
    }
});

test('a write that works answers as before', async () => {
    const res = await api.call('DELETE', '/api/support-inbox/tags/5b0a7c1e-0000-4000-8000-000000000001');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { ok: true });
});
