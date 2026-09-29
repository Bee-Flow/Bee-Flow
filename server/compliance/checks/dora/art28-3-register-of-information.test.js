/**
 * DORA-Art28(3)-register-of-information — the derived register of ICT
 * third-party arrangements: observed operators × attestation entries.
 * Run: cd server && node --test --test-force-exit compliance/checks/dora/art28-3-register-of-information.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const fx = { settings: {}, observed: null, collectCalls: [] };

const op = (operator, extra = {}) => ({
    operator, key: operator.toLowerCase(), sources: ['activity_log'], is_eu: null, country_code: null, calls_30d: 0, connections: 0, ...extra,
});
const observedStub = {
    WINDOW_DAYS: 30,
    canonical: (s) => String(s || '').toLowerCase().trim(),
    async collect(orgId) {
        fx.collectCalls.push(orgId);
        return fx.observed;
    },
};
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../lib/observedOperators': observedStub,
});
const check = require('./art28-3-register-of-information');
test.after(() => restore());

const OBSERVED = () => ({
    window_days: 30,
    ledger_available: true,
    activity: [], connections: [], ai_providers: [],
    operators: [
        op('openai', { is_eu: false, country_code: 'US', calls_30d: 120, sources: ['activity_log', 'ai_provider'] }),
        op('Mistral', { is_eu: true, country_code: 'FR', calls_30d: 40, sources: ['ai_provider', 'activity_log'] }),
        op('google', { is_eu: null, calls_30d: 0, connections: 2, sources: ['connection'] }),
    ],
});
const FULL = [
    { operator: 'openai', attested_by: 'dpo@example.org', attested_at: '2026-05-01T00:00:00Z', contract_ref: 'DPA-2026-014', critical: true, country: 'us' },
    { operator: 'mistral', attested_by: 'dpo@example.org', attested_at: '2026-05-01T00:00:00Z', contract_ref: 'MSA-2026-002', critical: false, country: 'FR' },
    { operator: 'Google', attested_by: 'user-7', attested_at: '2026-06-01T00:00:00Z', contract_ref: 'GWS-77', critical: true },
];
const noPii = (r) => {
    const blob = JSON.stringify(r);
    assert.doesNotMatch(blob, EMAIL);
    assert.doesNotMatch(blob, /user-7|attested_by/);
};

test.beforeEach(() => {
    fx.settings = { framework_relevance: { dora: 'relevant' }, scc_confirmed_operators: FULL };
    fx.observed = OBSERVED();
    fx.collectCalls = [];
});

test('contract shape — tagged GDPR Art. 28, ISO A.5.20, NIS2 Art. 21(2)(d); ROPA is the fix surface', () => {
    assert.equal(check.id, 'DORA-Art28(3)-register-of-information');
    assert.equal(check.regulation, 'DORA');
    assert.equal(check.article, 'Art. 28(3)');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.equal(check.remediationLink, 'admin/compliance/ropa');
    assert.equal(check.titleKey, 'compliance.check_dora_register_title');
    assert.equal(check.descriptionKey, 'compliance.check_dora_register_desc');
    assert.equal(check.remediationKey, 'compliance.check_dora_register_fix');
    assert.deepEqual(check.frameworks, [
        { regulation: 'GDPR', ref: 'Art. 28' },
        { regulation: 'ISO27001', ref: 'A.5.20' },
        { regulation: 'NIS2', ref: 'Art. 21(2)(d)' },
    ]);
});

test('relevance gate: not_relevant → not_applicable without collecting', async () => {
    fx.settings.framework_relevance = { dora: 'not_relevant' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(fx.collectCalls.length, 0);
});

test('relevance unknown → runs, evidence says unknown, details say the card asks', async () => {
    delete fx.settings.framework_relevance;
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.relevance, 'unknown');
    assert.match(r.details, /Frameworks card asks/);
    assert.deepEqual(fx.collectCalls, [ORG]);
});

test('empty: nothing observed → not_applicable (ledger quiet vs. ledger absent are worded apart)', async () => {
    fx.observed.operators = [];
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.operators_total, 0);
    assert.deepEqual(r.evidence.register, []);
    assert.match(r.details, /No ICT third-party arrangement observed/);
    fx.observed.ledger_available = false;
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.ledger_available, false);
    assert.match(r.details, /No outbound activity ledger yet/);
});

test('gap: operators observed, none attested → fail naming them', async () => {
    fx.settings.scc_confirmed_operators = [];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.attested_count, 0);
    assert.deepEqual(r.evidence.unattested, ['openai', 'Mistral', 'google']);
    assert.match(r.details, /3 ICT third-party provider\(s\) observed \(openai, Mistral, google\) but none is recorded/);
    noPii(r);
});

test('partial: an unattested operator, or attestations without contract_ref / criticality → warn naming each gap', async () => {
    fx.settings.scc_confirmed_operators = [
        { operator: 'openai', attested_at: '2026-05-01T00:00:00Z', contract_ref: 'DPA-2026-014', critical: true },
        { operator: 'mistral', attested_at: '2026-05-01T00:00:00Z' },
    ];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.unattested, ['google']);
    assert.deepEqual(r.evidence.missing_contract_ref, ['Mistral']);
    assert.deepEqual(r.evidence.missing_criticality, ['Mistral']);
    assert.equal(r.evidence.complete_count, 1);
    assert.match(r.details, /1 observed operator\(s\) are not in the register \(google\); 1 lack a contract reference \(Mistral\); 1 lack a criticality flag \(Mistral\)/);
    noPii(r);
});

test('good: every observed operator attested with contract_ref and criticality → pass; the evidence IS the register', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.operators_total, 3);
    assert.equal(r.evidence.complete_count, 3);
    assert.equal(r.evidence.critical_count, 2);
    assert.equal(r.evidence.non_eu_count, 1);
    assert.match(r.details, /Register of information complete: 3 ICT third-party provider\(s\), 2 marked critical, 1 outside the EU\/EEA/);
    assert.deepEqual(r.evidence.register[0], {
        operator: 'openai', country: 'US', is_eu: false, critical: true, contract_ref: 'DPA-2026-014',
        calls_30d: 120, connections: 0, sources: ['activity_log', 'ai_provider'], attested: true, attested_at: '2026-05-01T00:00:00Z',
    });
    noPii(r);
});

test('country falls back from the attestation to the ledger; EU flag is derived from the country when the ledger did not say', async () => {
    fx.settings.scc_confirmed_operators = [
        ...FULL.slice(0, 2),
        { operator: 'google', attested_at: '2026-06-01T00:00:00Z', contract_ref: 'GWS-77', critical: true, country: 'ie' },
    ];
    const r = await check.evaluate(ORG);
    const google = r.evidence.register.find(x => x.operator === 'google');
    assert.equal(google.country, 'IE');
    assert.equal(google.is_eu, true, 'derived from IE');
    const mistral = r.evidence.register.find(x => x.operator === 'Mistral');
    assert.equal(mistral.is_eu, true, 'ledger flag wins');
    assert.equal(mistral.country, 'FR');
});

test('a JSON-string attestation column and malformed entries do not crash the check', async () => {
    fx.settings.scc_confirmed_operators = JSON.stringify([null, 'x', { operator: '' }, FULL[0], FULL[1], FULL[2]]);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    fx.settings.scc_confirmed_operators = '{not json';
    const r2 = await check.evaluate(ORG);
    assert.equal(r2.status, 'fail');
});

test('evidence never carries the attester or an e-mail address', async () => {
    fx.settings.scc_confirmed_operators = FULL.map(e => ({ ...e, attested_by: 'dpo@example.org' }));
    const r = await check.evaluate(ORG);
    noPii(r);
    assert.deepEqual(Object.keys(r.evidence.register[0]).sort(), [
        'attested', 'attested_at', 'calls_30d', 'connections', 'contract_ref', 'country', 'critical', 'is_eu', 'operator', 'sources',
    ]);
});
