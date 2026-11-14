// @typecheck
/**
 * NIS2-Art21(2)(j)-admin-mfa — admins covered by TOTP or attested SSO-MFA.
 * On a real Postgres (the boot ladder's schema on PGlite behind db.js's pool);
 * only configStore (the SSO secrets) is swapped via installResolveStub.
 *
 * Run: cd server && node --test compliance/checks/nis2/admin-mfa.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
/** @type {{ configs: Record<string, unknown> }} */
const fx = { configs: {} };

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
// The SSO provider config is stubbed: it holds client secrets, and configStore has tests of its own.
const restore = installResolveStub({
    '../../../stores/configStore': { getConfig: async (k) => (k in fx.configs ? fx.configs[k] : null) },
});
const complianceStore = require('../../../stores/complianceStore');
const check = require('./admin-mfa');
test.after(async () => { restore(); await close(); });

/** @param {...Record<string, unknown>} list */
async function users(...list) {
    for (const u of list) await insertRow(pg, 'users', { username: String(u.id), ...u });
}
const admin = (id, extra = {}) => ({ id, organizationId: ORG, role: 'user', orgRole: 'org_admin', email: `${id}@example.org`, ...extra });
const noPii = (r) => assert.doesNotMatch(JSON.stringify(r.evidence) + ' ' + r.details, EMAIL);
const settings = (patch) => complianceStore.saveSettings(ORG, patch);

test.beforeEach(async () => {
    fx.configs = {};
    await pg.exec("DELETE FROM compliance_settings; DELETE FROM users WHERE \"organizationId\" IN ('org-a', 'org-b')");
});

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(j)-admin-mfa');
    assert.equal(check.regulation, 'NIS2');
    assert.equal(check.verification, 'automated');
    assert.equal(check.severity, 'high');
    assert.ok(check.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === 'A.8.5'));
    assert.ok(!check.remediationLink.includes('?'));
});

test('relevance gate: nis2 not_relevant → not_applicable', async () => {
    await settings({ framework_relevance: { nis2: 'not_relevant' } });
    await users(admin('u1'));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('no admin accounts → not_applicable', async () => {
    await users({ id: 'm1', organizationId: ORG, role: 'user', orgRole: 'member' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.admins_total, 0);
});

test('every admin has TOTP → pass; org-scoped query', async () => {
    await users(admin('u1', { mfa_enabled: true }), admin('u2', { mfa_enabled: true, role: 'admin', orgRole: '' }),
        admin('other', { organizationId: 'org-b' }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.admins_total, 2);
    assert.equal(r.evidence.mfa_enabled, 2);
    noPii(r);
});

test('some admins without MFA → warn, ids only (≤10), no e-mail in evidence', async () => {
    await users(admin('u1', { mfa_enabled: true }), admin('u2'), admin('u3'));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.uncovered_count, 2);
    assert.deepEqual(r.evidence.uncovered, ['u2', 'u3']);
    assert.match(r.details, /2 of 3/);
    noPii(r);
});

test('no admin has MFA and no SSO → fail', async () => {
    await users(admin('u1'), admin('u2'));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.sso_providers, []);
});

test('no admin has MFA but SSO is configured (not attested) → warn with the attestation hint', async () => {
    await users(admin('u1'), admin('u2'));
    // microsoft has a client id but no secret: not configured (lib/ssoProviders.js).
    fx.configs.providers = { google: { clientId: 'x', clientSecret: 's' }, microsoft: { clientId: 'y' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.sso_providers, ['google']);
    assert.equal(r.evidence.sso_covered, false);
    assert.match(r.details, /confirm that under Compliance/);
});

test('SSO configured AND sso_enforces_mfa attested → covered → pass', async () => {
    await users(admin('u1'), admin('u2', { mfa_enabled: true }));
    fx.configs.oauth = { nextcloudUrl: 'https://nc.example.org', clientId: 'x', clientSecret: 's' };
    await settings({ sso_enforces_mfa: true });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.sso_covered, true);
    assert.deepEqual(r.evidence.sso_providers, ['nextcloud']);
    assert.equal(r.evidence.uncovered_count, 0);
});

test('SSO as the SSO screen saves it (client id and secret, no enabled flag) counts as configured', async () => {
    await users(admin('u1'));
    fx.configs.providers = { microsoft: { clientId: 'x', clientSecret: 's', tenantId: 't' } };
    await settings({ sso_enforces_mfa: true });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass', 'working SSO attested to enforce MFA covers the admin');
    assert.deepEqual(r.evidence.sso_providers, ['microsoft']);
    assert.equal(r.evidence.sso_covered, true);
});

test('a provider with a client id but no secret is not SSO', async () => {
    await users(admin('u1'));
    fx.configs.providers = { google: { enabled: true, clientId: 'x' } };
    fx.configs.oauth = { nextcloudUrl: 'https://nc.example.org', clientId: 'x' };
    await settings({ sso_enforces_mfa: true });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.sso_providers, []);
});

test('attestation without a provider does not cover anyone', async () => {
    await users(admin('u1'));
    await settings({ sso_enforces_mfa: true });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.sso_covered, false);
});

test('suspended admins are ignored', async () => {
    await users(admin('u1', { mfa_enabled: true }), admin('u2', { status: 'suspended' }));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.admins_total, 1);
});

test('missing mfa column (42703) → warn "not provisioned", never throws', async () => {
    await users(admin('u1'));
    const restore = await failReads(pg, 'users', '42703', 'column "mfa_enabled" does not exist');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.provisioned, false);
    assert.match(r.details, /not provisioned/);
});

test('other db errors propagate to the runner', async () => {
    const restore = await failReads(pg, 'users', '57014', 'boom');
    try { await assert.rejects(() => check.evaluate(ORG), /boom/); } finally { await restore(); }
});
