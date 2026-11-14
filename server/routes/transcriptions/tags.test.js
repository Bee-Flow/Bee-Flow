// @typecheck
/**
 * Route tests for GET /api/transcriptions/tags (routes/transcriptions/tags.js).
 *
 * The chips this feeds are a FILTER over other people's meetings, so the test
 * that matters is the ACL one: a chip must never name a tag on a note the
 * caller could not open, the predicate is built from the SESSION's user, and
 * an empty org/group set never reaches Postgres as an empty array. The rest
 * holds the tolerance rules (a non-array `tags`, a non-string element, a
 * duplicate tag inside one note) and the response shape the client reads.
 *
 * The real router behind the session-checking gates of testUtils/routeHarness,
 * on a real Postgres (the boot ladder's schema on PGlite, the `pg` option):
 * the caller's orgs and groups come from their user row, the counts from the
 * transcriptions table.
 *
 * Run: cd server && node --test routes/transcriptions/tags.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { hideTable } = require('../../testUtils/pgliteFaults');

const pg = ladderPglite();
const { db, api } = h.routeUnderTest(test, '/api/transcriptions', () => require('./tags'), { pg });
const tagsRouter = require('./tags');

let seq = 0;
/** @param {Record<string, unknown>} over */
const note = (over) => insertRow(pg, 'transcriptions', { id: `tg-${++seq}`, user_id: 'owner', title: 'n', ...over });
/** @param {string} id @param {Record<string, unknown>} [over] */
const user = (id, over = {}) => insertRow(pg, 'users', { id, username: id, ...over });

test.before(async () => {
    await insertRow(pg, 'organizations', { id: 'orgA', name: 'A' });
    await insertRow(pg, 'organizations', { id: 'orgB', name: 'B' });
    await insertRow(pg, 'groups', { id: 'g1', organizationId: 'orgA', name: 'G1' });
    await user('solo');                                            // in no org
    await user('member', { organizationId: 'orgA' });              // org, no groups
    await user('grouped', { organizationId: 'orgA', groups: ['g1'] });
    // What the vocabulary is made of:
    await note({ user_id: 'solo', tags: ['eigen', 'eigen'] });                                          // duplicate inside one note
    await note({ user_id: 'owner', shared_with: ['solo'], tags: ['gedeeld'] });                          // legacy per-user share
    await note({ user_id: 'owner', is_published: true, organization_id: 'orgA', tags: ['org', 'eigen'] });
    await note({ user_id: 'owner', is_published: true, organization_id: 'orgA', shared_groups: ['g1'], tags: ['groep'] });
    await note({ user_id: 'owner', is_published: true, organization_id: 'orgA', shared_groups: ['g9'], tags: ['andere-groep'] });
    await note({ user_id: 'owner', is_published: false, organization_id: 'orgA', tags: ['concept'] });
    await note({ user_id: 'owner', is_published: true, organization_id: 'orgB', tags: ['ander-org'] });
    await note({ user_id: 'owner', tags: JSON.stringify('geen-array') });                                // a scalar
    await note({ user_id: 'owner', tags: [42, '', 'gedeeld'], shared_with: ['solo'] });                   // non-strings, empty
});

/** @param {Record<string, unknown> | null} [as] @param {string} [path] */
const get = (as = { id: 'solo', role: 'user' }, path = '/api/transcriptions/tags') => api.call('GET', path, { user: as });
/** @param {{ body: any }} res */
const asMap = (res) => Object.fromEntries(res.body.map((/** @type {{ tag: string, count: number }} */ r) => [r.tag, r.count]));

// ── The answer the client reads ─────────────────────────────────────

test('answers [{tag, count}]: most-used first, alphabetical inside a tie, counts as numbers', async () => {
    const res = await get();
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, [{ tag: 'gedeeld', count: 2 }, { tag: 'eigen', count: 1 }]);
    for (const r of res.body) assert.strictEqual(typeof r.count, 'number');
});

test('no rows → [], never null (an empty vocabulary is not an error)', async () => {
    await user('nobody');
    const res = await get({ id: 'nobody', role: 'user' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
});

test('a failing query is a 500 that leaks no SQL', async () => {
    const show = await hideTable(pg, 'transcriptions');
    let res;
    try { res = await get(); } finally { await show(); }
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('does not exist'), 'no SQL in the answer');
});

// ── The ACL: this is the security surface ───────────────────────────

test('anonymous is refused before any query runs', async () => {
    const res = await get(null);
    assert.equal(res.status, 401);
    assert.deepEqual(db.queries, [], 'requireAuth must gate the handler');
});

test('own rows + legacy shares only, when the caller is in no org; a note tagged twice counts once', async () => {
    assert.deepEqual(asMap(await get()), { gedeeld: 2, eigen: 1 });
});

test('an org member without groups sees org-published rows shared with nobody in particular', async () => {
    assert.deepEqual(asMap(await get({ id: 'member', role: 'user' })), { org: 1, eigen: 1 });
});

test('an org member WITH groups also sees rows shared to one of those groups', async () => {
    assert.deepEqual(asMap(await get({ id: 'grouped', role: 'user' })), { org: 1, eigen: 1, groep: 1 });
});

test('the predicate is built from the SESSION user, not from anything the caller sends', async () => {
    // The route reads NOTHING from the query string: a parameter shaped like
    // an override is refused rather than accepted and ignored.
    const res = await get({ id: 'solo', role: 'user' }, '/api/transcriptions/tags?userId=owner&orgIds=orgB');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.deepEqual(db.queries, [], 'a refused request must not reach the database');
});

test('a super admin counts over every note, with no ACL clause', async () => {
    const all = asMap(await get({ id: 'root', role: 'admin' }));
    assert.deepEqual(all, { eigen: 2, gedeeld: 2, org: 1, groep: 1, 'andere-groep': 1, concept: 1, 'ander-org': 1 },
        'every note of every tenant; still only string chips, and a scalar `tags` counts as none');
});

// ── buildListAcl on its own ─────────────────────────────────────────

test('buildListAcl: the params line up with the predicate, and an empty group list is no group clause', async () => {
    const { buildListAcl } = /** @type {any} */ (tagsRouter);
    const count = async (/** @type {{ where: string, params: unknown[] }} */ acl) => Number((await pg.query(
        `SELECT COUNT(*)::int AS n FROM transcriptions WHERE ${acl.where}`, acl.params)).rows[0].n);
    assert.deepEqual(buildListAcl('u9').params, ['u9', '["u9"]']);
    assert.strictEqual(await count(buildListAcl('solo')), 3);
    assert.strictEqual(await count(buildListAcl('x', { orgIds: ['orgA'] })), 1, 'org-wide publications only');
    assert.strictEqual(await count(buildListAcl('x', { orgIds: ['orgA'], userGroupIds: ['g1', 'g2'] })), 2);
    assert.deepStrictEqual(buildListAcl('u', { orgIds: ['o'], userGroupIds: [] }), buildListAcl('u', { orgIds: ['o'] }));
    assert.deepStrictEqual(buildListAcl('u', { orgIds: [] }), buildListAcl('u'), 'an empty org list adds nothing');
});
