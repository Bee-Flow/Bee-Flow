/**
 * Reference rows (design section 2, D20): capture with caps and the
 * personal-data gate, the stage plan, and the apply on a real Postgres.
 *
 * Reads run on pglite through an injected `query`, so the compiler's keyset
 * pagination is exercised for real; the guard is an injected `scan`. No module
 * mocking.
 *
 * Run: cd server && node --test projects/stages/referenceRows.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { toDollarParams } = require('../../stores/lib/pgAppEngine');
const queryCompiler = require('../../core/dataEngine/queryCompiler');
const { schemaNameFor } = require('../../stores/datatableDbStore');
const {
    captureReferenceRows, planReferenceRows, applyReferenceRows, canonicalRows, hashReferenceRows, LIMITS,
    referenceApplyOrder,
} = require('./referenceRows');

const { pg, db } = pgliteDb();

const f = (id, key, over = {}) => ({ id, key, name: key, type: 'text', ...over });
const PRICES = {
    id: 'tbl_prices00001', key: 'prices',
    fields: [f('fld_label', 'label'), f('fld_amount', 'amount', { type: 'number' }), f('fld_tags', 'tags', { type: 'multiselect' })],
};
const BIG = { id: 'tbl_big0000001', key: 'big', fields: [f('fld_n', 'n', { type: 'number' })] };
const CONTACTS = { id: 'tbl_contacts001', key: 'contacts', fields: [f('fld_note', 'note'), f('fld_mail', 'email')] };
const meta = (descriptor, over = {}) => ({
    id: descriptor.id, scope: { kind: 'org', id: 'acme' }, isReference: true,
    subjectColumn: null, rowScope: 'all', managedKind: null, source: null, retentionDays: null, ...over,
});
const entry = (ref, descriptor, metaOver) => ({ ref, meta: meta(descriptor, metaOver), descriptor });

// The capture reads go to pglite's public schema, converted the way the
// datatable engine converts them.
const query = async (_scope, { sql, params }) => (await pg.query(toDollarParams(sql, params.length), params)).rows;
const noGuard = { query, scan: null };
const cleanGuard = { query, scan: async () => ({ entities: [] }) };

before(async () => {
    await pg.exec(ddlForTable(PRICES, { dialect: 'pg' }));
    await pg.exec(ddlForTable(BIG, { dialect: 'pg' }));
    await pg.exec(ddlForTable(CONTACTS, { dialect: 'pg' }));
    await pg.query(`INSERT INTO prices (id, label, amount, tags) VALUES
        ('r2', 'Basic', 10, '["a"]'), ('r1', 'Pro', 25.5, NULL), ('r3', 'Team', NULL, '[]')`);
    await pg.query(`INSERT INTO big (id, n) SELECT 'b' || lpad(g::text, 5, '0'), g FROM generate_series(1, ${LIMITS.maxRowsPerTable + 1}) g`);
    await pg.query(`INSERT INTO contacts (id, note, email) VALUES ('c1', 'call back', NULL), ('c2', 'reach me at jan@example.com', NULL)`);
});

after(async () => { await pg.close(); });

// ── Capture ────────────────────────────────────────────────────────────

test('a clean reference table becomes one payload, keyed by field id and sorted by id', async () => {
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_1', PRICES)] }, cleanGuard);
    assert.deepStrictEqual(findings, []);
    assert.strictEqual(payloads.length, 1);
    const p = payloads[0];
    assert.strictEqual(p.ref, 'dt_1');
    assert.strictEqual(p.kind, 'reference_rows');
    assert.strictEqual(p.sourceEntityId, PRICES.id);
    assert.deepStrictEqual(p.payload.rows, [
        { id: 'r1', values: { fld_label: 'Pro', fld_amount: 25.5 } },
        { id: 'r2', values: { fld_label: 'Basic', fld_amount: 10, fld_tags: ['a'] } },
        { id: 'r3', values: { fld_label: 'Team', fld_tags: [] } },
    ]);
    assert.strictEqual(p.contentHash, hashReferenceRows(p.payload.rows));
    assert.match(p.contentHash, /^[0-9a-f]{64}$/);
});

test('a table that is not a reference table is not read at all', async () => {
    let reads = 0;
    const { payloads, findings } = await captureReferenceRows(
        { tables: [entry('dt_1', PRICES, { isReference: false })] },
        { scan: null, query: async (...a) => { reads++; return query(...a); } },
    );
    assert.deepStrictEqual([payloads, findings, reads], [[], [], 0]);
});

test('the part option decides over the table flag when it is set', async () => {
    const off = await captureReferenceRows({ tables: [entry('dt_1', PRICES)], options: { dt_1: { reference: false } } }, cleanGuard);
    assert.strictEqual(off.payloads.length, 0);
    const on = await captureReferenceRows(
        { tables: [entry('dt_1', PRICES, { isReference: false })], options: new Map([['dt_1', { reference: true }]]) }, cleanGuard);
    assert.strictEqual(on.payloads.length, 1);
});

test('more than 5,000 rows is a blocking reference.too_large', async () => {
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_big', BIG)] }, noGuard);
    assert.strictEqual(payloads.length, 0);
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual(
        { code: findings[0].code, severity: findings[0].severity, limit: findings[0].limit, max: findings[0].max },
        { code: 'reference.too_large', severity: 'blocking', limit: 'rows', max: 5000 },
    );
});

test('the byte caps per table and per release are blocking too', async () => {
    const perTable = await captureReferenceRows({ tables: [entry('dt_1', PRICES)] }, { ...cleanGuard, limits: { maxBytesPerTable: 50 } });
    assert.strictEqual(perTable.findings[0].code, 'reference.too_large');
    assert.strictEqual(perTable.findings[0].limit, 'table_bytes');

    const twice = [entry('dt_1', PRICES), entry('dt_2', { ...PRICES })];
    const size = Buffer.byteLength(JSON.stringify((await captureReferenceRows({ tables: [twice[0]] }, cleanGuard)).payloads[0].payload.rows));
    const perRelease = await captureReferenceRows({ tables: twice }, { ...cleanGuard, limits: { maxBytesPerRelease: size + 1 } });
    assert.strictEqual(perRelease.payloads.length, 1);
    assert.strictEqual(perRelease.findings[0].limit, 'release_bytes');
    assert.strictEqual(perRelease.findings[0].severity, 'blocking');
});

test('a column whose VALUES hold personal data is blocking, with no acknowledgement path', async () => {
    const scan = async (blob) => {
        const at = blob.indexOf('jan@example.com');
        return { entities: at >= 0 ? [{ category: 'Email', offset: at, text: 'jan@example.com' }] : [] };
    };
    // A table whose column names look harmless: the stray address is in the notes.
    const quiet = { ...CONTACTS, fields: [f('fld_note', 'note')] };
    const options = { dt_c: { reference: true, acks: [{ code: 'reference.personal_data', by: 'u1' }] } };
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_c', quiet)], options }, { query, scan });
    assert.strictEqual(payloads.length, 0, 'an acknowledgement in the options changes nothing');
    assert.strictEqual(findings.length, 1);
    const fd = findings[0];
    assert.strictEqual(fd.code, 'reference.personal_data');
    assert.strictEqual(fd.severity, 'blocking');
    assert.strictEqual(fd.acknowledgeable, false);
    assert.deepStrictEqual(fd.columns, [{ key: 'note', kind: 'email', by: 'values' }]);
    assert.ok(!JSON.stringify(fd).includes('jan@example.com'), 'a finding never carries a value');
});

test('every row is read, not a sample: a hit far down the table still blocks', async () => {
    const LONG = { id: 'tbl_long000001', key: 'long_notes', fields: [f('fld_t', 'remark')] };
    await pg.exec(ddlForTable(LONG, { dialect: 'pg' }));
    await pg.query(`INSERT INTO long_notes (id, remark) SELECT 'l' || lpad(g::text, 4, '0'), 'plain text ' || g FROM generate_series(1, 400) g`);
    await pg.query(`INSERT INTO long_notes (id, remark) VALUES ('l9999', 'SECRET-PERSON')`);
    let calls = 0;
    const scan = async (blob) => {
        calls++;
        const at = blob.indexOf('SECRET-PERSON');
        return { entities: at >= 0 ? [{ category: 'Person', offset: at }] : [] };
    };
    const { findings } = await captureReferenceRows({ tables: [entry('dt_l', LONG)] }, { query, scan });
    assert.strictEqual(findings[0].code, 'reference.personal_data');
    assert.ok(calls > 1, 'the column was scanned in several requests');
});

test('with no guard, a column NAMED like personal data is blocking', async () => {
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_c', CONTACTS)] }, noGuard);
    assert.strictEqual(payloads.length, 0);
    assert.strictEqual(findings[0].code, 'reference.personal_data');
    assert.deepStrictEqual(findings[0].columns.map(c => c.key), ['email']);
});

test('with no guard, an unread text column is blocking, never silently clean', async () => {
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_1', PRICES)] }, noGuard);
    assert.strictEqual(payloads.length, 0);
    assert.deepStrictEqual(findings.map(x => [x.code, x.severity, x.acknowledgeable, x.columns]),
        [['reference.unscanned', 'blocking', false, ['label']]]);
});

test('a degraded or failing guard counts as no guard', async () => {
    for (const scan of [async () => ({ degraded: true, entities: [] }), async () => { throw new Error('down'); }]) {
        const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_1', PRICES)] }, { query, scan });
        assert.deepStrictEqual([payloads.length, findings[0].code, findings[0].severity], [0, 'reference.unscanned', 'blocking']);
    }
});

test('no acknowledgement lets an unread table through (D20)', async () => {
    const ack = { dt_1: { reference: true, acks: [{ code: 'reference.unscanned', by: 'u1', columns: ['label'] }] } };
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_1', PRICES)], options: ack }, noGuard);
    assert.strictEqual(payloads.length, 0);
    assert.deepStrictEqual(findings.map(x => [x.code, x.severity, x.acknowledgeable]), [['reference.unscanned', 'blocking', false]]);
});

test('a table that may not be a reference table is refused at the cut', async () => {
    const { payloads, findings } = await captureReferenceRows(
        { tables: [entry('dt_1', PRICES, { subjectColumn: 'label' })] }, cleanGuard);
    assert.strictEqual(payloads.length, 0);
    assert.deepStrictEqual([findings[0].code, findings[0].reason, findings[0].severity], ['reference.not_allowed', 'subject_column', 'blocking']);
});

// ── Plan ───────────────────────────────────────────────────────────────

test('planReferenceRows gives insert, update and delete', () => {
    const stage = [
        { id: 'r1', values: { fld_label: 'Pro' } },
        { id: 'r2', values: { fld_label: 'Old' } },
        { id: 'r9', values: { fld_label: 'Gone' } },
    ];
    const plan = planReferenceRows(stage, { rows: [
        { id: 'r1', values: { fld_label: 'Pro' } },
        { id: 'r2', values: { fld_label: 'Basic' } },
        { id: 'r3', values: { fld_label: 'New' } },
    ] });
    assert.deepStrictEqual(plan.insert.map(r => r.id), ['r3']);
    assert.deepStrictEqual(plan.update.map(r => r.id), ['r2']);
    assert.deepStrictEqual(plan.delete, ['r9']);
});

// ── Apply on pglite ────────────────────────────────────────────────────

const SCOPE = { kind: 'org', id: 'acme' };
const SCHEMA = schemaNameFor('org', 'acme');
const STAGE = {
    id: 'tbl_stageprice1', key: 'prices__uat', rowsLocked: true,
    fields: [
        f('fld_label', 'label', { required: true }),
        f('fld_amount', 'amount', { type: 'number' }),
        f('fld_tags', 'tags', { type: 'multiselect' }),
    ],
};

test('applyReferenceRows upserts by id, deletes absent ids and stamps the run-as user', async () => {
    await pg.exec(`CREATE SCHEMA "${SCHEMA}"`);
    await pg.exec(`SET search_path = "${SCHEMA}"; ${ddlForTable(STAGE, { dialect: 'pg' })} SET search_path = public;`);
    await pg.query(`INSERT INTO "${SCHEMA}".prices__uat (id, label, amount, created_by) VALUES
        ('r1', 'Pro', 99, 'someone'), ('r9', 'Stale', 1, 'someone')`);
    const rows = (await captureReferenceRows({ tables: [entry('dt_1', PRICES)] }, cleanGuard)).payloads[0].payload.rows;

    // A locked table refuses every ordinary writer…
    assert.throws(() => queryCompiler.compileInsert(STAGE, { label: 'x' }, { dialect: 'pg' }), /managed|locked/i);

    // …and the deploy writes it inside its own transaction.
    const out = await db.tx(async (client) => {
        const res = await applyReferenceRows(client, { scope: SCOPE, tableMeta: STAGE, rows, runAsUserId: 'run-as' });
        // The rest of the commit still sees the public schema.
        const path = await client.query(`SELECT current_setting('search_path') AS p`);
        assert.ok(!path.rows[0].p.includes(SCHEMA), 'the search path is handed back');
        return res;
    });
    assert.strictEqual(out.deleted, 1);
    assert.deepStrictEqual(out.skippedFieldIds, []);

    const after = (await pg.query(`SELECT id, label, amount, tags, created_by FROM "${SCHEMA}".prices__uat ORDER BY id`)).rows;
    assert.deepStrictEqual(after.map(r => r.id), ['r1', 'r2', 'r3']);
    assert.strictEqual(after.find(r => r.id === 'r2').created_by, 'run-as');
    assert.strictEqual(Number(after.find(r => r.id === 'r1').amount), 25.5, 'an existing row is updated');
    assert.strictEqual(after.find(r => r.id === 'r3').amount, null, 'a value absent from the release is cleared');
    assert.strictEqual(after.find(r => r.id === 'r2').tags, '["a"]', 'JSON columns are not double-encoded');

    // The stage now hashes to the release: a second plan is empty.
    const stageRows = canonicalRows(STAGE, (await pg.query(`SELECT * FROM "${SCHEMA}".prices__uat`)).rows);
    assert.strictEqual(hashReferenceRows(stageRows), hashReferenceRows(rows));
    assert.deepStrictEqual(planReferenceRows(stageRows, { rows }), { insert: [], update: [], delete: [] });
});

test('applyReferenceRows reports a payload field the stage table does not have', async () => {
    const out = await db.tx((client) => applyReferenceRows(client, {
        scope: SCOPE, tableMeta: STAGE, runAsUserId: 'run-as',
        rows: [{ id: 'r1', values: { fld_label: 'Pro', fld_unknown: 'x' } }],
    }));
    assert.deepStrictEqual(out.skippedFieldIds, ['fld_unknown']);
    assert.strictEqual(out.deleted, 2);
});

test('applyReferenceRows refuses a scope without a row schema', async () => {
    await assert.rejects(
        db.tx((client) => applyReferenceRows(client, { scope: { kind: 'org', id: 'nobody' }, tableMeta: STAGE, rows: [], runAsUserId: 'u' })),
        (e) => e.code === 'reference_table_missing' && e.status === 409,
    );
});

// ── What the stage table enforces ──────────────────────────────────────

const REGIONS = { id: 'tbl_regions0001', key: 'regions', fields: [f('fld_rname', 'rname')] };
const SHOPS = {
    id: 'tbl_shops000001', key: 'shops',
    fields: [f('fld_sname', 'sname'), f('fld_region', 'region', { type: 'relation', relation: { table: REGIONS.id } })],
};

test('a relation into a table the release does not carry is blocking; carried together it passes', async () => {
    await pg.exec(ddlForTable(REGIONS, { dialect: 'pg' }));
    await pg.exec(ddlForTable(SHOPS, { tableKeyById: new Map([[REGIONS.id, 'regions']]), dialect: 'pg' }));
    await pg.query(`INSERT INTO regions (id, rname) VALUES ('g1', 'North')`);
    await pg.query(`INSERT INTO shops (id, sname, region) VALUES ('s1', 'Main', 'g1')`);
    const alone = await captureReferenceRows({ tables: [entry('dt_s', SHOPS)] }, cleanGuard);
    assert.strictEqual(alone.payloads.length, 0);
    assert.deepStrictEqual(alone.findings.map(x => [x.code, x.severity, x.columns]),
        [['reference.relation_not_carried', 'blocking', [{ key: 'region', targetTableId: REGIONS.id }]]]);
    const both = await captureReferenceRows({ tables: [entry('dt_s', SHOPS), entry('dt_g', REGIONS)] }, cleanGuard);
    assert.deepStrictEqual([both.payloads.length, both.findings], [2, []]);
    assert.deepStrictEqual(referenceApplyOrder([SHOPS, REGIONS]), [REGIONS.id, SHOPS.id], 'parents first');
});

test('a NULL in a column the stage creates NOT NULL is blocking at the cut', async () => {
    const REQ = { id: 'tbl_req0000001', key: 'reqs', fields: [f('fld_code', 'code'), f('fld_need', 'need', { type: 'number' })] };
    await pg.exec(ddlForTable(REQ, { dialect: 'pg' }));
    await pg.query(`INSERT INTO reqs (id, code, need) VALUES ('q1', 'a', 1), ('q2', 'b', NULL)`);
    // Dev added the column nullable; the descriptor says required.
    const asDeclared = { ...REQ, fields: [REQ.fields[0], { ...REQ.fields[1], required: true }] };
    const { payloads, findings } = await captureReferenceRows({ tables: [entry('dt_q', asDeclared)] }, cleanGuard);
    assert.strictEqual(payloads.length, 0);
    assert.deepStrictEqual(findings.map(x => [x.code, x.columns]), [['reference.required_null', [{ key: 'need', rows: 1 }]]]);
});

test('canonicalRows reads a DATE the same from either driver', () => {
    const D = { id: 'tbl_d', key: 'd', fields: [f('fld_day', 'day', { type: 'date' })] };
    const local = new Date(2026, 2, 5); // node-pg: local midnight
    const utc = new Date(Date.UTC(2026, 2, 5)); // pglite: UTC midnight
    const rows = (v) => canonicalRows(D, [{ id: 'x', day: v }])[0].values.fld_day;
    assert.deepStrictEqual([rows(local), rows(utc), rows('2026-03-05')], ['2026-03-05', '2026-03-05', '2026-03-05']);
});

test('applyReferenceRows maps a constraint violation to a typed 409 without the value', async () => {
    const S2 = { ...SHOPS, id: 'tbl_shopstage01', key: 'shops__uat' };
    await pg.exec(`SET search_path = "${SCHEMA}"; ${ddlForTable({ ...REGIONS, key: 'regions__uat' }, { dialect: 'pg' })} `
        + `${ddlForTable(S2, { tableKeyById: new Map([[REGIONS.id, 'regions__uat']]), dialect: 'pg' })} SET search_path = public;`);
    await assert.rejects(
        db.tx((client) => applyReferenceRows(client, {
            scope: SCOPE, tableMeta: S2, runAsUserId: 'u', rows: [{ id: 's1', values: { fld_sname: 'Main', fld_region: 'secret-g1' } }],
        })),
        (e) => e.status === 409 && e.code === 'reference_rows_violate' && e.details.violation === 'foreign_key'
            && !JSON.stringify({ m: e.message, d: e.details }).includes('secret-g1'),
    );
});

test('phases: upserts parent first, then deletes child first, across tables', async () => {
    const R = { ...REGIONS, key: 'regions__uat' };
    const S = { ...SHOPS, id: 'tbl_shopstage01', key: 'shops__uat' };
    await pg.query(`INSERT INTO "${SCHEMA}".regions__uat (id) VALUES ('g-old')`);
    await pg.query(`INSERT INTO "${SCHEMA}".shops__uat (id, sname, region) VALUES ('s-old', 'Old', 'g-old')`);
    const release = new Map([
        [R.id, [{ id: 'g1', values: { fld_rname: 'North' } }]],
        [S.id, [{ id: 's1', values: { fld_sname: 'Main', fld_region: 'g1' } }]],
    ]);
    const metas = new Map([[R.id, R], [S.id, S]]);
    const order = referenceApplyOrder([S, R]);
    await db.tx(async (client) => {
        for (const id of order) await applyReferenceRows(client, { scope: SCOPE, tableMeta: metas.get(id), rows: release.get(id), runAsUserId: 'u', phase: 'upsert' });
        for (const id of [...order].reverse()) await applyReferenceRows(client, { scope: SCOPE, tableMeta: metas.get(id), rows: release.get(id), runAsUserId: 'u', phase: 'delete' });
    });
    const shops = (await pg.query(`SELECT id, region FROM "${SCHEMA}".shops__uat ORDER BY id`)).rows;
    const regions = (await pg.query(`SELECT id FROM "${SCHEMA}".regions__uat ORDER BY id`)).rows;
    assert.deepStrictEqual([shops, regions], [[{ id: 's1', region: 'g1' }], [{ id: 'g1' }]]);
});

test('a table that points at itself is written parent first', async () => {
    const CAT = { id: 'tbl_cat00000001', key: 'cats__uat', fields: [f('fld_parent', 'parent', { type: 'relation', relation: { table: 'tbl_cat00000001' } })] };
    await pg.exec(`SET search_path = "${SCHEMA}"; ${ddlForTable(CAT, { tableKeyById: new Map([[CAT.id, 'cats__uat']]), dialect: 'pg' })} SET search_path = public;`);
    const rows = [{ id: 'a', values: { fld_parent: 'b' } }, { id: 'b', values: { fld_parent: 'c' } }, { id: 'c', values: {} }];
    const out = await db.tx((client) => applyReferenceRows(client, { scope: SCOPE, tableMeta: CAT, rows, runAsUserId: 'u' }));
    assert.strictEqual(out.written, 3);
});
