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
const { recordDb } = require('../../../testUtils/routeHarness');

const fx = { rows: [], error: null };
// The real db.js over a recording pool. It ignores the parameters on purpose:
// the check's own filter must mirror the SQL predicate.
const db = recordDb(() => {
    if (fx.error) throw fx.error;
    return { rows: fx.rows };
});
const check = require('./art13-transparency');
test.beforeEach(() => { fx.rows = []; fx.error = null; db.reset(); });

function pgError(message, code) {
    return Object.assign(new Error(message), { code });
}

const LONG = 'x'.repeat(40);

test('a failed read warns with the SQLSTATE only; a missing table is still not_applicable', async () => {
    fx.error = pgError('canceling statement due to statement timeout', '57014');
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.error_code, '57014');
    assert.match(r.details, /could not be read \(SQL state 57014\)/);
    assert.doesNotMatch(JSON.stringify(r), /statement timeout/, 'never the driver message');

    fx.error = pgError('relation "agents" does not exist', '42P01');
    const na = await check.evaluate('org-a');
    assert.equal(na.status, 'not_applicable');
    assert.deepEqual(na.evidence, { agents_table: false });
});

test('a platform agent (no organisation) is the default bucket\'s, never a tenant\'s', async () => {
    fx.rows = [
        { id: 'g', name: 'Platform', description: null, organization_id: null },
        { id: 'a', name: 'A', description: LONG, organization_id: 'org-a' },
    ];
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.total, 1);
    assert.equal(JSON.stringify(r.evidence).includes('Platform'), false);
    // The SQL carries the predicate and its parameter.
    assert.match(db.calls[0].sql.replace(/\s+/g, ' '), /FROM agents WHERE is_published = TRUE AND COALESCE\(NULLIF\(organization_id, ''\), 'default'\) = \$1/);
    assert.deepEqual(db.calls[0].params, ['org-a']);

    const def = await check.evaluate('default');
    assert.equal(def.status, 'fail');
    assert.equal(def.evidence.total, 1);
    assert.deepEqual(def.evidence.missing_descriptions.map(m => m.id), ['g']);
});
