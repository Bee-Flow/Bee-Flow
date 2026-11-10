'use strict';
/**
 * The client-credentials token request: it goes through safeFetch (stubbed
 * here through the module's init seam), sends the documented form body, keeps
 * only the AADSTS number and the allow-listed OAuth error of a refusal, and
 * never returns the error description.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/entraToken.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const entra = require('./entraToken.mts');

const TENANT = '11111111-2222-3333-4444-555555555555';
const SECRET = 'fixture-not-a-secret';

/** A fake JWT whose payload is `claims` (header and signature are filler). */
const fakeJwt = (claims) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

function stubFetch(answer) {
    const calls = [];
    entra.init({
        safeFetch: async (url, init) => {
            calls.push({ url, init });
            return answer(url, init);
        },
    });
    return calls;
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test.afterEach(() => entra.init());

test('posts the documented client-credentials form to the tenant v2 token endpoint through safeFetch', async () => {
    const token = fakeJwt({ tid: TENANT.toUpperCase(), roles: ['Calendars.Read'] });
    const calls = stubFetch(() => reply(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' }));
    const result = await entra.requestClientCredentialsToken({ clientId: 'client-a', clientSecret: SECRET, tenantId: TENANT.toUpperCase(), timeoutMs: 5000 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[0].init.body);
    assert.deepEqual(Object.fromEntries(form), {
        grant_type: 'client_credentials', client_id: 'client-a', client_secret: SECRET, scope: 'https://graph.microsoft.com/.default',
    });
    assert.ok(calls[0].init.signal, 'a timeout signal');
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, token);
    assert.deepEqual(result.roles, ['Calendars.Read']);
    assert.equal(result.tokenTenantId, TENANT);
    assert.ok(result.expiresAt > Date.now() + 3500_000);
});

test('a timeout of 0 sends no abort signal', async () => {
    const calls = stubFetch(() => reply(200, { access_token: fakeJwt({}), expires_in: 60 }));
    await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT, timeoutMs: 0 });
    assert.equal(calls[0].init.signal, undefined);
});

test('a refusal keeps error_codes[0] and the allow-listed error, and drops the description', async () => {
    stubFetch(() => reply(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000222: The provided client secret keys for app fixture-app are expired. Trace ID: abc',
        error_codes: [7000222],
        trace_id: 'trace', correlation_id: 'corr',
    }));
    const result = await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT });
    assert.deepEqual(result, { ok: false, kind: 'entra', httpStatus: 401, error: 'invalid_client', aadsts: 7000222 });
    assert.doesNotMatch(JSON.stringify(result), /expired|fixture-app|trace|corr/);
});

test('without error_codes the number comes from the description; an odd error name is dropped', async () => {
    stubFetch(() => reply(400, { error: 'Invalid-Client!', error_description: 'Something AADSTS700016: Application not found' }));
    const result = await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT });
    assert.deepEqual(result, { ok: false, kind: 'entra', httpStatus: 400, error: null, aadsts: 700016 });
});

test('an unreadable refusal body is an entra error without code', async () => {
    stubFetch(() => reply(500, '<html>oops</html>'));
    const result = await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT });
    assert.deepEqual(result, { ok: false, kind: 'entra', httpStatus: 500, error: null, aadsts: null });
});

test('a fetch failure is kind network; a timeout says so', async () => {
    stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'); });
    assert.deepEqual(await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT }), { ok: false, kind: 'network' });
    stubFetch(() => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; });
    assert.deepEqual(await entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId: TENANT }), { ok: false, kind: 'network', timedOut: true });
});

test('a non-GUID tenant is refused before any request', async () => {
    const calls = stubFetch(() => reply(200, {}));
    for (const tenantId of ['common', 'organizations', 'contoso.onmicrosoft.com', '', '../evil']) {
        await assert.rejects(() => entra.requestClientCredentialsToken({ clientId: 'c', clientSecret: SECRET, tenantId }), TypeError);
    }
    assert.equal(calls.length, 0);
});

test('readTokenClaims reads roles and tid from a fake JWT and survives garbage', () => {
    assert.deepEqual(entra.readTokenClaims(fakeJwt({ roles: ['A', 'B'], tid: TENANT })), { roles: ['A', 'B'], tid: TENANT });
    assert.deepEqual(entra.readTokenClaims(fakeJwt({ roles: ['A', 3], tid: 'not-a-guid' })), { roles: null, tid: null });
    assert.deepEqual(entra.readTokenClaims(fakeJwt({})), { roles: null, tid: null });
    for (const junk of ['', 'abc', 'a.!!!.c', 'a.bm90IGpzb24.c', null, undefined]) {
        assert.deepEqual(entra.readTokenClaims(junk), { roles: null, tid: null });
    }
});
