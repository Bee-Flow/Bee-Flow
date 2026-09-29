/**
 * What the DSR routes accept (routes/dsr.js).
 *
 *   - `notify_subject: "false"` on fulfil still e-mailed the subject: only the
 *     boolean false counted.
 *   - a misspelled `requestType` on the PUBLIC form filed the request as an
 *     access request, whatever the subject had asked for.
 *   - `?status=open` on the register filtered on a status that does not
 *     exist and answered an empty register.
 *
 * No refused request reaches the database; the admin session is checked
 * first. The verify routes keep their single `invalid_token` answer
 * (dsr.test.js).
 *
 * Run: cd server && node --test routes/dsr.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/dsr', () => require('./dsr'));

test('a misspelled key on the public form is refused, not filed as an access request', async () => {
    const res = await api.call('POST', '/api/dsr/requests', {
        body: { subject_email: 'person@example.org', requestType: 'deletion' }, user: null,
    });
    h.assertRefused(assert, res, 'body', /"requestType"/);
    assert.match(res.body.error, /It takes: subject_email, request_type, notes/);
    assert.deepStrictEqual(db.queries, []);
});

test('notify_subject is a boolean; "false" is refused rather than read as yes', async () => {
    const res = await api.call('POST', '/api/dsr/requests/7/fulfil', {
        body: { status: 'rejected', notify_subject: 'false' },
    });
    h.assertRefused(assert, res, 'body.notify_subject', /notify_subject is true or false/);
    assert.deepStrictEqual(db.queries, []);
});

test('admin bodies and queries are closed', async () => {
    h.assertRefused(assert, await api.call('GET', '/api/dsr/requests?status=open'), 'query.status', /pending, in_progress, fulfilled or rejected/);
    h.assertRefused(assert, await api.call('GET', '/api/dsr/requests/7/discovery?force=yes'), 'query.force');
    h.assertRefused(assert, await api.call('POST', '/api/dsr/requests/7/extend', { body: { reasons: 'x' } }), 'body', /"reasons"/);
    h.assertRefused(assert, await api.call('POST', '/api/dsr/requests/manual', {
        body: { subject_email: 'a@b.nl', received: '2026-09-01' },
    }), 'body', /"received"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the admin session is checked before the body', async () => {
    const res = await api.call('POST', '/api/dsr/requests/7/fulfil', { body: { notify_subject: 'false' }, user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid public status check reaches the database and answers as before', async () => {
    const res = await api.call('GET', '/api/dsr/requests/7/public?email=person%40example.org', { user: null });
    assert.strictEqual(res.status, 404, res.text);
    assert.deepStrictEqual(res.body, { error: 'not found' });
    assert.ok(db.queries.some((q) => /FROM dsr_requests/.test(q)));
});
