/**
 * Data Act Art. 25(2)(d) notice period: self-hosted → n/a (unless the org
 * resells), cloud without a declared platform value → warn, > 60 d → fail,
 * ≤ 60 d → pass, the org's own contract judged the same way with the worse
 * status winning, relevance gate, no personal data in evidence.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/data-act/art25-notice-period.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const state = { settings: {}, billing: null, billingError: null, mode: 'cloud', licenseShape: 'governs' };
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeConfigStore = {
    async getConfig(key) {
        assert.equal(key, 'billing');
        if (state.billingError) throw state.billingError;
        return state.billing;
    },
};
// The real licence module exports serverLicenseGovernsOrgs() (true ⇔ self-hosted),
// not deploymentMode(); the check must cope with either shape.
const fakeLicense = {
    get deploymentMode() { return state.licenseShape === 'mode' ? () => state.mode : undefined; },
    get serverLicenseGovernsOrgs() { return state.licenseShape === 'governs' ? () => state.mode === 'self-hosted' : undefined; },
};
const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../../stores/configStore': fakeConfigStore,
    '../../../license': fakeLicense,
});
const check = require('./art25-notice-period');
test.after(() => restore());

test.beforeEach(() => {
    state.settings = { framework_relevance: {}, data_act_provider_role: false, notice_period_days: null };
    state.billing = null;
    state.billingError = null;
    state.mode = 'cloud';
    state.licenseShape = 'governs';
    delete process.env.DEPLOYMENT_MODE;
});

test('module shape', () => {
    assert.equal(check.id, 'DATA_ACT-Art25-notice-period');
    assert.equal(check.regulation, 'DATA_ACT');
    assert.equal(check.article, '25(2)(d)');
    assert.equal(check.severity, 'medium');
    assert.equal(check.verification, 'hybrid');
    assert.deepEqual(check.frameworks, []);
    assert.equal(check.remediationLink, 'admin/compliance/settings');
    assert.equal(check.titleKey, 'compliance.check_data_act_notice_period_title');
    assert.equal(check._test.MAX_NOTICE_DAYS, 60);
});

test('relevance gate', async () => {
    state.settings.framework_relevance = { data_act: 'not_relevant' };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('self-hosted → not_applicable (no cloud switching contract), via either licence export shape or the env var', async () => {
    state.mode = 'self-hosted';
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.deployment_mode, 'self-hosted');
    state.licenseShape = 'mode';
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    state.licenseShape = 'none';
    process.env.DEPLOYMENT_MODE = 'private-cloud';
    assert.equal(check._test._deploymentMode(), 'self-hosted', 'retired private-cloud mode reads as self-hosted');
    delete process.env.DEPLOYMENT_MODE;
    assert.equal(check._test._deploymentMode(), 'cloud', 'default is cloud');
});

test('an unknown deployment mode without a provider role → not_applicable, not a crash', async () => {
    state.licenseShape = 'mode';
    state.mode = 'staging';
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.deployment_mode, 'staging');
    assert.deepEqual(Object.keys(r.evidence).sort(), ['deployment_mode', 'max_notice_days', 'org_provider_role']);
});

test('cloud, platform value not declared → warn', async () => {
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.platform_notice_period_days, null);
    assert.match(r.details, /platform's notice period .* is not declared/);
    state.billing = { notice_period_days: 'abc' };
    assert.equal((await check.evaluate('org-1')).status, 'warn', 'a non-numeric value is "not declared"');
    state.billingError = new Error('config down');
    assert.equal((await check.evaluate('org-1')).status, 'warn', 'a failing config read never throws');
});

test('cloud, platform value > 60 days → fail; ≤ 60 → pass', async () => {
    state.billing = { notice_period_days: 90 };
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.platform_notice_period_days, 90);
    assert.match(r.details, /is 90 days .* caps the switching notice at two months \(60 days\)/);
    state.billing = { notice_period_days: '60' };
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.platform_notice_period_days, 60);
    state.billing = { notice_period_days: 0 };
    assert.equal((await check.evaluate('org-1')).status, 'pass', 'no notice at all is fine');
});

test('the organisation as provider: its own period is judged too and the worse status wins', async () => {
    state.billing = { notice_period_days: 30 };
    state.settings.data_act_provider_role = true;
    state.settings.notice_period_days = 120;
    let r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.org_provider_role, true);
    assert.equal(r.evidence.org_notice_period_days, 120);
    assert.equal(r.evidence.platform_notice_period_days, 30);
    assert.match(r.details, /organisation's own customer notice period is 120 days/);
    assert.ok(!/platform's notice period is/.test(r.details), 'only the failing contract is named');

    state.settings.notice_period_days = null;
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /organisation's own customer notice period is not declared/);

    state.settings.notice_period_days = 45;
    r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.contracts.length, 2);
    assert.match(r.details, /platform's notice period \(billing settings\) is 30 days; this organisation's own customer notice period is 45 days/);
});

test('self-hosted org that resells the service: only its own contract is judged', async () => {
    state.mode = 'self-hosted';
    state.settings.data_act_provider_role = true;
    state.settings.notice_period_days = 61;
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.contracts.map(c => c.party), ['organisation']);
    assert.equal(r.evidence.platform_notice_period_days, null);
});

test('evidence carries numbers and modes only', async () => {
    state.billing = { notice_period_days: 30, stripe_customer_email: 'billing@example.org' };
    const r = await check.evaluate('org-1');
    assert.ok(!/@/.test(JSON.stringify(r)));
    assert.deepEqual(Object.keys(r.evidence).sort(), ['contracts', 'deployment_mode', 'max_notice_days', 'org_notice_period_days', 'org_provider_role', 'platform_notice_period_days']);
});
