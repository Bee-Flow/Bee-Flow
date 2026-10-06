/**
 * Lists inside lists (nested.mjs): the forEach trail walk, and the rows and
 * levels "Flatten a list" is built on.
 *
 * Run: node --test shared/expr/nested.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePath } from './path.mjs';
import {
    walkTrail, parentDepths, asRows, itemVarFor, splitRoute, nestedRows, routeLevels, lastKey, RESERVED_VARS,
} from './nested.mjs';
import { flattenMailRoot, flattenOrdersRoot } from './corpus.mjs';

const ORDERS = {
    orders: [
        { id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }], note: 'x'.repeat(200) },
        { id: 2, line_items: [{ sku: 'C' }] },
        { id: 3, line_items: [] },
    ],
};

/** Run `fn` and count the JSON.parse calls that parse exactly `text`. */
function countParses(text, fn) {
    const original = JSON.parse;
    const seen = [];
    JSON.parse = (s, reviver) => { seen.push(s); return original(s, reviver); };
    try {
        const result = fn();
        return { result, n: seen.filter(s => s === text).length };
    } finally {
        JSON.parse = original;
    }
}

test('walkTrail: every element with the trail that led to it (as forEachScope did)', () => {
    const walked = walkTrail(parsePath('orders[*].line_items[*]'), ORDERS);
    assert.deepEqual(walked.entries.map(e => e.value.sku), ['A', 'B', 'C']);
    assert.deepEqual(walked.entries.map(e => e.trail[1].id), [1, 1, 2]);
    assert.equal(walked.dead, false);
});

test('walkTrail: JSON text, a dead path, a non-list and an absent path', () => {
    const body = JSON.stringify(ORDERS);
    assert.deepEqual(walkTrail(parsePath('body.orders[*].line_items[*]'), { body }).entries.map(e => e.value.sku), ['A', 'B', 'C']);
    assert.equal(walkTrail(parsePath('orders[*].nope[*]'), ORDERS).dead, true);
    assert.deepEqual(walkTrail(parsePath('orders[0].id'), ORDERS), { entries: null, dead: false });
    assert.equal(walkTrail(parsePath('nothing.here'), ORDERS), undefined);
});

test('parentDepths: usable parents only, at their trail position', () => {
    const tokens = parsePath('orders[*].line_items[*]');
    assert.deepEqual(parentDepths([{ itemVar: 'order', overRef: 'orders' }], tokens, 'line'), [{ itemVar: 'order', at: 1 }]);
    assert.deepEqual(parentDepths([{ itemVar: 'line', overRef: 'orders' }], tokens, 'line'), []);
    assert.deepEqual(parentDepths([{ itemVar: 'x', overRef: 'other' }], tokens, 'line'), []);
    assert.deepEqual(parentDepths(null, tokens, 'line'), []);
});

test('asRows: a list, JSON text of one, a single record, or nothing', () => {
    assert.deepEqual(asRows([1, 2]), [1, 2]);
    assert.deepEqual(asRows('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(asRows({ a: 1 }), [{ a: 1 }]);
    for (const v of [null, undefined, '', 'text', 3]) assert.equal(asRows(v), null);
    assert.deepEqual(asRows([]), []);
});

test('itemVarFor: singular, a name, never reserved, never taken', () => {
    assert.equal(itemVarFor('messages'), 'message');
    assert.equal(itemVarFor('lineItems'), 'lineItem');
    assert.equal(itemVarFor('items'), 'parent');
    assert.equal(itemVarFor('3d-models'), '_3d_model');
    assert.equal(itemVarFor(''), 'parent');
    assert.equal(itemVarFor('messages', ['message']), 'message2');
    assert.equal(itemVarFor('messages', ['message', 'message2']), 'message3');
    for (const r of RESERVED_VARS) assert.notEqual(itemVarFor(r), r);
});

test('splitRoute: the path cut at each [*]', () => {
    const s = splitRoute('steps.g.output.messages[*].attachments');
    assert.equal(s.levels, 1);
    assert.deepEqual(s.segments.map(seg => seg.map(t => t.key)), [['steps', 'g', 'output', 'messages'], ['attachments']]);
    assert.equal(splitRoute('steps.g.output.messages'), null);
    assert.equal(splitRoute('not a path ['), null);
    assert.equal(splitRoute('a[*].b[*].c').levels, 2);
});

test('lastKey: the last key of a path', () => {
    assert.equal(lastKey('steps.g.output.messages[*].attachments'), 'attachments');
    assert.equal(lastKey('steps.g.output.messages[*]'), 'messages');
    assert.equal(lastKey('['), '');
});

const ROUTE = 'orders[*].line_items';

test('nestedRows: an inner join by default, each item with its parent', () => {
    const r = nestedRows(ORDERS, ROUTE);
    assert.deepEqual(r.rows.map(x => [x.item.sku, x.parents[0].id]), [['A', 1], ['B', 1], ['C', 2]]);
    assert.equal(r.inputCount, 3);
    assert.equal(r.emptyCount, 1);
    assert.equal(r.dead, false);
    assert.equal(r.over, false);
});

test('nestedRows: keepEmpty gives the empty parent one empty row, in place', () => {
    const r = nestedRows(ORDERS, ROUTE, { keepEmpty: true });
    assert.equal(r.rows.length, 4);
    assert.deepEqual(r.rows[3], { item: undefined, parents: [ORDERS.orders[2]], empty: true });
});

test('nestedRows: three levels, a single object as a one-element list', () => {
    const root = flattenOrdersRoot({ taxes: true });
    const r = nestedRows(root, 'steps.http.output.body.orders[*].lines[*].taxes');
    assert.equal(r.rows.length, 8);
    // The order without lines is not an innermost parent: emptyCount counts lines without taxes only.
    assert.equal(r.emptyCount, 0);
    const last = r.rows[r.rows.length - 1];
    assert.deepEqual([last.parents[0].id, last.parents[1].id, last.item.rate], ['o5', 'l8', 21]);
});

test('nestedRows: dead route, unresolved outer list, limit', () => {
    const dead = nestedRows(ORDERS, 'orders[*].nope');
    assert.equal(dead.dead, true);
    assert.equal(dead.emptyCount, 3);
    assert.equal(nestedRows(ORDERS, 'missing[*].x'), null);
    assert.equal(nestedRows(ORDERS, 'orders'), null);
    const capped = nestedRows(ORDERS, ROUTE, { limit: 2 });
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.over, true);
    assert.equal(nestedRows(ORDERS, ROUTE, { limit: 3 }).over, false);
});

test('nestedRows: a JSON-text body is parsed once per run', () => {
    const body = JSON.stringify(ORDERS);
    assert.ok(body.length >= 256, 'precondition: long enough to be cached');
    const run = { steps: { http: { output: { body } } } };
    const { result, n } = countParses(body, () => {
        nestedRows(run, 'steps.http.output.body.orders[*].line_items');
        return nestedRows(run, 'steps.http.output.body.orders[*].line_items');
    });
    assert.equal(n, 1);
    assert.equal(result.rows.length, 3);
});

test('routeLevels: Gmail messages hold a list of attachment records', () => {
    const levels = routeLevels('steps.g_read_many.output.messages', flattenMailRoot());
    assert.equal(levels.length, 2);
    assert.deepEqual(levels[0], {
        path: 'steps.g_read_many.output.messages', key: 'messages', itemVar: 'message', count: 4, outerCount: null, depth: 0, records: true,
    });
    assert.deepEqual(levels[1], {
        path: 'steps.g_read_many.output.messages[*].attachments', key: 'attachments', itemVar: 'attachment',
        count: 64, outerCount: 4, depth: 1, records: true,
    });
});

test('routeLevels: a list of plain values is a level without records', () => {
    const root = { m: [{ id: 1, labelIds: ['INBOX'] }, { id: 2, labelIds: [] }] };
    const [, labels] = routeLevels('m', root);
    assert.equal(labels.key, 'labelIds');
    assert.equal(labels.records, false);
    assert.equal(labels.count, 1);
    assert.equal(labels.outerCount, 1);
});

test('routeLevels: deeper levels only up to maxDepth', () => {
    const root = flattenOrdersRoot({ taxes: true });
    const one = routeLevels('steps.http.output.body.orders', root);
    assert.deepEqual(one.map(l => l.key), ['orders', 'lines']);
    const two = routeLevels('steps.http.output.body.orders', root, { maxDepth: 2 });
    assert.deepEqual(two.map(l => [l.key, l.depth, l.itemVar]), [['orders', 0, 'order'], ['lines', 1, 'line'], ['taxes', 2, 'tax']]);
    assert.equal(two[1].count, 8);
    assert.equal(two[1].outerCount, 4);
    assert.deepEqual(routeLevels('steps.nothing', root), []);
});

test('nestedRows: emptyCount counts innermost parents only; a middle key found nowhere is dead', () => {
    const root = { orders: [{ lines: [{ taxes: [1] }, { taxes: [] }, { taxes: [] }] }, {}] };
    const r = nestedRows(root, 'orders[*].lines[*].taxes');
    assert.equal(r.inputCount, 2);
    assert.equal(r.emptyCount, 2);
    assert.equal(r.dead, false);
    assert.equal(nestedRows({ orders: [{ x: 1 }, { x: 2 }] }, 'orders[*].lines[*].taxes').dead, true);
    assert.equal(nestedRows({ orders: [{ lines: [] }] }, 'orders[*].lines[*].taxes').dead, false);
});
