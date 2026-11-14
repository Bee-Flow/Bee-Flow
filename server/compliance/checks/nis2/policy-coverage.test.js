// @typecheck
/**
 * NIS2-Art21(2)-policy-coverage — the ten measures ↔ ISMS policy matrix, on
 * a real Postgres (the boot ladder's schema on PGlite behind db.js's pool).
 * Run: cd server && node --test compliance/checks/nis2/policy-coverage.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRows } = require('../../../testUtils/pgliteSeed');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
const complianceStore = require('../../../stores/complianceStore');
const check = require('./policy-coverage');
test.after(close);

const ORG = 'org-a';
/** @param {Array<Record<string, unknown>>} rows */
const docs = (rows) => insertRows(pg, 'isms_documents', rows.map(r => ({ title: String(r.slug), ...r })));

const ALL = Array.from(new Set(Object.values(check.LETTER_SLUGS).flat()));
const published = (slug, extra = {}) => ({ organization_id: ORG, slug, status: 'published', current_version: 1, review_due_at: null, ...extra });
const future = new Date(Date.now() + 30 * 86400e3).toISOString();
const past = new Date(Date.now() - 2 * 86400e3).toISOString();

test.beforeEach(() => pg.exec('DELETE FROM isms_documents; DELETE FROM compliance_settings'));

test('contract shape + the matrix covers all ten letters with known seed slugs', () => {
    assert.equal(check.id, 'NIS2-Art21(2)-policy-coverage');
    assert.equal(check.verification, 'automated');
    assert.deepEqual(Object.keys(check.LETTER_SLUGS).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    const seeds = require('../../iso/policySeeds');
    const seedSlugs = new Set((seeds.POLICY_SEEDS || seeds.SEEDS || seeds.default || seeds).map ? (seeds.POLICY_SEEDS || seeds.SEEDS || seeds.default || seeds).map(s => s.slug) : Object.values(seeds).flat().map(s => s && s.slug));
    for (const slug of ALL) assert.ok(seedSlugs.has(slug), `slug ${slug} is not an ISMS seed`);
});

test('relevance gate → not_applicable without a query', async () => {
    await docs(ALL.map(s => published(s)));
    await complianceStore.saveSettings(ORG, { framework_relevance: { nis2: 'not_relevant' } });
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.relevance, 'not_relevant');
});

test('empty register → fail, every letter missing', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.letters_missing.length, 10);
    assert.equal(r.evidence.measures_covered, 0);
});

test('all published and current → pass', async () => {
    await docs(ALL.map(s => published(s, { review_due_at: future })));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.evidence.letters_missing, []);
    assert.deepEqual(r.evidence.letters_overdue, []);
    assert.equal(r.evidence.measures_covered, 10);
});

test('one unpublished policy → fail naming the letter and the slug (drafts do not count)', async () => {
    await docs(ALL.map(s => (s === 'cryptography' ? published(s, { status: 'draft', current_version: 0 }) : published(s))));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.letters_missing, ['h']);
    assert.deepEqual(r.evidence.policies_missing, ['cryptography']);
    assert.match(r.details, /\(h\)/);
});

test('a shared slug (access-control) missing knocks out both (i) and (j)', async () => {
    await docs(ALL.filter(s => s !== 'access-control').map(s => published(s)));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.letters_missing, ['i', 'j']);
    assert.deepEqual(r.evidence.policies_missing, ['access-control']);
});

test('all published, one review overdue → warn', async () => {
    await docs(ALL.map(s => (s === 'acceptable-use' ? published(s, { review_due_at: past }) : published(s))));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.letters_overdue, ['g']);
    assert.deepEqual(r.evidence.policies_overdue, ['acceptable-use']);
    assert.equal(r.evidence.matrix.g.current, false);
    assert.equal(r.evidence.matrix.g.covered, true);
});

test('other org rows are invisible', async () => {
    await docs(ALL.map(s => ({ ...published(s), organization_id: 'org-b' })));
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
});

test('missing table (42P01) → warn not provisioned', async () => {
    const restore = await hideTable(pg, 'isms_documents');
    let r;
    try { r = await check.evaluate(ORG); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.match(r.details, /not provisioned/);
});
