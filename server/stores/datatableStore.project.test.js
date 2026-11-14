// @typecheck
/**
 * Filing a table into a Solution, against a real Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js): the store runs its own schema init
 * and its own SQL.
 *
 * Wiring `datatables.project_id` up is only safe if TWO doors stay shut:
 *
 *   1. THE METADATA PATCH STAYS CLOSED. `META_COLUMNS` is the list of things
 *      `PATCH /api/datatables/:id/meta` may write. Adding `projectId` to it
 *      would let anyone who may edit a table's label file it into any project
 *      by id, with no check on their role in that project.
 *   2. OWNERSHIP IS A PREDICATE, NOT A PRIOR CHECK. Filing a table into a
 *      project shows it to every member without it being published or granted;
 *      only the owner's call may move it.
 *
 * And a project delete detaches: it drops no table and touches no other row.
 *
 * Run: cd server && node --test stores/datatableStore.project.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./datatableStore');

const ORG = { kind: 'org', id: 'org1' };

before(async () => {
    await store.initDB();
});
after(close);

let seq = 0;
async function make(extra = {}) {
    seq += 1;
    return store.createDatatable({ scope: ORG, ownerUserId: 'alice', key: `t_${seq}`, name: `T ${seq}`, ...extra });
}

/** project_id, data_version and updated_at of one table, read straight from the database. */
async function rowOf(id) {
    const { rows } = await pg.query('SELECT project_id, data_version, updated_at FROM datatables WHERE id = $1', [id]);
    return rows[0];
}

// ═══ The door that must stay shut ════════════════════════════════════

test('projectId is NOT something the metadata PATCH may write', async () => {
    assert.ok(!Object.hasOwn(store.META_COLUMNS, 'projectId'), 'not in the map');
    const t = await make();
    await assert.rejects(
        () => store.updateDatatableMeta(t.id, ORG, { projectId: 'p1' }),
        (/** @type {any} */ err) => err.status === 400 && err.code === 'unknown_field',
        'and the store refuses it loudly rather than skipping the field',
    );
    assert.strictEqual((await rowOf(t.id)).project_id, null, 'nothing was written');
});

// ═══ Listing ═════════════════════════════════════════════════════════

test('the listing returns the tables of one project, by name, in the store shape', async () => {
    const b = await make({ name: 'B invoices', projectId: 'p-list' });
    const a = await make({ name: 'A orders', projectId: 'p-list' });
    await make({ name: 'Elsewhere', projectId: 'p-other' });
    await make({ name: 'Loose' });

    const list = await store.listDatatablesForProject('p-list');
    assert.deepStrictEqual(list.map((t) => t.id), [a.id, b.id]);
    assert.strictEqual(list[0].projectId, 'p-list');
    assert.strictEqual(list[0].ownerUserId, 'alice');
    assert.strictEqual(list[0].name, 'A orders');
});

test('no project id means an empty list, never the tables without a project', async () => {
    await make({ name: 'No project' });
    assert.deepStrictEqual(await store.listDatatablesForProject(null), []);
    assert.deepStrictEqual(await store.listDatatablesForProject(''), []);
});

test('the count is one number per project, and a project with no tables is absent', async () => {
    await make({ projectId: 'p-count-a' });
    await make({ projectId: 'p-count-a' });
    await make({ projectId: 'p-count-b' });
    const counts = await store.countDatatablesForProject(['p-count-a', 'p-count-b', 'p-count-none']);
    assert.deepStrictEqual([...counts.entries()].sort(), [['p-count-a', 2], ['p-count-b', 1]]);
    assert.strictEqual((await store.countDatatablesForProject([])).size, 0);
});

// ═══ Filing in and out ═══════════════════════════════════════════════

test('the owner files a table in; the row now carries the project, its data version untouched', async () => {
    const t = await make();
    const before = await rowOf(t.id);
    assert.strictEqual(await store.setDatatableProject(t.id, 'alice', 'p-file'), true);
    const now = await rowOf(t.id);
    assert.strictEqual(now.project_id, 'p-file');
    assert.strictEqual(now.data_version, before.data_version, 'membership changes no rows');
    assert.deepStrictEqual((await store.listDatatablesForProject('p-file')).map((x) => x.id), [t.id]);
});

test('anyone but the owner matches nothing: false, and the row keeps its project', async () => {
    const t = await make({ projectId: 'p-kept' });
    assert.strictEqual(await store.setDatatableProject(t.id, 'mallory', 'p-stolen'), false);
    assert.strictEqual((await rowOf(t.id)).project_id, 'p-kept');
    assert.strictEqual(await store.setDatatableProject('tbl_missing', 'alice', 'p-stolen'), false);
});

test('taking a table out writes a real NULL', async () => {
    const t = await make({ projectId: 'p-out' });
    assert.strictEqual(await store.setDatatableProject(t.id, 'alice', null), true);
    assert.strictEqual((await rowOf(t.id)).project_id, null);
});

test('a caller with no user id, or no table id, is refused and nothing moves', async () => {
    // `owner_user_id = undefined` binds as NULL, matches nothing and reads as
    // "not yours": the right answer for the wrong reason. Refused up front.
    const t = await make({ projectId: 'p-session' });
    assert.strictEqual(await store.setDatatableProject(t.id, undefined, 'p1'), false);
    assert.strictEqual(await store.setDatatableProject('', 'alice', 'p1'), false);
    assert.strictEqual((await rowOf(t.id)).project_id, 'p-session');
});

// ═══ Detaching ═══════════════════════════════════════════════════════

test('a deleted project detaches its tables and destroys nothing', async () => {
    const one = await make({ projectId: 'p-gone' });
    const two = await make({ projectId: 'p-gone' });
    const other = await make({ projectId: 'p-stays' });
    const tablesBefore = (await pg.query('SELECT COUNT(*)::int AS n FROM datatables')).rows[0].n;

    assert.strictEqual(await store.clearProjectFromDatatables('p-gone'), 2);

    assert.strictEqual((await rowOf(one.id)).project_id, null);
    assert.strictEqual((await rowOf(two.id)).project_id, null);
    assert.strictEqual((await rowOf(other.id)).project_id, 'p-stays', 'another project keeps its tables');
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int AS n FROM datatables')).rows[0].n, tablesBefore, 'not one table dropped');
    assert.ok(await store.getDatatable(one.id, ORG), 'the table itself is still there');
});
