// @typecheck
/**
 * AIA-Art13-transparency — a failed register read is not "no agents table",
 * and a platform agent (organization_id NULL) belongs to the 'default' bucket,
 * never to every tenant's evidence.
 *
 * Run: cd server && node --test compliance/checks/aia/art13-transparency.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');

// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool.
const { pg, close } = usePglitePool(ladderPglite());
const check = require('./art13-transparency');
test.after(close);
test.beforeEach(() => pg.exec('DELETE FROM agents'));

const LONG = 'x'.repeat(40);

/** @param {string} id @param {string} name @param {string | null} description @param {string | null} org @param {boolean} [published] */
const agent = (id, name, description, org, published = true) => pg.query(
    'INSERT INTO agents (id, name, description, owner_id, organization_id, is_published) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, name, description, 'owner', org, published]);

test('a failed read warns with the SQLSTATE only; a missing table is still not_applicable', async () => {
    const restore = await failReads(pg, 'agents', '57014', 'canceling statement due to statement timeout');
    let r;
    try { r = await check.evaluate('org-a'); } finally { await restore(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.error_code, '57014');
    assert.match(r.details, /could not be read \(SQL state 57014\)/);
    assert.doesNotMatch(JSON.stringify(r), /statement timeout/, 'never the driver message');

    const show = await hideTable(pg, 'agents');
    let na;
    try { na = await check.evaluate('org-a'); } finally { await show(); }
    assert.equal(na.status, 'not_applicable');
    assert.deepEqual(na.evidence, { agents_table: false });
});

test('a platform agent (no organisation) is the default bucket\'s, never a tenant\'s', async () => {
    await agent('g', 'Platform', null, null);
    await agent('e', 'Empty-org platform', null, '');
    await agent('a', 'A', LONG, 'org-a');
    await agent('b', 'B', null, 'org-b');
    await agent('draft', 'Draft', null, 'org-a', false);
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.total, 1, 'only org-a\'s published agent');
    assert.equal(JSON.stringify(r.evidence).includes('Platform'), false);

    const def = await check.evaluate('default');
    assert.equal(def.status, 'fail');
    assert.equal(def.evidence.total, 2);
    assert.deepEqual(def.evidence.missing_descriptions.map(m => m.id).sort(), ['e', 'g']);
});
