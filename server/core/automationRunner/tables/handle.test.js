'use strict';

/**
 * The table handle: preview caps, id shape, the dry-run handle.
 *
 * Run: cd server && node --test core/automationRunner/tables/handle.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { TABLE_ID_RE, isTableHandle, buildHandle, dryRunHandle, previewOf } = require('./handle');

const ID = `rtb_${'a'.repeat(32)}`;
const cols = (n) => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, type: 'text' }));

test('the table id pattern', () => {
    assert.ok(TABLE_ID_RE.test(ID));
    for (const bad of ['', 'rtb_abc', `rtb_${'A'.repeat(32)}`, `x_${'a'.repeat(32)}`, `rtb_${'a'.repeat(33)}`]) {
        assert.ok(!TABLE_ID_RE.test(bad), bad);
    }
});

test('the preview holds at most previewRows rows', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ c0: i }));
    const { preview, previewCut } = previewOf(rows, cols(1), 5);
    assert.strictEqual(preview.length, 5);
    assert.strictEqual(previewCut, true);
    assert.strictEqual(previewOf(rows.slice(0, 3), cols(1), 5).previewCut, false);
});

test('the preview keeps the first 50 columns only', () => {
    const wide = cols(80);
    const row = Object.fromEntries(wide.map(c => [c.key, 1]));
    const { preview, previewCut } = previewOf([row], wide, 20);
    assert.strictEqual(Object.keys(preview[0]).length, 50);
    assert.ok('c49' in preview[0] && !('c50' in preview[0]));
    assert.strictEqual(previewCut, true);
});

test('long text cells are cut to 200 characters; other values stay as they are', () => {
    const { preview, previewCut } = previewOf([{ c0: 'x'.repeat(500), c1: 7, c2: null }], cols(3), 20);
    assert.strictEqual(preview[0].c0.length, 200);
    assert.strictEqual(preview[0].c1, 7);
    assert.strictEqual(preview[0].c2, null);
    assert.strictEqual(previewCut, true);
});

test('buildHandle gives the documented shape', () => {
    const h = buildHandle({
        tableId: ID, runId: 'r1', name: 'Scores', columns: cols(2), rowCount: 2,
        rows: [{ c0: 'a', c1: 1 }, { c0: 'b', c1: 2 }], expiresAt: '2026-11-01T00:00:00Z', provenance: { source: 'synthetic' },
    });
    assert.deepStrictEqual(h, {
        kind: 'table', tableId: ID, runId: 'r1', name: 'Scores',
        columns: cols(2), rowCount: 2, preview: [{ c0: 'a', c1: 1 }, { c0: 'b', c1: 2 }],
        expiresAt: '2026-11-01T00:00:00.000Z', provenance: { source: 'synthetic' },
    });
    assert.ok(isTableHandle(h));
});

test('a handle whose rows were cut says so', () => {
    const h = buildHandle({ tableId: ID, runId: 'r1', name: 'T', columns: cols(1), rowCount: 500, rows: [{ c0: 1 }], previewRows: 20 });
    assert.strictEqual(h.previewCut, true);
});

test('provenance is limited to 200 entries and null when empty', () => {
    const big = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'v']));
    assert.strictEqual(Object.keys(buildHandle({ tableId: ID, name: 'T', columns: [], rowCount: 0, provenance: big }).provenance).length, 200);
    assert.strictEqual(buildHandle({ tableId: ID, name: 'T', columns: [], rowCount: 0, provenance: {} }).provenance, null);
});

test('the dry-run handle is empty and not stored', () => {
    const h = dryRunHandle({ name: 'Sheet1', columns: cols(1) });
    assert.strictEqual(h.tableId, 'dry-run');
    assert.strictEqual(h.rowCount, 0);
    assert.deepStrictEqual(h.preview, []);
    assert.strictEqual(h.runId, null);
    assert.strictEqual(h.expiresAt, null);
    assert.ok(isTableHandle(h));
});

test('isTableHandle', () => {
    assert.strictEqual(isTableHandle(null), false);
    assert.strictEqual(isTableHandle({ kind: 'table', tableId: 'nope', columns: [], rowCount: 0 }), false);
    assert.strictEqual(isTableHandle({ kind: 'file', tableId: ID, columns: [], rowCount: 0 }), false);
    assert.strictEqual(isTableHandle({ kind: 'table', tableId: ID, columns: [], rowCount: 0 }), true);
});
