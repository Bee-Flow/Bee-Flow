'use strict';

/**
 * depsWith: real collaborators on first use, the caller's in their place.
 *
 * Run: cd server && node --test automation/patterns/depsWith.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { depsWith } = require('./depsWith');

test('a given collaborator is used and its loader never runs; the rest load once, on first use', () => {
    const loaded = [];
    const loaders = {
        a: () => { loaded.push('a'); return 'real a'; },
        b: () => { loaded.push('b'); return 'real b'; },
        c: () => { loaded.push('c'); return 'real c'; },
    };
    const d = depsWith(loaders, { a: 'given a', b: undefined, c: null });
    assert.deepStrictEqual(loaded, []);
    assert.strictEqual(d.a, 'given a');
    assert.strictEqual(d.b, 'real b');
    assert.strictEqual(d.b, 'real b');
    assert.strictEqual(d.c, null, 'null is a value, not "not given"');
    assert.deepStrictEqual(loaded, ['b']);
});

test('each call has its own collaborators', () => {
    const loaders = { x: () => ({}) };
    assert.notStrictEqual(depsWith(loaders, null).x, depsWith(loaders, null).x);
    assert.strictEqual(depsWith(loaders, { x: 1 }).x, 1);
});
