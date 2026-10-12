/**
 * shapeCache — the output shape the AI builder sees: deep, compact, the
 * union of every list entry, real key names only.
 *
 * REGRESSION (audit:other-surfaces + audit:server-static-paths, 2026-10):
 * describeValue read element [0] of every list and stopped at depth 5, and
 * renderShapeHint printed two levels with Object.keys — so a Gmail page read
 * "payload: { mimeType, headers, parts }" (nothing said parts is a list or
 * what is in it), a matrix read "rows: array of { _array, _length }" (the
 * descriptor's own markers as field names), and a key only entry 2 had was
 * gone. The golden lines below are what the AI now reads.
 *
 * Run: cd server && node --test automation/shapeCache.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeValue, renderShapeHint, shapeHintOf, mergeDescriptors } = require('./shapeCache');

const GMAIL = {
    id: '18f2', threadId: 't1',
    payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'From', value: 'a@x.nl' }, { name: 'Subject', value: 'Invoice' }],
        parts: [
            { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { size: 2, data: 'QQ' } }] },
            { mimeType: 'application/pdf', filename: 'f.pdf', body: { attachmentId: 'att1', size: 1000 } },
        ],
    },
};
const SHOP = { orders: [{ id: 1, line_items: [{ sku: 'A', properties: [{ name: 'gift', value: 'yes' }] }] }, { id: 2, tax_lines: [{ rate: 0.21 }] }] };
const MATRIX = { rows: [[1, 2], [3]], hetero: [{ id: 1 }, { id: 2, extra: true }] };

test('Gmail: every level, lists as [*], keys of every part', () => {
    assert.equal(
        renderShapeHint(describeValue(GMAIL)),
        'id: string; threadId: string; payload: { mimeType, headers[*]: { name, value }, parts[*]: { mimeType, parts[*]: { mimeType, body: { size, data } }, filename, body: { attachmentId, size } } }',
    );
});

test('Shopify: list in list in list, and keys only the second order has', () => {
    assert.equal(
        renderShapeHint(describeValue(SHOP)),
        'orders[*]: { id, line_items[*]: { sku, properties[*]: { name, value } }, tax_lines[*]: { rate } }',
    );
});

test('a matrix and a ragged list never show _array/_length', () => {
    const hint = renderShapeHint(describeValue(MATRIX));
    assert.equal(hint, 'rows[*][*]: integer; hetero[*]: { id, extra }');
    assert.ok(!/_array|_length/.test(hint));
});

test('JSON text is described as what it encodes', () => {
    const d = describeValue({ body: '{"data":{"items":[{"id":1}]}}' });
    assert.deepEqual(d, { body: { _json: { data: { items: { _array: { id: 'integer' }, _length: 1 } } } } });
    assert.equal(renderShapeHint(d), 'body (JSON text): { data: { items[*]: { id } } }');
});

test('the descriptor stays structure only — no values leak', () => {
    const json = JSON.stringify(describeValue({ results: [{ from: 'a@b.com', subject: 'secret', amount: 1234 }], total: 1 }));
    assert.ok(!json.includes('a@b.com') && !json.includes('secret'));
    assert.match(json, /"from":"string"/);
});

test('from a value the hint also names the entries of a name/value list', () => {
    assert.match(shapeHintOf(GMAIL), /headers\[\*\]: \{ name, value \} \(name\/value pairs: From, Subject; pick one with \[name="From"\]\)/);
});

test('a big shape stays bounded: depth is cut to fit, never the line', () => {
    let deep = { leaf: 1 };
    for (let i = 0; i < 14; i++) deep = { [`level${i}`]: deep, [`wide${i}`]: Array.from({ length: 30 }, (_, j) => ({ [`k${j}`]: j })) };
    const hint = shapeHintOf(deep);
    assert.ok(hint.length <= 900, `${hint.length} chars`);
    assert.match(hint, /\{…\}/);
});

test('mergeDescriptors: union of keys, numbers widen, conflicting kinds are mixed', () => {
    assert.deepEqual(mergeDescriptors({ a: 'string' }, { b: 'integer' }), { a: 'string', b: 'integer' });
    assert.equal(mergeDescriptors('integer', 'number'), 'number');
    assert.equal(mergeDescriptors('null', 'string'), 'string');
    assert.equal(mergeDescriptors({ a: 'string' }, 'string'), 'mixed');
});
