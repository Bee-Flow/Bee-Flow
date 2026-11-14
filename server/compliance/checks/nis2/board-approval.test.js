// @typecheck
/**
 * NIS2-Art20-board-approval — admins acknowledged the published ISP + board training stamp.
 * Run: cd server && node --test compliance/checks/nis2/board-approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
const complianceStore = require('../../../stores/complianceStore');
const check = require('./board-approval');
test.after(close);

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const SLUG = 'information-security-policy';
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

test.beforeEach(async () => {
    await pg.exec(`DELETE FROM isms_acknowledgements; DELETE FROM isms_documents; DELETE FROM iso_management_reviews;
        DELETE FROM compliance_settings; DELETE FROM users WHERE id LIKE 'ba_%'`);
    await policy({ status: 'published', current_version: 3 });
});

/** @param {{ status: string, current_version: number }} doc */
const policy = (doc) => insertRow(pg, 'isms_documents', { organization_id: ORG, slug: SLUG, title: 'ISP', ...doc });
/**
 * An admin of ORG who acknowledged version `ackVersion` of the policy (or none).
 * @param {string} id @param {number | null} ackVersion @param {Record<string, unknown>} [over]
 */
async function admin(id, ackVersion, over = {}) {
    await insertRow(pg, 'users', { id: `ba_${id}`, username: `ba_${id}`, email: `${id}@example.org`, displayName: `Person ${id}`,
        organizationId: ORG, orgRole: 'org_admin', role: 'user', status: 'active', ...over });
    if (ackVersion != null) await insertRow(pg, 'isms_acknowledgements', { organization_id: ORG, slug: SLUG, version: ackVersion, user_id: `ba_${id}` });
}
/** @param {number} d @param {number} attendees */
const heldReview = (d, attendees) => insertRow(pg, 'iso_management_reviews', {
    organization_id: ORG, held_at: daysAgo(d), attendees: Array.from({ length: attendees }, (_, i) => `p${i}`) });
const trained = (d) => complianceStore.saveSettings(ORG, { nis2_board_training_at: daysAgo(d) });

test('contract shape — hybrid', () => {
    assert.equal(check.id, 'NIS2-Art20-board-approval');
    assert.equal(check.verification, 'hybrid');
    assert.equal(check.severity, 'high');
    assert.equal(check.remediationLink, 'admin/compliance/policies');
});

test('relevance gate', async () => {
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
});

test('policy not published → fail', async () => {
    await pg.exec('DELETE FROM isms_documents');
    await policy({ status: 'draft', current_version: 0 });
    await admin('u1', 0);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.policy_published, false);
});

test('missing policy row entirely → fail', async () => {
    await pg.exec('DELETE FROM isms_documents');
    await insertRow(pg, 'isms_documents', { organization_id: 'org-b', slug: SLUG, title: 'ISP', status: 'published', current_version: 1 });
    assert.equal((await check.evaluate(ORG)).status, 'fail');
});

test('all admins acknowledged + fresh board training → pass', async () => {
    await admin('u1', 3); await admin('u2', 3);
    await trained(30);
    await heldReview(10, 3);
    await heldReview(-10, 5);   // planned, not held
    await heldReview(1, 0);     // nobody attended
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.acknowledged, 2);
    assert.equal(r.evidence.board_training_current, true);
    assert.equal(r.evidence.last_management_review.attendees_count, 3);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
});

test('all acknowledged but no board training recorded → warn (hybrid attestation part)', async () => {
    await admin('u1', 3);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.board_training_current, false);
    assert.match(r.details, /No management cybersecurity training/);
});

test('stale board training (> 365 d) → warn with the age', async () => {
    await admin('u1', 3);
    await trained(400);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /400 days ago/);
});

test('some admins acknowledged → warn, unacknowledged ids only (no names/e-mail)', async () => {
    await admin('u1', 3); await admin('u2', 2); await admin('u3', null);
    await admin('member', null, { orgRole: 'member' });
    await admin('gone', null, { status: 'suspended' });
    await admin('elsewhere', null, { organizationId: 'org-b' });
    await trained(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual([...r.evidence.unacknowledged].sort(), ['ba_u2', 'ba_u3'], 'an acknowledgement of an older version does not count');
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
    assert.doesNotMatch(JSON.stringify(r.evidence), /Person/);
});

test('no admin acknowledged → fail', async () => {
    await admin('u1', null);
    await trained(1);
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /None of the 1 admin/);
});

test('no admin accounts at all → warn', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.admins_total, 0);
});

test('management-review register missing is only an evidence gap', async () => {
    await admin('u1', 3);
    await trained(1);
    const restore = await hideTable(pg, 'iso_management_reviews');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.last_management_review, null);
});

test('missing tables → warn not provisioned, never throws', async () => {
    const show = await hideTable(pg, 'isms_documents');
    try { assert.match((await check.evaluate(ORG)).details, /not provisioned/); } finally { await show(); }
    await admin('u1', 3);   // with no admin to join, the ledger is never read
    const restore = await failReads(pg, 'isms_acknowledgements', '42703', 'column "version" does not exist');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.provisioned, false);
});
