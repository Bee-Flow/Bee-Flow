/**
 * listQueryOf: the filter / sort / orderBy of a table page as the read runner
 * takes them, from the JSON text of the query string (RecordsQuery has already
 * refused text that is not JSON).
 *
 * Run: node --test routes/studio/appRuntimeSchemas.listQuery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { listQueryOf, RecordsQuery } = require('./appRuntimeSchemas');

test('a request without orderBy gives exactly filters and sort, as before', () => {
    assert.deepStrictEqual(listQueryOf({}), { filters: undefined, sort: undefined });
    assert.deepStrictEqual(
        listQueryOf({ filter: '[{"field":"a","op":"eq","value":1}]', sort: '{"field":"a","dir":"asc"}', limit: '5' }),
        { filters: [{ field: 'a', op: 'eq', value: 1 }], sort: { field: 'a', dir: 'asc' } },
    );
    assert.deepStrictEqual(listQueryOf({ filter: '{"field":"a","op":"isNull"}' }).filters, [{ field: 'a', op: 'isNull' }], 'one clause becomes a list');
});

test('orderBy and a filter tree pass through as sent', () => {
    const tree = [{ any: [{ all: [{ field: 'a', op: 'eq', value: 1 }, { not: { field: 'b', op: 'isNull' } }] }] }];
    const orderBy = [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }];
    assert.deepStrictEqual(listQueryOf({ filter: JSON.stringify(tree), orderBy: JSON.stringify(orderBy) }), { filters: tree, sort: undefined, orderBy });
});

test('RecordsQuery takes orderBy as JSON text and refuses anything else', () => {
    assert.strictEqual(RecordsQuery.safeParse({ orderBy: '[{"field":"a"}]' }).success, true);
    assert.strictEqual(RecordsQuery.safeParse({ orderBy: '[{"field":' }).success, false);
    assert.strictEqual(RecordsQuery.safeParse({ orderBy: ['a'] }).success, false);
});

test('expand and fields travel as JSON text, only when the request sent them', () => {
    const expand = [{ field: 'customer', pick: ['name'] }];
    assert.deepStrictEqual(listQueryOf({ expand: JSON.stringify(expand), fields: '["title"]' }), { filters: undefined, sort: undefined, expand, fields: ['title'] });
    assert.deepStrictEqual(Object.keys(listQueryOf({ sort: '{"field":"a"}' })), ['filters', 'sort']);
    assert.strictEqual(RecordsQuery.safeParse({ expand: JSON.stringify(expand), fields: '["title"]' }).success, true);
    assert.strictEqual(RecordsQuery.safeParse({ expand: '[{' }).success, false);
    assert.strictEqual(RecordsQuery.safeParse({ fields: 'title' }).success, false);
});
