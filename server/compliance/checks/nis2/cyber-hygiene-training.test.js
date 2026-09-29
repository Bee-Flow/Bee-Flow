/**
 * NIS2-Art21(2)(g)-cyber-hygiene-training — policy-ack ∪ training-attest coverage.
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/cyber-hygiene-training.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const fx = { docs: [], coverage: null, settings: {}, dbError: null, seen: [] };
const fakeDb = {
    async getAll(sql, params) {
        fx.seen.push({ sql, params });
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM isms_documents/);
        return fx.docs.filter(d => params[1].includes(d.slug));
    },
    async getOne(sql, params) {
        fx.seen.push({ sql, params });
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM users u/);
        assert.match(sql, /u\."organizationId" = \$1/);
        assert.match(sql, /subject_type = 'training_attest'/);
        assert.match(sql, /<> 'suspended'/);
        return fx.coverage;
    },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./cyber-hygiene-training');
test.after(() => restore());

const pub = (slug) => ({ slug, status: 'published', current_version: 2 });
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const cov = (population, byAcks, byAttest, covered) => ({ population, covered_by_acks: byAcks, covered_by_attest: byAttest, covered });

test.beforeEach(() => {
    fx.docs = check.REQUIRED_SLUGS.map(pub); fx.coverage = cov(0, 0, 0, 0); fx.settings = {}; fx.dbError = null; fx.seen = [];
});

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(g)-cyber-hygiene-training');
    assert.equal(check.remediationLink, 'admin/compliance/training');
    assert.ok(check.frameworks.some(f => f.regulation === 'NIS2' && f.ref === 'Art. 20(2)'));
    assert.deepEqual(check.REQUIRED_SLUGS, ['acceptable-use', 'information-security-policy']);
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.seen.length, 0);
});

test('no members → not_applicable; queries are org-scoped and ask for both slugs', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.seen.length, 2);
    for (const s of fx.seen) assert.equal(s.params[0], ORG);
    assert.deepEqual(fx.seen[1].params[1], check.REQUIRED_SLUGS);
    assert.equal(fx.seen[1].params[2], 2, 'a member needs BOTH acknowledgements');
});

test('a required policy unpublished → fail even with good attest coverage', async () => {
    fx.docs = [pub('acceptable-use'), { slug: 'information-security-policy', status: 'draft', current_version: 0 }];
    fx.coverage = cov(10, 0, 10, 10);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.policies_unpublished, ['information-security-policy']);
});

test('≥ 90 % covered → pass, counts only (no ids, no e-mail)', async () => {
    fx.coverage = cov(20, 15, 5, 19);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.coverage_pct, 95);
    assert.equal(r.evidence.covered_by_policy_acks, 15);
    assert.equal(r.evidence.covered_by_training_attest, 5);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
    assert.ok(!('members' in r.evidence) && !('users' in r.evidence));
});

test('60–90 % → warn', async () => {
    fx.coverage = cov(10, 6, 1, 7);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.coverage_pct, 70);
});

test('< 60 % → fail', async () => {
    fx.coverage = cov(10, 2, 1, 3);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.coverage_pct, 30);
});

test('boundaries: exactly 90 passes, exactly 60 warns', async () => {
    fx.coverage = cov(10, 9, 0, 9);
    assert.equal((await check.evaluate(ORG)).status, 'pass');
    fx.coverage = cov(10, 6, 0, 6);
    assert.equal((await check.evaluate(ORG)).status, 'warn');
});

test('missing ledger table → warn not provisioned', async () => {
    fx.dbError = pgError('42P01');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});
