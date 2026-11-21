'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    templateFileOf, parseTemplateFile, inlineImages, storageKeysIn, canExport,
    TEMPLATE_FILE_FORMAT, TEMPLATE_FILE_VERSION,
} = require('./templateFile.mts');

const contract = { parameters: [{ key: 'customer', type: 'text', label: 'Customer', required: true }], sections: [] };
const template = {
    name: 'Offer', description: 'A quote', docType: 'quote', bodyHtml: '<h1>{{customer}}</h1>', css: 'h1 { color: red; }',
    categories: ['Sales'],
    settings: {
        contract, design: { accent: '#ff0000' }, houseStyle: false, locale: 'nl',
        sampleValues: { customer: 'A real customer' }, sectionOverrides: { a: 'include' }, source: { documentId: 'x' },
        templateFill: { conversationId: 'c1' }, resolvedHouseStyleCss: ':root{}', somethingNew: 'secret',
    },
};

test('the file carries the template and only the settings on the allow-list', () => {
    const file = templateFileOf(template, '2026-11-20T10:00:00.000Z');
    assert.equal(file.format, TEMPLATE_FILE_FORMAT);
    assert.equal(file.version, TEMPLATE_FILE_VERSION);
    assert.equal(file.exportedAt, '2026-11-20T10:00:00.000Z');
    assert.deepEqual(Object.keys(file.template.settings).sort(), ['contract', 'design', 'houseStyle', 'locale']);
    assert.equal(file.template.bodyHtml, template.bodyHtml);
    assert.equal(file.template.css, template.css);
    assert.deepEqual(file.template.categories, ['Sales']);
    assert.doesNotMatch(JSON.stringify(file), /A real customer|conversationId|secret|resolvedHouseStyleCss/);
});

test('a file reads back as the template it was made from', () => {
    const back = parseTemplateFile(JSON.parse(JSON.stringify(templateFileOf(template))));
    assert.equal(back.name, 'Offer');
    assert.equal(back.docType, 'quote');
    assert.equal(back.bodyHtml, template.bodyHtml);
    assert.equal(back.css, template.css);
    assert.equal(back.settings.houseStyle, false);
    assert.equal(back.settings.contract.parameters[0].key, 'customer');
});

test('import refuses what is not a Bee Flow template', () => {
    const file = templateFileOf(template);
    const refused = (raw, errorClass) => assert.throws(() => parseTemplateFile(raw), (e) => e.status === 422 && e.errorClass === errorClass);
    refused({ hello: 'world' }, 'template_file_format');
    refused({ ...file, version: 2 }, 'template_file_version');
    refused({ ...file, template: { ...file.template, docType: 'spreadsheet' } }, 'template_file_kind');
    refused({ ...file, template: { ...file.template, docType: 'page' } }, 'template_file_kind');
    refused({ ...file, template: { ...file.template, name: '  ' } }, 'template_file_invalid');
    refused({ ...file, template: { ...file.template, bodyHtml: 42 } }, 'template_file_invalid');
    refused({ ...file, template: { ...file.template, settings: { contract: { parameters: [{ key: '../x', type: 'text' }] } } } }, 'template_file_contract');
    assert.equal(canExport('notebook'), false);
    assert.equal(canExport('presentation'), true);
});

test('storage keys are found on their own, once each', () => {
    const text = '![logo](users/u1/img/logo.png) and users/u1/img/logo.png again, "users/u2/a.png" not https://x/users/u3/b.png nor users/';
    assert.deepEqual(storageKeysIn(text), ['users/u1/img/logo.png', 'users/u2/a.png']);
});

test('pictures the exporter may read go in as data: URLs; the others are reported, not kept as keys of this server', async () => {
    const deck = { ...template, docType: 'presentation', bodyHtml: '# Deck\n## Slide\n![a](users/u1/a.png)\n![b](users/u9/b.png)', css: '' };
    const resolve = async ({ storageKey }) => (storageKey === 'users/u1/a.png' ? 'data:image/png;base64,AAAA' : null);
    const { file, skippedImages } = await inlineImages(templateFileOf(deck), resolve);
    assert.match(file.template.bodyHtml, /!\[a\]\(data:image\/png;base64,AAAA\)/);
    assert.deepEqual(skippedImages, ['users/u9/b.png']);
});
