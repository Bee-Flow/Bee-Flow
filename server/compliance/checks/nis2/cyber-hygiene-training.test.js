// @typecheck
/**
 * NIS2-Art21(2)(g)-cyber-hygiene-training — policy-ack ∪ training-attest coverage,
 * on a real Postgres (the boot ladder's schema on PGlite behind db.js's pool).
 * Run: cd server && node --test compliance/checks/nis2/cyber-hygiene-training.test.js
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
const check = require('./cyber-hygiene-training');
test.after(close);

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const VERSION = 2;

/** @param {string} slug @param {Record<string, unknown>} [over] */
const doc = (slug, over = {}) => insertRow(pg, 'isms_documents', { organization_id: ORG, slug, title: slug, status: 'published', current_version: VERSION, ...over });

let seq = 0;
/**
 * One member of ORG.
 * @param {{ acks?: string[], ackVersion?: number, attestedDaysAgo?: number | null, user?: Record<string, unknown> }} [m]
 */
async function member({ acks = [], ackVersion = VERSION, attestedDaysAgo = null, user = {} } = {}) {
    const id = `ch_${++seq}`;
    await insertRow(pg, 'users', { id, username: id, email: `${id}@example.org`, organizationId: ORG, status: 'active', ...user });
    for (const slug of acks) await insertRow(pg, 'isms_acknowledgements', { organization_id: ORG, slug, version: ackVersion, user_id: id });
    if (attestedDaysAgo != null) {
        await insertRow(pg, 'compliance_evidence', { organization_id: ORG, subject_type: 'training_attest', subject_id: id,
            payload: { action: 'training_attested' }, payload_hash: 'h', hash: 'h', captured_at: new Date(Date.now() - attestedDaysAgo * 86400e3).toISOString() });
    }
    return id;
}
/**
 * Members such that `byAcks` acknowledged both policies, `byAttest` attested
 * training, `covered` have either, out of `population`.
 */
async function cov(population, byAcks, byAttest, covered) {
    const both = byAcks + byAttest - covered;
    const all = check.REQUIRED_SLUGS;
    for (let i = 0; i < both; i++) await member({ acks: all, attestedDaysAgo: 10 });
    for (let i = 0; i < byAcks - both; i++) await member({ acks: all });
    for (let i = 0; i < byAttest - both; i++) await member({ attestedDaysAgo: 10 });
    for (let i = 0; i < population - covered; i++) await member({ acks: [all[0]] });
}

test.beforeEach(async () => {
    await pg.exec(`DELETE FROM isms_acknowledgements; DELETE FROM isms_documents; DELETE FROM compliance_evidence;
        DELETE FROM compliance_settings; DELETE FROM users WHERE id LIKE 'ch_%'`);
    for (const slug of check.REQUIRED_SLUGS) await doc(slug);
});

test('contract shape', () => {
    assert.equal(check.id, 'NIS2-Art21(2)(g)-cyber-hygiene-training');
    assert.equal(check.remediationLink, 'admin/compliance/training');
    assert.ok(check.frameworks.some(f => f.regulation === 'NIS2' && f.ref === 'Art. 20(2)'));
    assert.deepEqual(check.REQUIRED_SLUGS, ['acceptable-use', 'information-security-policy']);
});

test('relevance gate', async () => {
    await cov(10, 0, 0, 0);
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('no members → not_applicable; another organisation\'s users, a suspended one and one without e-mail are not members', async () => {
    await member({ user: { organizationId: 'org-b' } });
    await member({ user: { status: 'suspended' } });
    await member({ user: { email: '' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('a member needs BOTH acknowledgements, of the current version, and an attestation counts for a year', async () => {
    await member({ acks: check.REQUIRED_SLUGS });
    await member({ acks: [check.REQUIRED_SLUGS[0]] });
    await member({ acks: check.REQUIRED_SLUGS, ackVersion: VERSION - 1 });
    await member({ attestedDaysAgo: 30 });
    await member({ attestedDaysAgo: 400 });
    const r = await check.evaluate(ORG);
    assert.equal(r.evidence.covered_by_policy_acks, 1);
    assert.equal(r.evidence.covered_by_training_attest, 1);
    assert.equal(r.evidence.coverage_pct, 40);
});

test('a required policy unpublished → fail even with good attest coverage', async () => {
    await pg.exec("UPDATE isms_documents SET status = 'draft', current_version = 0 WHERE slug = 'information-security-policy'");
    await cov(10, 0, 10, 10);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.policies_unpublished, ['information-security-policy']);
});

test('≥ 90 % covered → pass, counts only (no ids, no e-mail)', async () => {
    await cov(20, 15, 5, 19);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.coverage_pct, 95);
    assert.equal(r.evidence.covered_by_policy_acks, 15);
    assert.equal(r.evidence.covered_by_training_attest, 5);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
    assert.ok(!('members' in r.evidence) && !('users' in r.evidence));
});

test('60–90 % → warn', async () => {
    await cov(10, 6, 1, 7);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.coverage_pct, 70);
});

test('< 60 % → fail', async () => {
    await cov(10, 2, 1, 3);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.coverage_pct, 30);
});

test('boundaries: exactly 90 passes, exactly 60 warns', async () => {
    await cov(10, 9, 0, 9);
    assert.equal((await check.evaluate(ORG)).status, 'pass');
    await pg.exec("DELETE FROM users WHERE id LIKE 'ch_%'");
    await cov(10, 6, 0, 6);
    assert.equal((await check.evaluate(ORG)).status, 'warn');
});

test('missing ledger table → warn not provisioned', async () => {
    await cov(2, 1, 0, 1);
    const restore = await hideTable(pg, 'isms_acknowledgements');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});
