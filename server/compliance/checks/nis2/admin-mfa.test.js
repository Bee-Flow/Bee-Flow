/**
 * NIS2-Art21(2)(j)-admin-mfa — admins covered by TOTP or attested SSO-MFA.
 * db / complianceStore / configStore are swapped via installResolveStub.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/admin-mfa.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const fx = { users: [], settings: {}, configs: {}, dbError: null, params: [] };

const fakeDb = {
    async getAll(sql, params) {
        fx.params.push(params);
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM users/);
        assert.match(sql, /"organizationId" = \$1/);
        const [orgId, roles] = params;
        return fx.users
            .filter(u => u.organizationId === orgId)
            .filter(u => u.role === 'admin' || roles.includes(u.orgRole))
            .filter(u => (u.status || 'active') !== 'suspended')
            .map(u => ({ id: u.id, mfa_enabled: !!u.mfa_enabled }));
    },
    async getOne() { return null; },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../../stores/configStore': { getConfig: async (k) => (k in fx.configs ? fx.configs[k] : null) },
});
const check = require('./admin-mfa');
test.after(() => restore());

const admin = (id, extra = {}) => ({ id, organizationId: ORG, role: 'user', orgRole: 'org_admin', email: `${id}@example.org`, ...extra });
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const noPii = (r) => assert.doesNotMatch(JSON.stringify(r.evidence) + ' ' + r.details, EMAIL);

test.beforeEach(() => { fx.users = []; fx.settings = {}; fx.configs = {}; fx.dbError = null; fx.params = []; });

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(j)-admin-mfa');
    assert.equal(check.regulation, 'NIS2');
    assert.equal(check.verification, 'automated');
    assert.equal(check.severity, 'high');
    assert.ok(check.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === 'A.8.5'));
    assert.ok(!check.remediationLink.includes('?'));
});

test('relevance gate: nis2 not_relevant → not_applicable', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    fx.users = [admin('u1')];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(fx.params.length, 0, 'no user query behind the gate');
});

test('no admin accounts → not_applicable', async () => {
    fx.users = [{ id: 'm1', organizationId: ORG, role: 'user', orgRole: 'member' }];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.admins_total, 0);
});

test('every admin has TOTP → pass; org-scoped query', async () => {
    fx.users = [admin('u1', { mfa_enabled: true }), admin('u2', { mfa_enabled: true, role: 'admin', orgRole: '' }),
        admin('other', { organizationId: 'org-b' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.admins_total, 2);
    assert.equal(r.evidence.mfa_enabled, 2);
    assert.equal(fx.params[0][0], ORG);
    noPii(r);
});

test('some admins without MFA → warn, ids only (≤10), no e-mail in evidence', async () => {
    fx.users = [admin('u1', { mfa_enabled: true }), admin('u2'), admin('u3')];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.uncovered_count, 2);
    assert.deepEqual(r.evidence.uncovered, ['u2', 'u3']);
    assert.match(r.details, /2 of 3/);
    noPii(r);
});

test('no admin has MFA and no SSO → fail', async () => {
    fx.users = [admin('u1'), admin('u2')];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.sso_providers, []);
});

test('no admin has MFA but SSO is configured (not attested) → warn with the attestation hint', async () => {
    fx.users = [admin('u1'), admin('u2')];
    // microsoft has a client id but no secret: not configured (lib/ssoProviders.js).
    fx.configs.providers = { google: { clientId: 'x', clientSecret: 's' }, microsoft: { clientId: 'y' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.sso_providers, ['google']);
    assert.equal(r.evidence.sso_covered, false);
    assert.match(r.details, /confirm that under Compliance/);
});

test('SSO configured AND sso_enforces_mfa attested → covered → pass', async () => {
    fx.users = [admin('u1'), admin('u2', { mfa_enabled: true })];
    fx.configs.oauth = { nextcloudUrl: 'https://nc.example.org', clientId: 'x', clientSecret: 's' };
    fx.settings = { sso_enforces_mfa: true };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.sso_covered, true);
    assert.deepEqual(r.evidence.sso_providers, ['nextcloud']);
    assert.equal(r.evidence.uncovered_count, 0);
});

test('SSO as the SSO screen saves it (client id and secret, no enabled flag) counts as configured', async () => {
    fx.users = [admin('u1')];
    fx.configs.providers = { microsoft: { clientId: 'x', clientSecret: 's', tenantId: 't' } };
    fx.settings = { sso_enforces_mfa: true };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass', 'working SSO attested to enforce MFA covers the admin');
    assert.deepEqual(r.evidence.sso_providers, ['microsoft']);
    assert.equal(r.evidence.sso_covered, true);
});

test('a provider with a client id but no secret is not SSO', async () => {
    fx.users = [admin('u1')];
    fx.configs.providers = { google: { enabled: true, clientId: 'x' } };
    fx.configs.oauth = { nextcloudUrl: 'https://nc.example.org', clientId: 'x' };
    fx.settings = { sso_enforces_mfa: true };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.sso_providers, []);
});

test('attestation without a provider does not cover anyone', async () => {
    fx.users = [admin('u1')];
    fx.settings = { sso_enforces_mfa: true };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.sso_covered, false);
});

test('suspended admins are ignored', async () => {
    fx.users = [admin('u1', { mfa_enabled: true }), admin('u2', { status: 'suspended' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.admins_total, 1);
});

test('missing mfa column (42703) → warn "not provisioned", never throws', async () => {
    fx.dbError = pgError('42703');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.provisioned, false);
    assert.match(r.details, /not provisioned/);
});

test('other db errors propagate to the runner', async () => {
    fx.dbError = Object.assign(new Error('boom'), { code: '57014', severity: 'ERROR' });
    await assert.rejects(() => check.evaluate(ORG), /boom/);
});
