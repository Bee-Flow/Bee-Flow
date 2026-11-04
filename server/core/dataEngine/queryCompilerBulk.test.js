/**
 * The filter-scoped write compilers (queryCompilerBulk.mts): access first, filters re-applied on
 * the id-addressed writes, id-list limits, locked rows, order + clamp, both dialects.
 *
 * Run: cd server && node --test core/dataEngine/queryCompilerBulk.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bulk = require('./queryCompilerBulk.mts');
const { compileUpdate, RowsLockedError } = require('./queryCompiler');

const T = { key: 'tasks', fields: [{ key: 'status', type: 'text' }, { key: 'n', type: 'number' }] };
const ACCESS = { where: '"created_by" = ?', params: ['u1'] };
const F = [{ field: 'status', op: 'eq', value: 'done' }];

for (const dialect of ['sqlite', 'pg']) {
    test(`${dialect}: match ids puts the access predicate first, orders oldest first and clamps the limit`, () => {
        const c = bulk.compileMatchIds(T, F, ACCESS, { dialect, limit: 9999 });
        assert.match(c.sql, /^SELECT "id" FROM "tasks" WHERE \("created_by" = \?\) AND .*"status".* ORDER BY "created_at" ASC, "id" ASC LIMIT \?$/);
        assert.deepEqual(c.params, ['u1', 'done', 500]);
        assert.equal(c.limit, 500);
    });

    test(`${dialect}: delete by ids re-applies access and filters`, () => {
        const c = bulk.compileDeleteIds(T, ['a', 'b'], F, ACCESS, { dialect });
        assert.match(c.sql, /^DELETE FROM "tasks" WHERE \("created_by" = \?\) AND .* AND "id" IN \(\?, \?\)$/);
        assert.deepEqual(c.params, ['u1', 'done', 'a', 'b']);
    });

    test(`${dialect}: update by ids: SET first, then access, filters, ids`, () => {
        const c = bulk.compileUpdateIds(T, ['a'], { n: 3, id: 'forged' }, F, ACCESS, { dialect });
        assert.match(c.sql, /^UPDATE "tasks" SET "updated_at" = \?, "n" = \? WHERE \("created_by" = \?\) AND .* AND "id" IN \(\?\)$/);
        assert.deepEqual(c.params.slice(1), [3, 'u1', 'done', 'a'], 'a system column in values is never written');
    });

    test(`${dialect}: the one-statement forms use a limited subquery under the same predicate`, () => {
        const d = bulk.compileDeleteMatching(T, F, ACCESS, { dialect, limit: 2 });
        assert.match(d.sql, /^DELETE FROM "tasks" WHERE \("created_by" = \?\) AND .* AND "id" IN \(SELECT "id" FROM "tasks" WHERE \("created_by" = \?\) AND .* ORDER BY "created_at" ASC, "id" ASC LIMIT \?\)$/);
        assert.deepEqual(d.params, ['u1', 'done', 'u1', 'done', 2]);
        const u = bulk.compileUpdateMatching(T, { status: 'x' }, F, ACCESS, { dialect });
        assert.equal(u.params[u.params.length - 1], 500);
    });
}

test('id lists: empty and over-long are refused; a filter must be a list', () => {
    assert.throws(() => bulk.compileDeleteIds(T, [], F, ACCESS), /at least one record id/);
    assert.throws(() => bulk.compileDeleteIds(T, Array.from({ length: 501 }, (_, i) => `r${i}`), F, ACCESS), /at most 500/);
    assert.throws(() => bulk.compileMatchIds(T, 'status = 1', ACCESS), /filter list/);
    assert.throws(() => bulk.compileMatchIds(T, [{ field: 'nope', op: 'eq', value: 1 }], ACCESS), /nope/);
});

test('locked reference rows refuse every bulk write', () => {
    const locked = { ...T, rowsLocked: true };
    assert.throws(() => bulk.compileDeleteIds(locked, ['a'], F, ACCESS), RowsLockedError);
    assert.throws(() => bulk.compileUpdateMatching(locked, { n: 1 }, F, ACCESS), RowsLockedError);
});

test('compileUpdate is unchanged by the shared SET clause', () => {
    const c = compileUpdate(T, 'rec_1', { status: 'x' }, ACCESS, { dialect: 'sqlite' });
    assert.equal(c.sql, 'UPDATE "tasks" SET "updated_at" = ?, "status" = ? WHERE "id" = ? AND ("created_by" = ?)');
    assert.deepEqual(c.params.slice(1), ['x', 'rec_1', 'u1']);
    assert.equal(c.updatedAt, c.params[0]);
});
