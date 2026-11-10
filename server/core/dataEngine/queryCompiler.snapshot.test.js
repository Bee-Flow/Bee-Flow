/**
 * Byte-identity guard for the read compilers.
 *
 * Pins the exact SQL text, the parameters and the side fields (primaryField,
 * limit) that compileRecordList, compileAggregate, compileGetById,
 * compileKeyIndex and compileRecordCount produce for a broad set of read descriptors, in BOTH dialects,
 * plus the error each invalid descriptor raises. Every App Studio screen and
 * every automation datatable read runs through these functions; a stored app
 * must keep reading exactly the rows it reads today, so a change to an existing
 * entry is a behaviour change, never a cleanup.
 *
 * The descriptors are in queryCompiler.snapshot.fixture.js. Re-capture (only for
 * an ADDED case, or a deliberate change named in the commit):
 *   UPDATE_GOLDEN=1 node --test core/dataEngine/queryCompiler.snapshot.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const { compileAccessFilter } = require('./accessFilter');
const engineFlag = require('./engineFlag');
const { FILTER_OPS, AGG_FNS, DATE_BUCKETS } = require('./dataModel/vocabulary');
const C = require('./queryCompiler.snapshot.fixture');

const GOLDEN_PATH = path.join(__dirname, 'queryCompiler.snapshot.golden.json');
const DIALECTS = ['sqlite', 'pg'];

/** JSON cannot tell undefined from null, and the difference is a bound parameter. */
function canon(value) {
    if (value === undefined) return { $undefined: true };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of Object.keys(value)) out[k] = canon(value[k]);
        return out;
    }
    return value;
}

/** The compiled result, or the error it threw (class, status and message). */
function capture(fn) {
    try {
        return canon(fn());
    } catch (err) {
        const e = /** @type {Error & { status?: number }} */ (err);
        return { error: { name: e.name, status: e.status ?? null, message: e.message } };
    }
}

// A case that names its own dialect keeps it (the invalid-dialect case).
const withDialect = (opts, dialect) => (opts === undefined ? { dialect } : { dialect, ...opts });
const accessOf = (access) => (access === undefined ? C.ACCESS : access);

function snapshot() {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = { list: {}, aggregate: {}, getById: {}, keyIndex: {}, access: {}, clampLimit: {}, implicitDialect: {}, count: {} };
    for (const [name, opts, access] of C.LIST_CASES) {
        out.list[name] = Object.fromEntries(DIALECTS.map((d) => [d, capture(
            () => qc.compileRecordList(C.TABLE, withDialect(opts, d), accessOf(access)))]));
    }
    for (const [name, opts, access] of C.AGGREGATE_CASES) {
        out.aggregate[name] = Object.fromEntries(DIALECTS.map((d) => [d, capture(
            () => qc.compileAggregate(C.TABLE, withDialect(opts, d), accessOf(access)))]));
    }
    for (const [name, id, access, opts] of C.GET_BY_ID_CASES) {
        out.getById[name] = Object.fromEntries(DIALECTS.map((d) => [d, capture(
            () => qc.compileGetById(C.TABLE, id, accessOf(access), { ...opts, dialect: d }))]));
    }
    for (const [name, opts, access] of C.COUNT_CASES) {
        out.count[name] = Object.fromEntries(DIALECTS.map((d) => [d, capture(
            () => qc.compileRecordCount(C.TABLE, withDialect(opts, d), accessOf(access)))]));
    }
    for (const [name, keyField, keys] of C.KEY_INDEX_CASES) {
        out.keyIndex[name] = Object.fromEntries(DIALECTS.map((d) => [d, capture(
            () => qc.compileKeyIndex(C.TABLE, keyField, keys, C.ACCESS, { dialect: d }))]));
    }
    for (const [name, role, viewer, action] of C.ACCESS_CASES) {
        out.access[name] = Object.fromEntries(DIALECTS.map((d) => {
            const filter = capture(() => compileAccessFilter(C.TABLE, role, viewer, action, { dialect: d }));
            const live = () => compileAccessFilter(C.TABLE, role, viewer, action, { dialect: d });
            return [d, {
                filter,
                list: capture(() => qc.compileRecordList(C.TABLE, { ...C.ACCESS_LIST_OPTS, dialect: d }, live())),
                aggregate: capture(() => qc.compileAggregate(C.TABLE, { ...C.ACCESS_AGG_OPTS, dialect: d }, live())),
                getById: capture(() => qc.compileGetById(C.TABLE, 'rec_1', live(), { dialect: d })),
            }];
        }));
    }
    for (const args of C.CLAMP_CASES) {
        out.clampLimit[JSON.stringify(canon(args))] = capture(() => qc.clampLimit(...args));
    }
    // App Studio passes no dialect: it follows the process-wide engine flag.
    for (const flag of DIALECTS) {
        engineFlag._setForTests(flag);
        try {
            out.implicitDialect[flag] = {
                list: capture(() => qc.compileRecordList(C.TABLE, { filters: [{ field: 'title', op: 'contains', value: 'a' }, { field: 'done', op: 'eq', value: true }, { field: 'region', op: 'in', value: [] }] }, C.ACCESS)),
                aggregate: capture(() => qc.compileAggregate(C.TABLE, { groupBy: [{ field: 'due', bucket: 'week' }], aggregates: [{ fn: 'p50', field: 'amount', as: 'm' }] }, C.ACCESS)),
            };
        } finally { engineFlag._setForTests(null); }
    }
    return out;
}

const actual = snapshot();

if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

for (const section of Object.keys(golden)) {
    test(`read compiler snapshot: ${section}`, () => {
        assert.deepStrictEqual(Object.keys(actual[section]).sort(), Object.keys(golden[section]).sort(),
            `the ${section} cases differ from the golden; re-capture only for an added case`);
        for (const name of Object.keys(golden[section])) {
            assert.deepStrictEqual(actual[section][name], golden[section][name], `${section} / ${name}`);
        }
    });
}

test('the snapshot covers every filter operator, aggregate function and date bucket', () => {
    const ops = new Set(C.LIST_CASES.flatMap(([, opts]) => (opts && Array.isArray(opts.filters) ? opts.filters : []))
        .flatMap((f) => (f && Array.isArray(f.any) ? f.any : [f])).map((f) => f && f.op));
    for (const op of FILTER_OPS) assert.ok(ops.has(op), `no snapshot case for filter op ${op}`);
    const fns = new Set(C.AGGREGATE_CASES.flatMap(([, opts]) => (opts && Array.isArray(opts.aggregates) ? opts.aggregates : [])).map((a) => a && a.fn));
    for (const fn of AGG_FNS) assert.ok(fns.has(fn), `no snapshot case for aggregate fn ${fn}`);
    const buckets = new Set(C.AGGREGATE_CASES.flatMap(([, opts]) => (opts && Array.isArray(opts.groupBy) ? opts.groupBy : [])).map((g) => g && g.bucket));
    for (const b of DATE_BUCKETS) assert.ok(buckets.has(b), `no snapshot case for date bucket ${b}`);
});

test('the snapshot holds real SQL in both dialects, not only errors', () => {
    const ok = (entry) => entry && typeof entry.sql === 'string';
    assert.ok(Object.values(actual.list).filter((e) => ok(e.sqlite) && ok(e.pg)).length > 60);
    assert.ok(Object.values(actual.aggregate).filter((e) => ok(e.sqlite) && ok(e.pg)).length > 30);
    assert.notDeepStrictEqual(actual.implicitDialect.sqlite, actual.implicitDialect.pg);
});
