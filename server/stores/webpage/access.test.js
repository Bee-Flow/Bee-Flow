// @typecheck noImplicitAny
/**
 * userHasAnyWebpageAccess on real Postgres (@electric-sql/pglite behind db.js's
 * pool, testUtils/pglitePool.js — no module-system mocking), with the table the
 * webpage store's own schema init creates.
 *
 * Proven:
 *   - a user whose only page is group-shared and sits behind more than 50
 *     other published pages in the org still gets "yes" (the old unordered
 *     LIMIT 50 window answered "no");
 *   - the group-share rule is the one getAccessibleWebpages / canReadWebpage
 *     use: an empty, NULL or non-array shared_groups is an entire-org publish,
 *     otherwise one of the caller's groups must be on it;
 *   - unpublished pages and pages of another org never count; owners always do;
 *   - a malformed array-looking value does not turn into a "no" (the JS
 *     fallback reads it as entire-org, like parseJSON always did).
 *
 * Run: cd server && node --test stores/webpage/access.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, query: rawQuery, close } = usePglitePool();
const webpageSchema = require('./schema');
const { userHasAnyWebpageAccess } = require('./access');

let seq = 0;
async function page({ owner = 'someone', org = 'org1', published = true, groups = '[]' } = {}) {
    seq += 1;
    await rawQuery(
        `INSERT INTO webpages (id, user_id, organization_id, is_published, shared_groups) VALUES ($1, $2, $3, $4, $5)`,
        [`wp-${seq}`, owner, org, published, groups]
    );
}

before(async () => {
    // The real webpage DDL ladder (shared_groups is TEXT holding JSON).
    await webpageSchema.initDB();
});
beforeEach(async () => { await pg.query('DELETE FROM webpages'); });
after(close);

test('a group-shared page behind 50+ other published pages still counts', async () => {
    for (let i = 0; i < 60; i++) await page({ groups: JSON.stringify(['g-other']) });
    await page({ groups: JSON.stringify(['g-x', 'g-mine']) });
    assert.strictEqual(await userHasAnyWebpageAccess('carol', ['g-mine'], ['org1']), true);
    assert.strictEqual(await userHasAnyWebpageAccess('dave', ['g-none'], ['org1']), false);
    assert.strictEqual(await userHasAnyWebpageAccess('dave', [], ['org1']), false);
});

test('entire-org publish: empty, NULL and non-array shared_groups admit every org member', async () => {
    await page({ groups: JSON.stringify(['g-other']) });
    assert.strictEqual(await userHasAnyWebpageAccess('erin', [], ['org1']), false);
    for (const groups of ['[]', ' [ ] ', null, '{}', '"g-other"']) {
        await pg.query('DELETE FROM webpages');
        await page({ groups: JSON.stringify(['g-other']) });
        await page({ groups });
        assert.strictEqual(await userHasAnyWebpageAccess('erin', [], ['org1']), true, `shared_groups=${groups}`);
    }
});

test('unpublished pages and other orgs never count; owners always do', async () => {
    await page({ published: false, groups: '[]' });
    await page({ org: 'org2', groups: '[]' });
    await page({ org: null, groups: '[]' });
    assert.strictEqual(await userHasAnyWebpageAccess('frank', ['g1'], ['org1']), false);
    assert.strictEqual(await userHasAnyWebpageAccess('frank', [], []), false, 'no orgs at all');
    await page({ owner: 'frank', published: false, org: null });
    assert.strictEqual(await userHasAnyWebpageAccess('frank', [], []), true, 'owner');
    assert.strictEqual(await userHasAnyWebpageAccess('', [], ['org1']), false, 'no user');
});

test('a malformed array-looking shared_groups reads as entire-org (parseJSON fallback), not as "no"', async () => {
    await page({ groups: JSON.stringify(['g-other']) });
    await page({ groups: '[not json' });
    assert.strictEqual(await userHasAnyWebpageAccess('gina', [], ['org1']), true);
});
