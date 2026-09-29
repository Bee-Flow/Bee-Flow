'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _buildServerScope: buildServerScope } = require('./actionExecutor');

/**
 * A step's formula must see the same starting values the browser seeded at
 * mount, or a filter that works on screen resolves to nothing the moment the
 * same expression runs server-side.
 *
 * The precedence rule is the interesting part: the declared default is a FLOOR.
 */

const DECLARED = [
    { name: 'status', label: 'Status', type: 'text', default: 'new', description: '' },
    { name: 'limit', label: 'Limit', type: 'number', default: 10, description: '' },
    { name: 'mine', label: 'Mine', type: 'yesno', default: false, description: '' },
];

test('declared defaults seed the scope', () => {
    const scope = buildServerScope({ variables: DECLARED });
    assert.deepStrictEqual(scope.vars, { status: 'new', limit: 10, mine: false });
});

test('a value the client already holds wins over the default', () => {
    // It is live user state — a filter the person set, or a resultVar the
    // previous step in this sequence just produced.
    const scope = buildServerScope({ variables: DECLARED, vars: { status: 'closed' } });
    assert.equal(scope.vars.status, 'closed');
    assert.equal(scope.vars.limit, 10);
});

test('an explicit null from the client is a value, not a miss', () => {
    const scope = buildServerScope({ variables: DECLARED, vars: { status: null } });
    assert.equal(scope.vars.status, null);
});

test('a caller that passes no variables gets exactly the old behaviour', () => {
    assert.deepStrictEqual(buildServerScope({ vars: { a: 1 } }).vars, { a: 1 });
    assert.deepStrictEqual(buildServerScope({}).vars, {});
});

test('defaults are coerced on the way in, so the server never sees a mistyped one', () => {
    const scope = buildServerScope({
        variables: [{ name: 'n', type: 'number', default: '5' }, { name: 'd', type: 'date', default: '2026-08-10T09:00:00Z' }],
    });
    assert.equal(scope.vars.n, 5);
    assert.equal(scope.vars.d, '2026-08-10');
});

test('a reserved or unusable name never reaches the scope', () => {
    const scope = buildServerScope({
        variables: [{ name: 'filters', type: 'text', default: 'x' }, { name: 'my var', type: 'text', default: 'y' }],
    });
    assert.deepStrictEqual(scope.vars, {});
});

test('seeding vars leaves every other scope root alone', () => {
    const scope = buildServerScope({ variables: DECLARED, formValues: { a: 1 } });
    assert.deepStrictEqual(scope.form, { a: 1 });
    assert.deepStrictEqual(scope.actions, {});
    assert.deepStrictEqual(scope.records, {});
});
