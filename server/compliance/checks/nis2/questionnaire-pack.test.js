// @typecheck
/**
 * NIS2-Art21(2)(d)-questionnaire-pack — the supplier evidence pack is ready (never fails).
 * Run: cd server && node --test compliance/checks/nis2/questionnaire-pack.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
const complianceStore = require('../../../stores/complianceStore');
const check = require('./questionnaire-pack');
test.after(close);

const ORG = 'org-a';
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

/** @param {string[]} slugs @param {string} [org] */
async function published(slugs, org = ORG) {
    for (const slug of slugs) await insertRow(pg, 'isms_documents', { organization_id: org, slug, title: slug, status: 'published', current_version: 1 });
}
/** @param {number} n @param {string} [org] */
async function soa(n, org = ORG) {
    for (let i = 0; i < n; i++) await insertRow(pg, 'iso_soa_entries', { organization_id: org, control_ref: `A.${i}` });
}
const sweep = (d, org = ORG) => insertRow(pg, 'compliance_score_history', { organization_id: org, captured_at: daysAgo(d) });
const exported = (d, action = 'evidence_bundle_exported', org = ORG) => insertRow(pg, 'compliance_evidence', {
    organization_id: org, payload: { action }, payload_hash: 'h', hash: 'h', captured_at: daysAgo(d) });

test.beforeEach(async () => {
    await pg.exec(`DELETE FROM isms_documents; DELETE FROM iso_soa_entries; DELETE FROM compliance_score_history;
        DELETE FROM compliance_evidence; DELETE FROM compliance_settings`);
});

/** Every ingredient there: the policies, a seeded SoA, a sweep yesterday. */
async function ready({ slugs = check.REQUIRED_SLUGS, soaEntries = 3, sweepDaysAgo = 1 } = {}) {
    await published(slugs);
    await soa(soaEntries);
    if (sweepDaysAgo != null) await sweep(sweepDaysAgo);
}

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(d)-questionnaire-pack');
    assert.equal(check.remediationLink, 'admin/compliance/soa');
    assert.ok(check.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === 'A.5.20'));
    assert.ok(check.frameworks.some(f => f.regulation === 'DORA' && f.ref === 'Art. 30'));
    assert.ok(check.BUNDLE_ACTIONS.includes('evidence_bundle_exported'));
});

test('relevance gate', async () => {
    await ready();
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('every ingredient present → pass', async () => {
    await ready();
    await exported(1, 'something_else');
    await exported(1, 'evidence_bundle_exported', 'org-b');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.policies_missing, []);
    assert.equal(r.evidence.soa_seeded, true);
    assert.equal(r.evidence.sweep_fresh, true);
    assert.equal(r.evidence.last_bundle_export_at, null);
    assert.match(r.details, /not been exported yet/);
});

test('bundle export stamp lands in evidence and details', async () => {
    await ready();
    await exported(3);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(typeof r.evidence.last_bundle_export_at, 'string');
    assert.match(r.details, /evidence bundle last exported/);
});

test('missing policy → warn naming it, never fail', async () => {
    await ready({ slugs: check.REQUIRED_SLUGS.filter(s => s !== 'business-continuity') });
    await published(['business-continuity'], 'org-b');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.policies_missing, ['business-continuity']);
    assert.match(r.details, /business-continuity/);
});

test('SoA not seeded → warn', async () => {
    await ready({ soaEntries: 0 });
    await soa(5, 'org-b');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /Statement of Applicability/);
});

test('stale or absent sweep → warn', async () => {
    await ready({ sweepDaysAgo: 12 });
    await sweep(1, 'org-b');
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /12 days ago/);
    await pg.exec('DELETE FROM compliance_score_history');
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /first check sweep/);
});

test('everything missing → still only warn (absence of an export is not a control failure)', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.ingredients_missing, 3);
});

test('missing register table → warn not provisioned', async () => {
    const restore = await hideTable(pg, 'iso_soa_entries');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});

test('evidence carries no personal data', async () => {
    await ready();
    await complianceStore.saveSettings(ORG, { dpo_email: 'dpo@example.org' });
    const r = await check.evaluate(ORG);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, /@/);
});
