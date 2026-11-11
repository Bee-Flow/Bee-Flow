/**
 * COLUMN RIGHTS on the App Studio doors, against a REAL in-memory SQLite: the read runner
 * (records, total, aggregate, batch, saved dataset and its cache), the step data source, the
 * single-record read, the table list, attachments, and every write path (record API, batch,
 * steps, bulk, transaction, replace). The real query compiler, access filter and dispatcher;
 * only the Postgres-backed stores are stand-ins that run the compiled SQL on the database.
 *
 * The app and its rows are the two-world kit's world A (testUtils/columnRightsWorlds.testkit.js).
 * core/dataEngine/columnRights.oracle.engines.test.js proves on both engines that no read tells
 * the worlds apart; this file proves each door goes through that same compiler, and that a
 * field a role may not write is refused before anything is stored.
 *
 * Run: cd server && node --test appStudio/columnRights.doors.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useSqliteAppStores } = require('../testUtils/sqliteAppStores.testkit');
const { MODEL, tableOf, secretsOf, seedWorld, sqliteEngineOn } = require('../testUtils/columnRightsWorlds.testkit');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org1' };
const DATASETS = {
    ds_pay: { id: 'ds_pay', tableId: 'tbl_staff', descriptor: { groupBy: [{ field: 'city' }], aggregates: [{ fn: 'sum', field: 'salary', as: 'paid' }] } },
    ds_heads: { id: 'ds_heads', tableId: 'tbl_staff', descriptor: { groupBy: [{ field: 'city' }], aggregates: [{ fn: 'count', as: 'n' }] } },
};
const cache = new Map();
const cacheKey = (id, scope, params, version) => [id, scope, params, version].join('|');
const db = useSqliteAppStores(test, {
    dataStore: {
        getDataset: async (id) => DATASETS[id] || null,
        getDataModel: async () => ({ model: MODEL, dataVersions: {} }),
        getCache: async (id, scope, params, version) => cache.get(cacheKey(id, scope, params, version)) || null,
        putCache: async (id, entry) => { cache.set(cacheKey(id, entry.viewerScopeKey, entry.paramsHash, entry.dataVersion), { result: entry.result }); },
    },
});

const dataReadRunner = require('./dataReadRunner');
const stepDataSource = require('./stepDataSource');
const datasetCache = require('./datasetCache');
const rlsGateway = require('./rlsGateway');
const { viewerMayReadAttachment } = require('./attachmentAccess');
const { executeDataStep } = require('./actionExecutor/dispatch');
const { writeRecord, writeRecordBatch } = require('./actionExecutor/records');
const { replaceRecordBatch } = require('./actionExecutor/replaceRecords.mts');
const { validateDataModel } = require('./dataModel/modelValidate');

const STAFF = tableOf('staff');
const SECRETS = secretsOf('A');
const viewerOf = (role) => ({ id: `u_${role}`, role });
const readCtx = (role) => ({ app, ownerScope: OWNER, viewerId: `u_${role}`, model: MODEL, role, viewer: viewerOf(role) });
const stepCtx = (role, extra = {}) => ({ viewerId: `u_${role}`, viewer: viewerOf(role), role, vars: {}, ...extra });
const row = (id) => db.prepare('SELECT * FROM "staff" WHERE id = ?').get(id);
const staffCount = () => db.prepare('SELECT COUNT(*) AS n FROM "staff"').get().n;
const noSecret = (value, what) => {
    const text = JSON.stringify(value);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${what} holds the hidden value ${secret}`);
};
const notWritable = (e) => e.name === 'FieldAccessError' && e.status === 403 && e.code === 'field_not_writable';

test('(setup) the kit model is a valid data model, and world A is seeded', async () => {
    assert.deepEqual(validateDataModel(MODEL).errors, []);
    await seedWorld(sqliteEngineOn(db), 'A');
    db.prepare('UPDATE "staff" SET "photo" = ?, "contract" = ? WHERE id = ?').run('[{"attachmentId":"att_photo"}]', '[{"attachmentId":"att_contract"}]', 's1');
    assert.equal(row('s1').salary, 41010);
});

test('read runner: records, total, aggregate and batch give a restricted role nothing of a hidden field', async () => {
    const ctx = readCtx('staffer');
    const list = await dataReadRunner.runRecordList(ctx, STAFF, { total: true, fields: ['name', 'salary'], expand: [{ field: 'department', pick: ['name', 'budget'] }, { field: 'mentor' }] });
    assert.equal(list.total, 4);
    assert.deepEqual(list.records.find((r) => r.id === 's1'), { id: 's1', name: 'Ada', department_record: { id: 'd1', name: 'Finance', _label: 'Finance' } });
    const plain = await dataReadRunner.runRecordList(ctx, STAFF, {});
    assert.ok(plain.records.every((r) => !('salary' in r) && !('bonus' in r) && !('pay_note' in r) && !('contract' in r) && r.title));
    noSecret([list, plain], 'a record list');
    for (const read of [
        () => dataReadRunner.runRecordList(ctx, STAFF, { filters: [{ field: 'salary', op: 'gt', value: 60000 }], total: true }),
        () => dataReadRunner.runRecordList(ctx, STAFF, { sort: [{ field: 'salary', dir: 'asc' }] }),
        () => dataReadRunner.runRecordList(ctx, tableOf('reviews'), { filters: [{ field: 'subject.salary', op: 'gt', value: 60000 }] }),
        () => dataReadRunner.runInlineAggregate(ctx, STAFF, { aggregates: [{ fn: 'max', field: 'salary', as: 'v' }] }),
        () => dataReadRunner.runInlineAggregate(ctx, STAFF, { groupBy: [{ field: 'rating' }], aggregates: [{ fn: 'count', as: 'n' }] }),
    ]) await assert.rejects(read(), (e) => e.name === 'CompileError' && /^unknown field: (salary|rating)$/.test(e.message));
    const batch = await dataReadRunner.runBatch(ctx, [
        { id: 'a', kind: 'records', tableId: 'tbl_staff' },
        { id: 'b', kind: 'aggregate', tableId: 'tbl_staff', aggregates: [{ fn: 'sum', field: 'salary', as: 'v' }] },
        { id: 'c', kind: 'dataset', datasetId: 'ds_pay' },
        { id: 'd', kind: 'records', tableId: 'tbl_staff', filters: [{ field: 'bonus', op: 'gt', value: 1 }] },
    ]);
    assert.deepEqual(batch.map((r) => r.ok), [true, false, false, false]);
    // A refused read on such a table is an answer (422 and the sentence), not a server fault; a
    // dataset names no table in the request, so it keeps the generic answer.
    assert.deepEqual(batch.slice(1).map((r) => [r.status, r.error]), [[422, 'unknown field: salary'], [500, 'Data request failed'], [422, 'unknown field: bonus']]);
    noSecret(batch, 'a batch');
    // hr reads all of it through the same door.
    const hr = await dataReadRunner.runInlineAggregate(readCtx('hr'), STAFF, { aggregates: [{ fn: 'max', field: 'salary', as: 'v' }] });
    assert.equal(hr.rows[0].v, 74040);
});

test('saved dataset: refused for a role that may not read a field it folds, and never served from another role\'s cache', async () => {
    cache.clear();
    const hr = await dataReadRunner.runSavedDataset(readCtx('hr'), 'ds_pay');
    assert.equal(hr.cached, false);
    assert.equal((await dataReadRunner.runSavedDataset(readCtx('hr'), 'ds_pay')).cached, true, 'hr is served from its own cache entry');
    await assert.rejects(dataReadRunner.runSavedDataset(readCtx('staffer'), 'ds_pay'), (e) => e.name === 'CompileError' && e.message === 'unknown field: salary');
    await assert.rejects(dataReadRunner.runSavedDataset(readCtx('public'), 'ds_pay'), (e) => e.name === 'CompileError');
    // A dataset over visible fields runs for everyone, each role under its own key.
    const heads = await dataReadRunner.runSavedDataset(readCtx('staffer'), 'ds_heads');
    assert.deepEqual(heads.rows.map((r) => [r.city, r.n]).sort(), [['Breda', 1], ['Utrecht', 2], ['Zwolle', 1]]);
    // The key holds what the role may not read: a change of the rights is a different entry.
    const filter = (table) => rlsGateway.compileAccessFilter(table, 'staffer', viewerOf('staffer'), 'read');
    const opened = { ...STAFF, fields: STAFF.fields.map((f) => (f.id === 'fld_sr00' ? { ...f, access: { read: ['hr', 'staffer'] } } : f)) };
    assert.notEqual(datasetCache.computeViewerScopeKey('staffer', filter(STAFF)), datasetCache.computeViewerScopeKey('staffer', filter(opened)));
    // A table without column rights keeps the key it always had.
    const bare = { where: '1=1', params: [] };
    assert.equal(datasetCache.computeViewerScopeKey('staffer', bare), datasetCache.computeViewerScopeKey('staffer', { ...bare }));
});

test('step data source: a binding that names a hidden field reads nothing; a plain one reads the visible columns', async () => {
    const opts = { viewer: viewerOf('staffer'), role: 'staffer', resolveValue: (b) => b.value };
    const plain = await stepDataSource.resolveDataBinding(app, MODEL, { kind: 'records', tableId: 'tbl_staff' }, opts);
    assert.equal(plain.length, 4);
    noSecret(plain, 'a step read');
    const one = await stepDataSource.resolveDataBinding(app, MODEL, { kind: 'record', tableId: 'tbl_staff', filter: [{ field: 'name', op: 'eq', value: 'Ada' }] }, opts);
    assert.ok(one.id === 's1' && !('salary' in one));
    for (const binding of [
        { kind: 'records', tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'gt', value: 1 }] },
        { kind: 'record', tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'eq', value: 41010 }] },
        { kind: 'aggregate', tableId: 'tbl_staff', aggregates: [{ fn: 'sum', field: 'salary', as: 'v' }] },
        { kind: 'records', tableId: 'tbl_staff', sort: [{ field: 'rating', dir: 'asc' }] },
    ]) assert.equal(await stepDataSource.resolveDataBinding(app, MODEL, binding, opts), null, JSON.stringify(binding));
    const hr = await stepDataSource.resolveDataBinding(app, MODEL, { kind: 'record', tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'eq', value: 41010 }] }, { ...opts, viewer: viewerOf('hr'), role: 'hr' });
    assert.equal(hr.id, 's1');
});

test('the single-record read and the table list follow the role', async () => {
    const { readOne, publicTable } = require('../routes/studio/appDataContext');
    const record = await readOne({ ...readCtx('staffer'), table: STAFF }, 's2');
    assert.ok(record.name === 'Bram' && record.title === 'BRAM' && !('salary' in record) && !('mentor' in record));
    noSecret(record, 'a single record');
    assert.equal((await readOne({ ...readCtx('hr'), table: STAFF }, 's2')).salary, 52020);
    const listed = (role) => publicTable(STAFF, role).fields.map((f) => f.key);
    assert.deepEqual(listed('staffer'), ['name', 'city', 'level', 'department', 'title', 'note', 'logged_by', 'photo']);
    assert.deepEqual(listed('public'), ['name', 'level', 'department', 'title', 'note', 'logged_by', 'photo']);
    assert.equal(listed('owner').length, STAFF.fields.length);
    assert.equal(listed('hr').length, STAFF.fields.length);
});

test('attachments: a file in a hidden field is not readable, whatever the role reads of the row', async () => {
    const may = (attachment, role) => viewerMayReadAttachment(app, attachment, { id: `u_${role}`, role, model: MODEL });
    assert.equal(await may({ id: 'att_photo', recordId: 's1', fieldKey: 'photo' }, 'staffer'), true);
    assert.equal(await may({ id: 'att_photo', recordId: 's1' }, 'staffer'), true, 'a ledger row without a field: found in a readable file field');
    assert.equal(await may({ id: 'att_photo', fieldKey: 'photo' }, 'staffer'), true);
    for (const attachment of [
        { id: 'att_contract', recordId: 's1', fieldKey: 'contract' },
        { id: 'att_contract', recordId: 's1' },
        { id: 'att_contract', fieldKey: 'contract' },
        { id: 'att_contract' },
    ]) {
        assert.equal(await may(attachment, 'staffer'), false, JSON.stringify(attachment));
        assert.equal(await may(attachment, 'hr'), true, JSON.stringify(attachment));
    }
});

test('record API writes: a field the role may not write is refused and nothing is stored', async () => {
    const staffer = { viewer: viewerOf('staffer') };
    const before = staffCount();
    await assert.rejects(writeRecord(app, MODEL, STAFF, { name: 'Eve', salary: 5 }, staffer), (e) => notWritable(e) && e.fields.join() === 'salary' && !/5/.test(e.message));
    await assert.rejects(writeRecord(app, MODEL, STAFF, { name: 'Eve', note: 'hello' }, staffer), (e) => notWritable(e) && e.message === 'You do not have permission to change "Note".');
    await assert.rejects(writeRecordBatch(app, MODEL, STAFF, [{ name: 'Eve' }, { name: 'Fay', rating: 'x' }], staffer), notWritable);
    assert.equal(staffCount(), before);
    // An update: every value counts, an empty one too (it would clear the field).
    for (const values of [{ salary: 1 }, { salary: null }, { mentor: 's3' }, { note: '' }, { name: 'Ada B', rating: 'r' }]) {
        await assert.rejects(writeRecord(app, MODEL, STAFF, values, { ...staffer, recordId: 's1' }), notWritable, JSON.stringify(values));
    }
    assert.deepEqual([row('s1').name, row('s1').salary, row('s1').rating], ['Ada', 41010, 'rating-amber']);
    // What the role may write lands, the hidden fields untouched.
    assert.equal((await writeRecord(app, MODEL, STAFF, { name: 'Ada L', feedback: 'thanks' }, { ...staffer, recordId: 's1' })).changes, 1);
    assert.deepEqual([row('s1').name, row('s1').feedback, row('s1').salary], ['Ada L', 'thanks', 41010]);
    await writeRecord(app, MODEL, STAFF, { name: 'Ada' }, { ...staffer, recordId: 's1' });
});

test('a create leaves out an empty value for a field the role may not write, and the server still fills its own', async () => {
    const { id } = await writeRecord(app, MODEL, STAFF, { name: 'Gus', salary: null, rating: '', note: null, level: 1 }, { viewer: viewerOf('staffer') });
    const created = row(id);
    assert.deepEqual([created.name, created.salary, created.rating, created.note, created.logged_by, created.created_by], ['Gus', null, null, null, 'u_staffer', 'u_staffer']);
    // hr and the owner write every field.
    const hr = await writeRecord(app, MODEL, STAFF, { name: 'Hal', salary: 100, note: 'n' }, { viewer: viewerOf('hr') });
    assert.deepEqual([row(hr.id).salary, row(hr.id).note, row(hr.id).bonus], [100, 'n', 10]);
    assert.equal((await writeRecord(app, MODEL, STAFF, { salary: 200 }, { viewer: { id: OWNER, role: 'owner' }, recordId: hr.id })).changes, 1);
    // A writer without a role writes no field that has a list (and has no create right at all).
    await assert.rejects(writeRecord(app, MODEL, STAFF, { name: 'Ian', salary: 1 }, { viewer: { id: 'x' } }), (e) => e.status === 403);
    db.prepare('DELETE FROM "staff" WHERE id IN (?, ?)').run(id, hr.id);
});

test('step writes run as the viewer: update, bulk, transaction and replace refuse the field', async () => {
    const before = db.prepare('SELECT id, salary, rating, note FROM "staff" ORDER BY id').all();
    const set = { salary: { kind: 'static', value: 1 } };
    const update = await executeDataStep(app, MODEL, { kind: 'update_record', tableId: 'tbl_staff', recordId: { kind: 'static', value: 's2' }, values: set }, stepCtx('staffer'));
    assert.deepEqual([update.ok, update.code], [false, 'forbidden']);
    const create = await executeDataStep(app, MODEL, { kind: 'create_record', tableId: 'tbl_staff', values: { name: { kind: 'static', value: 'Jo' }, rating: { kind: 'field', name: 'r' } } }, stepCtx('staffer', { formValues: { r: 'top' } }));
    assert.deepEqual([create.ok, create.code], [false, 'forbidden']);
    // A bulk write: neither a value for the field, nor a filter on a field the role may not read.
    const visible = [{ field: 'level', op: 'eq', value: 2 }];
    const bulkSet = await executeDataStep(app, MODEL, { kind: 'update_record', tableId: 'tbl_staff', filter: visible, values: set }, stepCtx('staffer'));
    assert.deepEqual([bulkSet.ok, bulkSet.code], [false, 'forbidden']);
    for (const kind of ['update_record', 'delete_record']) {
        const byHidden = await executeDataStep(app, MODEL, { kind, tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'gt', value: 60000 }], values: { name: { kind: 'static', value: 'x' } } }, stepCtx('staffer'));
        assert.equal(byHidden.ok, false, kind);
        assert.match(byHidden.error, /unknown field: salary/);
        noSecret(byHidden, `a bulk ${kind}`);
    }
    // A transaction refuses as a whole: the first child's rename is not kept either.
    for (const second of [
        { kind: 'update_record', tableId: 'tbl_staff', recordId: { kind: 'static', value: 's2' }, values: set },
        { kind: 'update_record', tableId: 'tbl_staff', filter: visible, values: set },
    ]) {
        const first = { kind: 'update_record', tableId: 'tbl_staff', recordId: { kind: 'static', value: 's1' }, values: { name: { kind: 'static', value: 'renamed' } } };
        const tx = await executeDataStep(app, MODEL, { kind: 'transaction', steps: [first, second] }, stepCtx('staffer'));
        assert.deepEqual([tx.ok, tx.code, tx.error], [false, 'forbidden', 'You do not have permission to change "salary".']);
        assert.equal(row('s1').name, 'Ada');
    }
    await assert.rejects(replaceRecordBatch(app, MODEL, STAFF, [{ name: 'Kim', salary: 9 }], { viewer: viewerOf('staffer'), filters: visible, limit: 10 }), notWritable);
    await assert.rejects(replaceRecordBatch(app, MODEL, STAFF, [{ name: 'Kim' }], { viewer: viewerOf('staffer'), filters: [{ field: 'salary', op: 'gt', value: 1 }], limit: 10 }), /unknown field: salary/);
    assert.deepEqual(db.prepare('SELECT id, salary, rating, note FROM "staff" ORDER BY id').all(), before, 'no step changed a row');
    // The same steps as hr go through.
    const hr = await executeDataStep(app, MODEL, { kind: 'update_record', tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'gt', value: 70000 }], values: { note: { kind: 'static', value: 'top' } } }, stepCtx('hr'));
    assert.equal(hr.ok, true, JSON.stringify(hr));
    assert.equal(row('s4').note, 'top');
});

test('an upsert key on a hidden field finds nothing for the role, in either case', async () => {
    const { findExistingByKey } = require('./actionExecutor/writeToRows.mts');
    const run = (role) => ({ ctx: { role }, viewer: viewerOf(role), resolveValue: (b) => b.value });
    const key = (value) => [{ field: 'salary', op: 'eq', value, required: true }];
    assert.equal(await findExistingByKey(app, MODEL, STAFF, key(41010), run('staffer')), null, 'a value that exists');
    assert.equal(await findExistingByKey(app, MODEL, STAFF, key(7), run('staffer')), null, 'a value that does not');
    assert.equal((await findExistingByKey(app, MODEL, STAFF, key(41010), run('hr'))).id, 's1');
});

test('the dry run and the server render read as the role: a count never answers for a hidden field', async () => {
    const dryRun = require('./appDryRunReads');
    const dbStore = require('../stores/studioAppDbStore');
    const deps = { dbQuery: (owner, appId, sql, params) => dbStore.query(owner, appId, sql, params) };
    const viewer = viewerOf('staffer');
    const args = { roleArg: 'staffer', viewer, scope: dryRun.syntheticScope(viewer, []), app, ownerScope: OWNER, deps, dataModel: MODEL };
    const byHidden = { kind: 'records', tableId: 'tbl_staff', filter: [{ field: 'salary', op: 'gt', value: 60000 }] };
    assert.deepEqual(await dryRun.runRecordBinding(byHidden, STAFF, args), { ok: false, error: 'unknown field: salary' });
    assert.deepEqual(await dryRun.runAggregateBinding({ kind: 'aggregate', tableId: 'tbl_staff', aggregates: [{ fn: 'max', field: 'salary', as: 'v' }] }, STAFF, args), { ok: false, error: 'unknown field: salary' });
    assert.equal((await dryRun.runRecordBinding({ kind: 'records', tableId: 'tbl_staff' }, STAFF, args)).ok, true);
    assert.equal((await dryRun.runRecordBinding(byHidden, STAFF, { ...args, roleArg: 'hr', viewer: viewerOf('hr') })).ok, true);

    const { _test } = require('../services/appStudioRender');
    const node = (id, type, props) => ({ id, type, props, style: { span: 12 }, visible: true });
    const definition = { variables: [], screens: [{ id: 'scr_staff1', name: 'Staff', sections: [{ id: 'sec_staff1', children: [
        node('cmp_list01', 'list', { source: { kind: 'records', tableId: 'tbl_staff' } }),
        node('cmp_stat01', 'stat', { value: { kind: 'aggregate', tableId: 'tbl_staff', aggregates: [{ fn: 'sum', field: 'salary', as: 'v' }] } }),
    ] }] }] };
    const state = Object.values(await _test.buildDataState({
        definition, model: MODEL, app, screen: definition.screens[0], roleArg: 'staffer', viewer,
        currentUser: { id: viewer.id, name: 'Probe', email: null, roleKey: 'staffer' }, deps,
    }));
    assert.equal(state.length, 2);
    const listed = state.find((e) => Array.isArray(e.result));
    assert.equal(listed.result.length, 4);
    assert.deepEqual(state.find((e) => e !== listed).error, 'unknown field: salary');
    noSecret(state, 'the server render');
});
