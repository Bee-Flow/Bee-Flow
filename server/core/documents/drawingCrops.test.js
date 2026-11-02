// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { addDrawingCrops, planCrops, isDrawingLikePage } = require('./drawingCrops.mts');

const A3 = { width: 1191, height: 842 };
const A4 = { width: 595, height: 842 };
const overview = { base64: 'T1ZFUg==', mimeType: /** @type {const} */ ('image/png') };

/** A fake region renderer: sizes pages as given, renders each request as a 1568-long-edge PNG stand-in. */
function fakeRender(sizes) {
    return async (_buf, { maxPages, targetLongEdge, plan }) => {
        const pages = sizes.slice(0, maxPages).map((s, i) => ({ pageNumber: i + 1, ...s }));
        return plan(pages).map((r) => {
            const pw = r.w * pages[r.pageNumber - 1].width;
            const ph = r.h * pages[r.pageNumber - 1].height;
            const k = targetLongEdge / Math.max(pw, ph);
            return { pageNumber: r.pageNumber, label: r.label, base64: 'Q1JPUA==', mimeType: /** @type {const} */ ('image/png'), width: Math.round(pw * k), height: Math.round(ph * k) };
        });
    };
}

const run = (n, sizes, extra = {}) => addDrawingCrops({
    buffer: Buffer.from('x'), images: Array.from({ length: n }, () => overview), totalPages: n,
    pageCharCounts: Array(n).fill(12), render: fakeRender(Array(n).fill(sizes)), ...extra,
});

test('one drawing page: overview, title block, four tiles in order, with a legend', async () => {
    const { images, legend } = await run(1, A3);
    assert.deepStrictEqual(images.map((i) => i.label), ['Overview', 'Title block (enlarged)', 'Tile top-left', 'Tile top-right', 'Tile bottom-left', 'Tile bottom-right']);
    assert.ok(legend?.includes('1 = Overview') && legend.includes('6 = Tile bottom-right'));
    for (const c of images.slice(1)) assert.ok(Math.max(c.width ?? 0, c.height ?? 0) >= 1560 && Math.max(c.width ?? 0, c.height ?? 0) <= 1570, 'crop long edge ~1568');
});

test('four pages: overviews for all, crops for the first three pages only', async () => {
    const { images } = await run(4, A3);
    assert.strictEqual(images.length, 4 + 15);
    assert.strictEqual(images[0].label, 'Page 1 — Overview');
    assert.ok(images.some((i) => i.label === 'Page 2 — Tile top-left'));
    assert.ok(!images.some((i) => i.label.startsWith('Page 4 — Tile') || i.label.startsWith('Page 4 — Title')));
});

test('maxImages: overviews first, then title blocks, then tiles, earlier pages first', async () => {
    const { images } = await run(3, A3, { maxImages: 3 + 4 });
    assert.strictEqual(images.length, 7);
    const crops = images.slice(3).map((i) => i.label);
    assert.deepStrictEqual(crops, ['Page 1 — Title block (enlarged)', 'Page 1 — Tile top-left', 'Page 2 — Title block (enlarged)', 'Page 3 — Title block (enlarged)']);
});

test('no room under the cap: result is the plain overviews, no legend', async () => {
    const { images, legend } = await run(2, A3, { maxImages: 2 });
    assert.strictEqual(images.length, 2);
    assert.strictEqual(legend, null);
});

test('a dense A4 text page gets no crops; a short-text A4 page does', () => {
    assert.strictEqual(isDrawingLikePage({ pageNumber: 1, ...A4 }, 5000), false);
    assert.strictEqual(isDrawingLikePage({ pageNumber: 1, ...A4 }, 20), true);
    assert.strictEqual(isDrawingLikePage({ pageNumber: 1, ...A3 }, 5000), true);
    assert.deepStrictEqual(planCrops([{ pageNumber: 1, ...A4 }], [5000], 15, false), []);
});

test('a renderer that fails or is missing leaves the images untouched', async () => {
    const images = [overview];
    const failing = await addDrawingCrops({ buffer: Buffer.from('x'), images, totalPages: 1, pageCharCounts: [3], render: async () => { throw new Error('boom'); } });
    assert.strictEqual(failing.images, images);
    assert.strictEqual(failing.legend, null);
    const nul = await addDrawingCrops({ buffer: Buffer.from('x'), images, totalPages: 1, pageCharCounts: [3], render: async () => null });
    assert.strictEqual(nul.images, images);
});
