'use strict';
/**
 * The platform test of the Microsoft app registration (catalogue 3.1).
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/appRegistration.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const entra = require('./entraToken.mts');
const { testAppRegistration, tokenOutcome } = require('./appRegistration.mts');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CALLER_TENANT = '99999999-8888-7777-6666-555555555555';
const SECRET = 'fixture-not-a-secret';
const URIS = { signIn: 'https://bee.test/auth/callback/microsoft', connect: 'https://bee.test/api/integrations/microsoft/callback' };
const cfg = (microsoft) => ({ providers: { microsoft } });

let calls;
function answer(fn) {
    calls = [];
    entra.init({ safeFetch: async (url, init) => { calls.push({ url, init }); return fn(url, init); } });
}
const ok = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fixture-access-token', expires_in: 3600 }) });
const refuse = (codes) => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client', error_codes: codes, error_description: `AADSTS${codes[0]}: secret for ${SECRET}` }) });
const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test.afterEach(() => entra.init());

test('a configured GUID tenant and a working secret: app.token passes against that tenant', async () => {
    answer(ok);
    const report = await testAppRegistration({ config: cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT }), callerTenantId: CALLER_TENANT, redirectUris: URIS });
    const c = byId(report);
    assert.equal(report.level, 'platform');
    assert.deepEqual(report.checks.map((x) => x.id), ['app.config', 'app.token', 'app.redirect_uris']);
    assert.equal(c['app.config'].status, 'pass');
    assert.deepEqual(c['app.config'].params, { tenantMode: 'single' });
    assert.equal(c['app.token'].status, 'pass');
    assert.deepEqual(c['app.token'].params, { tenantSource: 'configured', tenantId: TENANT });
    assert.match(calls[0].url, new RegExp(`/${TENANT}/oauth2/v2.0/token$`));
    assert.equal(c['app.redirect_uris'].status, 'unknown');
    assert.deepEqual(c['app.redirect_uris'].params, { uris: [URIS.signIn, URIS.connect] });
    assert.equal(report.overall, 'warn', 'the manual redirect check keeps it at warn');
});

test('tenant common without a verified caller tenant: tenant_needed, and no request is made', async () => {
    answer(ok);
    const report = await testAppRegistration({ config: cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: 'common' }), callerTenantId: null, redirectUris: URIS });
    const token = byId(report)['app.token'];
    assert.equal(token.status, 'unknown');
    assert.equal(token.code, 'tenant_needed');
    assert.deepEqual(token.params, { tenantMode: 'common' });
    assert.equal(token.remediation, 'teams_setup.fix.sign_in_with_microsoft_or_set_tenant');
    assert.equal(calls.length, 0);
});

test('tenant common with a verified caller tenant: the token comes from the caller tenant', async () => {
    answer(ok);
    const report = await testAppRegistration({ config: cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: 'organizations' }), callerTenantId: CALLER_TENANT.toUpperCase() });
    assert.deepEqual(byId(report)['app.token'].params, { tenantSource: 'your_account', tenantId: CALLER_TENANT });
    assert.match(calls[0].url, new RegExp(CALLER_TENANT));
});

test('AADSTS7000222 is secret_expired, and the secret is nowhere in the report', async () => {
    answer(() => refuse([7000222]));
    const report = await testAppRegistration({ config: cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT }), callerTenantId: null, redirectUris: URIS });
    const token = byId(report)['app.token'];
    assert.equal(token.status, 'fail');
    assert.equal(token.code, 'secret_expired');
    assert.deepEqual(token.params, { aadsts: 'AADSTS7000222' });
    assert.equal(token.remediation, 'teams_setup.fix.new_client_secret');
    assert.equal(token.fixer, 'platform_admin');
    assert.equal(report.overall, 'fail');
    assert.doesNotMatch(JSON.stringify(report), new RegExp(SECRET));
});

test('app.config failures skip the token check', async () => {
    answer(ok);
    const cases = [
        [{ clientSecret: SECRET }, 'client_id_missing'],
        [{ clientId: 'not-a-guid', clientSecret: SECRET }, 'client_id_invalid'],
        [{ clientId: CLIENT }, 'secret_missing'],
        [{ clientId: CLIENT, clientSecret: SECRET, tenantId: 'contoso.example' }, 'tenant_invalid'],
        [{ clientId: CLIENT, clientSecret: SECRET, tenantId: 'consumers' }, 'tenant_consumers'],
    ];
    for (const [microsoft, code] of cases) {
        const c = byId(await testAppRegistration({ config: cfg(microsoft), callerTenantId: CALLER_TENANT }));
        assert.equal(c['app.config'].code, code);
        assert.equal(c['app.token'].status, 'skipped', code);
        assert.deepEqual(c['app.token'].params, { prerequisite: 'app.config' });
    }
    assert.equal(byId(await testAppRegistration({ config: cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: 'consumers' }), callerTenantId: null }))['app.config'].status, 'warn');
    assert.equal(calls.length, 0);
});

test('an unreachable token endpoint and a timeout are told apart', async () => {
    answer(() => { throw new Error('ECONNREFUSED'); });
    const config = cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: TENANT });
    assert.equal((await tokenOutcome({ config, callerTenantId: null, primaryOnly: true })).code, 'entra_unreachable');
    answer(() => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; });
    const timedOut = await tokenOutcome({ config, callerTenantId: null, primaryOnly: true });
    assert.equal(timedOut.status, 'unknown');
    assert.equal(timedOut.code, 'probe_timeout');
});
