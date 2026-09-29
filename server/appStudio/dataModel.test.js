/**
 * App Studio v2 DATA MODEL contract tests.
 *
 * Three layers:
 *   1. validateDataModel — one assertion per error class.
 *   2. canonicalizeDataModel + ddlForTable — pure structural checks.
 *   3. migrationPlan — pure string checks PLUS a property-style end-to-end test
 *      that applies random migration plans against a real in-memory SQLite DB
 *      and asserts the resulting physical schema matches the new model. The
 *      e2e block SKIPs when better-sqlite3's native binding can't load.
 *
 * Run: node --test appStudio/dataModel.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const dm = require('./dataModel');

// ── Small model builders ────────────────────────────────────────────
function field(over = {}) {
    return { id: dm.newFieldId(), key: 'name', type: 'text', required: false, unique: false, ...over };
}
function table(over = {}) {
    return { id: dm.newTableId(), key: 'people', name: 'People', icon: null, fields: [], access: { default: 'app', roles: {}, rowFilters: {} }, ...over };
}
function model(tables = []) {
    return { modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

// ── 1. validateDataModel ────────────────────────────────────────────

test('validate: rejects a non-object model', () => {
    assert.ok(dm.validateDataModel(null).errors.some(e => /must be an object/.test(e)));
});

test('validate: rejects a bad modelVersion', () => {
    const { errors } = dm.validateDataModel({ modelVersion: 2, tables: [] });
    assert.ok(errors.some(e => /modelVersion/.test(e)));
});

test('validate: tables must be an array', () => {
    assert.ok(dm.validateDataModel({ modelVersion: 1, tables: {} }).errors.some(e => /tables must be an array/.test(e)));
});

test('validate: too many tables', () => {
    const tables = Array.from({ length: dm.DATA_LIMITS.MAX_TABLES_PER_APP + 1 }, (_, i) =>
        table({ id: `tbl_${String(i).padStart(6, '0')}`, key: `t${i}` }));
    assert.ok(dm.validateDataModel(model(tables)).errors.some(e => /too many tables/.test(e)));
});

test('validate: bad table id, duplicate table id, bad+duplicate table key', () => {
    assert.ok(dm.validateDataModel(model([table({ id: 'nope' })])).errors.some(e => /id must match tbl_/.test(e)));
    const dupId = dm.validateDataModel(model([table({ id: 'tbl_aaaaaa', key: 'a' }), table({ id: 'tbl_aaaaaa', key: 'b' })]));
    assert.ok(dupId.errors.some(e => /is duplicated/.test(e)));
    assert.ok(dm.validateDataModel(model([table({ key: 'Bad Key' })])).errors.some(e => /key .* must match/.test(e)));
    const dupKey = dm.validateDataModel(model([table({ id: 'tbl_a1', key: 'same' }), table({ id: 'tbl_b2', key: 'same' })]));
    assert.ok(dupKey.errors.some(e => /key "same" is duplicated/.test(e)));
});

test('validate: fields array, field-count cap', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: 'x' })])).errors.some(e => /fields must be an array/.test(e)));
    const fields = Array.from({ length: dm.DATA_LIMITS.MAX_FIELDS_PER_TABLE + 1 }, (_, i) =>
        field({ id: `fld_${String(i).padStart(6, '0')}`, key: `f${i}` }));
    assert.ok(dm.validateDataModel(model([table({ fields })])).errors.some(e => /too many fields/.test(e)));
});

test('validate: bad/dup field id, bad/dup/reserved field key', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ id: 'x' })] })])).errors.some(e => /id must match fld_/.test(e)));
    const dupFieldId = model([table({ fields: [field({ id: 'fld_dupp', key: 'a' }), field({ id: 'fld_dupp', key: 'b' })] })]);
    assert.ok(dm.validateDataModel(dupFieldId).errors.some(e => /id "fld_dupp" is duplicated/.test(e)));
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ key: 'Bad' })] })])).errors.some(e => /key .* must match/.test(e)));
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ key: 'created_by' })] })])).errors.some(e => /reserved system column/.test(e)));
    const dupFieldKey = model([table({ fields: [field({ key: 'same' }), field({ key: 'same' })] })]);
    assert.ok(dm.validateDataModel(dupFieldKey).errors.some(e => /key "same" is duplicated/.test(e)));
});

test('validate: unknown field type', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ type: 'colour' })] })])).errors.some(e => /not a known field type/.test(e)));
});

test('validate: select requires options and caps them', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ type: 'select', key: 'status' })] })])).errors.some(e => /requires an options array/.test(e)));
    const many = Array.from({ length: dm.DATA_LIMITS.MAX_SELECT_OPTIONS + 1 }, (_, i) => `o${i}`);
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ type: 'multiselect', key: 'tags', options: many })] })])).errors.some(e => /too many options/.test(e)));
});

test('validate: relation must resolve to a table in the model', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ type: 'relation', key: 'owner' })] })])).errors.some(e => /requires relation.table/.test(e)));
    const unresolved = model([table({ id: 'tbl_aaaa', key: 'a', fields: [field({ type: 'relation', key: 'owner', relation: { table: 'tbl_missing' } })] })]);
    assert.ok(dm.validateDataModel(unresolved).errors.some(e => /does not resolve/.test(e)));
    const resolved = model([
        table({ id: 'tbl_aaaa', key: 'a', fields: [field({ type: 'relation', key: 'owner', relation: { table: 'tbl_bbbb' } })] }),
        table({ id: 'tbl_bbbb', key: 'b' }),
    ]);
    assert.strictEqual(dm.validateDataModel(resolved).errors.length, 0);
});

test('validate: computed needs a descriptor and a safe expr', () => {
    assert.ok(dm.validateDataModel(model([table({ fields: [field({ type: 'computed', key: 'c' })] })])).errors.some(e => /requires a computed descriptor/.test(e)));
    const inj = model([table({ fields: [field({ type: 'computed', key: 'c', computed: { expr: 'a); DROP TABLE x;--' } })] })]);
    assert.ok(dm.validateDataModel(inj).errors.some(e => /computed\.expr may not contain/.test(e)));
    const ok = model([table({ fields: [field({ type: 'computed', key: 'c', computed: { expr: 'price * qty' } })] })]);
    assert.strictEqual(dm.validateDataModel(ok).errors.length, 0);
});

test('validate: roles + roleMapping shape', () => {
    assert.ok(dm.validateDataModel({ modelVersion: 1, tables: [], roles: {} }).errors.some(e => /roles must be an array/.test(e)));
    assert.ok(dm.validateDataModel({ modelVersion: 1, tables: [], roles: [{ key: 'Bad Key' }] }).errors.some(e => /roles\[0\].key/.test(e)));
    assert.ok(dm.validateDataModel({ modelVersion: 1, tables: [], roleMapping: [] }).errors.some(e => /roleMapping must be an object/.test(e)));
});

test('validate: a clean model yields no errors', () => {
    const clean = model([table({ fields: [field({ key: 'title' }), field({ key: 'count', type: 'number' })] })]);
    assert.deepStrictEqual(dm.validateDataModel(clean).errors, []);
});

// ── 1b. table.source — de TWEEDE tabelsoort ─────────────────────────
// Zonder `source` bezit de app haar eigen opslag (de soort die er altijd al
// was); met `source` staan de rijen in een Studio-datatabel. Deze blok pint de
// twee dingen die niet mogen verschuiven: `mode` kent twee waarden en een derde
// is een FOUT, en niets aan de bestaande soort verandert.

const sourced = (source) => model([table({ id: 'tbl_link01', key: 'orders', source })]);

test('validate: table.source accepts the datatable kind in both modes', () => {
    for (const mode of dm.TABLE_SOURCE_MODES) {
        const { errors } = dm.validateDataModel(sourced({ kind: 'datatable', datatableId: 'tbl_dt0001', mode }));
        assert.deepStrictEqual(errors, [], `mode ${mode} is legal`);
    }
});

test('validate: an unknown third mode is an error, never a silent read', () => {
    for (const mode of ['write', 'readWrite', 'read-write', '', null, 7]) {
        const { errors } = dm.validateDataModel(sourced({ kind: 'datatable', datatableId: 'tbl_dt0001', mode }));
        assert.ok(
            errors.some((e) => /source\.mode/.test(e) && /read, readwrite/.test(e)),
            `mode ${JSON.stringify(mode)} rejected by name: ${JSON.stringify(errors)}`,
        );
    }
});

test('validate: table.source kind / datatableId / stray keys are rejected by name', () => {
    assert.ok(dm.validateDataModel(sourced('tbl_dt0001')).errors.some(e => /source must be an object/.test(e)));
    assert.ok(dm.validateDataModel(sourced({ kind: 'sheet', datatableId: 'tbl_dt0001', mode: 'read' }))
        .errors.some(e => /source\.kind "sheet" is not a known table source kind/.test(e)));
    assert.ok(dm.validateDataModel(sourced({ kind: 'datatable', datatableId: 'nope', mode: 'read' }))
        .errors.some(e => /source\.datatableId "nope" must match tbl_/.test(e)));
    assert.ok(dm.validateDataModel(sourced({ kind: 'datatable', mode: 'read' }))
        .errors.some(e => /source\.datatableId undefined must match tbl_/.test(e)));
    // Een sleutel waarvan iemand dacht dat hij iets deed, ziet er ingeschakeld
    // uit en doet niets. Dus afwijzen, met de naam erbij.
    assert.ok(dm.validateDataModel(sourced({ kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read', readOnly: true }))
        .errors.some(e => /source has unknown keys: readOnly/.test(e)));
});

test('validate: a table WITHOUT source is untouched by any of this', () => {
    assert.deepStrictEqual(dm.validateDataModel(model([table({ key: 'orders' })])).errors, []);
    assert.deepStrictEqual(dm.validateDataModel(sourced(null)).errors, [], 'explicit null = own storage');
});

test('canonicalize: an ABSENT source mode narrows to read; a filled-in one is left alone', () => {
    const { model: out, repairs } = dm.canonicalizeDataModel(sourced({ kind: 'datatable', datatableId: 'tbl_dt0001' }));
    assert.strictEqual(out.tables[0].source.mode, 'read', 'never asked for write, never gets it');
    assert.ok(repairs.some(r => /source mode defaulted to read/.test(r)), 'and it says so');

    // Een INGEVULDE mode blijft staan — ook een onbekende. Hem naar 'read'
    // duwen zou een typefout in een recht veranderen zonder dat iemand het ziet;
    // validateDataModel wijst hem daarna af.
    const { model: typo } = dm.canonicalizeDataModel(sourced({ kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'readWrite' }));
    assert.strictEqual(typo.tables[0].source.mode, 'readWrite');
    assert.ok(dm.validateDataModel(typo).errors.some(e => /source\.mode/.test(e)));
});

test('canonicalize: a model without source canonicalizes byte-identically', () => {
    const before = model([table({ key: 'orders' })]);
    const { model: out } = dm.canonicalizeDataModel(structuredClone(before));
    assert.ok(!('source' in out.tables[0]), 'no source key invented');
    assert.deepStrictEqual(out, before);
    // Een expliciete null laat geen sleutel rondslingeren.
    const { model: nulled } = dm.canonicalizeDataModel(sourced(null));
    assert.ok(!('source' in nulled.tables[0]));
});

// ── 2. canonicalizeDataModel ────────────────────────────────────────

test('canonicalize: fills ids/keys/names, coerces flags, defaults access', () => {
    const { model: out, repairs } = dm.canonicalizeDataModel({
        tables: [{ name: 'My Table', fields: [{ name: 'First Name', type: 'text', required: 1 }, { name: 'Bad', type: 'nope' }] }],
    });
    assert.strictEqual(out.modelVersion, 1);
    const t = out.tables[0];
    assert.match(t.id, /^tbl_[0-9a-f]{6}$/);
    assert.match(t.key, /^[a-z][a-z0-9_]*$/);
    assert.strictEqual(t.name, 'My Table');
    assert.deepStrictEqual(t.access, { default: 'app', roles: {}, rowFilters: {} });
    assert.match(t.fields[0].id, /^fld_[0-9a-f]{6}$/);
    assert.strictEqual(t.fields[0].required, true, 'required coerced to boolean');
    assert.strictEqual(t.fields[1].type, 'text', 'unknown type repaired to text');
    assert.ok(repairs.length > 0);
});

test('canonicalize: dedupes colliding table keys and clamps options', () => {
    const many = Array.from({ length: dm.DATA_LIMITS.MAX_SELECT_OPTIONS + 5 }, (_, i) => `o${i}`);
    const { model: out } = dm.canonicalizeDataModel({
        tables: [
            { key: 'dup', fields: [] },
            { key: 'dup', fields: [{ key: 'tags', type: 'select', options: many }] },
        ],
    });
    assert.notStrictEqual(out.tables[0].key, out.tables[1].key, 'colliding keys disambiguated');
    assert.strictEqual(out.tables[1].fields[0].options.length, dm.DATA_LIMITS.MAX_SELECT_OPTIONS);
});

test('canonicalize: reserved field key is rewritten', () => {
    const { model: out } = dm.canonicalizeDataModel({ tables: [{ key: 't', fields: [{ key: 'org_id', type: 'text' }] }] });
    assert.notStrictEqual(out.tables[0].fields[0].key, 'org_id');
});

// ── 2b. ddlForTable ─────────────────────────────────────────────────

test('ddlForTable: system columns + type mapping', () => {
    const t = table({
        key: 'items', id: 'tbl_items0',
        fields: [
            field({ key: 'title', type: 'text' }),
            field({ key: 'qty', type: 'number', subtype: 'integer' }),
            field({ key: 'price', type: 'number' }),
            field({ key: 'active', type: 'bool' }),
            field({ key: 'tags', type: 'multiselect', options: ['a'] }),
        ],
    });
    const ddl = dm.ddlForTable(t);
    for (const sys of dm.SYSTEM_COLUMNS) assert.ok(new RegExp(`\\b${sys}\\b`).test(ddl), `has system col ${sys}`);
    assert.match(ddl, /"title" TEXT/);
    assert.match(ddl, /"qty" INTEGER/);
    assert.match(ddl, /"price" REAL/);
    assert.match(ddl, /"active" INTEGER/);
    assert.match(ddl, /"tags" TEXT/);
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS "items"/);
});

test('ddlForTable: unique → separate index (never inline UNIQUE); required default; escaping', () => {
    const t = table({
        key: 'u', id: 'tbl_uuuuuu',
        fields: [
            field({ id: 'fld_u1', key: 'email', type: 'text', unique: true }),
            field({ key: 'status', type: 'text', required: true, default: "o'brien" }),
        ],
    });
    const ddl = dm.ddlForTable(t);
    assert.ok(!/UNIQUE\s*\)/.test(ddl) && !/TEXT UNIQUE/.test(ddl), 'no inline UNIQUE');
    assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_uuuuuu_fld_u1" ON "u" \("email"\)/);
    assert.match(ddl, /"status" TEXT NOT NULL DEFAULT 'o''brien'/, 'default single-quote escaped');
});

test('ddlForTable: relation emits FK only when target resolves', () => {
    const t = table({ key: 'a', fields: [field({ key: 'owner', type: 'relation', relation: { table: 'tbl_b' } })] });
    assert.ok(!/REFERENCES/.test(dm.ddlForTable(t)), 'no map → plain TEXT');
    const withMap = dm.ddlForTable(t, { tableKeyById: new Map([['tbl_b', 'people']]) });
    assert.match(withMap, /"owner" TEXT REFERENCES "people"\(id\)/);
});

test('ddlForTable: computed read-time omitted; stored emitted GENERATED STORED', () => {
    const readTime = table({ key: 'c', fields: [field({ key: 'total', type: 'computed', computed: { expr: 'a + b' } })] });
    assert.ok(!/total/.test(dm.ddlForTable(readTime)), 'read-time computed → no column');
    const stored = table({ key: 'c', fields: [field({ key: 'total', type: 'computed', computed: { expr: 'a + b', stored: true, type: 'number' } })] });
    assert.match(dm.ddlForTable(stored), /"total" REAL GENERATED ALWAYS AS \(a \+ b\) STORED/);
});

// ── 3. migrationPlan — pure string checks ───────────────────────────

test('migrationPlan: a stored-computed rule change rebuilds the column', () => {
    // A GENERATED ALWAYS column answers with the expression baked in at
    // CREATE time. Editing computed.expr in the model used to emit no DDL at
    // all, so the model and the data disagreed in silence — a check column
    // kept reporting the old verdict while its definition said otherwise.
    // Safe to rebuild precisely because the value is derived: DROP + ADD
    // recomputes it from the surviving columns.
    const withExpr = (expr, stored = true) => ({
        tables: [{
            id: 'tl', key: 'lines', name: 'Lines', fields: [
                { id: 'fn', key: 'note', type: 'text' },
                { id: 'fc', key: 'check', type: 'computed', computed: { type: 'text', stored, expr } },
            ],
        }],
    });
    const A = "CASE WHEN note IS NULL THEN 'todo' ELSE 'ok' END";
    const B = "CASE WHEN note IS NULL THEN 'todo' WHEN note <> '' THEN 'kijken' ELSE 'ok' END";

    const changed = dm.migrationPlan(withExpr(A), withExpr(B));
    assert.deepEqual(changed, [
        'ALTER TABLE "lines" DROP COLUMN "check"',
        `ALTER TABLE "lines" ADD COLUMN "check" TEXT GENERATED ALWAYS AS (${B}) STORED`,
    ], 'the rule change is a drop + re-add carrying the NEW expression');

    // Same rule, no churn — a save that touches something else must not
    // rebuild a column (and briefly empty it) for nothing.
    assert.deepEqual(dm.migrationPlan(withExpr(A), withExpr(A)), [], 'an unchanged rule emits nothing');

    // read-time → stored materialises; stored → read-time drops.
    assert.deepEqual(dm.migrationPlan(withExpr(A, false), withExpr(A, true)),
        [`ALTER TABLE "lines" ADD COLUMN "check" TEXT GENERATED ALWAYS AS (${A}) STORED`],
        'materialising a read-time computed is an ADD');
    assert.deepEqual(dm.migrationPlan(withExpr(A, true), withExpr(A, false)),
        ['ALTER TABLE "lines" DROP COLUMN "check"'],
        'going back to read-time drops the physical column');
});
test('migrationPlan: a stored-computed field ADDED to an existing table materialises', () => {
    // The gap this closes: step 4 sent every new field through addColumnDdl,
    // which returns [] for anything computed. So the save succeeded, the model
    // listed the field, the table never grew the column, and every read came
    // back with the key missing — no error, no warning, nothing to notice.
    const EXPR = "CASE WHEN note IS NULL THEN 'todo' ELSE 'ok' END";
    const before = {
        tables: [{ id: 'tl', key: 'lines', name: 'Lines', fields: [{ id: 'fn', key: 'note', type: 'text' }] }],
    };
    const withField = (stored) => ({
        tables: [{
            id: 'tl', key: 'lines', name: 'Lines', fields: [
                { id: 'fn', key: 'note', type: 'text' },
                { id: 'fc', key: 'check', type: 'computed', computed: { type: 'text', stored, expr: EXPR } },
            ],
        }],
    });

    assert.deepEqual(dm.migrationPlan(before, withField(true)),
        [`ALTER TABLE "lines" ADD COLUMN "check" TEXT GENERATED ALWAYS AS (${EXPR}) STORED`],
        'a new stored-computed field gets its column');
    assert.deepEqual(dm.migrationPlan(before, withField(false)), [],
        'a read-time computed still has no column — that is what read-time means');

    // …and removing it takes the column with it, rather than orphaning a
    // column no field explains any more.
    assert.deepEqual(dm.migrationPlan(withField(true), before),
        ['ALTER TABLE "lines" DROP COLUMN "check"']);
    assert.deepEqual(dm.migrationPlan(withField(false), before), []);
});

test('migrationPlan: add table / drop table', () => {
    const a = table({ id: 'tbl_a', key: 'a' });
    const b = table({ id: 'tbl_b', key: 'b' });
    assert.ok(dm.migrationPlan(model([a]), model([a, b])).some(s => /CREATE TABLE IF NOT EXISTS "b"/.test(s)));
    assert.ok(dm.migrationPlan(model([a, b]), model([a])).some(s => /DROP TABLE IF EXISTS "b"/.test(s)));
});

test('migrationPlan: add / drop column', () => {
    const t0 = table({ id: 'tbl_t', key: 't', fields: [field({ id: 'fld_1', key: 'a' })] });
    const t1 = table({ id: 'tbl_t', key: 't', fields: [field({ id: 'fld_1', key: 'a' }), field({ id: 'fld_2', key: 'b', type: 'number' })] });
    assert.ok(dm.migrationPlan(model([t0]), model([t1])).some(s => /ALTER TABLE "t" ADD COLUMN "b" REAL/.test(s)));
    assert.ok(dm.migrationPlan(model([t1]), model([t0])).some(s => /ALTER TABLE "t" DROP COLUMN "b"/.test(s)));
});

test('migrationPlan: rename table then column (table rename comes first)', () => {
    const before = table({ id: 'tbl_x', key: 'old_t', fields: [field({ id: 'fld_1', key: 'old_f' })] });
    const after = table({ id: 'tbl_x', key: 'new_t', fields: [field({ id: 'fld_1', key: 'new_f' })] });
    const plan = dm.migrationPlan(model([before]), model([after]));
    const iTable = plan.findIndex(s => /RENAME TO "new_t"/.test(s));
    const iCol = plan.findIndex(s => /RENAME COLUMN "old_f" TO "new_f"/.test(s));
    assert.ok(iTable >= 0 && iCol >= 0);
    assert.ok(iTable < iCol, 'table rename must precede column rename');
    assert.match(plan[iCol], /ALTER TABLE "new_t"/, 'column rename addresses the NEW table name');
});

test('migrationPlan: add relation FK — new table created before the inbound ADD COLUMN', () => {
    const child = table({ id: 'tbl_c', key: 'c', fields: [field({ id: 'fld_1', key: 'a' })] });
    const childRel = table({ id: 'tbl_c', key: 'c', fields: [
        field({ id: 'fld_1', key: 'a' }),
        field({ id: 'fld_r', key: 'parent', type: 'relation', relation: { table: 'tbl_p' } }),
    ] });
    const parent = table({ id: 'tbl_p', key: 'p' });
    const plan = dm.migrationPlan(model([child]), model([childRel, parent]));
    const iParent = plan.findIndex(s => /CREATE TABLE IF NOT EXISTS "p"/.test(s));
    const iRel = plan.findIndex(s => /ADD COLUMN "parent" TEXT REFERENCES "p"\(id\)/.test(s));
    assert.ok(iParent >= 0 && iRel >= 0, 'both statements present');
    assert.ok(iParent < iRel, 'parent table created before the FK column that references it');
});

test('migrationPlan: unique toggle on/off; drop unique column drops its index first', () => {
    const plain = table({ id: 'tbl_u', key: 'u', fields: [field({ id: 'fld_e', key: 'email' })] });
    const uniq = table({ id: 'tbl_u', key: 'u', fields: [field({ id: 'fld_e', key: 'email', unique: true })] });
    assert.ok(dm.migrationPlan(model([plain]), model([uniq])).some(s => /CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_u_fld_e"/.test(s)));
    assert.ok(dm.migrationPlan(model([uniq]), model([plain])).some(s => /DROP INDEX IF EXISTS "uq_tbl_u_fld_e"/.test(s)));

    const dropPlan = dm.migrationPlan(model([uniq]), model([table({ id: 'tbl_u', key: 'u', fields: [] })]));
    const iIdx = dropPlan.findIndex(s => /DROP INDEX IF EXISTS "uq_tbl_u_fld_e"/.test(s));
    const iCol = dropPlan.findIndex(s => /DROP COLUMN "email"/.test(s));
    assert.ok(iIdx >= 0 && iCol >= 0 && iIdx < iCol, 'unique index dropped before its column');
});

test('migrationPlan: no-op for identical models', () => {
    const t = table({ id: 'tbl_t', key: 't', fields: [field({ id: 'fld_1', key: 'a' })] });
    assert.deepStrictEqual(dm.migrationPlan(model([t]), model([t])), []);
});

// ── 3b. migrationPlan — property-style e2e against real SQLite ───────

let Database = null;
try { Database = require('better-sqlite3'); } catch (_) { /* skip below */ }

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const FIELD_KINDS = ['text', 'number', 'bool', 'select'];

function buildRandomModel(rng, counter) {
    const nTables = 1 + Math.floor(rng() * 3);
    const tables = [];
    for (let i = 0; i < nTables; i++) {
        const tid = `tbl_${String(counter.t++).padStart(6, '0')}`;
        const fields = [];
        const nFields = Math.floor(rng() * 3);
        for (let j = 0; j < nFields; j++) {
            const fid = `fld_${String(counter.f++).padStart(6, '0')}`;
            const kind = FIELD_KINDS[Math.floor(rng() * FIELD_KINDS.length)];
            const f = { id: fid, key: `f${counter.f}`, type: kind, required: false, unique: rng() < 0.3 };
            if (kind === 'select') f.options = ['a', 'b'];
            fields.push(f);
        }
        tables.push({ id: tid, key: `t${counter.t}`, name: `T${i}`, fields });
    }
    return { modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

// Physical column names expected for a table (system cols + all field keys,
// since the property generator never uses computed fields).
function expectedColumns(t) {
    return new Set([...dm.SYSTEM_COLUMNS, ...t.fields.map(f => f.key)]);
}

function mutate(rng, base, counter) {
    // Deep clone.
    const next = JSON.parse(JSON.stringify(base));
    const ops = 1 + Math.floor(rng() * 4);
    for (let k = 0; k < ops; k++) {
        const choice = rng();
        if (choice < 0.18 && next.tables.length > 0) {
            // rename a table
            const t = next.tables[Math.floor(rng() * next.tables.length)];
            t.key = `t${counter.t++}r`;
        } else if (choice < 0.36 && next.tables.some(t => t.fields.length)) {
            // rename a field
            const cands = next.tables.filter(t => t.fields.length);
            const t = cands[Math.floor(rng() * cands.length)];
            const f = t.fields[Math.floor(rng() * t.fields.length)];
            f.key = `f${counter.f++}r`;
        } else if (choice < 0.55 && next.tables.length > 0) {
            // add a field
            const t = next.tables[Math.floor(rng() * next.tables.length)];
            const kind = FIELD_KINDS[Math.floor(rng() * FIELD_KINDS.length)];
            const f = { id: `fld_${String(counter.f++).padStart(6, '0')}`, key: `f${counter.f}n`, type: kind, required: false, unique: rng() < 0.3 };
            if (kind === 'select') f.options = ['a'];
            t.fields.push(f);
        } else if (choice < 0.70 && next.tables.some(t => t.fields.length)) {
            // drop a field
            const cands = next.tables.filter(t => t.fields.length);
            const t = cands[Math.floor(rng() * cands.length)];
            t.fields.splice(Math.floor(rng() * t.fields.length), 1);
        } else if (choice < 0.82) {
            // add a table
            next.tables.push({ id: `tbl_${String(counter.t++).padStart(6, '0')}`, key: `t${counter.t}n`, name: 'N', fields: [] });
        } else if (choice < 0.92 && next.tables.length > 1) {
            // drop a table
            next.tables.splice(Math.floor(rng() * next.tables.length), 1);
        } else if (next.tables.some(t => t.fields.length)) {
            // toggle unique
            const cands = next.tables.filter(t => t.fields.length);
            const t = cands[Math.floor(rng() * cands.length)];
            const f = t.fields[Math.floor(rng() * t.fields.length)];
            f.unique = !f.unique;
        }
    }
    return next;
}

test('migrationPlan: property — random plans applied to real SQLite yield the new schema', (t) => {
    if (!Database) return t.skip('better-sqlite3 native binding unavailable');
    const rng = mulberry32(20260704);
    const ITER = 60;
    for (let iter = 0; iter < ITER; iter++) {
        const counter = { t: iter * 1000, f: iter * 1000 };
        const oldModel = buildRandomModel(rng, counter);
        const newModel = mutate(rng, oldModel, counter);

        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        const keyById = new Map(oldModel.tables.map(x => [x.id, x.key]));
        for (const tbl of oldModel.tables) db.exec(dm.ddlForTable(tbl, { tableKeyById: keyById }));

        const plan = dm.migrationPlan(oldModel, newModel);
        try {
            for (const stmt of plan) db.exec(stmt);
        } catch (err) {
            db.close();
            assert.fail(`iter ${iter}: plan failed to apply: ${err.message}\nPLAN:\n${plan.join(';\n')}`);
        }

        // Every new table's physical columns must match the model.
        for (const tbl of newModel.tables) {
            const cols = db.prepare(`PRAGMA table_info("${tbl.key}")`).all();
            assert.ok(cols.length > 0, `iter ${iter}: table ${tbl.key} should exist`);
            const got = new Set(cols.map(c => c.name));
            assert.deepStrictEqual(got, expectedColumns(tbl), `iter ${iter}: columns for ${tbl.key}`);
            // Unique fields must be backed by their stable-id index.
            for (const f of tbl.fields.filter(x => x.unique)) {
                const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
                    .get(dm._uniqueIndexName(tbl.id, f.id));
                assert.ok(idx, `iter ${iter}: missing unique index for ${tbl.key}.${f.key}`);
            }
        }
        // Dropped tables must be gone.
        const surviving = new Set(newModel.tables.map(x => x.key));
        for (const old of oldModel.tables) {
            if (!newModel.tables.some(x => x.id === old.id)) {
                // old.key may have been reused by a rename; only assert when truly gone.
                if (!surviving.has(old.key)) {
                    const info = db.prepare(`PRAGMA table_info("${old.key}")`).all();
                    assert.strictEqual(info.length, 0, `iter ${iter}: dropped table ${old.key} should be gone`);
                }
            }
        }
        db.close();
    }
});

// ── Connectors (model.connectors[]) ─────────────────────────────────
function connModel(connectors) {
    return { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} }, connectors };
}
const errsOf = (m) => dm.validateDataModel(m).errors;

test('connectors: a valid integration_tool / automation / rest set passes', () => {
    const { errors } = dm.validateDataModel(connModel([
        { id: 'conn_aaa111', kind: 'integration_tool', name: 'Emails', tool: 'gmail_list', fixedArgs: { labelIds: ['INBOX'] } },
        { id: 'conn_bbb222', kind: 'automation', name: 'Sync', automationId: 'auto-1' },
        { id: 'conn_ccc333', kind: 'rest', name: 'Items', params: [{ key: 'q', type: 'text' }], url: 'https://api.example.com/items?q={q}', auth: { type: 'bearer', credentialProvider: 'example' }, maxRows: 50 },
    ]));
    assert.deepStrictEqual(errors, [], JSON.stringify(errors));
});

test('connectors: bad id / unknown kind / duplicate id are rejected', () => {
    assert.ok(errsOf(connModel([{ id: 'bad', kind: 'rest', url: 'https://a.example.com/x' }])).some((e) => /id must match conn_/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_xx1111', kind: 'ftp' }])).some((e) => /not a known connector kind/.test(e)));
    const dup = errsOf(connModel([
        { id: 'conn_dup111', kind: 'automation', automationId: 'a' },
        { id: 'conn_dup111', kind: 'automation', automationId: 'b' },
    ]));
    assert.ok(dup.some((e) => /duplicated/.test(e)));
});

test('connectors: per-kind required fields', () => {
    assert.ok(errsOf(connModel([{ id: 'conn_t00001', kind: 'integration_tool' }])).some((e) => /requires a tool name/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_a00001', kind: 'automation' }])).some((e) => /requires an automationId/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_r00001', kind: 'rest' }])).some((e) => /requires a url template/.test(e)));
});

test('connectors: integration_tool accepts integrationId + runAs, rejects bad values', () => {
    assert.deepStrictEqual(errsOf(connModel([
        { id: 'conn_v00001', kind: 'integration_tool', tool: 'gmail_list', integrationId: 'gmail', runAs: 'viewer' },
        { id: 'conn_v00002', kind: 'integration_tool', tool: 'gmail_list', integrationId: 'google-calendar', runAs: 'owner' },
        { id: 'conn_v00003', kind: 'integration_tool', tool: 'gmail_list' }, // both optional
    ])), []);
    assert.ok(errsOf(connModel([{ id: 'conn_v00004', kind: 'integration_tool', tool: 't', runAs: 'admin' }]))
        .some((e) => /runAs must be 'owner' or 'viewer'/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_v00005', kind: 'integration_tool', tool: 't', integrationId: 'bad id!' }]))
        .some((e) => /integrationId must be a provider id/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_v00006', kind: 'integration_tool', tool: 't', integrationId: 42 }]))
        .some((e) => /integrationId must be a provider id/.test(e)));
});

test('connectors: rest url must be https, host not templated, placeholders declared', () => {
    assert.ok(errsOf(connModel([{ id: 'conn_r00001', kind: 'rest', url: 'http://api.example.com/x' }])).some((e) => /must be https/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_r00002', kind: 'rest', url: 'https://{host}.example.com/x' }])).some((e) => /may not template the host/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_r00003', kind: 'rest', url: 'https://api.example.com/x?p={undeclared}' }])).some((e) => /undeclared param \{undeclared\}/.test(e)));
    // A declared placeholder passes.
    assert.deepStrictEqual(errsOf(connModel([{ id: 'conn_r00004', kind: 'rest', params: [{ key: 'p' }], url: 'https://api.example.com/x?p={p}' }])), []);
});

test('connectors: maxRows may not exceed the runtime ceiling (500)', () => {
    assert.ok(errsOf(connModel([{ id: 'conn_r00001', kind: 'rest', url: 'https://api.example.com/x', maxRows: 5000 }])).some((e) => /exceeds the cap/.test(e)));
    assert.deepStrictEqual(errsOf(connModel([{ id: 'conn_r00002', kind: 'rest', url: 'https://api.example.com/x', maxRows: 500 }])), []);
});

test('connectors: NO inline secrets — only auth.credentialProvider is allowed', () => {
    assert.ok(errsOf(connModel([{ id: 'conn_s00001', kind: 'rest', url: 'https://api.example.com/x', apiKey: 'sk-live-123' }])).some((e) => /inline secret/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_s00002', kind: 'rest', url: 'https://api.example.com/x', headers: { Authorization: 'Bearer abc' } }])).some((e) => /secret header/.test(e)));
    assert.ok(errsOf(connModel([{ id: 'conn_s00003', kind: 'rest', url: 'https://api.example.com/x', auth: { type: 'bearer', token: 'abc' } }])).some((e) => /auth\.token is not allowed/.test(e)));
});

test('connectors: MAX_CONNECTORS cap', () => {
    // One connector holds ONE action (the picker bulk-creates them), so the cap
    // is spent per action rather than per app — Gmail alone ships ~15.
    assert.strictEqual(dm.DATA_LIMITS.MAX_CONNECTORS, 50);
    const cap = dm.DATA_LIMITS.MAX_CONNECTORS;
    const many = Array.from({ length: cap + 1 }, (_, i) => ({ id: `conn_x${String(i).padStart(5, '0')}`, kind: 'automation', automationId: `a${i}` }));
    assert.ok(errsOf(connModel(many)).some((e) => /too many connectors/.test(e)));
});

// ── chain + sync (connectors that combine actions / fill a table) ────────────

// connModel() builds a tableless model; these need a real table to point at.
function syncModel(connectors, tables = [{ id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [{ id: 'fld_aaaaaa', key: 'subject', name: 'Subject', type: 'text' }] }]) {
    return { modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} }, connectors };
}
const TOOL_CONN = { id: 'conn_ab12cd', kind: 'integration_tool', name: 'Emails', tool: 'gmail_search' };

test('connectors: a chained, table-filling connector validates', () => {
    const errors = errsOf(syncModel([{
        ...TOOL_CONN,
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, merge: 'extend' }],
        sync: {
            tableId: 'tbl_aaaaaa', mode: 'upsert', keyField: 'id',
            incremental: { field: 'modifiedTime', format: 'iso' },
            schedule: { everyMinutes: 60 }, refreshOnView: true,
        },
    }]));
    assert.deepStrictEqual(errors, []);
});

test('connectors: a sync must point at a table THIS app has', () => {
    // Doubles as the "you can't delete a table a connector fills" rule: removing
    // the table makes the model invalid rather than leaving a nightly failure.
    const errors = errsOf(syncModel([{ ...TOOL_CONN, sync: { tableId: 'tbl_zzzzzz' } }]));
    assert.ok(errors.some((e) => /is not a table in this app/.test(e)));
});

test('connectors: upsert mode requires the field that identifies a row', () => {
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { tableId: 'tbl_aaaaaa', mode: 'upsert' } }]))
        .some((e) => /keyField is required for mode 'upsert'/.test(e)));
});

test('connectors: a refresh cadence below the floor is refused, a cron is parsed for real', () => {
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { tableId: 'tbl_aaaaaa', schedule: { everyMinutes: 1 } } }]))
        .some((e) => /at least 15/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { tableId: 'tbl_aaaaaa', schedule: { cron: 'not a cron' } } }]))
        .some((e) => /not a valid 5-field cron/.test(e)));
    assert.deepStrictEqual(
        errsOf(syncModel([{ ...TOOL_CONN, sync: { tableId: 'tbl_aaaaaa', schedule: { cron: '0 6 * * *', tz: 'Europe/Amsterdam' } } }])),
        [],
    );
});

test('connectors: the chain is bounded and its bindings are field paths', () => {
    const deep = Array.from({ length: dm.MAX_CHAIN_STEPS + 1 }, (_, i) => ({ tool: `t${i}` }));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, chain: deep }])).some((e) => /too many steps/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, chain: [{ tool: 'a', argsFrom: { id: '../../etc/passwd' } }] }]))
        .some((e) => /must be a field path/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, chain: [{ tool: 'a', merge: 'nest' }] }]))
        .some((e) => /alias is required/.test(e)));
    // `a.b` and `a[].b` are the shapes the runtime can actually read.
    assert.deepStrictEqual(errsOf(syncModel([{ ...TOOL_CONN, chain: [{ tool: 'a', argsFrom: { x: 'attachments[].id', y: 'sender.email' } }] }])), []);
});

test('connectors: the no-inline-secrets rule also walks chain step args', () => {
    // Without this the rule would have had a hole the moment chains shipped.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, chain: [{ tool: 'a', fixedArgs: { api_key: 'sk-live-xxx' } }] }]))
        .some((e) => /looks like an inline secret/.test(e)));
});

test('connectors: chaining is refused for kinds that have no second call to make', () => {
    assert.ok(errsOf(syncModel([{ id: 'conn_ab12cd', kind: 'rest', url: 'https://api.example.com/x', chain: [{ tool: 'a' }] }]))
        .some((e) => /only supported for app connectors/.test(e)));
});

test('connectors: a sync with related child tables validates', () => {
    const tables = [
        { id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [{ id: 'fld_aaaa01', key: 'subject', name: 'S', type: 'text' }] },
        { id: 'tbl_bbbbbb', key: 'attachments', name: 'Attachments', fields: [{ id: 'fld_bbbb01', key: 'emails_ref', name: 'R', type: 'relation', relation: { table: 'tbl_aaaaaa' } }] },
    ];
    const errors = errsOf(syncModel([{
        ...TOOL_CONN,
        chain: [{ tool: 'gmail_read', argsFrom: { messageId: 'id' }, expand: 'attachments' }],
        sync: {
            tableId: 'tbl_aaaaaa', mode: 'upsert', keyField: 'id',
            children: [{ tableId: 'tbl_bbbbbb', level: 1, parentLevel: 0, relationField: 'emails_ref', mode: 'upsert', keyField: 'id' }],
        },
    }], tables));
    assert.deepStrictEqual(errors, []);
});

test('connectors: a child table must exist, differ from the parent, and name its link', () => {
    const tables = [
        { id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [{ id: 'fld_aaaa01', key: 'subject', name: 'S', type: 'text' }] },
        { id: 'tbl_bbbbbb', key: 'attachments', name: 'Attachments', fields: [{ id: 'fld_bbbb01', key: 'emails_ref', name: 'R', type: 'text' }] },
    ];
    const base = { tableId: 'tbl_aaaaaa', mode: 'upsert', keyField: 'id' };
    const child = { tableId: 'tbl_bbbbbb', level: 1, parentLevel: 0, relationField: 'emails_ref' };

    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [{ ...child, tableId: 'tbl_zzzzzz' }] } }], tables))
        .some((e) => /children\[0\]\.tableId must be a table in this app/.test(e)));
    // Pointing a child at the parent would fill one table from two grains.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [{ ...child, tableId: 'tbl_aaaaaa' }] } }], tables))
        .some((e) => /must differ from the connector's main table/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [{ ...child, relationField: undefined }] } }], tables))
        .some((e) => /relationField must be the column holding the parent's record/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [{ ...child, level: 0 }] } }], tables))
        .some((e) => /level must be the grain this table stores/.test(e)));
    // A grain can only feed one table, and a parent must sit below its child.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [child, { ...child, tableId: 'tbl_bbbbbb' }] } }], tables))
        .some((e) => /level 1 is used by more than one table/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...base, children: [{ ...child, parentLevel: 1 }] } }], tables))
        .some((e) => /parentLevel must be a lower grain/.test(e)));
});

// ── sync.dependents — tables the connector does not WRITE but must purge ─────
// An app-written line-items table hanging off the synced conversation used to
// sit outside planRetention entirely (neither steps nor unreachable), so its
// rows outlived the purge as orphans no gate ever saw. Declaring it as a
// dependent pulls it into the plan; validation checks it against REAL columns,
// because the connector never writes these tables — there is no sync stamp to
// fall back to.

const DEP_TABLES = [
    { id: 'tbl_aaaaaa', key: 'emails', name: 'Emails', fields: [
        { id: 'fld_aaaa01', key: 'subject', name: 'S', type: 'text' },
        { id: 'fld_aaaa02', key: 'received_at', name: 'R', type: 'datetime' },
    ] },
    { id: 'tbl_dddddd', key: 'quote_lines', name: 'Quote lines', fields: [
        { id: 'fld_dddd01', key: 'thread_key', name: 'T', type: 'text' },
        { id: 'fld_dddd02', key: 'added_at', name: 'A', type: 'datetime' },
        { id: 'fld_dddd03', key: 'request', name: 'Req', type: 'relation', relation: { table: 'tbl_aaaaaa' } },
    ] },
    { id: 'tbl_cccccc', key: 'other', name: 'Other', fields: [] },
];
// retentionDays makes the planRetention save-gate run too, so a green fixture
// proves the whole promise, not just the field shapes.
const DEP_SYNC = { tableId: 'tbl_aaaaaa', mode: 'upsert', keyField: 'id', retentionDays: 30, retentionField: 'received_at' };

test('connectors: dependents validate in both modes and satisfy the retention gate', () => {
    assert.deepStrictEqual(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [
        { tableId: 'tbl_dddddd', retentionField: 'added_at' },
    ] } }], DEP_TABLES)), []);
    assert.deepStrictEqual(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [
        { tableId: 'tbl_dddddd', relationField: 'request', parentTableId: 'tbl_aaaaaa', retentionCascade: true },
    ] } }], DEP_TABLES)), []);
});

test('connectors: a dependent must name a real table and a real DATE column', () => {
    const dep = { tableId: 'tbl_dddddd', retentionField: 'added_at' };
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: {} } }], DEP_TABLES))
        .some((e) => /sync\.dependents must be an array/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...dep, tableId: 'tbl_zzzzzz' }] } }], DEP_TABLES))
        .some((e) => /dependents\[0\]\.tableId must be a table in this app/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...dep, retentionField: 'nope' }] } }], DEP_TABLES))
        .some((e) => /dependents\[0\]\.retentionField "nope" is not a column on that table/.test(e)));
    // thread_key is TEXT — exactly the quote-intake gap. App-typed text is not
    // a stamp; comparing an ISO cutoff to it would purge on string luck.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...dep, retentionField: 'thread_key' }] } }], DEP_TABLES))
        .some((e) => /retentionField "thread_key" must be a date or datetime column, not text/.test(e)));
});

test('connectors: a dependent cascade must follow a relation that points at its parent', () => {
    const casc = { tableId: 'tbl_dddddd', relationField: 'request', parentTableId: 'tbl_aaaaaa', retentionCascade: true };
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...casc, relationField: 'thread_key' }] } }], DEP_TABLES))
        .some((e) => /relationField "thread_key" must be a relation column/.test(e)));
    // The relation resolves — but at the WRONG table. Pointing at the parent is
    // the whole contract; anything else deletes on a coincidence of ids.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...casc, parentTableId: 'tbl_cccccc' }] } }], DEP_TABLES))
        .some((e) => /relationField "request" does not point at parentTableId "tbl_cccccc"/.test(e)));
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ ...casc, retentionField: 'added_at' }] } }], DEP_TABLES))
        .some((e) => /cannot both cascade retention from its parent and carry its own retentionField/.test(e)));
    // A typo'd key would otherwise silently leave the table outside the purge.
    assert.ok(errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ tableId: 'tbl_dddddd', retentionfield: 'added_at' }] } }], DEP_TABLES))
        .some((e) => /dependents\[0\]\.retentionfield is not allowed/.test(e)));
});

test('connectors: a dependent nothing would ever purge is refused at save time', () => {
    // Neither a date column nor a cascade: planRetention lands it in
    // unreachable, and the existing retention gate refuses — the same contract
    // children have.
    const errors = errsOf(syncModel([{ ...TOOL_CONN, sync: { ...DEP_SYNC, dependents: [{ tableId: 'tbl_dddddd' }] } }], DEP_TABLES));
    assert.ok(errors.some((e) => /nothing would ever delete rows from quote_lines/.test(e)),
        `expected the retention gap to be refused, got: ${JSON.stringify(errors)}`);
});

// ── DATA_LIMITS env overrides ────────────────────────────────────────────────

test('MAX_ATTACHMENTS_PER_APP reads STUDIO_APP_MAX_ATTACHMENTS (default 5000)', () => {
    // Read at module load (same idiom as STUDIO_APP_ATTACHMENT_TOTAL_BYTES in
    // mailboxAttachments.js), so each case needs a fresh require.
    const path = require.resolve('./dataModel');
    // DATA_LIMITS is defined in the vocabulary and the facade re-exports it, so a
    // fresh read of the env needs the whole module set evicted — evicting the
    // facade alone would hand back the cached vocabulary.
    //
    // Six of those modules now LIVE in core/dataEngine/ (the engine moved down a
    // layer so automation datatables can share it; layering.test.js forbids one
    // feature requiring another). The files under ./dataModel/ are re-export
    // shims, and evicting a shim does NOT evict what it re-exports — so the core
    // paths must be listed too or this test silently reads the stale cache.
    const paths = [
        path,
        require.resolve('./dataModel/shared'),
        require.resolve('./dataModel/vocabulary'),
        require.resolve('./dataModel/ids'),
        require.resolve('./dataModel/ddl'),
        require.resolve('./dataModel/migrationPlan'),
        require.resolve('./dataModel/tolerantDdl'),
        require.resolve('./dataModel/connectorValidate'),
        require.resolve('./dataModel/modelValidate'),
        require.resolve('./dataModel/canonicalize'),
        require.resolve('../core/dataEngine/dataModel/shared'),
        require.resolve('../core/dataEngine/dataModel/vocabulary'),
        require.resolve('../core/dataEngine/dataModel/ids'),
        require.resolve('../core/dataEngine/dataModel/ddl'),
        require.resolve('../core/dataEngine/dataModel/migrationPlan'),
        require.resolve('../core/dataEngine/dataModel/tolerantDdl'),
    ];
    const evict = () => { for (const p of paths) delete require.cache[p]; };
    const prev = process.env.STUDIO_APP_MAX_ATTACHMENTS;
    try {
        delete process.env.STUDIO_APP_MAX_ATTACHMENTS;
        evict();
        const fresh = require('./dataModel');
        assert.strictEqual(fresh.DATA_LIMITS.MAX_ATTACHMENTS_PER_APP, 5000, 'shipped default');
        assert.ok(Object.isFrozen(fresh.DATA_LIMITS), 'the limits object stays frozen');

        process.env.STUDIO_APP_MAX_ATTACHMENTS = '100000';
        evict();
        assert.strictEqual(require('./dataModel').DATA_LIMITS.MAX_ATTACHMENTS_PER_APP, 100000, 'env override wins');

        // Garbage falls back to the shipped default rather than NaN-ing the cap.
        process.env.STUDIO_APP_MAX_ATTACHMENTS = 'twenty';
        evict();
        assert.strictEqual(require('./dataModel').DATA_LIMITS.MAX_ATTACHMENTS_PER_APP, 5000, 'garbage → default');
    } finally {
        if (prev === undefined) delete process.env.STUDIO_APP_MAX_ATTACHMENTS;
        else process.env.STUDIO_APP_MAX_ATTACHMENTS = prev;
        evict();
        require(path); // leave a clean instance in the cache for later requires
    }
});

test('connectors: canonicalize assigns conn_ ids and names, preserves connectorless models', () => {
    const { model: m1 } = dm.canonicalizeDataModel(connModel([{ kind: 'automation', automationId: 'a' }]));
    assert.ok(/^conn_/.test(m1.connectors[0].id), 'id assigned');
    assert.strictEqual(m1.connectors[0].name, m1.connectors[0].id, 'name defaulted to id');
    // A model without connectors canonicalizes without a connectors key (byte-stable).
    const { model: m2 } = dm.canonicalizeDataModel({ modelVersion: 1, tables: [] });
    assert.ok(!('connectors' in m2), 'connectorless model gains no connectors key');
});
