'use strict';
/**
 * The organisation app token: asked at the organisation's own tenant endpoint
 * (never common), only for the verified tenant, cached per client id and
 * tenant, refused when its tid claim names another tenant; the session it
 * gives addresses one covered user of THAT tenant and has nothing to refresh
 * with. Also the poller's resolver.
 *
 * Run: cd server && node --test core/meetingNotes/teamsAppImport/appToken.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const appToken = require('./appToken.mts');
const entraToken = require('../teamsSetup/entraToken.mts');

const T = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const OID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIENT = 'cccccccc-0000-0000-0000-000000000001';
const PINNED = 'dddddddd-0000-0000-0000-000000000002';
const CONFIG = { providers: { microsoft: { clientId: CLIENT, clientSecret: 'fixture-not-a-secret', tenantId: 'common',
    connections: [{ id: 'other', label: 'Other', logo: '', clientId: PINNED, clientSecret: 'fixture-not-a-secret-2', tenantId: OTHER }] } } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;

function setup({ tid = T, roles = ['OnlineMeetings.Read.All', 'OnlineMeetingTranscript.Read.All'], verified = { ok: true, tenantId: T, source: 'directory_binding' }, coverageResult } = {}) {
    const fetches = [];
    entraToken.init({
        safeFetch: async (url, init) => {
            fetches.push({ url, body: String(init.body) });
            return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: jwt({ tid, roles }), expires_in: 3600 }) };
        },
    });
    const warns = [];
    appToken.init({
        loadConfig: async () => CONFIG,
        orgTenant: async () => verified,
        coverageForUser: async () => coverageResult || { covered: true, tenantId: T, objectId: OID },
        log: { warn: (...a) => warns.push(a.join(' ')) },
    });
    return { fetches, warns };
}

test.afterEach(() => { appToken.init(); entraToken.init(); });

test("asked at the organisation's tenant endpoint with the registration that serves it; never common", async () => {
    const { fetches } = setup();
    const t = await appToken.getAppToken({ orgId: 'org-a', tenantId: T });
    assert.equal(t.ok, true);
    assert.equal(t.tenantId, T);
    assert.equal(t.clientId, CLIENT);
    assert.deepEqual(t.roles, ['OnlineMeetings.Read.All', 'OnlineMeetingTranscript.Read.All']);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, `https://login.microsoftonline.com/${T}/oauth2/v2.0/token`);
    assert.ok(!fetches.some((f) => f.url.includes('/common/') || f.url.includes('/organizations/')));
    assert.match(fetches[0].body, /grant_type=client_credentials/);

    for (const tenantId of ['common', 'organizations', '', 'not-a-guid']) {
        const r = await appToken.getAppToken({ orgId: 'org-a', tenantId });
        assert.equal(r.ok, false, tenantId);
    }
    assert.equal(fetches.length, 1, 'no request for a non-GUID tenant');
});

test('a tenant that is not the organisation verified tenant gets no token and no request', async () => {
    const { fetches } = setup({ verified: { ok: true, tenantId: T, source: 'directory_binding' } });
    const r = await appToken.getAppToken({ orgId: 'org-a', tenantId: OTHER });
    assert.deepEqual(r, { ok: false, result: { kind: 'tenant_not_verified' } });
    assert.equal(fetches.length, 0);
    const unbound = setup({ verified: { ok: false, reason: 'tenant_not_bound' } });
    assert.equal((await appToken.getAppToken({ orgId: 'org-a', tenantId: T })).ok, false);
    assert.equal(unbound.fetches.length, 0);
});

test('cached per client id and tenant while more than 10 minutes are left', async () => {
    const { fetches } = setup({ tid: OTHER, verified: { ok: true, tenantId: OTHER, source: 'directory_binding' } });
    const now = Date.now();
    const a = await appToken.getAppToken({ orgId: 'org-b', tenantId: OTHER, now });
    assert.equal(a.clientId, PINNED, 'the connection pinned to that tenant');
    await appToken.getAppToken({ orgId: 'org-b', tenantId: OTHER, now: now + 40 * 60_000 });
    assert.equal(fetches.length, 1, 'reused');
    await appToken.getAppToken({ orgId: 'org-b', tenantId: OTHER, now: now + 51 * 60_000 });
    assert.equal(fetches.length, 2, 'renewed with less than 10 minutes left');
});

test('a token whose tid claim is another tenant is refused and not cached', async () => {
    const { fetches, warns } = setup({ tid: OTHER });
    const r = await appToken.getAppToken({ orgId: 'org-a', tenantId: T });
    assert.deepEqual(r, { ok: false, result: { kind: 'tenant_mismatch' } });
    assert.equal(warns.length, 1);
    assert.ok(!warns[0].includes('eyJ'), 'the token is not logged');
    await appToken.getAppToken({ orgId: 'org-a', tenantId: T });
    assert.equal(fetches.length, 2, 'not cached');
});

test('appSessionFor: one covered user of the token tenant, no refresh token, no save', () => {
    const s = appToken.appSessionFor({ covered: true, tenantId: T, objectId: OID }, { accessToken: 'fixture-access-token', tenantId: T });
    assert.deepEqual(s, { accessToken: 'fixture-access-token', graphUserPath: `/users/${OID}`, appOnly: true });
    assert.equal('refreshToken' in s, false);
    assert.equal('save' in s, false);
    assert.throws(() => appToken.appSessionFor({ covered: true, tenantId: OTHER, objectId: OID }, { accessToken: 'x', tenantId: T }), /another tenant/);
    assert.throws(() => appToken.appSessionFor({ covered: false, reason: 'other_tenant' }, { accessToken: 'x', tenantId: T }), /covered/);
    assert.throws(() => appToken.appSessionFor({ covered: true, tenantId: T, objectId: '../me' }, { accessToken: 'x', tenantId: T }), /object id/);
});

test('resolveAppImportSession: not covered asks no token; covered gives the session and the transcript flag from roles', async () => {
    let r = (setup({ coverageResult: { covered: false, reason: 'other_organisation' } }), await appToken.resolveAppImportSession('u-x', 'org-a'));
    assert.deepEqual(r, { status: 'not_covered', reason: 'other_organisation' });
    const { fetches } = setup();
    r = await appToken.resolveAppImportSession('u-amy', 'org-a', { fresh: true });
    assert.equal(r.status, 'covered');
    assert.equal(r.session.graphUserPath, `/users/${OID}`);
    assert.equal(r.transcriptAllowed, true);
    assert.equal(fetches.length, 1);
    setup({ roles: ['OnlineMeetings.Read.All'] });
    assert.equal((await appToken.resolveAppImportSession('u-amy', 'org-a')).transcriptAllowed, false);
    setup({ roles: null });
    assert.equal((await appToken.resolveAppImportSession('u-amy', 'org-a')).transcriptAllowed, false, 'unreadable roles: no transcripts');
});

test('resolveAppImportSession: a refused token is token_failed, logged without the body', async () => {
    const warns = [];
    entraToken.init({ safeFetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'invalid_client', error_codes: [7000215], error_description: 'Fixture subject 7' }) }) });
    appToken.init({
        loadConfig: async () => CONFIG,
        orgTenant: async () => ({ ok: true, tenantId: T, source: 'single_org' }),
        coverageForUser: async () => ({ covered: true, tenantId: T, objectId: OID }),
        log: { warn: (...a) => warns.push(a.join(' ')) },
    });
    assert.deepEqual(await appToken.resolveAppImportSession('u-amy', 'org-a'), { status: 'token_failed' });
    assert.match(warns[0], /AADSTS7000215/);
    assert.ok(!warns[0].includes('Fixture subject 7'));
});
