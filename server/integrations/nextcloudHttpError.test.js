// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextcloudHttpError, extractReason } = require('./nextcloudHttpError');

const res = (status, body = '') => ({ status, text: async () => body });
const AUTH = 'Bee Flow connector could not reach Nextcloud';

test('401 is the connector message, nothing else', async () => {
    assert.deepStrictEqual(await nextcloudHttpError(res(401), { authError: AUTH, what: 'x' }), { error: AUTH });
});

test('403 is a permission error with the OCS reason, not the connector message', async () => {
    const body = JSON.stringify({ ocs: { meta: { status: 'failure', message: 'Only the owner may do this' } } });
    const { error } = await nextcloudHttpError(res(403, body), { authError: AUTH, what: 'team update' });
    assert.match(error, /Permission denied/);
    assert.match(error, /Only the owner may do this/);
    assert.ok(!error.includes('could not reach'));
    assert.ok(!error.includes('{'), 'no raw JSON');
});

test('404 with a reason says not found; without one it hedges between id and app', async () => {
    const withReason = await nextcloudHttpError(res(404, '{"message":"Form not found"}'), { authError: AUTH, what: 'form lookup', app: 'Forms' });
    assert.match(withReason.error, /Not found for form lookup: Form not found/);
    assert.ok(!withReason.error.includes('not installed'));
    const bare = await nextcloudHttpError(res(404, '<html>x</html>'), { authError: AUTH, what: 'form lookup', app: 'Forms' });
    assert.match(bare.error, /id may be wrong/);
    assert.match(bare.error, /"Forms" app/);
});

test('5xx never echoes the body', async () => {
    const { error } = await nextcloudHttpError(res(500, 'SQLSTATE[42S22]: oc_tables_x column missing'), { authError: AUTH, what: 'row create' });
    assert.match(error, /\(500\)/);
    assert.ok(!/SQLSTATE|oc_tables/.test(error));
});

test('a Sabre XML message is read', () => {
    assert.strictEqual(extractReason('<d:error><s:message>Locked</s:message></d:error>'), 'Locked');
});

test('XML entities in a Sabre message are decoded', () => {
    assert.strictEqual(extractReason('<s:message>Can&apos;t &quot;lock&quot; &lt;a&gt; &amp; b</s:message>'), 'Can\'t "lock" <a> & b');
});

test('502/503/504 read as unreachable, 500 as an internal error, neither echoes the body', async () => {
    for (const status of [502, 503, 504]) {
        const { error } = await nextcloudHttpError(res(status, 'SQLSTATE secret'), { authError: AUTH, what: 'x' });
        assert.match(error, /could not be reached or is temporarily unavailable/);
        assert.ok(!error.includes('SQLSTATE'));
    }
    const { error } = await nextcloudHttpError(res(500, 'SQLSTATE secret'), { authError: AUTH, what: 'x' });
    assert.match(error, /internal error/);
});

test('a 403 that is the AppAPI signature failure is the connector message', async () => {
    const body = JSON.stringify({ message: 'AppAPI authentication failed' });
    assert.deepStrictEqual(await nextcloudHttpError(res(403, body), { authError: AUTH, what: 'x' }), { error: AUTH });
    const code = JSON.stringify({ ocs: { meta: { statuscode: 997, message: 'Unauthorised' } } });
    assert.deepStrictEqual(await nextcloudHttpError(res(403, code), { authError: AUTH, what: 'x' }), { error: AUTH });
});
