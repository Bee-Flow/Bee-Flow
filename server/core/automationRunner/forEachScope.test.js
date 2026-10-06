/**
 * The forEach trail walk shares the run's JSON-text cache.
 *
 * execForEachStep resolves the overRef with walkPath (which caches a parsed
 * JSON-text body on the run's `steps`) and then walks it a second time with
 * walkWithTrail to find each item's parent element. That second walk parsed
 * the same body again, and the "matched none" count a third time: on a large
 * HTTP body read as JSON text, every forEach paid for the parse two or three
 * times.
 *
 * Run: cd server && node --test core/automationRunner/forEachScope.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveForEachItems, walkWithTrail } = require('./forEachScope');
const { walkPath } = require('../../automation/bind');
const { parsePath } = require('../../automation/expr');

/** Run `fn` and count the JSON.parse calls that parse exactly `text`. */
function countParses(text, fn) {
    const real = JSON.parse;
    let n = 0;
    JSON.parse = function (s, ...rest) {
        if (s === text) n++;
        return real.call(this, s, ...rest);
    };
    try { return { result: fn(), n }; } finally { JSON.parse = real; }
}

const ORDERS = {
    orders: [
        { id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }], note: 'x'.repeat(200) },
        { id: 2, line_items: [{ sku: 'C' }] },
        { id: 3, line_items: [] },
    ],
};

test('walkPath and the trail walk parse a JSON-text body once between them', () => {
    const body = JSON.stringify(ORDERS);
    assert.ok(body.length >= 256, 'precondition: long enough to be cached');
    const run = { trigger: { output: {} }, steps: { http: { output: { body } } }, vars: {}, secrets: {}, loop: {} };
    const overRef = 'steps.http.output.body.orders[*].line_items[*]';
    const fe = { overRef, itemVar: 'line', parents: [{ itemVar: 'order', overRef: 'steps.http.output.body.orders' }] };
    const { result, n } = countParses(body, () => {
        const list = walkPath(overRef, run);
        return resolveForEachItems(fe, { ...run, secrets: {} }, list);
    });
    assert.equal(n, 1);
    assert.deepEqual(result.scopes.map(s => s.order.id), [1, 1, 2]);
});

test('the trail walk reads JSON text itself (list inside list)', () => {
    const body = JSON.stringify(ORDERS);
    const run = { steps: { http: { output: { body } } } };
    const walked = walkWithTrail(parsePath('steps.http.output.body.orders[*].line_items[*]'), run);
    assert.deepEqual(walked.entries.map(e => e.value.sku), ['A', 'B', 'C']);
});

test('a path that matches no element counts the outer list without parsing again', () => {
    const body = JSON.stringify(ORDERS);
    const run = { trigger: { output: {} }, steps: { http: { output: { body } } }, vars: {}, secrets: {}, loop: {} };
    const overRef = 'steps.http.output.body.orders[*].nope[*]';
    const fe = { overRef, itemVar: 'x' };
    const { result, n } = countParses(body, () => resolveForEachItems(fe, run, walkPath(overRef, run)));
    assert.equal(n, 1);
    assert.deepEqual(result.noMatch, { outer: 'steps.http.output.body.orders', count: 3 });
});
