/**
 * The compilers a MIRROR of an external table needs, and nothing a client can
 * reach through them: a caller-supplied record id, an upsert keyed on that id
 * that leaves an unchanged row alone, and the two whole-table reads the sync
 * builds its snapshot and its relation indexes from.
 */
const test = require('node:test');
const assert = require('node:assert');
const qc = require('./queryCompiler');

const PG = { dialect: 'pg' };
const meta = {
    id: 'tbl_facturen', key: 'facturen',
    fields: [
        { id: 'fld_a', key: 'leverancier', type: 'text' },
        { id: 'fld_b', key: 'totaal', type: 'number' },
        { id: 'fld_c', key: 'betaald', type: 'bool' },
    ],
};
const owner = { where: '1=1', params: [] };
const scoped = { where: '"org_id" = ?', params: ['org_1'] };

test('compileInsert takes a server-supplied id and still drops values.id', () => {
    const out = qc.compileInsert(meta, { id: 'rec_client', leverancier: 'Acme' }, { ...PG, id: '17' });
    assert.equal(out.id, '17');
    assert.equal(out.params[0], '17');
    assert.doesNotMatch(out.sql, /rec_client/);
    // Without the option the compiler still mints its own.
    assert.match(qc.compileInsert(meta, {}, PG).id, /^rec_[0-9a-f]+$/);
});

test('compileInsert refuses a malformed caller id', () => {
    for (const bad of ['', 42, null, 'x'.repeat(65)]) {
        assert.throws(() => qc.compileInsert(meta, {}, { ...PG, id: bad }), qc.CompileError);
    }
});

test('compileUpsertById conflicts on id, guards the update on the access filter AND a real change', () => {
    const out = qc.compileUpsertById(meta, '17', { leverancier: 'Acme', totaal: 12.5, betaald: true }, scoped,
        { ...PG, createdBy: 'user_1', orgId: 'org_1' });
    assert.match(out.sql, /^INSERT INTO "facturen" \("id", "created_at", "updated_at", "created_by", "org_id", "leverancier", "totaal", "betaald"\)/);
    assert.match(out.sql, /ON CONFLICT \("id"\) DO UPDATE SET "updated_at" = EXCLUDED\."updated_at", "leverancier" = EXCLUDED\."leverancier", "totaal" = EXCLUDED\."totaal", "betaald" = EXCLUDED\."betaald"/);
    assert.match(out.sql, /WHERE \("org_id" = \?\) AND \("facturen"\."leverancier", "facturen"\."totaal", "facturen"\."betaald"\) IS DISTINCT FROM \(EXCLUDED\."leverancier", EXCLUDED\."totaal", EXCLUDED\."betaald"\)$/);
    // id, created_at, updated_at, created_by, org_id, then the three values, then the filter param
    assert.equal(out.params[0], '17');
    assert.equal(out.params[3], 'user_1');
    assert.equal(out.params[4], 'org_1');
    assert.deepEqual(out.params.slice(5), ['Acme', 12.5, true, 'org_1']);
    // No minted id: the caller named the row.
    assert.equal(out.id, undefined);
});

test('compileUpsertById with no data columns can never update', () => {
    const out = qc.compileUpsertById(meta, '17', {}, owner, PG);
    assert.match(out.sql, /WHERE \(1=1\) AND 1=0$/);
});

test('compileUpsertById refuses sqlite, unknown fields and a bad id', () => {
    assert.throws(() => qc.compileUpsertById(meta, '17', {}, owner, { dialect: 'sqlite' }), /Postgres-only/);
    assert.throws(() => qc.compileUpsertById(meta, '17', { nope: 1 }, owner, PG), /unknown field/);
    assert.throws(() => qc.compileUpsertById(meta, '', {}, owner, PG), qc.CompileError);
});

test('compileIdList selects only ids, access-scoped, unlimited', () => {
    const out = qc.compileIdList(meta, scoped, PG);
    assert.equal(out.sql, 'SELECT "id" FROM "facturen" WHERE "org_id" = ?');
    assert.deepEqual(out.params, ['org_1']);
});

test('compileKeyValues reads one resolved column, NULLs excluded', () => {
    const out = qc.compileKeyValues(meta, 'leverancier', scoped, PG);
    assert.equal(out.sql, 'SELECT "id" AS "id", "leverancier" AS "k" FROM "facturen" WHERE ("org_id" = ?) AND "leverancier" IS NOT NULL');
    assert.deepEqual(out.params, ['org_1']);
    assert.throws(() => qc.compileKeyValues(meta, 'nope', scoped, PG), /unknown field/);
    assert.throws(() => qc.compileKeyValues(meta, 'x"; DROP', scoped, PG), qc.CompileError);
});
