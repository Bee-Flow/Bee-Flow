/**
 * NIS2-Art21(2)(d)-questionnaire-pack — the supplier evidence pack is ready (never fails).
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/questionnaire-pack.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { published: [], facts: null, settings: {}, dbError: null, seen: [] };
const fakeDb = {
    async getAll(sql, params) {
        fx.seen.push({ sql, params });
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM isms_documents/);
        assert.match(sql, /status = 'published'/);
        assert.equal(params[0], ORG);
        return fx.published.filter(s => params[1].includes(s)).map(slug => ({ slug }));
    },
    async getOne(sql, params) {
        fx.seen.push({ sql, params });
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM iso_soa_entries WHERE organization_id = \$1/);
        assert.match(sql, /FROM compliance_score_history WHERE organization_id = \$1/);
        assert.match(sql, /payload->>'action' = ANY\(\$2\)/);
        assert.deepEqual(params[1], check.BUNDLE_ACTIONS);
        return fx.facts;
    },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./questionnaire-pack');
test.after(() => restore());

const daysAgo = (d) => new Date(Date.now() - d * 86400e3);
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });

test.beforeEach(() => {
    fx.published = [...check.REQUIRED_SLUGS];
    fx.facts = { soa_entries: 93, last_sweep_at: daysAgo(1), last_bundle_export_at: null };
    fx.settings = {}; fx.dbError = null; fx.seen = [];
});

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(d)-questionnaire-pack');
    assert.equal(check.remediationLink, 'admin/compliance/soa');
    assert.ok(check.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === 'A.5.20'));
    assert.ok(check.frameworks.some(f => f.regulation === 'DORA' && f.ref === 'Art. 30'));
    assert.ok(check.BUNDLE_ACTIONS.includes('evidence_bundle_exported'));
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.seen.length, 0);
});

test('every ingredient present → pass (two queries)', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.policies_missing, []);
    assert.equal(r.evidence.soa_seeded, true);
    assert.equal(r.evidence.sweep_fresh, true);
    assert.equal(r.evidence.last_bundle_export_at, null);
    assert.match(r.details, /not been exported yet/);
    assert.equal(fx.seen.length, 2);
});

test('bundle export stamp lands in evidence and details', async () => {
    fx.facts.last_bundle_export_at = daysAgo(3);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(typeof r.evidence.last_bundle_export_at, 'string');
    assert.match(r.details, /evidence bundle last exported/);
});

test('missing policy → warn naming it, never fail', async () => {
    fx.published = check.REQUIRED_SLUGS.filter(s => s !== 'business-continuity');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.policies_missing, ['business-continuity']);
    assert.match(r.details, /business-continuity/);
});

test('SoA not seeded → warn', async () => {
    fx.facts.soa_entries = 0;
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /Statement of Applicability/);
});

test('stale or absent sweep → warn', async () => {
    fx.facts.last_sweep_at = daysAgo(12);
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /12 days ago/);
    fx.facts.last_sweep_at = null;
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /first check sweep/);
});

test('everything missing → still only warn (absence of an export is not a control failure)', async () => {
    fx.published = []; fx.facts = { soa_entries: 0, last_sweep_at: null, last_bundle_export_at: null };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.ingredients_missing, 3);
});

test('missing register table → warn not provisioned', async () => {
    fx.dbError = pgError('42P01');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});

test('evidence carries no personal data', async () => {
    fx.settings = { dpo_email: 'dpo@example.org' };
    const r = await check.evaluate(ORG);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, /@/);
});
