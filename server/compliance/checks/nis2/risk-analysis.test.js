/**
 * NIS2-Art21(2)(a)-risk-analysis — the ISO risk register as NIS2 evidence.
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/risk-analysis.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { risks: [], settings: {}, dbError: null, params: [] };
const fakeDb = {
    async getAll(sql, params) {
        fx.params.push(params);
        if (fx.dbError) throw fx.dbError;
        assert.match(sql, /FROM iso_risks r/);
        assert.match(sql, /r\.organization_id = \$1/);
        return fx.risks.filter(r => r.organization_id === params[0]).map(r => ({
            id: r.id, status: r.status, score: r.score, review_due_at: r.review_due_at || null,
            has_owner: !!r.owner_user_id, treatments: r.treatments || 0,
        }));
    },
    async getOne() { return null; },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./risk-analysis');
test.after(() => restore());

const risk = (id, extra = {}) => ({ id, organization_id: ORG, status: 'open', score: 6, owner_user_id: 'u1', treatments: 0, ...extra });
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const past = new Date(Date.now() - 86400e3).toISOString();
const future = new Date(Date.now() + 86400e3).toISOString();

test.beforeEach(() => { fx.risks = []; fx.settings = {}; fx.dbError = null; fx.params = []; });

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(a)-risk-analysis');
    assert.equal(check.remediationLink, 'admin/compliance/risks');
    assert.equal(check.HIGH_SCORE, 12);
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.params.length, 0);
});

test('empty register → fail', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.risks_total, 0);
    assert.equal(fx.params[0][0], ORG);
});

test('open high risk without treatment → warn, ids listed', async () => {
    fx.risks = [risk(1, { score: 16 }), risk(2, { score: 4 })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.untreated_high, [1]);
    assert.match(r.details, /1 open risk\(s\) scored 12 or higher/);
});

test('high risk WITH a treatment, or closed/accepted, is fine', async () => {
    fx.risks = [risk(1, { score: 20, treatments: 1 }), risk(2, { score: 25, status: 'closed' }), risk(3, { score: 15, status: 'accepted' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.by_status, { open: 1, closed: 1, accepted: 1 });
});

test('overdue review → warn (closed risks excluded)', async () => {
    fx.risks = [risk(1, { review_due_at: past }), risk(2, { review_due_at: past, status: 'closed' })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.overdue_review, [1]);
});

test('both problems → one warn naming both', async () => {
    fx.risks = [risk(1, { score: 12 }), risk(2, { review_due_at: past })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no treatment/);
    assert.match(r.details, /past their review date/);
});

test('maintained register → pass', async () => {
    fx.risks = [risk(1, { review_due_at: future }), risk(2, { score: 12, status: 'treating', treatments: 2 })];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.risks_total, 2);
    assert.doesNotMatch(JSON.stringify(r.evidence), /@/);
});

test('missing table → warn not provisioned', async () => {
    fx.dbError = pgError('42P01');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});
