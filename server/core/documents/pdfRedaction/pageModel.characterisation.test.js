// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the page model's content interpreter
 * (analyzePage → Interpreter.run): every object it reports (kind, byte range,
 * bbox, text, origin, size, colours, line width, clip, form, removable) for
 * content streams that reach each operator: path construction and every
 * paint, clipping, q/Q nesting, cm, every colour operator, the text-state and
 * positioning operators, Tj / TJ / ' / ", inline and XObject images, a form
 * XObject with its own matrix and resources, a form drawing itself until the
 * depth cap, malformed operands, and the media box.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/documents/pdfRedaction/pageModel.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, StandardFonts } = require('pdf-lib');

const { analyzePage } = require('./pageModel');

const GOLDEN = path.join(__dirname, 'pageModel.characterisation.golden.json');

/** Round to 4 decimals so the golden is stable text; NaN and infinities stay visible. */
const round = (/** @type {unknown} */ v) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : String(v)) : v);
/** @param {unknown} v @returns {unknown} */
const plain = (v) => (Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : round(v));

const CASES = {
    paths: [
        '0 0 m 10 0 l 10 10 l h S',
        '1 0 0 rg 5 5 20 10 re f',
        '0 0 1 RG 2 w 0 0 m 1 2 3 4 5 6 c 7 8 9 10 v 11 12 13 14 y B',
        '0 0 m 5 5 l b*',
        '0 0 m 5 5 l n',
        '0 0 10 10 re W n',
        '0 0 10 10 re W* f*',
        '0 0 m s',
        'f',
        '1 0 0 0 k 0 0 0 1 K 3 3 3 3 re B*',
        '0.5 g 0.25 G 0 0 4 4 re F',
        '/Pattern cs 0 0 4 4 re f /Pattern CS 0 0 4 4 re S',
        '/P1 scn 0 0 4 4 re f 0.2 0.4 0.6 SCN 0 0 4 4 re s 0.1 0.2 sc 0 0 4 4 re f',
        '0 0 m 1 l 2 3 4 l S',
        '1 0 0 rg 0 1 0 RG /DeviceRGB cs /DeviceRGB CS 0 0 4 4 re B',
    ],
    stateStack: [
        'q 2 0 0 2 10 10 cm 0 0 5 5 re f Q 0 0 5 5 re f',
        'Q Q 0 0 1 1 re f',
        'q 1 0 0 1 5 5 cm q 0 1 -1 0 0 0 cm 0 0 1 2 re S Q 0 0 1 2 re S Q',
        '1 2 3 cm 0 0 1 1 re f',
        '0 w 0 0 1 1 re S x w 0 0 1 1 re S',
    ],
    text: [
        'BT /F1 12 Tf 100 700 Td (Hello) Tj ET',
        'BT /F1 10 Tf 1 0 0 1 50 50 Tm [(A) -500 (B) 250 (C)] TJ ET',
        'BT /F1 10 Tf 2 Tc 5 Tw 50 Tz 3 Ts 14 TL 10 20 Td (a b) Tj T* (c) Tj (d) \' ET',
        'BT /F1 8 Tf 12 TL 0 0 TD 1 2 (e f) " 0 -20 TD (g) Tj ET',
        'BT /Missing 9 Tf (x) Tj ET',
        'BT 9 Tf (no font) Tj ET',
        'BT /F1 x Tf (bad size) Tj ET',
        'BT (no Tf) Tj ET',
        'BT /F1 10 Tf 1 0 0 1 0 0 cm 3 0 0 3 0 0 cm (scaled) Tj ET',
        'BT /F1 10 Tf [] TJ [(z)] TJ ET',
        'BT /F1 10 Tf Tz (default scale) Tj ET',
        'BT /F1 10 Tf 0 Tz (zero scale) Tj /x Tz (nan scale) Tj ET',
        'BT /F1 10 Tf 1 2 3 Tm (Tm needs six) Tj 1 0 0 1 9 9 Tm (six) Tj ET',
        'BT /F1 10 Tf 5 Td (one operand) Tj ET',
        'BT /F1 10 Tf (first) Tj (second) Tj BT (reset) Tj ET',
        'BT /F1 10 Tf 0 1 -1 0 300 300 Tm (rotated) Tj ET',
    ],
    images: [
        'q 100 0 0 50 10 20 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI Q',
        'q 30 0 0 30 5 5 cm /Im1 Do Q',
        '/Nope Do',
        'Do',
        'q 2 0 0 2 0 0 cm /Fm1 Do Q',
        '/Loop Do',
        '/Bare Do',
    ],
    malformed: [
        '0 0 m 10 ( l S',
        '] 0 0 m 5 5 l S',
        '<< /A 1 >> 0 0 m 5 5 l S',
        '',
    ],
};

/** A one-page PDF whose page content is `content`, with a font, an image, forms and a box. */
async function pageWith(/** @type {string} */ content) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const ctx = pdf.context;
    const image = ctx.register(ctx.stream('\x00', { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: 'DeviceGray' }));
    const formRes = ctx.obj({});
    formRes.set(PDFName.of('Font'), ctx.obj({ F1: font.ref }));
    const form = ctx.register(ctx.stream('BT /F1 6 Tf (in form) Tj ET 0 0 3 3 re f /Img Do', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Matrix: [1, 0, 0, 1, 7, 9], Resources: formRes,
    }));
    formRes.set(PDFName.of('XObject'), ctx.obj({ Img: image }));
    const loopRes = ctx.obj({});
    const loop = ctx.register(ctx.stream('0 0 1 1 re f /Loop Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Matrix: [2, 0, 0, 2, 1, 1], Resources: loopRes }));
    loopRes.set(PDFName.of('XObject'), ctx.obj({ Loop: loop }));
    // A form without its own resources or matrix draws with the page's.
    const bare = ctx.register(ctx.stream('BT /F1 5 Tf (bare) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Matrix: [1, 'x', 0, 1, 0, 0] }));
    page.node.setXObject(PDFName.of('Im1'), image);
    page.node.setXObject(PDFName.of('Fm1'), form);
    page.node.setXObject(PDFName.of('Loop'), loop);
    page.node.setXObject(PDFName.of('Bare'), bare);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
    return { ctx, node: page.node };
}

/** @param {string} content */
async function model(content) {
    const { ctx, node } = await pageWith(content);
    const m = analyzePage(ctx, node);
    return { objects: plain(m.objects), malformed: m.malformed, box: m.box, bytes: m.contentBytes.length, refs: m.contentRefs.length };
}

test('analyzePage: every content stream matches the golden page model', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [group, list] of Object.entries(CASES)) {
        for (const [i, content] of list.entries()) actual[`${group}.${i}`] = { content, ...(await model(content)) };
    }
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const k of Object.keys(golden)) assert.deepEqual(actual[k], golden[k], k);
});

test('analyzePage: two content streams join with a newline, a missing one is skipped, and the media box is normalised', async () => {
    const { ctx, node } = await pageWith('');
    node.set(PDFName.of('Contents'), ctx.obj([ctx.register(ctx.stream('0 0 1 1 re')), ctx.register(ctx.stream('f')), ctx.obj(5)]));
    node.set(PDFName.of('MediaBox'), ctx.obj([300, 200, 0, 0]));
    const m = analyzePage(ctx, node);
    assert.equal(m.contentBytes.toString('latin1'), '0 0 1 1 re\nf');
    assert.equal(m.contentRefs.length, 2);
    assert.deepEqual(m.box, [0, 0, 300, 200]);
    assert.deepEqual(m.objects.map(o => [o.kind, o.start, o.end, o.bbox]), [['path', 0, 12, [0, 0, 1, 1]]]);
});
