/**
 * The shared pdfkit helpers — and the one bug that made them shared.
 *
 * A footer belongs in the bottom margin, and pdfkit will not write there:
 * LineWrapper breaks to a new page whenever `y > maxY`, BEFORE it draws
 * anything, and `lineBreak: false` does not suppress that. So both pdfkit
 * documents in this repo silently ended with a blank page — the compliance
 * pack for every auditor who ever printed one, and the demo drawing by a
 * margin of 0.09 pt.
 *
 * It is invisible in review, because a reviewer reads the content and stops.
 * These tests look at the page count instead.
 *
 * Run: cd server && node --test --test-force-exit utils/pdfKit.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');

const { newDoc, collect, table, footer } = require('./pdfKit');

async function pages(buffer) {
    return (await PDFDocument.load(buffer)).getPageCount();
}

/** The text layer, so a test can assert what a reader would actually see. */
async function textOf(buffer) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

test('a footer does not cost a page', async () => {
    const doc = newDoc();
    const done = collect(doc);
    doc.fontSize(12).text('one short page');
    footer(doc, 'Integrity sha256:abc — supports, does not replace, legal review.');
    assert.equal(await pages(await done), 1);
});

test('a footer does not cost a page in landscape or with tight margins either', async () => {
    for (const margins of [{ top: 28, bottom: 28, left: 28, right: 28 }, { top: 56, bottom: 64, left: 56, right: 56 }]) {
        const doc = newDoc({ landscape: true, margins });
        const done = collect(doc);
        doc.fontSize(9).text('content');
        footer(doc, 'a footer line', { pageNumbers: false });
        assert.equal(await pages(await done), 1, `bottom margin ${margins.bottom}`);
    }
});

test('the bottom margin is put back, so a footer cannot change later layout', async () => {
    const doc = newDoc();
    const before = doc.page.margins.bottom;
    const done = collect(doc);
    doc.text('x');
    footer(doc, 'f');
    await done;
    assert.equal(doc.page.margins.bottom, before);
});

test('page numbers appear only when there is more than one page', async () => {
    const one = newDoc();
    const oneDone = collect(one);
    one.text('short');
    footer(one, 'f');
    const oneText = (await oneDone).toString('latin1');
    assert.ok(!/1 \/ 1/.test(oneText), 'a one-page document numbered itself');
});

test('a table breaks to a new page instead of running off the sheet', async () => {
    const doc = newDoc();
    const done = collect(doc);
    table(doc, {
        columns: [{ label: 'Pos', width: 40, key: 'pos' }, { label: 'Naam', width: 300, key: 'naam' }],
        rows: Array.from({ length: 90 }, (_, i) => ({ pos: String(i), naam: `part-${i}` })),
    });
    footer(doc, 'f');
    const buf = await done;
    assert.ok(await pages(buf) > 1, '90 rows fitted on one A4 page, which they do not');
    // Every row survives the break — the hand-rolled table this replaced
    // advanced y by a fixed step and simply drew the overflow off the sheet.
    const text = await textOf(buf);
    for (const i of [0, 45, 89]) assert.ok(text.includes(`part-${i}`), `part-${i} is not in the document`);
    // …and the header is repeated, so page two is readable on its own.
    assert.ok((text.match(/POS/g) || []).length > 1, 'the header was not repeated after the break');
});

test('a table measures its rows, so a wrapping cell cannot overlap the next', async () => {
    const doc = newDoc();
    const done = collect(doc);
    const long = 'Aluminium 5083 TOOLINGPLATE met een omschrijving die ruim over de kolombreedte heen loopt';
    table(doc, {
        columns: [{ label: 'Materiaal', width: 90, key: 'm' }, { label: 'Pos', width: 40, key: 'p' }],
        rows: [{ m: long, p: '10' }, { m: 'kort', p: '20' }],
    });
    const yAfter = doc.y;
    footer(doc, 'f');
    await done;
    // Two rows, one of them several lines tall: well past a fixed 2×rowHeight.
    assert.ok(yAfter > doc.page.margins.top + 60, `rows did not grow with their content (y=${yAfter})`);
});
