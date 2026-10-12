/**
 * NIS2-Art21(2)(f)-effectiveness-review — audit/management review + sweep freshness.
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/effectiveness-review.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { audit: null, review: null, futureReview: null, sweep: null, settings: {}, missing: new Set(), params: [] };
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const fakeDb = {
    async getOne(sql, params) {
        fx.params.push(params);
        assert.match(sql, /organization_id = \$1/);
        if (/FROM iso_audits/.test(sql)) { if (fx.missing.has('audits')) throw pgError('42P01'); return { last: fx.audit }; }
        if (/FROM iso_management_reviews/.test(sql)) {
            if (fx.missing.has('reviews')) throw pgError('42P01');
            // Emulates MAX(held_at) over a planned (future-dated) row: only a
            // query that excludes future dates gets the held review back.
            return { last: fx.futureReview && !/held_at <= NOW\(\)/.test(sql) ? fx.futureReview : fx.review };
        }
        if (/FROM compliance_score_history/.test(sql)) { if (fx.missing.has('sweeps')) throw pgError('42703'); return { last: fx.sweep }; }
        throw new Error(`unexpected sql: ${sql}`);
    },
    async getAll() { return []; },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./effectiveness-review');
test.after(() => restore());

const daysAgo = (d) => new Date(Date.now() - d * 86400e3);

test.beforeEach(() => { fx.audit = null; fx.review = null; fx.futureReview = null; fx.sweep = null; fx.settings = {}; fx.missing = new Set(); fx.params = []; });

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(f)-effectiveness-review');
    assert.equal(check.severity, 'medium');
    assert.equal(check.remediationLink, 'admin/compliance/audits');
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.params.length, 0);
});

test('never reviewed → fail; all three queries org-scoped', async () => {
    fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.last_effectiveness_review_at, null);
    assert.equal(fx.params.length, 3);
    for (const p of fx.params) assert.equal(p[0], ORG);
});

test('a review dated in the future is not a review held', async () => {
    fx.review = daysAgo(600); fx.futureReview = daysAgo(-30); fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.review_age_days, 600);
});

test('review 400 days ago (grace window) → warn', async () => {
    fx.review = daysAgo(400); fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.review_age_days, 400);
});

test('review older than 540 days → fail', async () => {
    fx.audit = daysAgo(600); fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /600 days old/);
});

test('recent review but stale sweeps → warn', async () => {
    fx.audit = daysAgo(30); fx.sweep = daysAgo(10);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.sweep_fresh, false);
    assert.match(r.details, /stale/);
});

test('recent review and no sweep ever → warn (run the checks once)', async () => {
    fx.review = daysAgo(30);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no check sweep/);
});

test('recent review (the newer of audit/review wins) + fresh sweep → pass', async () => {
    fx.audit = daysAgo(500); fx.review = daysAgo(20); fx.sweep = daysAgo(2);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.review_age_days, 20);
    assert.equal(r.evidence.last_effectiveness_review_at, r.evidence.last_review_at);
});

test('both audit and review tables missing → warn not provisioned', async () => {
    fx.missing = new Set(['audits', 'reviews']); fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});

test('one register missing is tolerated when the other has data', async () => {
    fx.missing = new Set(['audits']); fx.review = daysAgo(10); fx.sweep = daysAgo(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.last_audit_at, null);
});

test('missing score-history column is treated as "no sweep"', async () => {
    fx.missing = new Set(['sweeps']); fx.review = daysAgo(10);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.last_sweep_at, null);
});
