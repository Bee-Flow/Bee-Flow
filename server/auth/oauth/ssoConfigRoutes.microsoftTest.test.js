'use strict';
/**
 * POST /providers/microsoft/test (auth/oauth/ssoConfigRoutes.js): a real
 * client-credentials token request, stubbed here at the safeFetch seam of
 * core/meetingNotes/teamsSetup/entraToken.mts. Still for the super admin only;
 * the answer keeps the `{ success, message }` / `{ error }` shape the SSO tab
 * toasts, adds the check report, and never carries the secret.
 *
 * Run: cd server && node --test auth/oauth/ssoConfigRoutes.microsoftTest.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';
const SECRET = 'fixture-not-a-secret';
const fx = { microsoft: { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT }, token: null, calls: [] };

// The real super-admin gate stays in place; only the config load is swapped.
const realSuperAdmin = require('../permissions').requireSuperAdmin;
const harness = require('../../testUtils/routeHarness');
harness.openGates({
    requireSuperAdmin: realSuperAdmin,
    loadConfig: async () => ({ providers: { microsoft: fx.microsoft } }),
});

const entra = require('../../core/meetingNotes/teamsSetup/entraToken.mts');
const teamsSetup = require('../../routes/teamsSetup.mts');
const { resetDiagnosticsSlots } = require('../../core/meetingNotes/teamsSetup/rateLimit.mts');
const router = require('./ssoConfigRoutes');

entra.init({
    safeFetch: async (url, init) => {
        fx.calls.push({ url, body: String(init.body) });
        const t = fx.token;
        return { ok: t.status === 200, status: t.status, text: async () => JSON.stringify(t.body) };
    },
});
teamsSetup.init({ identityBinding: async () => null, buildRedirectUri: () => 'https://bee.test/api/integrations/microsoft/callback' });

const ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'root', role: 'admin' } };
const MEMBER = { isAuthenticated: true, user: { id: 'u1', role: 'user', organizationId: 'org-a' } };

// The shared in-process dispatcher sends no Host header, so the public address is configured,
// as on an installation behind a proxy.
process.env.SERVER_PUBLIC_HOST = 'bee.test';
const send = harness.dispatcher(router);
const dispatch = (session) => send({ method: 'POST', url: '/providers/microsoft/test', session });

test.beforeEach(() => { resetDiagnosticsSlots(); fx.calls.length = 0; });
test.after(() => { entra.init(); teamsSetup.init(); delete process.env.SERVER_PUBLIC_HOST; });

test('a member who is not the super admin still gets 403 and no token request is made', async () => {
    fx.token = { status: 200, body: { access_token: 'fixture-access-token', expires_in: 3600 } };
    const res = await dispatch(MEMBER);
    assert.equal(res.statusCode, 403);
    assert.equal(fx.calls.length, 0);
});

test('a token from Microsoft answers 200 with success, the message and the report', async () => {
    fx.token = { status: 200, body: { access_token: 'fixture-access-token', expires_in: 3600 } };
    const res = await dispatch(ADMIN);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Microsoft accepted the app registration.');
    assert.equal(res.body.report.level, 'platform');
    assert.deepEqual(res.body.report.checks.map((c) => [c.id, c.status]), [['app.config', 'pass'], ['app.token', 'pass'], ['app.redirect_uris', 'unknown']]);
    assert.deepEqual(res.body.report.checks[2].params.uris, ['https://bee.test/auth/callback/microsoft', 'https://bee.test/api/integrations/microsoft/callback']);
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(SECRET), 'no secret in the answer');
    assert.ok(!text.includes('fixture-access-token'), 'no token in the answer');
});

test('AADSTS7000215 answers 400 with the code and the report, still without the secret', async () => {
    fx.token = { status: 401, body: { error: 'invalid_client', error_codes: [7000215], error_description: `AADSTS7000215: Invalid client secret provided for ${SECRET}` } };
    const res = await dispatch(ADMIN);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'The Microsoft app registration test failed: secret_invalid.');
    const token = res.body.report.checks.find((c) => c.id === 'app.token');
    assert.deepEqual([token.status, token.code, token.params.aadsts], ['fail', 'secret_invalid', 'AADSTS7000215']);
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
});

test('tenant common without a verified tenant: 400 that says the secret could not be tested', async () => {
    fx.microsoft = { clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' };
    try {
        const res = await dispatch(ADMIN);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'The secret could not be tested: tenant_needed.');
        assert.equal(fx.calls.length, 0);
    } finally {
        fx.microsoft = { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT };
    }
});

test('a missing client id fails on app.config without a request', async () => {
    fx.microsoft = { clientSecret: SECRET, tenantId: TENANT };
    try {
        const res = await dispatch(ADMIN);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'The Microsoft app registration test failed: client_id_missing.');
        assert.equal(fx.calls.length, 0);
    } finally {
        fx.microsoft = { clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT };
    }
});

test('a second test within the interval is refused with 429', async () => {
    fx.token = { status: 200, body: { access_token: 'fixture-access-token', expires_in: 3600 } };
    assert.equal((await dispatch(ADMIN)).statusCode, 200);
    const again = await dispatch(ADMIN);
    assert.equal(again.statusCode, 429);
    assert.equal(again.body.code, 'diagnostics_rate_limited');
});
