// @typecheck
/**
 * nextcloud_read_file:
 *   - an image goes to the OCR of a scanned PDF (attachmentExtractor
 *     extractImage, text only) instead of failing as "binary"; without OCR it
 *     answers a plain error; SVG stays text;
 *   - formFields: true returns the filled-in AcroForm fields of a PDF as
 *     [{ name, value, type }] (a neutral form built in the test with pdf-lib).
 *
 * Run: cd server && node --test integrations/nextcloudFiles/readFile.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../../testUtils/routeHarness').recordDb();
const configStore = require('../../stores/configStore');
const ocr = require('../../core/documents/ocr');
const { executeFileOperationTool } = require('./fileOperations');
const { formFieldsFromObjects } = require('../../core/documents/pdfFormFields.mts');

const BASE = 'https://nc.example.test';
const ROOT = `${BASE}/remote.php/dav/files/alice`;

const realGetConfig = configStore.getConfig;
const realMistral = ocr.mistralOCR;
test.beforeEach(() => {
    // No Azure Document Intelligence in these tests: OCR is Mistral, mocked per test.
    configStore.getConfig = /** @type {any} */ (async () => null);
});
test.afterEach(() => {
    configStore.getConfig = realGetConfig;
    ocr.mistralOCR = realMistral;
});

/**
 * @param {Buffer | Uint8Array} bytes
 * @param {string} contentType
 */
function ctxServing(bytes, contentType) {
    const ncFetch = async () => new Response(Buffer.from(bytes), { status: 200, headers: { 'content-type': contentType } });
    return /** @type {any} */ ({ ncFetch, authError: 'AUTH', root: ROOT, baseUrl: BASE, uid: 'alice', session: {} });
}

// Eight bytes of PNG signature and a little more: never valid UTF-8 text.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xfe]);

test('an image is read through OCR and returns its text', async () => {
    /** @type {Array<[string, string, string]>} */
    const seen = [];
    ocr.mistralOCR = /** @type {any} */ (async (/** @type {string} */ b64, /** @type {string} */ mime, /** @type {string} */ name) => { seen.push([b64, mime, name]); return 'RECEIPT\nTotal EUR 12,50'; });
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/Receipts/receipt.jpg' }, ctxServing(PNG_BYTES, 'image/jpeg'));
    assert.strictEqual(res.content, 'RECEIPT\nTotal EUR 12,50');
    assert.strictEqual(res.extractedVia, 'mistral');
    assert.strictEqual(res.path, '/Receipts/receipt.jpg');
    assert.deepStrictEqual(seen, [[PNG_BYTES.toString('base64'), 'image/jpeg', 'receipt.jpg']]);
});

test('an image without an OCR provider is a plain error, not "binary"', async () => {
    ocr.mistralOCR = /** @type {any} */ (async () => null);
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/scan.png' }, ctxServing(PNG_BYTES, 'image/png'));
    assert.match(String(res.error), /No text could be read from scan\.png: it is an image/);
    assert.match(String(res.error), /OCR provider/);
    assert.doesNotMatch(String(res.error), /binary/);
});

test('an SVG stays on the text path (markup, not pixels)', async () => {
    ocr.mistralOCR = /** @type {any} */ (async () => { throw new Error('must not OCR an SVG'); });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Hi</text></svg>';
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/logo.svg' }, ctxServing(Buffer.from(svg), 'image/svg+xml'));
    assert.strictEqual(res.content, svg);
});

/** A small neutral filled-in form, built here so the repository carries no PDF. */
async function filledFormPdf() {
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const name = form.createTextField('applicant.name');
    name.setText('Sample Person');
    name.addToPage(page, { x: 20, y: 340, width: 200, height: 20 });
    const empty = form.createTextField('remarks');
    empty.addToPage(page, { x: 20, y: 300, width: 200, height: 20 });
    const agree = form.createCheckBox('agree');
    agree.addToPage(page, { x: 20, y: 260, width: 15, height: 15 });
    agree.check();
    const optIn = form.createCheckBox('newsletter');
    optIn.addToPage(page, { x: 60, y: 260, width: 15, height: 15 });
    const colour = form.createDropdown('colour');
    colour.addOptions(['red', 'green']);
    colour.select('green');
    colour.addToPage(page, { x: 20, y: 220, width: 100, height: 20 });
    const size = form.createRadioGroup('size');
    size.addOptionToPage('small', page, { x: 20, y: 180, width: 15, height: 15 });
    size.addOptionToPage('large', page, { x: 60, y: 180, width: 15, height: 15 });
    size.select('large');
    const unset = form.createRadioGroup('delivery');
    unset.addOptionToPage('post', page, { x: 20, y: 140, width: 15, height: 15 });
    form.createButton('submit').addToPage('Send', page, { x: 20, y: 100, width: 60, height: 20 });
    return Buffer.from(await doc.save());
}

test('formFields: true returns the filled-in AcroForm fields of a PDF', async () => {
    const pdf = await filledFormPdf();
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/Forms/application.pdf', formFields: true }, ctxServing(pdf, 'application/pdf'));
    assert.deepStrictEqual(res.formFields, [
        { name: 'applicant.name', value: 'Sample Person', type: 'text' },
        { name: 'remarks', value: '', type: 'text' },
        { name: 'agree', value: true, type: 'checkbox' },
        { name: 'newsletter', value: false, type: 'checkbox' },
        { name: 'colour', value: 'green', type: 'combobox' },
        { name: 'size', value: 'large', type: 'radiobutton' },
        { name: 'delivery', value: null, type: 'radiobutton' },
    ]);
    assert.strictEqual(res.path, '/Forms/application.pdf');
});

test('without formFields the answer has no formFields key', async () => {
    const pdf = await filledFormPdf();
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/Forms/application.pdf' }, ctxServing(pdf, 'application/pdf'));
    assert.ok(!('formFields' in res));
});

test('formFields on a file that is not a PDF is an empty list', async () => {
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/notes.md', formFields: true }, ctxServing(Buffer.from('# Notes'), 'text/markdown'));
    assert.strictEqual(res.content, '# Notes');
    assert.deepStrictEqual(res.formFields, []);
});

test('formFieldsFromObjects reads the Map of pdf.js 4+ and the plain object of older versions', () => {
    const widgets = { 'a.b': [{ type: '', kidIds: ['2R'] }, { type: 'text', value: 'x' }], pick: [{ type: 'listbox', value: ['one', 'two'], multipleSelection: true }], sig: [{ type: 'signature' }] };
    const expected = [{ name: 'a.b', value: 'x', type: 'text' }, { name: 'pick', value: ['one', 'two'], type: 'listbox' }];
    assert.deepStrictEqual(formFieldsFromObjects(/** @type {any} */ (widgets)), expected);
    assert.deepStrictEqual(formFieldsFromObjects(/** @type {any} */ (new Map(Object.entries(widgets)))), expected);
    assert.deepStrictEqual(formFieldsFromObjects(null), []);
});
