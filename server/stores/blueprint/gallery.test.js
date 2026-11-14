/**
 * O4 part C — "how often has this been installed", as two numbers.
 *
 * Blueprints are strictly org-scoped (see the header of `canRead`).
 * `countInstallsFor` is the ONLY read that looks across that, and that is allowed
 * only because nothing but numbers can come out of it. These tests guard
 * exactly those sides:
 *
 *   1. IT COUNTS ACROSS ORGANISATIONS, split into "here" and "elsewhere". A
 *      count that quietly sees only the own organisation answers "0" to the question
 *      the function exists for.
 *   2. THE COMPARISON BETWEEN TWO DIFFERENT EMPTY VALUES.
 *      `projects.organization_id` is TEXT DEFAULT '' and the gallery side may be
 *      NULL; a naive `=` counts every org-less installation as "elsewhere".
 *   3. NO ROW COMES OUT. No `SELECT *`, no project name, no owner,
 *      no timestamp — one COUNT row. So there is also no column that is added to
 *      `projects` next year and rides along by itself.
 *   4. ZERO IS AN ANSWER, "not readable" is not one. Those two may not become the
 *      same on any screen, so they may not have the same value here either.
 *
 * On a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind the store's db facade
 * (testUtils/pgliteDb.js dbFacade). The facade notes the columns each read
 * got back, which is how "no row comes out" and "the manifest is not
 * fetched" are read off the database's answer.
 *
 * Run: cd server && node --test stores/blueprint/gallery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { pgliteDb, dbFacade } = require('../../testUtils/pgliteDb');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { makeBlueprintStore } = require('../blueprintStore');

const { pg, db } = pgliteDb(ladderPglite());
const facade = dbFacade(db);
/** The column names of every row the database answered with, per read. */
const answered = [];
const getOne = facade.getOne;
const getAll = facade.getAll;
facade.getOne = async (sql, params) => { const r = await getOne(sql, params); answered.push(r ? Object.keys(r) : []); return r; };
facade.getAll = async (sql, params) => { const rows = await getAll(sql, params); answered.push(rows[0] ? Object.keys(rows[0]) : []); return rows; };
const store = makeBlueprintStore(facade);

test.after(() => pg.close());

async function reset() {
    answered.length = 0;
    await pg.exec('DELETE FROM projects; DELETE FROM project_blueprints');
}
let seq = 0;
/** @param {string} blueprintId @param {string | null} org */
const install = (blueprintId, org) => pg.query(
    'INSERT INTO projects (id, name, owner_id, organization_id, installed_from_blueprint_id) VALUES ($1, $1, $2, $3, $4)',
    [`p${++seq}`, 'someone', org, blueprintId]);
/** @param {Record<string, unknown>} over */
const blueprint = (over) => {
    const r = { solution_key: 'sol_p1', name: 'Orders', manifest: JSON.stringify({ solution: {} }), ...over };
    const cols = Object.keys(r);
    return pg.query(`INSERT INTO project_blueprints (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
};

// ── 1. Across organisations ─────────────────────────────────────────────────

test('the count splits into here and elsewhere, and so looks across organisations', async () => {
    await reset();
    for (const org of ['org_source', 'org_source', 'org_b', 'org_b', 'org_c', '', null]) await install('bp_a', org);
    await install('bp_b', 'org_c');
    await install('bp_other', 'org_source');          // another Blueprint: not counted
    await install(null, 'org_source');
    const out = await store.countInstallsFor(['bp_a', 'bp_b'], { organizationId: 'org_source' });
    // Were the organisation in the WHERE instead of the FILTER, "elsewhere"
    // would be zero by definition: the answer "0" to the question it exists for.
    assert.deepStrictEqual(out, { here: 2, elsewhere: 6 });
});

// ── 2. Empty and NULL are the same "no organisation" ────────────────────────

test('an org-less source compares with the empty string, not with NULL', async () => {
    // `projects.organization_id` is TEXT DEFAULT '' (createProject writes
    // `organizationId || ''`), while the gallery side may be NULL. Without the
    // COALESCE on BOTH sides an org-less installation never matches and
    // counts as "elsewhere" — exactly the wrong way round.
    await reset();
    await install('bp_a', '');
    await install('bp_a', null);
    await install('bp_a', 'org1');
    assert.deepStrictEqual(await store.countInstallsFor(['bp_a'], { organizationId: null }), { here: 2, elsewhere: 1 });
    assert.deepStrictEqual(await store.countInstallsFor(['bp_a'], {}), { here: 2, elsewhere: 1 });
});

// ── 3. No row comes out ─────────────────────────────────────────────────────

test('two numbers come out, never a row', async () => {
    await reset();
    await install('bp_a', 'org1');
    await install('bp_a', 'org2');
    const out = await store.countInstallsFor(['bp_a'], { organizationId: 'org1' });
    assert.deepStrictEqual(out, { here: 1, elsewhere: 1 });
    // One row of two counts: no project column, and no breakdown per organisation.
    assert.deepStrictEqual(answered, [['here', 'elsewhere']]);
});

// ── 4. Zero is an answer ────────────────────────────────────────────────────

test('without a Blueprint there is nothing to count, and that is zero', async () => {
    // From an id that does not exist nobody can have installed anything. Zero is
    // an answer here and not a gap — and it saves a query.
    await reset();
    await install('bp_a', 'org1');
    for (const ids of [[], null, ['', null, 42]]) {
        assert.deepStrictEqual(await store.countInstallsFor(/** @type {any} */ (ids), { organizationId: 'org1' }),
            { here: 0, elsewhere: 0 });
    }
    assert.deepStrictEqual(answered, [], 'no query without a single usable id');
    assert.deepStrictEqual(await store.countInstallsFor(['bp_nobody'], { organizationId: 'org1' }), { here: 0, elsewhere: 0 });
});

test('an unreadable count is null, never 0', async () => {
    // "Nobody has installed this" and "we could not check" are two different
    // statements. `Number(null)` is 0, so this is precisely the place where a
    // bare coercion throws the distinction away. A database does not answer
    // like this, so the answer is injected.
    for (const answer of [null, {}, { here: null, elsewhere: 0 }, { here: 0, elsewhere: 'lots' }]) {
        const odd = makeBlueprintStore({ ...facade, getOne: async () => answer });
        assert.strictEqual(await odd.countInstallsFor(['bp_a'], {}), null,
            `${JSON.stringify(answer)} is not a count and may not read as 0`);
    }
});

// ── 5. The access question does NOT belong here ─────────────────────────────

test('the store authorises nothing — the caller supplies the authorised ids', async () => {
    // The same promise as listStamps/listInstalledVersions/listReleases: this
    // function counts what it gets. Who may count is decided by the route, with the
    // owner role on the source project.
    await reset();
    await blueprint({ id: 'bp_of_someone_else', created_by: 'mallory', organization_id: 'org_other' });
    await install('bp_of_someone_else', 'org_random');
    assert.deepStrictEqual(await store.countInstallsFor(['bp_of_someone_else'], { organizationId: 'org_random' }), { here: 1, elsewhere: 0 });
});

// ── 6. The meta read does not drag the manifest along ───────────────────────

test('a read without the manifest really does not fetch the manifest', async () => {
    await reset();
    await blueprint({ id: 'bp_abc', organization_id: 'org1', created_by: 'alice', version: 2 });
    const meta = await store.getBlueprintById('bp_abc', { includeManifest: false });
    assert.strictEqual(meta.manifest, undefined, 'no manifest in the answer');
    assert.strictEqual(meta.organizationId, 'org1');
    assert.strictEqual(meta.name, 'Orders');
    assert.ok(!answered.at(-1).includes('manifest'), 'the database did not send the manifest');
});

test('the ordinary read still carries the manifest', async () => {
    // The install wizard reads a Blueprint WITH the manifest; that path must not
    // have been quietly narrowed by the option above.
    await reset();
    await blueprint({ id: 'bp_abc', organization_id: 'org1', created_by: 'alice', version: 1 });
    const full = await store.getBlueprintById('bp_abc');
    assert.deepStrictEqual(full.manifest, { solution: {} });
});

test('the gallery list does not fetch the manifests either, and shows only what the caller may install', async () => {
    // `mapRow(..., { includeManifest: false })` threw them away afterwards, so the
    // query dragged up to MAX_BLUEPRINTS_PER_ORG (100) JSONB blobs of at most
    // MAX_BLUEPRINT_BYTES (16 MB) each through the pool to read a handful of
    // strings out of them. Every reader paid that: the gallery, the access
    // question and the install counter.
    await reset();
    await blueprint({ id: 'bp_org', organization_id: 'org1', created_by: 'bob' });
    await blueprint({ id: 'bp_mine', organization_id: null, created_by: 'alice' });
    await blueprint({ id: 'bp_theirs', organization_id: null, created_by: 'bob' });
    await blueprint({ id: 'bp_other_org', organization_id: 'org2', created_by: 'alice' });
    const list = await store.listBlueprintsFor({ userId: 'alice', organizationId: 'org1' });
    assert.deepStrictEqual(list.map(b => b.id).sort(), ['bp_mine', 'bp_org']);
    assert.ok(list.every(b => b.manifest === undefined));
    assert.ok(!answered.at(-1).includes('manifest'), 'the database did not send the manifests');
});
