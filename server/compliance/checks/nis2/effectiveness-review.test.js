// @typecheck
/**
 * NIS2-Art21(2)(f)-effectiveness-review — audit/management review + sweep freshness,
 * on a real Postgres (the boot ladder's schema on PGlite behind db.js's pool).
 * Run: cd server && node --test compliance/checks/nis2/effectiveness-review.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
const complianceStore = require('../../../stores/complianceStore');
const check = require('./effectiveness-review');
test.after(close);

const ORG = 'org-a';
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

test.beforeEach(() => pg.exec('DELETE FROM iso_audits; DELETE FROM iso_management_reviews; DELETE FROM compliance_score_history; DELETE FROM compliance_settings'));

/** A closed audit, a held review and a sweep, `d` days ago, for `org`. */
const audit = (d, { org = ORG, status = 'closed' } = {}) => pg.query(
    "INSERT INTO iso_audits (organization_id, title, status, closed_at) VALUES ($1, 'Audit', $2, $3)", [org, status, daysAgo(d)]);
const review = (d, org = ORG) => pg.query('INSERT INTO iso_management_reviews (organization_id, held_at) VALUES ($1, $2)', [org, daysAgo(d)]);
const sweep = (d, org = ORG) => pg.query('INSERT INTO compliance_score_history (organization_id, captured_at) VALUES ($1, $2)', [org, daysAgo(d)]);

/** Run `fn` with the named tables gone, then put them back. */
async function without(tables, fn) {
    const restores = [];
    for (const t of tables) restores.push(await hideTable(pg, t));
    try { return await fn(); } finally { for (const r of restores.reverse()) await r(); }
}

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(f)-effectiveness-review');
    assert.equal(check.severity, 'medium');
    assert.equal(check.remediationLink, 'admin/compliance/audits');
});

test('relevance gate', async () => {
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('never reviewed → fail; another organisation\'s audits, reviews and sweeps do not count', async () => {
    await sweep(1);
    await audit(10, { org: 'org-b' });
    await review(10, 'org-b');
    await audit(5, { status: 'planned' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.last_effectiveness_review_at, null);
    await pg.exec('DELETE FROM compliance_score_history');
    await sweep(1, 'org-b');
    assert.equal((await check.evaluate(ORG)).evidence.last_sweep_at, null);
});

test('a review dated in the future is not a review held', async () => {
    await review(600); await review(-30); await sweep(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.review_age_days, 600);
});

test('review 400 days ago (grace window) → warn', async () => {
    await review(400); await sweep(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.review_age_days, 400);
});

test('review older than 540 days → fail', async () => {
    await audit(600); await sweep(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /600 days old/);
});

test('recent review but stale sweeps → warn', async () => {
    await audit(30); await sweep(10);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.sweep_fresh, false);
    assert.match(r.details, /stale/);
});

test('recent review and no sweep ever → warn (run the checks once)', async () => {
    await review(30);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no check sweep/);
});

test('recent review (the newer of audit/review wins) + fresh sweep → pass', async () => {
    await audit(500); await review(20); await sweep(2);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.review_age_days, 20);
    assert.equal(r.evidence.last_effectiveness_review_at, r.evidence.last_review_at);
});

test('both audit and review tables missing → warn not provisioned', async () => {
    await sweep(1);
    const r = await without(['iso_audits', 'iso_management_reviews'], () => check.evaluate(ORG));
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});

test('one register missing is tolerated when the other has data', async () => {
    await review(10); await sweep(1);
    const r = await without(['iso_audits'], () => check.evaluate(ORG));
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.last_audit_at, null);
});

test('missing score-history column is treated as "no sweep"', async () => {
    await review(10);
    const restore = await failReads(pg, 'compliance_score_history', '42703', 'column "captured_at" does not exist');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.last_sweep_at, null);
});
