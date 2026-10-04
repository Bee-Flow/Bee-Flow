'use strict';

/**
 * The managed-part lock on datatables (design 3.2 steps 6-7, 5.2, 5.3),
 * against a REAL Postgres (@electric-sql/pglite behind db.js's pool,
 * testUtils/pglitePool.js): the store runs its own schema and SQL, and the
 * capability is checked against real solution_deployments rows through
 * solutionStageStore. No module is replaced.
 *
 * A table whose project is a UAT/PRD stage project is managed:
 *   - saveModel refuses a change to its entry (columns, removal) without the
 *     capability of an active deployment of that stage, while an edit to an
 *     unrelated org table in the same scope model passes;
 *   - buildNext computes the next model from the one read under the lock, so
 *     the deploy replaces only the stage entries and a concurrent unrelated
 *     edit survives;
 *   - updateDatatableMeta lets grants/sharing, lawful basis, retention and the
 *     subject column through, and refuses a rename; deleteDatatable and
 *     setReferenceFlag need the capability;
 *   - createDatatable refuses a stage projectId without the capability, and a
 *     reference table created there carries `rowsLocked`, which the automation
 *     datatable step refuses with errorClass managed_part.
 *
 * And every writer that reaches such a table, driven through its own entry
 * point as a signed-in member of the org:
 *   - the rows route (single insert and bulk import) answers 409 managed_part,
 *     before the row quota is read;
 *   - the App Studio record steps answer a step failure with code managed_part;
 *   - the form answers write records `lastWriteError.code` managed_part.
 *
 * Run: cd server && node --test stores/datatableStore/managedLock.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
// Loaded first: the automation step's require graph starts userStore's own schema
// init and default seeding at load, and PGlite is ONE session, so that has to
// finish before any other store opens a transaction (see settleUserStore).
const { execDatatable } = require('../../core/automationRunner/execDatatable');
const userStore = require('../userStore');
const { initDB } = require('./schema');
const store = require('./datatables');
const { setDefinitionSource } = require('./definitionSources');
const grants = require('./grants');
const solutionStageStore = require('../solutionStageStore');

const express = require('express');
const records = require('../../appStudio/actionExecutor/records');
const formAnswers = require('../../automation/formAnswers/write');
const rowsRoute = require('../../routes/datatables/rows');

const ORG = { kind: 'org', id: 'org1' };
const DEV = 'p_dev';
const UAT = 'p_uat';
const PRD = 'p_prd';
const ACTIVE = { deploymentId: 'dep_uat_active' };
const FIELDS = [{ id: 'fld_name', key: 'name', name: 'Name', type: 'text' }];

/** Wait for userStore's load-time init and its default groups and roles. */
async function settleUserStore() {
    await userStore.initDB();
    for (let i = 0; i < 500; i++) {
        const r = await pg.query(
            `SELECT (SELECT COUNT(*)::int FROM roles WHERE id = 'agent_editor')
                  + (SELECT COUNT(*)::int FROM groups WHERE id = 'users') AS n`,
        );
        if (Number(r.rows[0].n) === 2) return;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error('userStore never finished seeding');
}

before(async () => {
    await settleUserStore();
    // projectStore's stage columns, reduced to what the guard reads.
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, kind TEXT, stage TEXT, stage_of TEXT);
        INSERT INTO projects (id, name, kind, stage, stage_of) VALUES
            ('p_dev', 'Orders', 'solution', NULL, NULL),
            ('p_uat', 'Orders (UAT)', 'solution', 'uat', 'p_dev'),
            ('p_prd', 'Orders (Production)', 'solution', 'prd', 'p_dev'),
            ('p_team', 'Team', NULL, NULL, NULL);
    `);
    // One store init at a time: PGlite is one session.
    await initDB();
    await solutionStageStore.initDB();
    const dep = (id, stageProjectId, stage, status) => pg.query(
        `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, kind, status,
             plan, plan_hash, stage_settings_version, request_key, requested_by)
         VALUES ($1, 'p_dev', $2, $3, 'rel_1', 'deploy', $4, '{}'::jsonb, 'h', 1, $1, 'alice')`,
        [id, stageProjectId, stage, status],
    );
    await dep('dep_uat_active', UAT, 'uat', 'committing');
    await dep('dep_uat_done', UAT, 'uat', 'succeeded');
    await dep('dep_prd_active', PRD, 'prd', 'committing');
    // The account the writer paths resolve: a member of org1, who owns every
    // table below (ownerUserId 'alice').
    await userStore.createUser({ id: 'alice', username: 'alice', passwordHash: 'x', organizationId: 'org1', orgRole: 'member' });
});

after(close);

let seq = 0;
/** A table in ORG; `def` overrides any createDatatable parameter. */
function make(def = {}, opts = {}) {
    seq += 1;
    return store.createDatatable({
        scope: ORG, ownerUserId: 'alice', key: `t_${seq}`, name: `T ${seq}`, fields: FIELDS, ...def,
    }, opts);
}

/** A stage table, created the only way one can be: by an active deployment. */
function stageTable(def = {}) {
    return make({ projectId: UAT, ...def }, { managedWrite: ACTIVE });
}

/** Expect the managed_part refusal for the UAT stage. */
function managedPart(e) {
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'managed_part');
    assert.strictEqual(e.errorClass, 'managed_part');
    assert.strictEqual(e.expose, true);
    assert.deepStrictEqual(e.details, { solutionId: DEV, stage: 'uat' });
    return true;
}

/** The scope model, with `fn` applied to a copy of table `id`'s entry. */
async function modelWith(id, fn) {
    const { model, modelVersion } = await store.getModel(ORG);
    const next = JSON.parse(JSON.stringify(model));
    next.tables = next.tables.map(t => (t.id === id ? fn({ ...t }) : t));
    return { next, modelVersion };
}

const addColumn = (key) => (t) => ({ ...t, fields: [...t.fields, { id: `fld_${key}`, key, name: key, type: 'text' }] });

test('a stage table column change via saveModel is refused; an unrelated org table edit passes', async () => {
    const managed = await stageTable();
    const plain = await make();

    const { next: bad } = await modelWith(managed.id, addColumn('price'));
    await assert.rejects(store.saveModel(ORG, bad), managedPart);
    const kept = await store.getTableMeta(ORG, managed.id);
    assert.deepStrictEqual(kept.fields.map(f => f.key), ['name'], 'the refused save wrote nothing');

    // A capability of another stage, or of a finished deployment, is no capability.
    await assert.rejects(store.saveModel(ORG, bad, { managedWrite: { deploymentId: 'dep_prd_active' } }), managedPart);
    await assert.rejects(store.saveModel(ORG, bad, { managedWrite: { deploymentId: 'dep_uat_done' } }), managedPart);

    // Removing the entry is a change too.
    const { model } = await store.getModel(ORG);
    await assert.rejects(store.saveModel(ORG, { ...model, tables: model.tables.filter(t => t.id !== managed.id) }), managedPart);

    // The same scope model, an unrelated table: no capability needed.
    const { next: ok, modelVersion } = await modelWith(plain.id, addColumn('note'));
    const saved = await store.saveModel(ORG, ok, { expectedVersion: modelVersion });
    assert.strictEqual(saved.ok, true);
    assert.deepStrictEqual((await store.getTableMeta(ORG, plain.id)).fields.map(f => f.key), ['name', 'note']);

    // Key order and an undefined member are not a change of the stage entry.
    const { model: m2 } = await store.getModel(ORG);
    const reordered = {
        ...m2,
        tables: m2.tables.map(t => (t.id === managed.id
            ? { fields: t.fields, name: t.name, key: t.key, id: t.id, extra: undefined }
            : t)),
    };
    assert.strictEqual((await store.saveModel(ORG, reordered)).ok, true);

    // And the deploy's own capability opens it.
    const { next: deployed } = await modelWith(managed.id, addColumn('price'));
    assert.strictEqual((await store.saveModel(ORG, deployed, { managedWrite: ACTIVE })).ok, true);
    assert.deepStrictEqual((await store.getTableMeta(ORG, managed.id)).fields.map(f => f.key), ['name', 'price']);
});

test('a Dev table and a plain project table are not managed', async () => {
    const dev = await make({ projectId: DEV });
    const team = await make({ projectId: 'p_team' });
    for (const t of [dev, team]) {
        const { next } = await modelWith(t.id, addColumn('extra'));
        assert.strictEqual((await store.saveModel(ORG, next)).ok, true);
        assert.strictEqual(await store.deleteDatatable(t.id, ORG), true);
    }
});

test('buildNext replaces only the stage entries and leaves a concurrent unrelated edit intact', async () => {
    const managed = await stageTable();
    const plain = await make();
    const { model: planned, modelVersion: plannedVersion } = await store.getModel(ORG);
    const plannedFp = store.tableFingerprint(planned.tables.find(t => t.id === managed.id));

    // Somebody edits an unrelated table after the deploy planned.
    const { next: theirs } = await modelWith(plain.id, addColumn('theirs'));
    assert.strictEqual((await store.saveModel(ORG, theirs)).ok, true);

    let lockedSeen = null;
    let physical = null;
    const saved = await store.saveModel(ORG, null, {
        managedWrite: ACTIVE,
        buildNext: (locked) => {
            lockedSeen = locked;
            const entry = locked.tables.find(t => t.id === managed.id);
            // The plan's fingerprint still matches the locked entry: no plan_stale.
            assert.strictEqual(store.tableFingerprint(entry), plannedFp);
            entry.fields = [...entry.fields, { id: 'fld_qty', key: 'qty', name: 'Qty', type: 'number' }];
            return locked;
        },
        applyPhysical: async (_c, ctx) => { physical = ctx; },
    });
    assert.strictEqual(saved.ok, true);
    assert.ok(saved.modelVersion > plannedVersion);

    const after = await store.getModel(ORG);
    const byId = new Map(after.model.tables.map(t => [t.id, t]));
    assert.deepStrictEqual(byId.get(managed.id).fields.map(f => f.key), ['name', 'qty']);
    assert.deepStrictEqual(byId.get(plain.id).fields.map(f => f.key), ['name', 'theirs'],
        'the concurrent edit survived the deploy');

    // buildNext got a copy: the `before` applyPhysical diffs against is the locked model unchanged.
    assert.notStrictEqual(physical.before, lockedSeen);
    assert.deepStrictEqual(physical.before.tables.find(t => t.id === managed.id).fields.map(f => f.key), ['name']);
    assert.deepStrictEqual(physical.next.tables.find(t => t.id === managed.id).fields.map(f => f.key), ['name', 'qty']);

    // A throwing buildNext (plan_stale) rolls back; so does a stage change without the capability.
    const stale = Object.assign(new Error('stale'), { code: 'plan_stale' });
    await assert.rejects(store.saveModel(ORG, null, { managedWrite: ACTIVE, buildNext: () => { throw stale; } }), /stale/);
    await assert.rejects(store.saveModel(ORG, null, {
        buildNext: (locked) => {
            locked.tables.find(t => t.id === managed.id).name = 'Renamed';
            return locked;
        },
    }), managedPart);
    assert.strictEqual((await store.getModel(ORG)).modelVersion, after.modelVersion, 'nothing was written');
});

test('tableFingerprint is a sha256 of the stable stringify', () => {
    const a = { id: 'tbl_1', key: 'k', fields: [{ id: 'f', key: 'x' }] };
    const b = { fields: [{ key: 'x', id: 'f' }], key: 'k', id: 'tbl_1', gone: undefined };
    assert.match(store.tableFingerprint(a), /^[0-9a-f]{64}$/);
    assert.strictEqual(store.tableFingerprint(a), store.tableFingerprint(b));
    assert.notStrictEqual(store.tableFingerprint(a), store.tableFingerprint({ ...a, key: 'other' }));
    assert.notStrictEqual(store.tableFingerprint(a), store.tableFingerprint({ ...a, rowsLocked: true }));
});

test('grants, sharing, the lawful basis, retention and the subject column stay editable', async () => {
    const t = await stageTable({ lawfulBasis: null });

    const meta = await store.updateDatatableMeta(t.id, ORG, {
        lawfulBasis: 'contract', retentionDays: 30, retentionField: 'created_at', subjectColumn: 'name',
    });
    assert.strictEqual(meta.lawfulBasis, 'contract');
    assert.strictEqual(meta.retentionDays, 30);

    const shared = await store.setSharing(t.id, ORG, { isPublished: true, sharedGroups: ['g1'] });
    assert.strictEqual(shared.isPublished, true);
    const grant = await grants.addGrant(t.id, ORG, { granteeType: 'user', granteeId: 'bob', grade: 'viewer', grantedBy: 'alice' });
    assert.ok(grant);

    // A rename is not on the list; resending the CURRENT name with an allowed change is fine.
    await assert.rejects(store.updateDatatableMeta(t.id, ORG, { name: 'Renamed' }), managedPart);
    await assert.rejects(store.updateDatatableMeta(t.id, ORG, { description: 'New purpose' }), managedPart);
    const resent = await store.updateDatatableMeta(t.id, ORG, { name: t.name, lawfulBasis: 'consent' });
    assert.strictEqual(resent.lawfulBasis, 'consent');
    assert.strictEqual((await store.updateDatatableMeta(t.id, ORG, { name: 'Renamed' }, { managedWrite: ACTIVE })).name, 'Renamed');
});

test('deleting a stage table and changing its reference mark need the capability', async () => {
    const t = await stageTable();
    await assert.rejects(store.deleteDatatable(t.id, ORG), managedPart);
    assert.ok(await store.getDatatable(t.id, ORG), 'the refused delete removed nothing');
    assert.ok(await store.getTableMeta(ORG, t.id));

    await assert.rejects(store.setReferenceFlag(t.id, ORG, true), managedPart);
    assert.strictEqual((await store.setReferenceFlag(t.id, ORG, true, { managedWrite: ACTIVE })).isReference, true);

    assert.strictEqual(await store.deleteDatatable(t.id, ORG, { managedWrite: ACTIVE }), true);
    assert.strictEqual(await store.getDatatable(t.id, ORG), null);
});

test('createDatatable with a stage projectId is refused without a capability', async () => {
    const count = async () => Number((await pg.query(`SELECT COUNT(*)::int AS n FROM datatables`)).rows[0].n);
    const n = await count();
    await assert.rejects(make({ projectId: UAT }), managedPart);
    await assert.rejects(make({ projectId: UAT }, { managedWrite: { deploymentId: 'dep_uat_done' } }), managedPart);
    await assert.rejects(make({ projectId: PRD }, { managedWrite: ACTIVE }), (e) => {
        assert.strictEqual(e.code, 'managed_part');
        assert.deepStrictEqual(e.details, { solutionId: DEV, stage: 'prd' });
        return true;
    });
    assert.strictEqual(await count(), n, 'nothing was written');

    const created = await make({ projectId: UAT }, { managedWrite: ACTIVE });
    assert.strictEqual(created.projectId, UAT);
    assert.strictEqual((await store.getTableMeta(ORG, created.id)).rowsLocked, undefined,
        'an ordinary stage table keeps writable rows');
});

test('a stage reference table carries rowsLocked, and the automation datatable step refuses it', async () => {
    const t = await stageTable({ isReference: true, logicalKey: 'prices' });
    const meta = await store.getTableMeta(ORG, t.id);
    assert.strictEqual(meta.rowsLocked, true);
    // A Dev reference table is the source of the rows: never locked.
    const dev = await make({ projectId: DEV, isReference: true });
    assert.strictEqual((await store.getTableMeta(ORG, dev.id)).rowsLocked, undefined);

    const ctx = { userId: 'alice', orgId: 'org1', userHomeOrgId: 'org1', orgRole: 'member', userGroupIds: [] };
    const run = { trigger: { output: {} }, steps: {} };
    const step = { id: 's1', type: 'datatable', op: 'add_row', datatableId: t.id, values: { name: 'Widget' } };
    for (const mode of ['live', 'dry_run']) {
        await assert.rejects(execDatatable(step, ctx, run, mode), (e) => {
            assert.strictEqual(e.errorClass, 'managed_part', `${mode}: ${e.message}`);
            assert.strictEqual(e.status, 409);
            return true;
        });
    }
    // Reads are unaffected.
    const read = await execDatatable({ ...step, op: 'count_rows', values: undefined }, ctx, run, 'live').catch(e => e);
    assert.ok(!(read instanceof Error) || read.errorClass !== 'managed_part', 'a read is never refused as managed');
});

// ── The writer paths, each through its own entry point ─────────────────────

/** POST `path` with `body` to the rows router, signed in as alice. */
async function postRows(path, body) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'alice' } }; next(); });
    const router = express.Router();
    rowsRoute.register(router);
    app.use(router);
    const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    } finally {
        await new Promise((resolve) => { server.close(resolve); });
    }
}

test('rows route: a single insert and a bulk import answer 409 managed_part', async () => {
    const t = await stageTable({ isReference: true });
    const one = await postRows(`/${t.id}/rows`, { values: { name: 'Widget' } });
    assert.strictEqual(one.status, 409, JSON.stringify(one.body));
    assert.strictEqual(one.body.code, 'managed_part');
    const bulk = await postRows(`/${t.id}/rows/bulk`, { rows: [{ name: 'A' }, { name: 'B' }] });
    assert.strictEqual(bulk.status, 409, JSON.stringify(bulk.body));
    assert.strictEqual(bulk.body.code, 'managed_part');
    assert.strictEqual((await store.getDatatable(t.id, ORG)).rowCount, 0, 'nothing was written');
});

test('App Studio record steps: create, update and delete answer managed_part', async () => {
    const t = await stageTable({ isReference: true });
    const app = { id: 'app1', userId: 'alice' };
    const model = { tables: [{ id: 'm_prices', name: 'Prices', source: { kind: 'datatable', datatableId: t.id, mode: 'readwrite' } }] };
    const ctx = { viewerId: 'alice', role: 'owner', viewer: { id: 'alice', role: 'owner' } };
    const rowId = 'rec_0123456789abcdef';
    const results = [
        await records.createRecord(app, model, { tableId: 'm_prices', values: { name: 'Widget' } }, ctx),
        await records.updateRecord(app, model, { tableId: 'm_prices', recordId: rowId, values: { name: 'B' } }, ctx),
        await records.deleteRecord(app, model, { tableId: 'm_prices', recordId: rowId }, ctx),
    ];
    for (const r of results) {
        assert.strictEqual(r.ok, false, JSON.stringify(r));
        assert.strictEqual(r.code, 'managed_part', JSON.stringify(r));
    }
});

test('form answers: a locked answers table records lastWriteError managed_part', async () => {
    // A form answers table cannot be MARKED a reference table, so the lock is
    // put on its descriptor the way a deploy writes one: under the capability.
    const columnMap = { q2: { key: 'name', formName: 'q2', pageStepId: 'p2', columnType: 'text' } };
    const source = { automationId: 'auto_form1', linked: true, columnMap };
    const t = await stageTable({ managedKind: 'form_answers', source });
    const saved = await store.saveModel(ORG, null, {
        managedWrite: ACTIVE,
        buildNext: (locked) => {
            locked.tables.find(x => x.id === t.id).rowsLocked = true;
            return locked;
        },
    });
    assert.strictEqual(saved.ok, true);
    assert.strictEqual((await store.getTableMeta(ORG, t.id)).rowsLocked, true);

    const automation = { id: 'auto_form1', userId: 'alice', organizationId: 'org1' };
    const out = await formAnswers.recordSubmission({ automation, definition: {}, values: {} });
    assert.strictEqual(out, null);
    const after = await store.getDatatable(t.id, ORG);
    assert.strictEqual(after.source.lastWriteError?.code, 'managed_part', JSON.stringify(after.source));
    assert.strictEqual(after.rowCount, 0);

    // A later page goes through patchRow: refused the same way.
    await setDefinitionSource(t.id, ORG, source);
    const page = await formAnswers.recordPageAnswers({
        automation, datatableId: t.id, rowId: 'rec_0123456789abcdef', pageStepId: 'p2', values: { q2: 'Later' },
    });
    assert.strictEqual(page, false);
    assert.strictEqual((await store.getDatatable(t.id, ORG)).source.lastWriteError?.code, 'managed_part');
});

test('a mirror schema reconcile may change only the fields of a stage source mirror', async () => {
    const mirror = await stageTable({ source: { kind: 'mirror', ref: 'crm' } });
    const plain = await stageTable();

    // The ordinary save is refused, the reconcile save of the fields passes.
    let { next } = await modelWith(mirror.id, addColumn('synced'));
    await assert.rejects(store.saveModel(ORG, next), managedPart);
    const ok = await store.saveModel(ORG, next, { mirrorReconcile: true });
    assert.strictEqual(ok.ok, true);
    assert.ok((await store.getTableMeta(ORG, mirror.id)).fields.some(f => f.key === 'synced'));

    // Anything beyond the fields still needs the capability.
    ({ next } = await modelWith(mirror.id, (t) => ({ ...addColumn('again')(t), key: 'renamed_key' })));
    await assert.rejects(store.saveModel(ORG, next, { mirrorReconcile: true }), managedPart);
    ({ next } = await modelWith(mirror.id, (t) => ({ ...t, rowsLocked: true })));
    await assert.rejects(store.saveModel(ORG, next, { mirrorReconcile: true }), managedPart);

    // A stage table that is not a mirror gets no exemption.
    ({ next } = await modelWith(plain.id, addColumn('nope')));
    await assert.rejects(store.saveModel(ORG, next, { mirrorReconcile: true }), managedPart);
});

test('changing the reference mark of a stage table moves rowsLocked with it', async () => {
    const t = await stageTable();
    assert.strictEqual((await store.getTableMeta(ORG, t.id)).rowsLocked, undefined);
    const v0 = (await store.getModel(ORG)).modelVersion;

    await store.setReferenceFlag(t.id, ORG, true, { managedWrite: ACTIVE });
    assert.strictEqual((await store.getTableMeta(ORG, t.id)).rowsLocked, true);
    assert.ok((await store.getModel(ORG)).modelVersion > v0, 'the compiler sees a new model version');

    await store.setReferenceFlag(t.id, ORG, false, { managedWrite: ACTIVE });
    assert.strictEqual((await store.getTableMeta(ORG, t.id)).rowsLocked, undefined);

    // Outside a stage the mark never locks rows.
    const dev = await make({ projectId: DEV });
    await store.setReferenceFlag(dev.id, ORG, true);
    assert.strictEqual((await store.getTableMeta(ORG, dev.id)).rowsLocked, undefined);
});
