/**
 * Filing a table into a Solution.
 *
 * `datatables.project_id` and its partial index shipped with nothing that read
 * or wrote them. Wiring them up is only safe if TWO doors stay shut, and both
 * are pinned here:
 *
 *   1. THE METADATA PATCH STAYS CLOSED. `META_COLUMNS` is the list of things
 *      `PATCH /api/datatables/:id/meta` may write. Adding `projectId` to it
 *      would let anyone who may edit a table's label file it into any project
 *      by id, with no check on their role in that project. Membership is its
 *      own act with its own gate, so it gets its own statement — and this file
 *      fails if somebody takes the shortcut.
 *   2. OWNERSHIP IS A PREDICATE, NOT A PRIOR CHECK. Filing a table into a
 *      project shows it to every member without it being published or granted.
 *      `AND owner_user_id = $3` is what makes that the owner's decision.
 *
 * And one thing that must never happen: a project delete detaches. It does not
 * drop a table, and it does not touch a single row.
 *
 * No database: `../db` is stubbed and every assertion is about the SQL and the
 * parameters that reach it.
 *
 * Run: cd server && node --test --test-force-exit stores/datatableStore.project.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const sql = { run: [], getAll: [], getOne: [] };
let nextRunResult = { rowCount: 1 };
let nextRows = [];

const mockDb = {
    async exec() {},
    async run(text, params) { sql.run.push({ text, params }); return nextRunResult; },
    async getAll(text, params) { sql.getAll.push({ text, params }); return nextRows; },
    async getOne(text, params) { sql.getOne.push({ text, params }); return null; },
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    makeStoreInit: () => async () => {},
};

const mockId = 'mock:datatableProject:db';
require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: mockDb };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // De naad zit op '../db' in de FACADE (stores/datatableStore.js) én op
    // '../../db' in elk onderdeel (stores/datatableStore/*.js) — na de
    // opsplitsing doet het tweede het echte werk. Matcht het patroon niet
    // meer, dan laadt de echte db-module en sterft deze test op een live
    // Postgres-verbinding, ver van de oorzaak.
    if (parent && /datatableStore([\\/][^\\/]+)?\.js$/.test(parent.filename)
        && (request === '../db' || request === '../../db')) return mockId;
    return originalResolve.call(this, request, parent, ...rest);
};

const store = require('./datatableStore');
test.after(() => { Module._resolveFilename = originalResolve; });

function reset() {
    sql.run.length = 0; sql.getAll.length = 0; sql.getOne.length = 0;
    nextRunResult = { rowCount: 1 };
    nextRows = [];
}

const ROW = {
    id: 'tbl_1', scope_kind: 'org', scope_id: 'org1', organization_id: 'org1',
    owner_user_id: 'alice', project_id: 'p1', key: 'invoices', name: 'Invoices',
    description: 'what we billed', is_published: false, shared_groups: '[]',
    write_mode: 'grants', row_scope: 'all', retention_field: 'created_at',
    row_count: 12, data_version: 3,
};

// ═══ The door that must stay shut ════════════════════════════════════

test('projectId is NOT something the metadata PATCH may write', async () => {
    // The shortcut this rejects: adding `projectId` to META_COLUMNS would open
    // PATCH /api/datatables/:id/meta to filing a table into a project the
    // caller has no role on at all.
    assert.ok(!Object.hasOwn(store.META_COLUMNS, 'projectId'), 'not in the map');
    reset();
    await assert.rejects(
        () => store.updateDatatableMeta('tbl_1', { kind: 'org', id: 'org1' }, { projectId: 'p1' }),
        (err) => err.status === 400 && err.code === 'unknown_field',
        'and the store refuses it loudly rather than skipping the field',
    );
    assert.strictEqual(sql.run.length, 0, 'nothing was written');
});

// ═══ Listing ═════════════════════════════════════════════════════════

test('the listing asks for one project and maps the store shape', async () => {
    reset();
    nextRows = [ROW];
    const list = await store.listDatatablesForProject('p1');

    assert.strictEqual(sql.getAll.length, 1);
    assert.match(sql.getAll[0].text, /WHERE project_id = \$1/);
    assert.deepStrictEqual(sql.getAll[0].params, ['p1']);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'tbl_1');
    assert.strictEqual(list[0].projectId, 'p1');
    assert.strictEqual(list[0].ownerUserId, 'alice');
});

test('no project id means no query at all, and an empty list', async () => {
    reset();
    assert.deepStrictEqual(await store.listDatatablesForProject(null), []);
    assert.deepStrictEqual(await store.listDatatablesForProject(''), []);
    assert.strictEqual(sql.getAll.length, 0, 'a missing id must not become WHERE project_id = NULL');
});

// ═══ Filing in and out ═══════════════════════════════════════════════

test('filing in matches on the OWNER, not just the id', async () => {
    reset();
    const ok = await store.setDatatableProject('tbl_1', 'alice', 'p1');

    assert.strictEqual(ok, true);
    assert.strictEqual(sql.run.length, 1);
    assert.match(sql.run[0].text, /UPDATE datatables SET project_id = \$1/);
    assert.match(sql.run[0].text, /WHERE id = \$2 AND owner_user_id = \$3/);
    assert.deepStrictEqual(sql.run[0].params, ['p1', 'tbl_1', 'alice']);
});

test('a write that matched nothing is reported as false, never as success', async () => {
    reset();
    nextRunResult = { rowCount: 0 };
    assert.strictEqual(await store.setDatatableProject('tbl_1', 'mallory', 'p1'), false);
});

test('taking a table out writes a real NULL', async () => {
    reset();
    await store.setDatatableProject('tbl_1', 'alice', null);
    assert.strictEqual(sql.run[0].params[0], null);
});

test('a caller with no user id is refused before any SQL runs', async () => {
    // `owner_user_id = undefined` binds as NULL, matches nothing and reads as
    // "not yours" — the right answer for the wrong reason. Refuse it here so a
    // caller that lost its session cannot look like a caller who lost a race.
    reset();
    assert.strictEqual(await store.setDatatableProject('tbl_1', undefined, 'p1'), false);
    assert.strictEqual(await store.setDatatableProject('', 'alice', 'p1'), false);
    assert.strictEqual(sql.run.length, 0);
});

// ═══ Detaching ═══════════════════════════════════════════════════════

test('a deleted project detaches its tables and destroys nothing', async () => {
    reset();
    nextRunResult = { rowCount: 2 };
    const cleared = await store.clearProjectFromDatatables('p1');

    assert.strictEqual(cleared, 2);
    assert.strictEqual(sql.run.length, 1);
    assert.match(sql.run[0].text, /UPDATE datatables SET project_id = NULL WHERE project_id = \$1/);
    assert.ok(!/DROP|DELETE/i.test(sql.run[0].text), 'not one table and not one row');
    assert.deepStrictEqual(sql.run[0].params, ['p1']);
});
