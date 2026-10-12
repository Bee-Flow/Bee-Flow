'use strict';

/**
 * The Solution-stage columns on `datatables`, against a REAL Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js): the
 * store runs its own schema init and SQL, with no module mocking.
 *
 *   - the DDL, run twice, is idempotent and leaves `logical_key`,
 *     `is_reference` and the project/logical-key index in place;
 *   - createDatatable stores `logicalKey` and `isReference` (and an existing
 *     caller that names neither gets NULL / false);
 *   - setReferenceFlag refuses, with 409 `reference_not_allowed` and a reason,
 *     every table shape whose rows may not travel between stages, allows a
 *     plain table, and always allows clearing the mark;
 *   - updateDatatableMeta holds a reference table to the same rules, so a
 *     later edit cannot give it a subject column, per-user rows or retention.
 *
 * Run: cd server && node --test stores/datatableStore/stageColumns.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { createSchema, initDB } = require('./schema');
const store = require('./datatables');

const ORG = { kind: 'org', id: 'org1' };

before(async () => {
    await initDB();
});

after(close);

let seq = 0;
/** A table in ORG; `extra` overrides any createDatatable parameter. */
function make(extra = {}) {
    seq += 1;
    return store.createDatatable({ scope: ORG, ownerUserId: 'alice', key: `t_${seq}`, name: `T ${seq}`, ...extra });
}

/** Expect `promise` to reject with the reference refusal for `reason`. */
async function refused(promise, reason) {
    await assert.rejects(promise, (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'reference_not_allowed');
        assert.strictEqual(e.expose, true);
        assert.deepStrictEqual(e.details, { reason });
        assert.ok(e.message.length > 0);
        return true;
    });
}

test('the DDL applied twice is idempotent', async () => {
    await createSchema();
    await createSchema();
    const cols = await pg.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'datatables' AND column_name IN ('logical_key', 'is_reference')
          ORDER BY column_name`,
    );
    assert.deepStrictEqual(cols.rows.map(r => [r.column_name, r.data_type, r.is_nullable]), [
        ['is_reference', 'boolean', 'NO'],
        ['logical_key', 'text', 'YES'],
    ]);
    assert.match(String(cols.rows[0].column_default), /false/i);
    const idx = await pg.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_datatables_project_logical_key'`,
    );
    assert.strictEqual(idx.rows.length, 1);
    assert.match(idx.rows[0].indexdef, /lower\(COALESCE\(logical_key, key\)\)/);
    assert.match(idx.rows[0].indexdef, /WHERE \(project_id IS NOT NULL\)/);
});

test('createDatatable stores logicalKey and isReference', async () => {
    const t = await make({ key: 'orders__uat', logicalKey: 'orders', isReference: true, projectId: 'stage1' });
    assert.strictEqual(t.logicalKey, 'orders');
    assert.strictEqual(t.isReference, true);

    const raw = await pg.query(`SELECT logical_key, is_reference FROM datatables WHERE id = $1`, [t.id]);
    assert.deepStrictEqual(raw.rows[0], { logical_key: 'orders', is_reference: true });

    const read = await store.getDatatable(t.id, ORG);
    assert.strictEqual(read.logicalKey, 'orders');
    assert.strictEqual(read.isReference, true);

    const listed = (await store.listDatatablesForScope(ORG)).find(d => d.id === t.id);
    assert.strictEqual(listed.logicalKey, 'orders');
    assert.strictEqual(listed.isReference, true);
});

test('an existing caller that names neither column gets NULL and false', async () => {
    const t = await make();
    assert.strictEqual(t.logicalKey, null);
    assert.strictEqual(t.isReference, false);
});

test('createDatatable refuses a reference table that may hold personal data', async () => {
    await refused(make({ isReference: true, subjectColumn: 'email' }), 'subject_column');
    await refused(make({ isReference: true, retentionDays: 30 }), 'retention');
    const before = await pg.query(`SELECT COUNT(*)::int AS n FROM datatables WHERE subject_column = 'email' OR retention_days = 30`);
    assert.strictEqual(before.rows[0].n, 0, 'nothing was written');
});

test('setReferenceFlag allows a plain table and always allows clearing', async () => {
    const t = await make();
    const on = await store.setReferenceFlag(t.id, ORG, true);
    assert.strictEqual(on.isReference, true);
    assert.strictEqual((await store.getDatatable(t.id, ORG)).isReference, true);

    const off = await store.setReferenceFlag(t.id, ORG, false);
    assert.strictEqual(off.isReference, false);

    // Clearing works on a shape that may not be set: a table that was marked
    // before it gained a retention rule can always be unmarked.
    await pg.query(`UPDATE datatables SET is_reference = TRUE, retention_days = 7 WHERE id = $1`, [t.id]);
    const cleared = await store.setReferenceFlag(t.id, ORG, false);
    assert.strictEqual(cleared.isReference, false);
});

test('setReferenceFlag refuses each disallowed shape, with its reason', async () => {
    const shapes = [
        [{ subjectColumn: 'customer_email' }, 'subject_column'],
        [{ rowScope: 'own' }, 'row_scope_own'],
        [{ managedKind: 'form_answers' }, 'managed'],
        [{ source: { provider: 'nextcloud', ncTableId: 4 } }, 'source_mirror'],
        [{ retentionDays: 90 }, 'retention'],
        [{ retentionDays: 30, retentionField: 'updated_at' }, 'retention'],
    ];
    for (const [shape, reason] of shapes) {
        const t = await make(shape);
        await refused(store.setReferenceFlag(t.id, ORG, true), reason);
        const raw = await pg.query(`SELECT is_reference FROM datatables WHERE id = $1`, [t.id]);
        assert.strictEqual(raw.rows[0].is_reference, false, `${reason}: the flag stayed off`);
    }
});

test('a source mirror without a managed kind is still refused', async () => {
    const t = await make();
    await pg.query(`UPDATE datatables SET source = '{"provider":"x"}'::jsonb WHERE id = $1`, [t.id]);
    await refused(store.setReferenceFlag(t.id, ORG, true), 'source_mirror');
});

test('setReferenceFlag is scoped: another tenant gets null and changes nothing', async () => {
    const t = await make();
    assert.strictEqual(await store.setReferenceFlag(t.id, { kind: 'org', id: 'org2' }, true), null);
    assert.strictEqual(await store.setReferenceFlag('tbl_missing', ORG, true), null);
    assert.strictEqual((await store.getDatatable(t.id, ORG)).isReference, false);
    await assert.rejects(store.setReferenceFlag(t.id, null, true), /scope/);
});

test('updateDatatableMeta refuses to give a reference table a personal-data shape', async () => {
    const patches = [
        [{ subjectColumn: 'email' }, 'subject_column'],
        [{ retentionDays: 30 }, 'retention'],
        [{ rowScope: 'own' }, 'row_scope_own'],
    ];
    for (const [patch, reason] of patches) {
        const t = await make();
        await store.setReferenceFlag(t.id, ORG, true);
        await refused(store.updateDatatableMeta(t.id, ORG, patch), reason);
        const raw = await pg.query(
            `SELECT is_reference, subject_column, retention_days, row_scope FROM datatables WHERE id = $1`, [t.id]);
        assert.deepStrictEqual(raw.rows[0],
            { is_reference: true, subject_column: null, retention_days: null, row_scope: 'all' },
            `${reason}: nothing was written`);
    }
});

test('updateDatatableMeta still edits a reference table harmlessly, and any shape once unmarked', async () => {
    const t = await make();
    await store.setReferenceFlag(t.id, ORG, true);
    const renamed = await store.updateDatatableMeta(t.id, ORG, { name: 'Price list', description: 'EUR' });
    assert.strictEqual(renamed.name, 'Price list');
    assert.strictEqual(renamed.isReference, true);
    // Clearing a value that is already clear merges to an allowed shape.
    assert.strictEqual((await store.updateDatatableMeta(t.id, ORG, { retentionDays: null })).isReference, true);

    await store.setReferenceFlag(t.id, ORG, false);
    const personal = await store.updateDatatableMeta(t.id, ORG, { subjectColumn: 'email', rowScope: 'own' });
    assert.strictEqual(personal.subjectColumn, 'email');
    assert.strictEqual(personal.isReference, false);

    assert.strictEqual(await store.updateDatatableMeta(t.id, { kind: 'org', id: 'org2' }, { name: 'x' }), null);
});

test('referenceRefusal reads the snake_case row and passes a plain one', () => {
    assert.strictEqual(store.referenceRefusal({ row_scope: 'all', subject_column: null, managed_kind: null, source: null, retention_days: null }), null);
    assert.strictEqual(store.referenceRefusal({ row_scope: 'own' }).reason, 'row_scope_own');
});
