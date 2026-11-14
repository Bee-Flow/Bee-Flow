// @typecheck
/**
 * NIS2-Art21(2)(a)-risk-analysis — the ISO risk register as NIS2 evidence,
 * against a real Postgres (the boot ladder's schema on PGlite,
 * testUtils/pgliteTemplate.js ladderPglite, behind db.js's pool).
 * Run: cd server && node --test compliance/checks/nis2/risk-analysis.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { hideTable } = require('../../../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const complianceStore = require('../../../stores/complianceStore');
const check = require('./risk-analysis');
test.after(close);

const ORG = 'org-a';
const past = new Date(Date.now() - 86400e3).toISOString();
const future = new Date(Date.now() + 86400e3).toISOString();

test.beforeEach(() => pg.exec('DELETE FROM iso_risk_treatments; DELETE FROM iso_risks; DELETE FROM compliance_settings'));

/**
 * @param {Record<string, unknown>} [over]
 * @param {number} [treatments]
 */
async function risk(over = {}, treatments = 0) {
    const r = { organization_id: ORG, title: 'A risk', status: 'open', score: 6, owner_user_id: 'u1', ...over };
    const cols = Object.keys(r);
    const { rows } = await pg.query(`INSERT INTO iso_risks (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(r));
    for (let i = 0; i < treatments; i++) {
        await pg.query('INSERT INTO iso_risk_treatments (organization_id, risk_id) VALUES ($1, $2)', [r.organization_id, rows[0].id]);
    }
    return rows[0].id;
}

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(a)-risk-analysis');
    assert.equal(check.remediationLink, 'admin/compliance/risks');
    assert.equal(check.HIGH_SCORE, 12);
});

test('relevance gate', async () => {
    await risk({ score: 16 });
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('empty register → fail, and another organisation\'s risks are not this one\'s', async () => {
    await risk({ organization_id: 'org-b' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.risks_total, 0);
});

test('open high risk without treatment → warn, ids listed', async () => {
    const high = await risk({ score: 16 });
    await risk({ score: 4 });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.untreated_high, [high]);
    assert.match(r.details, /1 open risk\(s\) scored 12 or higher/);
});

test('a treatment counts only for its own organisation\'s risk', async () => {
    const high = await risk({ score: 16 });
    await pg.query('INSERT INTO iso_risk_treatments (organization_id, risk_id) VALUES ($1, $2)', ['org-b', high]);
    assert.deepEqual((await check.evaluate(ORG)).evidence.untreated_high, [high]);
});

test('high risk WITH a treatment, or closed/accepted, is fine', async () => {
    await risk({ score: 20 }, 1);
    await risk({ score: 25, status: 'closed' });
    await risk({ score: 15, status: 'accepted' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.by_status, { open: 1, closed: 1, accepted: 1 });
});

test('overdue review → warn (closed risks excluded)', async () => {
    const overdue = await risk({ review_due_at: past });
    await risk({ review_due_at: past, status: 'closed' });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.overdue_review, [overdue]);
});

test('both problems → one warn naming both', async () => {
    await risk({ score: 12 });
    await risk({ review_due_at: past });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no treatment/);
    assert.match(r.details, /past their review date/);
});

test('maintained register → pass', async () => {
    await risk({ review_due_at: future });
    await risk({ score: 12, status: 'treating' }, 2);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.risks_total, 2);
    assert.doesNotMatch(JSON.stringify(r.evidence), /@/);
});

test('missing table → warn not provisioned', async () => {
    const restore = await hideTable(pg, 'iso_risks');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});
