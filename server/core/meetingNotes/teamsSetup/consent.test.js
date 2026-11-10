'use strict';
/**
 * The admin consent link: the exact v2 URL, which tenant it asks, the trust
 * rules of the callback and the stored outcome per organisation.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/consent.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const consent = require('./consent.mts');

const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SUB_CLIENT = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CALLER = '99999999-8888-7777-6666-555555555555';
const SECRET = 'fixture-not-a-secret';
const cfg = (microsoft) => ({ providers: { microsoft } });

test('the URL is the v2 admin consent endpoint with the encoded .default scope', () => {
    const url = consent.buildAdminConsentUrl({ tenantId: TENANT, clientId: CLIENT, redirectUri: 'https://bee.test/api/integrations/microsoft/callback', state: 'abc123' });
    assert.equal(url, `https://login.microsoftonline.com/${TENANT}/v2.0/adminconsent?client_id=${CLIENT}`
        + '&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default'
        + '&redirect_uri=https%3A%2F%2Fbee.test%2Fapi%2Fintegrations%2Fmicrosoft%2Fcallback&state=abc123');
    assert.throws(() => consent.buildAdminConsentUrl({ tenantId: 'common', clientId: CLIENT, redirectUri: 'x', state: 's' }), TypeError);
});

test('tenant rules: configured GUID, the caller tenant for a multi-tenant app, never consumers', () => {
    const base = { clientId: CLIENT, clientSecret: SECRET };
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base, tenantId: TENANT.toUpperCase() }), CALLER), { ok: true, tenantId: TENANT, tenantSource: 'configured' });
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base, tenantId: 'common' }), CALLER), { ok: true, tenantId: CALLER, tenantSource: 'your_account' });
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base, tenantId: 'organizations' }), CALLER), { ok: true, tenantId: CALLER, tenantSource: 'your_account' });
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base }), null), { ok: false, reason: 'tenant_unknown' }, 'blank = common, no caller tenant');
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base, tenantId: 'common' }), 'not-a-guid'), { ok: false, reason: 'tenant_unknown' });
    assert.deepEqual(consent.consentTenantFor(cfg({ ...base, tenantId: 'consumers' }), CALLER), { ok: false, reason: 'tenant_consumers' });
    assert.deepEqual(consent.consentTenantFor(cfg({ clientId: CLIENT, tenantId: TENANT }), CALLER), { ok: false, reason: 'app_not_configured' });
    assert.deepEqual(consent.consentTenantFor(cfg({}), CALLER), { ok: false, reason: 'app_not_configured' });
});

test('the client id is the registration pinned to the tenant, else the primary', () => {
    const config = cfg({ clientId: CLIENT, clientSecret: SECRET, tenantId: 'common',
        connections: [{ id: 'sub', label: 'Sub', logo: '', clientId: SUB_CLIENT, clientSecret: SECRET, tenantId: CALLER }] });
    assert.equal(consent.consentClientId(config, CALLER), SUB_CLIENT);
    assert.equal(consent.consentClientId(config, TENANT), CLIENT);
});

test('a pending request: 64 hex characters of state, 30 minutes, lower-cased tenant', () => {
    const p = consent.newPendingConsent('org-a', TENANT.toUpperCase(), 1000);
    assert.match(p.state, /^[0-9a-f]{64}$/);
    assert.equal(p.expiresAt, 1000 + 30 * 60_000);
    assert.equal(p.tenantId, TENANT);
    assert.notEqual(consent.newPendingConsent('org-a', TENANT).state, p.state);
});

test('the callback is trusted only with a matching, fresh state of the same org, for an admin', () => {
    const pending = { state: 's'.repeat(64), orgId: 'org-a', tenantId: TENANT, expiresAt: 10_000 };
    const ok = { pending, state: 's'.repeat(64), userId: 'u1', sessionOrgId: 'org-a', isOrgAdmin: true, now: 5000 };
    assert.equal(consent.callbackIsTrusted(ok), true);
    assert.equal(consent.callbackIsTrusted({ ...ok, state: 't'.repeat(64) }), false, 'wrong state');
    assert.equal(consent.callbackIsTrusted({ ...ok, state: 's' }), false, 'shorter state');
    assert.equal(consent.callbackIsTrusted({ ...ok, state: ['s'.repeat(64)] }), false, 'array state');
    assert.equal(consent.callbackIsTrusted({ ...ok, now: 10_001 }), false, 'expired');
    assert.equal(consent.callbackIsTrusted({ ...ok, userId: null }), false, 'no session user');
    assert.equal(consent.callbackIsTrusted({ ...ok, pending: undefined }), false, 'nothing pending');
    assert.equal(consent.callbackIsTrusted({ ...ok, sessionOrgId: 'org-b' }), false, 'another org by now');
    assert.equal(consent.callbackIsTrusted({ ...ok, isOrgAdmin: false }), false, 'no longer admin');
});

test("the callback's outcome: granted only for the asked tenant, denied keeps only the error name and the AADSTS code", () => {
    assert.deepEqual(consent.outcomeOfCallback({ admin_consent: 'True', tenant: TENANT.toUpperCase() }, TENANT), { outcome: 'granted' });
    assert.deepEqual(consent.outcomeOfCallback({ admin_consent: 'True', tenant: CALLER }, TENANT), { outcome: 'tenant_mismatch' });
    assert.deepEqual(consent.outcomeOfCallback({ admin_consent: 'False', tenant: TENANT }, TENANT), { outcome: 'tenant_mismatch' });
    assert.deepEqual(consent.outcomeOfCallback({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent for member@fixture.test' }, TENANT),
        { outcome: 'denied', error: 'access_denied', aadsts: 'AADSTS65004' });
    assert.deepEqual(consent.outcomeOfCallback({ error: '<script>' }, TENANT), { outcome: 'denied', error: 'unknown', aadsts: null });
});

test('record and read round trip under org_<id>_teams_admin_consent, without a user id', async () => {
    const store = new Map();
    consent.init({ configStore: { getConfig: async (k) => store.get(k) ?? null, setConfig: async (k, v) => { store.set(k, v); } } });
    try {
        await consent.recordAdminConsentOutcome('org-a', { outcome: 'denied', error: 'access_denied', aadsts: 'AADSTS65004', tenantId: TENANT.toUpperCase(), byUserId: 'u1' });
        assert.deepEqual([...store.keys()], ['org_org-a_teams_admin_consent']);
        const read = await consent.readAdminConsentOutcome('org-a');
        assert.equal(read.outcome, 'denied');
        assert.equal(read.error, 'access_denied');
        assert.equal(read.aadsts, 'AADSTS65004');
        assert.equal(read.tenantId, TENANT);
        assert.match(read.at, /^\d{4}-\d\d-\d\dT/);
        assert.doesNotMatch(JSON.stringify(read), /u1/);
        assert.equal(await consent.readAdminConsentOutcome('org-b'), null);
        await consent.recordAdminConsentOutcome('org-a', { outcome: 'granted', error: 'ignored', tenantId: TENANT });
        assert.deepEqual({ ...(await consent.readAdminConsentOutcome('org-a')), at: 'x' }, { outcome: 'granted', error: null, aadsts: null, tenantId: TENANT, at: 'x' });
    } finally {
        consent.init();
    }
});

test('the org checks: consent link availability and the recorded answer', () => {
    const base = { clientId: CLIENT, clientSecret: SECRET };
    assert.equal(consent.consentLinkOutcome(cfg({ ...base, tenantId: TENANT }), null).status, 'pass');
    assert.equal(consent.consentLinkOutcome(cfg({ ...base, tenantId: 'common' }), null).code, 'tenant_unknown');
    assert.equal(consent.consentLinkOutcome(cfg({ ...base, tenantId: 'consumers' }), null).status, 'warn');
    assert.equal(consent.consentLinkOutcome(cfg({}), null).code, 'app_not_configured');
    assert.equal(consent.adminConsentOutcome(null).code, 'consent_not_recorded');
    assert.deepEqual(consent.adminConsentOutcome({ outcome: 'granted', at: 'T', tenantId: TENANT }).params, { at: 'T', tenantId: TENANT });
    assert.deepEqual(consent.adminConsentOutcome({ outcome: 'denied', error: 'access_denied', aadsts: null, at: 'T' }).params, { error: 'access_denied', at: 'T' });
    assert.equal(consent.adminConsentOutcome({ outcome: 'tenant_mismatch', at: 'T' }).code, 'consent_tenant_mismatch');
});
