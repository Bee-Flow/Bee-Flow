/**
 * The 2D DXF renderer.
 *
 * Asserted on the PARSE and the flattening rather than on pixels: a PNG diff
 * would break on a font hint, while "did the block reference draw its circle"
 * is the question that actually decides whether someone sees their part.
 *
 * Run: cd server && node --test core/cad/dxfRender.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderDxfSheet, _internal } = require('./dxfRender');
const { parseDxf, collectPaths, vertexPath } = _internal;

/** A DXF is (group code, value) line pairs — build one from a flat list. */
const dxf = (...pairs) => pairs.join('\r\n') + '\r\n';

const PLATE = dxf(
    '999', 'nesting post-processor',
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '2', 'TAP', '10', '0', '20', '0',
    '0', 'CIRCLE', '10', '0', '20', '0', '40', '4',
    '0', 'ENDBLK',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '200', '20', '0', '10', '200', '20', '100', '10', '0', '20', '100',
    '0', 'CIRCLE', '10', '50', '20', '50', '40', '10',
    '0', 'INSERT', '2', 'TAP', '10', '170', '20', '80',
    '0', 'ENDSEC', '0', 'EOF',
);

test('parseDxf separates entities, blocks and the units header', () => {
    const { entities, blocks, header } = parseDxf(PLATE);
    assert.deepStrictEqual(entities.map((e) => e.type), ['LWPOLYLINE', 'CIRCLE', 'INSERT']);
    assert.strictEqual(header.insunits, 4, 'millimetres');
    assert.ok(blocks.has('TAP'));
    assert.deepStrictEqual(blocks.get('TAP').entities.map((e) => e.type), ['CIRCLE']);
});

test('an INSERT draws its block, moved to the insertion point', () => {
    // THE CASE THIS PROTECTS: nesting exporters wrap a part in blocks and
    // place them with INSERT. A renderer that ignores INSERT produces a
    // technically correct empty sheet for a very large share of real files.
    const { entities, blocks } = parseDxf(PLATE);
    const paths = [];
    collectPaths(entities, blocks, paths, null, 0, { segments: 0, truncated: false });

    assert.strictEqual(paths.length, 3, 'outline + loose circle + the block circle');
    const inserted = paths[2];
    const xs = inserted.map((p) => p[0]);
    const ys = inserted.map((p) => p[1]);
    // A Ø8 circle centred on (170, 80).
    assert.ok(Math.min(...xs) > 165.9 && Math.min(...xs) < 166.1, `left edge ${Math.min(...xs)}`);
    assert.ok(Math.max(...ys) > 83.9 && Math.max(...ys) < 84.1, `top edge ${Math.max(...ys)}`);
});

test('a bulged polyline segment becomes an arc, not a chord', () => {
    // bulge = tan(θ/4); 0.4142 ≈ a quarter turn. Drawn as a straight line a
    // rounded corner reads as a chamfer, which is a different part.
    const straight = vertexPath([{ x: 0, y: 0, bulge: 0 }, { x: 10, y: 10, bulge: 0 }], false);
    assert.strictEqual(straight.length, 2);

    const rounded = vertexPath([{ x: 0, y: 0, bulge: 0.4142 }, { x: 10, y: 10, bulge: 0 }], false);
    assert.ok(rounded.length > 5, `an arc has intermediate points, got ${rounded.length}`);
    // Every point bulges off the straight chord, and the ends still land.
    assert.deepStrictEqual(rounded[0], [0, 0]);
    const [ex, ey] = rounded[rounded.length - 1];
    assert.ok(Math.abs(ex - 10) < 1e-6 && Math.abs(ey - 10) < 1e-6, `ends at ${ex},${ey}`);
    const offChord = rounded.slice(1, -1).some(([x, y]) => Math.abs(x - y) > 0.5);
    assert.ok(offChord, 'the arc leaves the chord');
});

test('renderDxfSheet draws a plate and reports its real size', async () => {
    const { png, stats } = await renderDxfSheet(Buffer.from(PLATE, 'utf8'), { name: 'plaat.DXF' });
    assert.ok(Buffer.isBuffer(png) && png.length > 1000, 'a real PNG came back');
    assert.strictEqual(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.deepStrictEqual(stats.size, [200, 100]);
    assert.strictEqual(stats.insunits, 4);
    assert.strictEqual(stats.paths, 3);
    assert.strictEqual(stats.truncated, false);
});

test('refusals are specific enough to act on', async () => {
    await assert.rejects(
        renderDxfSheet(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00rest', 'latin1')),
        /binary DXF/,
        'a binary DXF says so instead of reporting "no geometry"',
    );
    await assert.rejects(
        renderDxfSheet(Buffer.from(dxf('0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'), 'utf8')),
        /no geometry/,
    );
    await assert.rejects(renderDxfSheet(Buffer.alloc(0)), /empty buffer/);
});

test('an entity type that is not cut is not drawn', async () => {
    // TEXT and DIMENSION belong to the paper drawing, not to the part. Drawn
    // at thumbnail scale they are a grey smear over the contours.
    const withText = dxf(
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'CIRCLE', '10', '0', '20', '0', '40', '5',
        '0', 'TEXT', '10', '0', '20', '0', '40', '2.5', '1', 'PLAAT 20MM',
        '0', 'ENDSEC', '0', 'EOF',
    );
    const { stats } = await renderDxfSheet(Buffer.from(withText, 'utf8'));
    assert.strictEqual(stats.paths, 1, 'the circle only');
});
