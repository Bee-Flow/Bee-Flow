/**
 * A TEMPLATE with required fields can be downloaded from the editor: a value
 * nobody gave prints as its label in brackets ("[Customer name]") instead of
 * the PDF or .pptx being refused. A document, and any caller that does not ask
 * for placeholders (an automation, an app), keeps refusing.
 *
 * DB-free: the composer and the deck renderer are swapped through the feature
 * registry and the PDF renderer through renderFilledDocument's test seam; they
 * only show what they were handed.
 *
 * Run: cd server && node --test core/documents/templatePlaceholders.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerFeatureModules, _featureModuleGetter } = require('../featureModules');
const { renderFilledDocument, _setDepsForTests } = require('./renderFilledDocument');

const composed = [];
const decks = [];
const FEATURES = ['services/documentCompose', 'services/presentationRenderer'];
const realFeatures = FEATURES.map((name) => [name, _featureModuleGetter(name)]);
registerFeatureModules({
    'services/documentCompose': () => ({
        composeDocument: (doc) => { composed.push(doc.bodyHtml); return `<html>${doc.bodyHtml}</html>`; },
    }),
    'services/presentationRenderer': () => ({
        renderPresentation: async ({ deck }) => { decks.push(deck); return { buffer: Buffer.from('PK'), contentType: 'application/pptx', format: 'pptx' }; },
    }),
});
_setDepsForTests({
    renderStyledHtmlToPdf: async () => ({ buffer: Buffer.from('%PDF'), contentType: 'application/pdf', degraded: false, marking: null }),
});

test.after(() => {
    _setDepsForTests(null);
    registerFeatureModules(Object.fromEntries(realFeatures.filter(([, get]) => get)));
});

const { templatePreviewValues, prepareTemplateForDownload } = require('./templatePlaceholders.mts');

test.beforeEach(() => { composed.length = 0; decks.length = 0; });

const contract = {
    parameters: [
        { key: 'customer', label: 'Customer name', type: 'text', required: true },
        { key: 'amount', label: 'Amount', type: 'number', required: true },
        { key: 'lines', label: 'Lines', type: 'list', required: true, fields: [{ key: 'item', label: 'Item', type: 'text' }, { key: 'qty', label: 'Quantity', type: 'number' }] },
    ],
};
const offer = (kind) => ({
    id: 'd1', name: 'Offer', kind, docType: 'designed', organizationId: null,
    bodyHtml: '<p>Dear {{customer}}, the total is {{amount}}.</p><ul>{{#each lines}}<li>{{item}} x {{qty}}</li>{{/each}}</ul>',
    settings: { houseStyle: false, contract },
});

test('a template downloads with every missing value shown as its label in brackets', async () => {
    const out = await renderFilledDocument({ document: offer('template'), values: {}, placeholders: true });
    assert.equal(out.contentType, 'application/pdf');
    assert.equal(composed.length, 1);
    assert.match(composed[0], /Dear \[Customer name\], the total is \[Amount\]\./);
    assert.match(composed[0], /<li>\[Item\] x \[Quantity\]<\/li>/);
    assert.equal(out.fill.valid, true);
});

test('a value that was given is printed as given', async () => {
    await renderFilledDocument({ document: offer('template'), values: { customer: 'Acme', amount: 12 }, placeholders: true });
    assert.match(composed[0], /Dear Acme, the total is 12\./);
});

test('without placeholders (a document, an automation, an app) a missing required value still refuses', async () => {
    await assert.rejects(renderFilledDocument({ document: offer('template'), values: {} }), (e) => e.errorClass === 'document_validation_failed' && e.status === 422);
    await assert.rejects(renderFilledDocument({ document: offer('document'), values: {} }), (e) => e.errorClass === 'document_validation_failed');
    assert.equal(composed.length, 0);
});

test('a malformed template still refuses, placeholders or not', () => {
    const broken = { ...offer('template'), bodyHtml: '<p>{{#each lines}}<li>{{item}}</li></p>' };
    assert.equal(prepareTemplateForDownload(broken, {}).valid, false);
});

test('a yes/no value and a value only a section rule reads are not decided by a label', () => {
    const doc = {
        bodyHtml: '<p>{{#if vip}}VIP{{/if}} {{name}}</p>',
        settings: { contract: { parameters: [{ key: 'vip', type: 'boolean', required: true }, { key: 'name', label: 'Name', type: 'text' }] } },
    };
    const { values, filled } = templatePreviewValues(doc, {});
    assert.deepEqual(filled, ['name']);
    assert.equal(values.vip, undefined);
    const fill = prepareTemplateForDownload(doc, {});
    assert.equal(fill.valid, true, JSON.stringify(fill.issues));
    assert.match(fill.bodyHtml, /\[Name\]/);
    assert.doesNotMatch(fill.bodyHtml, /VIP/);
});

test('the caller\'s values are never written to', () => {
    const given = { lines: [] };
    templatePreviewValues(offer('template'), given);
    assert.deepEqual(given, { lines: [] });
});

test('a presentation template downloads as .pptx with its gaps shown; a presentation document still refuses', async () => {
    const deck = (kind) => ({
        id: 'p1', name: 'Pitch', kind, docType: 'presentation', organizationId: null,
        bodyHtml: '# Pitch for {{customer}}\n\n## Why us\n\n- For {{customer}}',
        settings: { houseStyle: false, contract: { parameters: [{ key: 'customer', label: 'Customer name', type: 'text', required: true }] } },
    });
    const out = await renderFilledDocument({ document: deck('template'), values: {}, format: 'pptx', placeholders: true });
    assert.equal(out.extension, 'pptx');
    assert.match(JSON.stringify(decks[0]), /\[Customer name\]/);
    await assert.rejects(renderFilledDocument({ document: deck('document'), values: {}, format: 'pptx' }), (e) => e.errorClass === 'document_validation_failed');
});

test('a value a section rule reads is not given a label, so the rule is not decided by it', () => {
    const doc = {
        bodyHtml: '<p>{{kind}} {{name}}</p><div data-doc-section="extra">Extra</div>',
        settings: { contract: {
            parameters: [{ key: 'kind', label: 'Kind', type: 'choice', options: ['A', 'B'], required: true }, { key: 'name', label: 'Name', type: 'text' }],
            sections: [{ id: 'extra', condition: { any: [{ all: [{ parameter: 'kind', operator: 'equals', value: 'A' }] }] } }],
        } },
    };
    const { values, filled } = templatePreviewValues(doc, {});
    assert.deepEqual(filled, ['name']);
    assert.equal(values.kind, undefined);
});

test('a flat stored dotted value and a dotted label end up in one object', () => {
    const doc = {
        bodyHtml: '<p>{{client.name}} {{client.city}}</p>',
        settings: { contract: { parameters: [{ key: 'client.name', label: 'Name', type: 'text' }, { key: 'client.city', label: 'City', type: 'text' }] } },
    };
    const { values, filled } = templatePreviewValues(doc, { 'client.name': 'Acme' });
    assert.deepEqual(filled, ['client.city']);
    assert.match(prepareTemplateForDownload(doc, { 'client.name': 'Acme' }).bodyHtml, /<p>Acme \[City\]<\/p>/);
    assert.equal(values.client.name, 'Acme');
});
