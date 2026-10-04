/**
 * migrationPlan's `retainRetired` option: the schema half of a Solution-stage
 * deploy (design 3.2 steps 2-3).
 *
 * A field a release no longer carries is RETIRED in a stage table, never
 * dropped, so a rollback brings the column back with its data. Keeping the
 * column is not enough on its own: a required column was created NOT NULL, a
 * unique one has an index and a relation an inline FOREIGN KEY, and once the
 * release stops writing it every insert would fail on one of the three. So
 * retiring relaxes them, and an unretire puts them back.
 *
 * The pure cases pin the statements; the pglite cases run them against a real
 * Postgres, because a DO block that finds its constraint in pg_constraint is
 * only proven by a database that has one.
 *
 * Run: cd server && node --test core/dataEngine/dataModel/migrationPlan.retain.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { migrationPlan, retireMetaFor, retiredColumnKey, readRetireState, retainConflicts } = require('./migrationPlan');
const { ddlForTable } = require('./ddl');

const f = (id, key, over = {}) => ({ id, key, name: key, type: 'text', ...over });
const t = (id, key, fields, over = {}) => ({ id, key, name: key, fields, ...over });
const model = (tables) => ({ modelVersion: 1, tables });

const PARENT = t('tbl_parent', 'parents', [f('fld_pn', 'title')]);
const CODE = f('fld_code', 'code', { required: true, unique: true });
const OWNER = f('fld_owner', 'owner', { type: 'relation', relation: { table: 'tbl_parent' } });
const NOTE = f('fld_note', 'note');
const CHILD_FULL = t('tbl_child', 'children', [NOTE, CODE, OWNER]);
const CHILD_RETIRED = t('tbl_child', 'children', [NOTE], {
    retired_fields: [retireMetaFor(CODE), retireMetaFor(OWNER)],
});

const RETIRE_OPTS = { dialect: 'pg', retainRetired: true, retiredFieldIds: new Set(['fld_code', 'fld_owner']) };
const renameAside = (plan, from, to) => plan.find(s => s.startsWith('DO $$') && s.includes(`RENAME COLUMN "${from}" TO "${to}"`));
// An unretire moves the column back through the same guarded DO block.
const renameBack = renameAside;
const bareAdd = (plan) => plan.some(s => s.startsWith('ALTER TABLE') && /ADD COLUMN/.test(s));

// ── Pure: what the plan says ───────────────────────────────────────────

test('the default plan is unchanged: a missing field is dropped, with its unique index', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, t('tbl_child', 'children', [NOTE])]), { dialect: 'pg' });
    assert.deepStrictEqual(plan, [
        'DROP INDEX IF EXISTS "uq_tbl_child_fld_code"',
        'ALTER TABLE "children" DROP COLUMN IF EXISTS "code"',
        'ALTER TABLE "children" DROP COLUMN IF EXISTS "owner"',
    ]);
});

test('the default plan ignores retired_fields on the model entries', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, CHILD_RETIRED]), { dialect: 'pg' });
    assert.ok(plan.some(s => /DROP COLUMN IF EXISTS "code"/.test(s)), 'without the option the column goes');
});

test('a retired field emits no DROP COLUMN, moves aside and relaxes unique, NOT NULL and the FK', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, t('tbl_child', 'children', [NOTE])]), RETIRE_OPTS);
    assert.ok(!plan.some(s => /DROP COLUMN/.test(s)), plan.join('\n'));
    assert.ok(plan.includes('DROP INDEX IF EXISTS "uq_tbl_child_fld_code"'));
    assert.ok(renameAside(plan, 'code', '_r_fld_code'), plan.join('\n'));
    assert.ok(renameAside(plan, 'owner', '_r_fld_owner'), plan.join('\n'));
    assert.ok(plan.includes('ALTER TABLE "children" ALTER COLUMN "_r_fld_code" DROP NOT NULL'));
    const fkDrop = plan.find(s => s.startsWith('DO $$') && /pg_constraint/.test(s));
    assert.ok(fkDrop, 'the FK is dropped through pg_constraint');
    assert.match(fkDrop, /to_regclass\('"children"'\)/);
    assert.match(fkDrop, /a\.attname = '_r_fld_owner'/);
    assert.match(fkDrop, /con\.contype = 'f'/);
    assert.ok(plan.indexOf(renameAside(plan, 'owner', '_r_fld_owner')) < plan.indexOf(fkDrop), 'the FK is found under the retired name');
});

test('retired_fields on the new model count as retired without retiredFieldIds', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, CHILD_RETIRED]), { dialect: 'pg', retainRetired: true });
    assert.ok(!plan.some(s => /DROP COLUMN/.test(s)), plan.join('\n'));
    assert.ok(plan.includes('ALTER TABLE "children" ALTER COLUMN "_r_fld_code" DROP NOT NULL'));
});

test('under the option NO field is dropped, even one nobody listed as retired', () => {
    const plan = migrationPlan(
        model([PARENT, CHILD_FULL]),
        model([PARENT, t('tbl_child', 'children', [NOTE, OWNER])]),
        { dialect: 'pg', retainRetired: true, retiredFieldIds: new Set() },
    );
    assert.ok(!plan.some(s => /DROP COLUMN/.test(s)), plan.join('\n'));
    assert.ok(renameAside(plan, 'code', '_r_fld_code'));
    assert.ok(plan.includes('ALTER TABLE "children" ALTER COLUMN "_r_fld_code" DROP NOT NULL'));
});

test('a plain optional field retires with only the move aside', () => {
    const plan = migrationPlan(
        model([CHILD_FULL]),
        model([t('tbl_child', 'children', [CODE, OWNER])]),
        { dialect: 'pg', retainRetired: true, retiredFieldIds: new Set(['fld_note']) },
    );
    assert.strictEqual(plan.length, 1);
    assert.ok(renameAside(plan, 'note', '_r_fld_note'));
});

test('a returning field emits no ADD COLUMN and re-adds NOT NULL, the unique index and the FK', () => {
    const plan = migrationPlan(model([PARENT, CHILD_RETIRED]), model([PARENT, CHILD_FULL]), { dialect: 'pg', retainRetired: true });
    assert.ok(!bareAdd(plan), plan.join('\n'));
    assert.ok(renameBack(plan, '_r_fld_code', 'code'), plan.join('\n'));
    assert.ok(renameBack(plan, '_r_fld_owner', 'owner'), plan.join('\n'));
    assert.ok(plan.includes('ALTER TABLE "children" ALTER COLUMN "code" SET NOT NULL'));
    assert.ok(plan.includes('CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_child_fld_code" ON "children" ("code")'));
    const fkAdd = plan.find(s => /ADD CONSTRAINT "fk_tbl_child_fld_owner"/.test(s));
    assert.ok(fkAdd, plan.join('\n'));
    assert.match(fkAdd, /FOREIGN KEY \("owner"\) REFERENCES "parents"\(id\)/);
});

test('retiredMeta passed as an option is honoured the same way', () => {
    const meta = new Map([['fld_code', retireMetaFor(CODE)]]);
    const plan = migrationPlan(
        model([t('tbl_child', 'children', [NOTE])]),
        model([t('tbl_child', 'children', [NOTE, CODE])]),
        { dialect: 'pg', retainRetired: true, retiredMeta: meta },
    );
    assert.ok(renameBack(plan, '_r_fld_code', 'code'), plan.join('\n'));
    assert.deepStrictEqual(plan.slice(1), [
        'ALTER TABLE "children" ALTER COLUMN "code" SET NOT NULL',
        'CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_child_fld_code" ON "children" ("code")',
    ]);
});

test('a returning field that lost a constraint in the release does not get it back', () => {
    const relaxed = f('fld_code', 'code');
    const plan = migrationPlan(
        model([CHILD_RETIRED]),
        model([t('tbl_child', 'children', [NOTE, relaxed])]),
        { dialect: 'pg', retainRetired: true },
    );
    assert.strictEqual(plan.length, 1, plan.join('\n'));
    assert.ok(renameBack(plan, '_r_fld_code', 'code'));
});

test('a returning field under a new key renames the retained column first', () => {
    const renamed = f('fld_code', 'product_code', { required: true, unique: true });
    const plan = migrationPlan(
        model([CHILD_RETIRED]),
        model([t('tbl_child', 'children', [NOTE, renamed])]),
        { dialect: 'pg', retainRetired: true },
    );
    assert.strictEqual(plan[0], renameBack(plan, '_r_fld_code', 'product_code'));
    assert.ok(plan.includes('ALTER TABLE "children" ALTER COLUMN "product_code" SET NOT NULL'));
});

test('retainRetired refuses a non-Postgres dialect', () => {
    assert.throws(
        () => migrationPlan(model([CHILD_FULL]), model([CHILD_RETIRED]), { dialect: 'sqlite', retainRetired: true }),
        /Postgres-only/,
    );
});

test('the retain statements respect onlyTableIds', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, CHILD_RETIRED]),
        { ...RETIRE_OPTS, onlyTableIds: ['tbl_parent'] });
    assert.deepStrictEqual(plan, []);
});

test('retireMetaFor records what an unretire needs, type included', () => {
    assert.deepStrictEqual(retireMetaFor(CODE), {
        id: 'fld_code', key: '_r_fld_code', fieldKey: 'code', type: 'text', columnType: 'TEXT', stored: false, expr: null,
        relationTable: null, notNull: true, unique: true, fk: null, verified: false,
    });
    const owner = retireMetaFor(OWNER);
    assert.deepStrictEqual([owner.key, owner.notNull, owner.unique, owner.fk, owner.relationTable],
        ['_r_fld_owner', false, false, { table: 'tbl_parent' }, 'tbl_parent']);
    assert.strictEqual(retireMetaFor(f('fld_r', 'r', { type: 'relation', relation: { table: 'x', fk: false } })).fk, null);
});

test('retireMetaFor takes the physical state over the descriptor guess', () => {
    const m = retireMetaFor(CODE, { notNull: false, unique: true, fk: false });
    assert.deepStrictEqual([m.notNull, m.unique, m.verified], [false, true, true]);
    assert.strictEqual(retireMetaFor(OWNER, { notNull: false, unique: false, fk: false }).fk, null, 'no FK on the column, none to restore');
});

test('retiredColumnKey never matches a field key and stays inside 63 bytes', () => {
    assert.strictEqual(retiredColumnKey('fld_abc1'), '_r_fld_abc1');
    const long = retiredColumnKey(`fld_${'a'.repeat(80)}`);
    assert.ok(long.startsWith('_r_') && long.length <= 63, long);
    assert.ok(!/^[a-z]/.test(retiredColumnKey('fld_x')), 'KEY_RE keys start with a letter');
});

test('a new field taking a retired key gets a column of its own, in the same plan or a later one', () => {
    const status = f('fld_status', 'status');
    const statusDate = f('fld_status2', 'status', { type: 'date' });
    // Same plan: retire first, then add.
    const same = migrationPlan(model([t('tbl_x', 'xs', [status])]), model([t('tbl_x', 'xs', [statusDate])]), { dialect: 'pg', retainRetired: true });
    const aside = same.findIndex(s => s.includes('RENAME COLUMN "status" TO "_r_fld_status"'));
    const add = same.indexOf('ALTER TABLE "xs" ADD COLUMN IF NOT EXISTS "status" DATE');
    assert.ok(aside >= 0 && add > aside, same.join('\n'));
    // A later plan: the retired column sits at its own key, nothing collides.
    const later = migrationPlan(
        model([t('tbl_x', 'xs', [], { retired_fields: [retireMetaFor(status)] })]),
        model([t('tbl_x', 'xs', [statusDate], { retired_fields: [retireMetaFor(status)] })]),
        { dialect: 'pg', retainRetired: true },
    );
    assert.deepStrictEqual(later, ['ALTER TABLE "xs" ADD COLUMN IF NOT EXISTS "status" DATE']);
});

test('a live key on a column an older entry still occupies is a blocking conflict, never a silent no-op', () => {
    const legacy = { id: 'fld_status', key: 'status', notNull: false, unique: false, fk: null };
    const oldM = model([t('tbl_x', 'xs', [], { retired_fields: [legacy] })]);
    const newM = model([t('tbl_x', 'xs', [f('fld_other', 'status')], { retired_fields: [legacy] })]);
    assert.deepStrictEqual(retainConflicts(oldM, newM).map(c => [c.code, c.fieldId, c.retiredFieldId]),
        [['schema.retired_key_conflict', 'fld_other', 'fld_status']]);
    assert.throws(() => migrationPlan(oldM, newM, { dialect: 'pg', retainRetired: true }),
        (e) => e.status === 409 && e.code === 'schema_retain_conflict' && e.details.findings[0].code === 'schema.retired_key_conflict');
});

test('a returning field of another column type is a schema.type_change', () => {
    const asNumber = f('fld_code', 'code', { type: 'number' });
    const oldM = model([CHILD_RETIRED]);
    const newM = model([t('tbl_child', 'children', [NOTE, asNumber])]);
    assert.deepStrictEqual(retainConflicts(oldM, newM).map(c => [c.code, c.fieldId, c.reason]),
        [['schema.type_change', 'fld_code', 'column_type']]);
    assert.throws(() => migrationPlan(oldM, newM, { dialect: 'pg', retainRetired: true }), /retired columns/);
    // A relation returning with another target is a type change too.
    const otherTarget = f('fld_owner', 'owner', { type: 'relation', relation: { table: 'tbl_other' } });
    const rel = retainConflicts(oldM, model([t('tbl_child', 'children', [NOTE, otherTarget])]));
    assert.deepStrictEqual(rel.map(c => c.reason), ['relation_target']);
    // The same storage under another field type (select over text) is not.
    assert.deepStrictEqual(retainConflicts(oldM, model([t('tbl_child', 'children', [NOTE, f('fld_code', 'code', { type: 'select' })])])), []);
});

test('an unretire finds the column where retire put it, even when the entry names the field key', () => {
    const status = f('fld_status', 'status', { required: true });
    const retired = migrationPlan(model([t('tbl_x', 'xs', [status])]), model([t('tbl_x', 'xs', [])]), { dialect: 'pg', retainRetired: true });
    assert.ok(renameAside(retired, 'status', '_r_fld_status'), retired.join('\n'));
    const legacy = { id: 'fld_status', key: 'status', notNull: true };
    for (const opts of [
        { old: [t('tbl_x', 'xs', [], { retired_fields: [legacy] })], extra: {} },
        { old: [t('tbl_x', 'xs', [])], extra: { retiredMeta: new Map([['fld_status', { key: 'status', notNull: true }]]) } },
        { old: [t('tbl_x', 'xs', [])], extra: { retiredMeta: new Map([['fld_status', { notNull: true, unique: false, fk: null }]]) } },
    ]) {
        const back = migrationPlan(model(opts.old), model([t('tbl_x', 'xs', [status])]), { dialect: 'pg', retainRetired: true, ...opts.extra });
        assert.ok(renameBack(back, '_r_fld_status', 'status'), back.join('\n'));
        assert.ok(!bareAdd(back), back.join('\n'));
        assert.strictEqual(back[back.length - 1], 'ALTER TABLE "xs" ALTER COLUMN "status" SET NOT NULL');
    }
});

test('a field live in the new model but still listed as retired comes back, never as an empty column', () => {
    const status = f('fld_status', 'status');
    const entry = retireMetaFor(status);
    const plan = migrationPlan(
        model([t('tbl_x', 'xs', [], { retired_fields: [entry] })]),
        model([t('tbl_x', 'xs', [status], { retired_fields: [entry] })]),
        { dialect: 'pg', retainRetired: true, retiredFieldIds: new Set(['fld_status']) },
    );
    assert.ok(!bareAdd(plan), plan.join('\n'));
    assert.ok(renameBack(plan, '_r_fld_status', 'status'), plan.join('\n'));
});

test('under the option a table leaving the release is detached, never dropped', () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT]), { dialect: 'pg', retainRetired: true });
    assert.ok(!plan.some(s => /DROP TABLE/.test(s)), plan.join('\n'));
    const plain = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT]), { dialect: 'pg' });
    assert.ok(plain.includes('DROP TABLE IF EXISTS "children"'), 'the default plan still drops it');
});

// ── pglite: the statements against a real Postgres ─────────────────────

const { pg } = pgliteDb();

// One transaction, as the deploy commit runs it: a failing statement leaves
// nothing half-applied behind.
async function runPlan(plan) {
    await pg.transaction(async (tx) => { for (const stmt of plan) await tx.exec(stmt); });
}

before(async () => {
    const keys = new Map([['tbl_parent', 'parents'], ['tbl_child', 'children']]);
    await pg.exec(ddlForTable(PARENT, { tableKeyById: keys, dialect: 'pg' }));
    await pg.exec(ddlForTable(CHILD_FULL, { tableKeyById: keys, dialect: 'pg' }));
    await pg.query(`INSERT INTO parents (id, title) VALUES ('p1', 'one')`);
    await pg.query(`INSERT INTO children (id, note, code, owner) VALUES ('c1', 'first', 'A', 'p1')`);
});

after(async () => { await pg.close(); });

test('pglite: before retiring, the constraints really bite', async () => {
    await assert.rejects(pg.query(`INSERT INTO children (id, note) VALUES ('cx', 'no code')`), /null value|not-null/i);
    await assert.rejects(pg.query(`INSERT INTO children (id, note, code, owner) VALUES ('cy', 'x', 'B', 'nope')`), /foreign key/i);
});

test('pglite: after retiring, an insert without the retired columns succeeds and the data stays', async () => {
    const plan = migrationPlan(model([PARENT, CHILD_FULL]), model([PARENT, CHILD_RETIRED]), RETIRE_OPTS);
    await runPlan(plan);
    // The release no longer writes code or owner.
    await pg.query(`INSERT INTO children (id, note) VALUES ('c2', 'second')`);
    await pg.query(`INSERT INTO children (id, note) VALUES ('c3', 'third')`);
    // Unique and FK are gone too: an old writer's duplicate or dangling value no longer fails.
    await pg.query(`INSERT INTO children (id, note, _r_fld_code, _r_fld_owner) VALUES ('c4', 'x', 'A', 'gone')`);
    const kept = await pg.query(`SELECT _r_fld_code AS code, _r_fld_owner AS owner FROM children WHERE id = 'c1'`);
    assert.deepStrictEqual(kept.rows[0], { code: 'A', owner: 'p1' }, 'the retired column keeps its data');
    // Replaying the same plan is a no-op, not an error.
    await runPlan(plan);
});

test('pglite: an unretire re-adds the constraints, and a violation surfaces', async () => {
    const plan = migrationPlan(model([PARENT, CHILD_RETIRED]), model([PARENT, CHILD_FULL]), { dialect: 'pg', retainRetired: true });
    // Rows written while retired violate NOT NULL: the plan must fail, never pass silently.
    await assert.rejects(runPlan(plan), /null values|contains null/i);
    await pg.query(`DELETE FROM children WHERE id IN ('c2', 'c3', 'c4')`);
    await runPlan(plan);
    await assert.rejects(pg.query(`INSERT INTO children (id, note) VALUES ('c5', 'no code')`), /null value|not-null/i);
    await assert.rejects(pg.query(`INSERT INTO children (id, note, code) VALUES ('c6', 'dup', 'A')`), /duplicate key|unique/i);
    await assert.rejects(pg.query(`INSERT INTO children (id, note, code, owner) VALUES ('c7', 'x', 'C', 'nope')`), /foreign key/i);
    await pg.query(`INSERT INTO children (id, note, code, owner) VALUES ('c8', 'ok', 'D', 'p1')`);
    // The re-added FK is idempotent on replay.
    const fkOnly = plan.filter(s => /ADD CONSTRAINT/.test(s));
    await runPlan(fkOnly);
});

test('pglite: a required column added by ALTER was never NOT NULL, so its unretire does not make it one', async () => {
    const keys = new Map([['tbl_alt', 'alts']]);
    const V1 = t('tbl_alt', 'alts', [NOTE]);
    const REQ = f('fld_req', 'req', { required: true });
    const V2 = t('tbl_alt', 'alts', [NOTE, REQ]);
    await pg.exec(ddlForTable(V1, { tableKeyById: keys, dialect: 'pg' }));
    await pg.query(`INSERT INTO alts (id, note) VALUES ('a1', 'before the column')`);
    await runPlan(migrationPlan(model([V1]), model([V2]), { dialect: 'pg' }));
    const state = await readRetireState(pg, { tableKey: 'alts', tableId: 'tbl_alt', field: REQ });
    assert.deepStrictEqual(state, { notNull: false, unique: false, fk: false });
    const entry = retireMetaFor(REQ, state);
    assert.strictEqual(entry.notNull, false);

    const V3 = t('tbl_alt', 'alts', [NOTE], { retired_fields: [entry] });
    await runPlan(migrationPlan(model([V2]), model([V3]), { dialect: 'pg', retainRetired: true }));
    const back = migrationPlan(model([V3]), model([V2]), { dialect: 'pg', retainRetired: true });
    assert.ok(!back.some(s => /SET NOT NULL/.test(s)), back.join('\n'));
    await runPlan(back); // the row from before the column still holds NULL
    const row = await pg.query(`SELECT req FROM alts WHERE id = 'a1'`);
    assert.strictEqual(row.rows[0].req, null);
});

test('pglite: readRetireState reads the constraints a CREATE TABLE gave a column', async () => {
    const keys = new Map([['tbl_parent', 'parents'], ['tbl_st', 'states']]);
    const ST = t('tbl_st', 'states', [CODE, OWNER]);
    await pg.exec(ddlForTable(ST, { tableKeyById: keys, dialect: 'pg' }));
    assert.deepStrictEqual(await readRetireState(pg, { tableKey: 'states', tableId: 'tbl_st', field: CODE }), { notNull: true, unique: true, fk: false });
    assert.deepStrictEqual(await readRetireState(pg, { tableKey: 'states', tableId: 'tbl_st', field: OWNER }), { notNull: false, unique: false, fk: true });
    assert.strictEqual(await readRetireState(pg, { tableKey: 'states', tableId: 'tbl_st', field: NOTE }), null, 'no such column');
});

test('pglite: a same-key field in a later release gets its own column and type, the retired data stays apart', async () => {
    const keys = new Map([['tbl_sk', 'skeys']]);
    const status = f('fld_status', 'status');
    const statusDate = f('fld_status2', 'status', { type: 'date' });
    const R1 = t('tbl_sk', 'skeys', [NOTE, status]);
    await pg.exec(ddlForTable(R1, { tableKeyById: keys, dialect: 'pg' }));
    await pg.query(`INSERT INTO skeys (id, note, status) VALUES ('s1', 'n', 'open')`);
    const R2 = t('tbl_sk', 'skeys', [NOTE], { retired_fields: [retireMetaFor(status)] });
    await runPlan(migrationPlan(model([R1]), model([R2]), { dialect: 'pg', retainRetired: true }));
    const R3 = t('tbl_sk', 'skeys', [NOTE, statusDate], { retired_fields: [retireMetaFor(status)] });
    await runPlan(migrationPlan(model([R2]), model([R3]), { dialect: 'pg', retainRetired: true }));
    const types = await pg.query(`SELECT attname, format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'skeys'::regclass AND attname IN ('status', '_r_fld_status') ORDER BY attname`);
    assert.deepStrictEqual(types.rows, [{ attname: '_r_fld_status', t: 'text' }, { attname: 'status', t: 'date' }]);
    const row = await pg.query(`SELECT status, _r_fld_status AS old FROM skeys WHERE id = 's1'`);
    assert.deepStrictEqual(row.rows[0], { status: null, old: 'open' });
});

test('pglite: a returning field whose entry names its own key gets its retired column and data back', async () => {
    const keys = new Map([['tbl_lg', 'legs']]);
    const status = f('fld_status', 'status');
    const L1 = t('tbl_lg', 'legs', [NOTE, status]);
    await pg.exec(ddlForTable(L1, { tableKeyById: keys, dialect: 'pg' }));
    await pg.query(`INSERT INTO legs (id, note, status) VALUES ('l1', 'n', 'open')`);
    const legacy = { id: 'fld_status', key: 'status', notNull: false, unique: false, fk: null };
    const L2 = t('tbl_lg', 'legs', [NOTE], { retired_fields: [legacy] });
    await runPlan(migrationPlan(model([L1]), model([L2]), { dialect: 'pg', retainRetired: true }));
    const back = migrationPlan(model([L2]), model([L1]), { dialect: 'pg', retainRetired: true });
    await runPlan(back);
    await runPlan(back); // replay is a no-op
    const row = await pg.query(`SELECT status FROM legs WHERE id = 'l1'`);
    assert.strictEqual(row.rows[0].status, 'open');
});

test('pglite: a returning field with no column anywhere gets one added', async () => {
    const keys = new Map([['tbl_nc', 'nocols']]);
    await pg.exec(ddlForTable(t('tbl_nc', 'nocols', [NOTE]), { tableKeyById: keys, dialect: 'pg' }));
    const back = migrationPlan(
        model([t('tbl_nc', 'nocols', [NOTE])]),
        model([t('tbl_nc', 'nocols', [NOTE, f('fld_gone', 'gone')])]),
        { dialect: 'pg', retainRetired: true, retiredMeta: new Map([['fld_gone', { notNull: false }]]) },
    );
    await runPlan(back);
    await pg.query(`INSERT INTO nocols (id, note, gone) VALUES ('n1', 'x', 'y')`);
});
