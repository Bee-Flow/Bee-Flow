/**
 * `{ any: [clause, …] }` OR groups in a filter list: the clauses of one group
 * OR each other inside one parenthesised group, the group ANDs with the other
 * entries, the access predicate stays outside everything, the parameters follow
 * the placeholders, and the clause cap counts the clauses inside the groups.
 * The rows themselves are proven on Postgres in appStudio/queryCompiler.pg.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const { MAX_FILTERS, CompileError } = require('./queryCompilerBase');

const TABLE = {
    id: 'tbl_aaaaaa',
    key: 'tickets',
    fields: [
        { id: 'f1', key: 'status', type: 'text' },
        { id: 'f2', key: 'priority', type: 'text' },
        { id: 'f3', key: 'amount', type: 'number' },
    ],
};
const SCOPE = { where: '"created_by" = ?', params: ['u1'] };
const OPEN = { field: 'status', op: 'eq', value: 'open' };
const HIGH = { field: 'priority', op: 'eq', value: 'high' };

const list = (filters, extra = {}) => qc.compileRecordList(TABLE, { filters, dialect: 'sqlite', ...extra }, SCOPE);

test('an any group compiles to one parenthesised OR, ANDed after the access predicate', () => {
    const { sql, params } = list([{ any: [OPEN, HIGH] }]);
    assert.match(sql, /WHERE \("created_by" = \?\) AND \("status" = \? OR "priority" = \?\)/);
    assert.deepStrictEqual(params.slice(0, 3), ['u1', 'open', 'high']);
});

test('the parameters follow the placeholders across entries and groups', () => {
    const { sql, params } = list([
        { field: 'amount', op: 'gt', value: 5 },
        { any: [OPEN, { field: 'amount', op: 'between', value: [1, 2] }] },
        HIGH,
    ]);
    assert.match(sql, /"amount" > \? AND \("status" = \? OR \("amount" BETWEEN \? AND \?\)\) AND "priority" = \?/);
    assert.deepStrictEqual(params.slice(0, 6), ['u1', 5, 'open', 1, 2, 'high']);
});

test('a one-clause group is that clause', () => {
    const one = list([{ any: [OPEN] }]);
    const flat = list([OPEN]);
    assert.strictEqual(one.sql, flat.sql);
    assert.deepStrictEqual(one.params, flat.params);
});

test('match any ORs the entries with the group as one of them; access stays outside', () => {
    const { sql } = list([{ field: 'amount', op: 'gt', value: 5 }, { any: [OPEN, HIGH] }], { match: 'any' });
    assert.match(sql, /\("created_by" = \?\) AND \("amount" > \? OR \("status" = \? OR "priority" = \?\)\)/);
});

test('aggregates take groups too', () => {
    const { sql, params } = qc.compileAggregate(TABLE, { filters: [{ any: [OPEN, HIGH] }], aggregates: [{ fn: 'count', as: 'n' }], dialect: 'sqlite' }, SCOPE);
    assert.match(sql, /\("status" = \? OR "priority" = \?\)/);
    assert.deepStrictEqual(params.slice(0, 3), ['u1', 'open', 'high']);
});

test('an empty group, a group inside a group and a group with a field are refused', () => {
    assert.throws(() => list([{ any: [] }]), (e) => e instanceof CompileError && /at least one clause/.test(e.message));
    assert.throws(() => list([{ any: [OPEN, { any: [HIGH] }] }]), /cannot hold another group/);
    assert.throws(() => list([{ field: 'status', any: [OPEN] }]), /not both/);
});

test('a clause inside a group is checked like any other: unknown columns and ops are refused', () => {
    assert.throws(() => list([{ any: [OPEN, { field: 'secret', op: 'eq', value: 1 }] }]), CompileError);
    assert.throws(() => list([{ any: [{ field: 'status', op: 'regex', value: '.' }] }]), /unknown filter op/);
});

test('the clause cap counts the clauses inside groups and names the count', () => {
    const clauses = Array.from({ length: MAX_FILTERS }, () => OPEN);
    assert.doesNotThrow(() => list([{ any: clauses }]));
    assert.throws(() => list([HIGH, { any: clauses }]), new RegExp(`${MAX_FILTERS + 1} clauses \\(max ${MAX_FILTERS}`));
});
