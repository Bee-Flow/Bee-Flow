/**
 * DORA-Art30-contract-clauses — annual attestation that contracts with
 * financial entities carry the Art. 30 provisions.
 * Run: cd server && node --test --test-force-exit compliance/checks/dora/art30-contract-clauses.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const DAY = 86400e3;
const fx = { settings: {} };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./art30-contract-clauses');
test.after(() => restore());

const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const noPii = (r) => assert.doesNotMatch(JSON.stringify(r), EMAIL);

test.beforeEach(() => {
    fx.settings = {
        framework_relevance: { dora: 'relevant' },
        dora_contract_clauses_confirmed_at: ago(30),
        dora_contract_clauses_confirmed_by: 'user-7',
        dora_contract_template_url: 'https://contracts.example.org/dora-template-v3.pdf',
    };
});

test('contract shape — medium, attestation, settings is the fix surface, no cross-tags', () => {
    assert.equal(check.id, 'DORA-Art30-contract-clauses');
    assert.equal(check.regulation, 'DORA');
    assert.equal(check.severity, 'medium');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'attestation');
    assert.equal(check.remediationLink, 'admin/compliance/settings');
    assert.equal(check.titleKey, 'compliance.check_dora_contract_clauses_title');
    assert.equal(check.descriptionKey, 'compliance.check_dora_contract_clauses_desc');
    assert.equal(check.remediationKey, 'compliance.check_dora_contract_clauses_fix');
    assert.deepEqual(check.frameworks, []);
});

test('relevance gate: not_relevant → not_applicable', async () => {
    fx.settings.framework_relevance = { dora: 'not_relevant' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('relevance unknown → runs and mentions the card', async () => {
    fx.settings.framework_relevance = '{"dora":"unknown"}';
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.relevance, 'unknown');
    assert.match(r.details, /Frameworks card asks/);
});

test('empty: no attestation → fail (missing, null, unparsable date)', async () => {
    for (const v of [undefined, null, '', 'not a date']) {
        fx.settings.dora_contract_clauses_confirmed_at = v;
        const r = await check.evaluate(ORG);
        assert.equal(r.status, 'fail', `value ${JSON.stringify(v)}`);
        assert.equal(r.evidence.confirmed_at, null);
        assert.equal(r.evidence.age_days, null);
        assert.match(r.details, /No attestation .* Art\. 30 provisions/);
    }
});

test('partial: attestation older than a year → warn with its age', async () => {
    fx.settings.dora_contract_clauses_confirmed_at = ago(400);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.age_days, 400);
    assert.equal(r.evidence.window_days, 365);
    assert.match(r.details, /400 days old — re-confirm annually/);
});

test('good: attested within the year → pass; template link is echoed, Date objects accepted', async () => {
    fx.settings.dora_contract_clauses_confirmed_at = new Date(Date.now() - 30 * DAY);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.age_days, 30);
    assert.equal(r.evidence.confirmed_by_recorded, true);
    assert.equal(r.evidence.template_url, 'https://contracts.example.org/dora-template-v3.pdf');
    assert.match(r.details, /attested 30 day\(s\) ago \(contract template linked\)/);
    fx.settings.dora_contract_template_url = null;
    const r2 = await check.evaluate(ORG);
    assert.equal(r2.evidence.template_url, null);
    assert.doesNotMatch(r2.details, /template linked/);
});

test('evidence never carries the attester; a non-URL or mailto "template" is recorded only as linked', async () => {
    fx.settings.dora_contract_clauses_confirmed_by = 'legal@example.org';
    fx.settings.dora_contract_template_url = 'mailto:legal@example.org';
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.template_url, 'linked');
    assert.equal(r.evidence.confirmed_by_recorded, true);
    noPii(r);
    fx.settings.dora_contract_template_url = 'https://drive.example.org/?owner=legal@example.org';
    noPii(await check.evaluate(ORG));
});
