/**
 * The write half of the many relation and of relation.onDelete (core/dataEngine/dataModel/linkedFields.js)
 * through the REAL record write path (writeRecord, eraseRecord, the filter-mode delete step), on both
 * engines: SQLite in memory with its foreign keys on, and Postgres through PGlite.
 *
 *   - a many relation is written as a list of ids into its junction, in the row's transaction; an id
 *     the writer cannot read is refused before anything is written, and a link the writer cannot see
 *     is kept when they write the list;
 *   - onDelete cascade deletes the rows pointing at a record (and theirs), setNull empties their
 *     relation, restrict refuses while one points at it; a child the deleting role may not delete,
 *     or more rows than STUDIO_APP_CASCADE_MAX_ROWS, refuses the whole delete and changes nothing;
 *   - a filter-mode delete on a table a rule points at is refused (it does not walk).
 *
 * Run: cd server && node --test appStudio/actionExecutor/records.linked.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootLinkedEngines, useEngineAsAppStore } = require('../../testUtils/linkedEngines.testkit');
const { validateDataModel } = require('../dataModel');
const { junctionName } = require('../../core/dataEngine/dataModel/linkedFields');
const { writeRecord, eraseRecord } = require('./records');
const { bulkDeleteRecordStep } = require('./bulkRecords.mts');

const app = { id: 'app-linked', userId: 'owner-1', organizationId: 'org-1' };
const viewer = { id: 'u1', role: 'member' };
const ALL = { read: 'all', create: true, update: 'all', delete: 'all' };
const access = (rowFilters = {}) => ({ default: 'none', roles: { member: ALL }, rowFilters });
const rel = (id, key, table, extra = {}) => ({ id, key, type: 'relation', relation: { table, ...extra } });
const text = (id, key) => ({ id, key, type: 'text' });

const PROJECTS = { id: 'tbl_prj001', key: 'projects', name: 'Projects', fields: [text('fld_pnam01', 'name'), rel('fld_plab01', 'labels', 'tbl_lab001', { many: true })], access: access() };
const TASKS = { id: 'tbl_tsk001', key: 'tasks', name: 'Tasks', fields: [text('fld_ttl001', 'title'), rel('fld_tprj01', 'project', 'tbl_prj001', { onDelete: 'cascade' })],
    access: access({ member: { read: 'true', delete: 'record.title != "locked"' } }) };
const COMMENTS = { id: 'tbl_com001', key: 'comments', name: 'Comments', fields: [text('fld_cbod01', 'body'), rel('fld_ctsk01', 'task', 'tbl_tsk001', { onDelete: 'cascade' })], access: access() };
const NOTES = { id: 'tbl_not001', key: 'notes', name: 'Notes', fields: [text('fld_nbod01', 'body'), rel('fld_nprj01', 'project', 'tbl_prj001', { onDelete: 'setNull' })], access: access() };
const INVOICES = { id: 'tbl_inv001', key: 'invoices', name: 'Invoices', fields: [rel('fld_iprj01', 'project', 'tbl_prj001', { onDelete: 'restrict' })], access: access() };
const LABELS = { id: 'tbl_lab001', key: 'labels', name: 'Labels', fields: [text('fld_llab01', 'label')], access: access({ member: 'record.label != "hidden"' }) };
const MODEL = { modelVersion: 1, roles: [{ key: 'member', label: 'Member' }], tables: [PROJECTS, TASKS, COMMENTS, NOTES, INVOICES, LABELS] };
const JN = junctionName(PROJECTS.id, 'fld_plab01');

const closers = [];
let engines;
test.after(async () => { for (const close of closers) await close(); });

test('(setup) a valid model on both engines, with labels to link', async () => {
    assert.deepEqual(validateDataModel(MODEL).errors, []);
    engines = await bootLinkedEngines(MODEL, closers);
    for (const engine of Object.values(engines)) {
        for (const [id, label] of [['lab_a', 'a'], ['lab_b', 'b'], ['lab_h', 'hidden']]) {
            await engine.run('INSERT INTO "labels" (id, label) VALUES (?, ?)', [id, label]);
        }
    }
});

/** Run `fn(engine)` with the app store served from each engine in turn. */
async function onBoth(fn) {
    for (const engine of Object.values(engines)) {
        const restore = useEngineAsAppStore(engine);
        try { await fn(engine); } finally { restore(); }
    }
}
const links = async (engine, id) => (await engine.all(`SELECT target_id FROM "${JN}" WHERE source_id = ? ORDER BY target_id`, [id])).map((r) => r.target_id);
const count = async (engine, table) => Number((await engine.all(`SELECT COUNT(*) AS n FROM "${table}"`, []))[0].n);

test('a many relation writes its list into the junction, keeps what the writer cannot see, refuses what they cannot read', async () => {
    await onBoth(async (engine) => {
        const { id } = await writeRecord(app, MODEL, PROJECTS, { name: 'P', labels: ['lab_a', 'lab_b'] }, { viewer });
        assert.deepEqual(await links(engine, id), ['lab_a', 'lab_b'], engine.dialect);
        await engine.run(`INSERT INTO "${JN}" (source_id, target_id) VALUES (?, ?)`, [id, 'lab_h']);
        const out = await writeRecord(app, MODEL, PROJECTS, { labels: ['lab_b'] }, { viewer, recordId: id });
        assert.equal(out.changes, 1, engine.dialect);
        assert.deepEqual(await links(engine, id), ['lab_b', 'lab_h'], `${engine.dialect}: the hidden link stays`);
        for (const bad of [['lab_h'], ['lab_nope'], 'lab_a']) {
            await assert.rejects(writeRecord(app, MODEL, PROJECTS, { name: 'Q', labels: bad }, { viewer }), { status: 422 }, `${engine.dialect}: ${bad}`);
        }
        assert.equal(await count(engine, 'projects'), 1, `${engine.dialect}: a refused write leaves no row behind`);
        const missing = await writeRecord(app, MODEL, PROJECTS, { labels: [] }, { viewer, recordId: 'rec_missing' });
        assert.equal(missing.changes, 0, `${engine.dialect}: no row, no link changed`);
    });
});

/** A project with two tasks (one with a comment), a note and, optionally, an invoice or a locked task. */
async function projectWithChildren(engine, { invoice = false, locked = false } = {}) {
    const p = (await writeRecord(app, MODEL, PROJECTS, { name: 'with children' }, { viewer })).id;
    const t1 = (await writeRecord(app, MODEL, TASKS, { title: locked ? 'locked' : 't1', project: p }, { viewer })).id;
    await writeRecord(app, MODEL, TASKS, { title: 't2', project: p }, { viewer });
    await writeRecord(app, MODEL, COMMENTS, { body: 'c', task: t1 }, { viewer });
    const n = (await writeRecord(app, MODEL, NOTES, { body: 'n', project: p }, { viewer })).id;
    if (invoice) await writeRecord(app, MODEL, INVOICES, { project: p }, { viewer });
    return { p, n, before: { tasks: await count(engine, 'tasks'), comments: await count(engine, 'comments'), notes: await count(engine, 'notes') } };
}

test('cascade deletes the children and theirs, setNull empties the relation, all in one go', async () => {
    await onBoth(async (engine) => {
        const { p, n, before } = await projectWithChildren(engine);
        const out = await eraseRecord(app, MODEL, PROJECTS, p, { viewer });
        assert.equal(out.deleted, true, engine.dialect);
        assert.equal(await count(engine, 'tasks'), before.tasks - 2, engine.dialect);
        assert.equal(await count(engine, 'comments'), before.comments - 1, engine.dialect);
        assert.equal(await count(engine, 'notes'), before.notes, engine.dialect);
        assert.equal((await engine.all('SELECT project FROM "notes" WHERE id = ?', [n]))[0].project, null, engine.dialect);
        assert.equal((await eraseRecord(app, MODEL, PROJECTS, p, { viewer })).changes, 0, `${engine.dialect}: gone is not found`);
    });
});

test('a child the role may not delete, a restrict rule or too many rows refuse the whole delete', async () => {
    await onBoth(async (engine) => {
        const snapshot = async () => [await count(engine, 'projects'), await count(engine, 'tasks'), await count(engine, 'comments')];
        const locked = await projectWithChildren(engine, { locked: true });
        const lockedBefore = await snapshot();
        await assert.rejects(eraseRecord(app, MODEL, PROJECTS, locked.p, { viewer }), { status: 403, code: 'cascade_forbidden' }, engine.dialect);
        assert.deepEqual(await snapshot(), lockedBefore, `${engine.dialect}: nothing half-deleted`);

        const billed = await projectWithChildren(engine, { invoice: true });
        await assert.rejects(eraseRecord(app, MODEL, PROJECTS, billed.p, { viewer }), { status: 422, code: 'record_has_links' }, engine.dialect);

        const big = await projectWithChildren(engine);
        process.env.STUDIO_APP_CASCADE_MAX_ROWS = '2';
        try {
            await assert.rejects(eraseRecord(app, MODEL, PROJECTS, big.p, { viewer }), { status: 422, code: 'cascade_too_large' }, engine.dialect);
        } finally { delete process.env.STUDIO_APP_CASCADE_MAX_ROWS; }
        assert.equal((await eraseRecord(app, MODEL, PROJECTS, big.p, { viewer })).deleted, true, `${engine.dialect}: within the limit it goes`);
    });
});

test('a filter-mode delete does not walk the rules: refused on a table they point at', async () => {
    await onBoth(async () => {
        const step = { kind: 'delete_record', tableId: 'tbl_prj001', filter: [{ field: 'name', op: 'eq', value: { kind: 'static', value: 'P' } }] };
        await assert.rejects(bulkDeleteRecordStep(app, MODEL, step, { viewerId: 'u1', viewer, role: 'member', vars: {} }), { status: 422, code: 'delete_rules' });
    });
});

test('a many-relation write on a table with a record trigger records ONE change and writes its links in the same transaction', async () => {
    const { _setOutboxDeps } = require('../triggers/recordOutbox.mts');
    const { recordTriggerLimits } = require('../triggers/recordTriggerLimits.mts');
    const recorded = [];
    _setOutboxDeps({
        store: () => ({
            armedRecordTriggers: async () => [{ appId: app.id, triggerId: 'on_projects', config: { tableId: PROJECTS.id, on: ['create', 'update'] } }],
            add: async (list) => { recorded.push(...list); return { written: list.length, dropped: [] }; },
            noteSkip: async () => {},
        }),
        now: () => 1, limits: () => recordTriggerLimits({}), log: { warn() {} },
    });
    try {
        await onBoth(async (engine) => {
            recorded.length = 0;
            const { id } = await writeRecord(app, MODEL, PROJECTS, { name: 'T', labels: ['lab_a'] }, { viewer, source: { kind: 'user' } });
            await writeRecord(app, MODEL, PROJECTS, { name: 'U', labels: ['lab_b'] }, { viewer, recordId: id, source: { kind: 'user' } });
            assert.deepEqual(await links(engine, id), ['lab_b'], engine.dialect);
            assert.deepEqual(recorded.map((d) => [d.event, d.before && d.before.name, d.after && d.after.name]), [['create', null, 'T'], ['update', 'T', 'U']], engine.dialect);
            const missing = await writeRecord(app, MODEL, PROJECTS, { labels: ['lab_a'] }, { viewer, recordId: 'rec_missing', source: { kind: 'user' } });
            assert.equal(missing.changes, 0, `${engine.dialect}: no row, no link, no change recorded`);
            assert.equal(recorded.length, 2, engine.dialect);
        });
    } finally { _setOutboxDeps({}); }
});
