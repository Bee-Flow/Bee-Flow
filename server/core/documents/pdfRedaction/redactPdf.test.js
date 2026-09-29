'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PDFKit = require('pdfkit');
const { PDFDocument, PDFName } = require('pdf-lib');
const { redactPdf, listTextRuns, PdfRedactionError, cutRanges } = require('./redactPdf');

// 1x1 PNG, used as a raster logo.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A fictional technical drawing: part geometry, a title block, and the customer's marks. */
function drawing({ encrypted = false } = {}) {
    return new Promise((resolve, reject) => {
        const doc = new PDFKit({
            size: 'A4', margin: 0,
            info: { Title: 'E0123456', Author: 'ACMEMETAL\\plotserver' },
            ...(encrypted ? { userPassword: 'secret', ownerPassword: 'owner' } : {}),
        });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Part geometry and dimensions (must survive untouched).
        doc.lineWidth(0.8).rect(150, 150, 200, 120).stroke();
        doc.circle(250, 210, 30).stroke();
        doc.font('Helvetica').fontSize(10).fillColor('black');
        doc.text('R0,5 (2x)', 360, 150, { lineBreak: false });
        doc.text('45°', 360, 170, { lineBreak: false });
        doc.text('Contact: Jan de Vries', 150, 300, { lineBreak: false });

        // Title block.
        doc.rect(20, 700, 555, 120).stroke();
        doc.fontSize(7);
        doc.text('Material', 250, 705, { lineBreak: false });
        doc.text('RVS304', 330, 705, { lineBreak: false });
        doc.text('Author', 440, 705, { lineBreak: false });
        doc.text('JDO', 470, 705, { lineBreak: false });
        doc.text('Date', 520, 705, { lineBreak: false });
        doc.text('14-07-2026', 540, 705, { lineBreak: false });
        doc.text('Checked', 440, 720, { lineBreak: false });
        doc.text('JDO', 470, 720, { lineBreak: false });
        doc.text('Article', 250, 740, { lineBreak: false });
        doc.text('00000002', 330, 740, { lineBreak: false });
        doc.text('Drawing', 250, 760, { lineBreak: false });
        doc.text('E0123456', 330, 760, { lineBreak: false });

        // The customer's block: a coloured logo, a raster mark, contact line and disclaimer.
        doc.save().fillColor('#009994');
        doc.polygon([30, 712], [60, 712], [70, 722], [60, 732], [30, 732], [25, 722]).fill();
        doc.restore();
        doc.image(PNG, 80, 712, { width: 20, height: 20 });
        doc.fontSize(5).fillColor('black');
        doc.text('www.acme-metal.com', 30, 740, { lineBreak: false });
        doc.text('phone: [+31] 10 123 4567', 120, 740, { lineBreak: false });
        doc.text('Property of Acme Metal BV. All rights reserved.', 30, 750, { lineBreak: false });
        doc.text('Unauthorised use of this document is illegal.', 30, 757, { lineBreak: false });
        doc.link(30, 740, 60, 6, 'https://www.acme-metal.com');
        doc.end();
    });
}

const texts = async (buf) => (await listTextRuns(buf)).runs.map((r) => r.text);

test('removes the customer marks and keeps every dimension, field and value', async () => {
    const input = await drawing();
    const { buffer, removed, summary } = await redactPdf(input);

    const gone = removed.filter((r) => r.text).map((r) => r.text).sort();
    assert.deepEqual(gone, [
        'JDO', 'JDO',
        'Property of Acme Metal BV. All rights reserved.',
        'Unauthorised use of this document is illegal.',
        'phone: [+31] 10 123 4567',
        'www.acme-metal.com',
    ]);
    assert.equal(summary.images, 1);
    assert.equal(summary.annotations, 1);
    assert.ok(summary.graphics >= 1, 'the coloured logo is removed');

    const left = await texts(buffer);
    for (const keep of ['R0,5 (2x)', '45°', 'Material', 'RVS304', 'Author', 'Date', '14-07-2026', 'Checked', '00000002', 'E0123456']) {
        assert.ok(left.includes(keep), `kept: ${keep}`);
    }
    for (const g of gone) assert.ok(!left.includes(g), `gone: ${g}`);
});

test('the output carries no metadata, no links and no trace of the customer in its bytes', async () => {
    const { buffer } = await redactPdf(await drawing());
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    assert.equal(doc.context.trailerInfo.Info, undefined);
    assert.equal(doc.catalog.get(PDFName.of('Metadata')), undefined);
    const annots = doc.getPages()[0].node.get(PDFName.of('Annots'));
    assert.ok(!annots || doc.context.lookup(annots).size() === 0);
    const raw = buffer.toString('latin1').toLowerCase();
    assert.ok(!raw.includes('acmemetal'), 'no author string');
    assert.ok(!raw.includes('acme-metal'), 'no link URI');
});

test('an AI-flagged text run is removed too, by its reference', async () => {
    const input = await drawing();
    const { runs } = await listTextRuns(input);
    const contact = runs.find((r) => r.text === 'Contact: Jan de Vries');
    assert.ok(contact, 'the run is listed for the AI');
    const { buffer, removed } = await redactPdf(input, { aiMarks: [{ page: contact.page, id: contact.id, category: 'person' }] });
    assert.ok(removed.some((r) => r.text === 'Contact: Jan de Vries' && r.category === 'person'));
    assert.ok(!(await texts(buffer)).includes('Contact: Jan de Vries'));
});

test('cleaning a cleaned file removes nothing more', async () => {
    const once = await redactPdf(await drawing());
    const twice = await redactPdf(once.buffer);
    assert.equal(twice.summary.text, 0);
    assert.equal(twice.summary.graphics, 0);
    assert.deepEqual(await texts(twice.buffer), await texts(once.buffer));
});

test('a user-given term removes a line the rules would not catch', async () => {
    const { removed } = await redactPdf(await drawing(), { terms: ['Jan de Vries'] });
    assert.ok(removed.some((r) => r.text === 'Contact: Jan de Vries'));
});

test('refuses what it cannot clean safely', async () => {
    await assert.rejects(redactPdf(Buffer.from('not a pdf')), (e) => e instanceof PdfRedactionError && e.code === 'not_pdf');
    await assert.rejects(redactPdf(await drawing({ encrypted: true })), (e) => e instanceof PdfRedactionError && e.code === 'encrypted');
});

test('a scanned page (one picture, no text) is flagged instead of passing as clean', async () => {
    const scan = await new Promise((resolve, reject) => {
        const doc = new PDFKit({ size: 'A4', margin: 0 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
        doc.image(PNG, 0, 0, { width: 595, height: 842 });
        doc.end();
    });
    const { removed, warnings } = await redactPdf(scan);
    assert.equal(removed.length, 0);
    assert.match(warnings[0], /Page 1 is a scanned image/);
    assert.deepEqual((await redactPdf(await drawing())).warnings, []);
});

test('cutRanges leaves a space at every cut so neighbouring tokens never merge', () => {
    const out = cutRanges(Buffer.from('1 0 0 RG 5 5 m 6 6 l S Q'), [[9, 22]]);
    assert.equal(out.toString(), '1 0 0 RG   Q');
});
