'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSection, insertSection } = require('./documentSections');
const { prepareDocument, getContract } = require('./documentContract');

const source = { id: 'library', versionId: 'v1', name: 'Security', kind: 'section',
    bodyHtml: '<section data-doc-section="remote"><h2>Remote access</h2><section data-doc-section="vpn">{{controls}}</section></section>',
    css: '[data-doc-section="remote"] { color: red; }', settings: { contract: {
        parameters: [{ key: 'remote', type: 'boolean' }, { key: 'vpn', type: 'boolean' }, { key: 'controls', type: 'text', required: true }],
        sections: [{ id: 'remote', condition: { parameter: 'remote', operator: 'equals', value: true } },
            { id: 'vpn', condition: { parameter: 'vpn', operator: 'equals', value: true } }],
    } } };
const blank = { bodyHtml: '<h1>Customer</h1>', css: '', settings: {} };

test('saving reusable content retains nested and root conditions and their inputs', () => {
    const saved = extractSection(source, 'remote');
    assert.equal(saved.settings.contract.sections.length, 2);
    assert.deepEqual(saved.settings.contract.parameters.map(p => p.key), ['remote', 'vpn', 'controls']);
    assert.equal(prepareDocument(saved, { remote: false }).valid, true);
    assert.doesNotMatch(prepareDocument(saved, { remote: false }).bodyHtml, /Remote access/);
    assert.equal(prepareDocument(saved, { remote: true, vpn: true }).valid, false);
});

test('two insertions have distinct IDs and preserve conditional rendering', () => {
    const once = { ...blank, ...insertSection(blank, source, 'copy-one') };
    const twice = { ...once, ...insertSection(once, source, 'copy-two') };
    const contract = getContract(twice);
    assert.equal(new Set(contract.sections.map(s => s.id)).size, 6);
    assert.match(twice.css, /data-doc-section="copy-one-/);
    assert.equal(prepareDocument(twice, { remote: false }).valid, true);
    assert.doesNotMatch(prepareDocument(twice, { remote: false }).bodyHtml, /Remote access/);
    assert.equal(prepareDocument(twice, { remote: true, vpn: true, controls: 'MFA' }).valid, true);
    const {inspectBindings} = require('./documentDiscovery');
    assert.equal(inspectBindings({documentId:'nested',values:{remote:false}},{_documentContracts:{nested:contract}},'builder'),null);
});

test('reviewing source updates keeps IDs stable, replaces CSS and leaves original untouched', () => {
    const original = { ...blank, ...insertSection(blank, source, 'copy') };
    const updated = { ...original, ...insertSection(original, { ...source, versionId: 'v2', css: 'h2 { color: blue; }' }, 'copy', { replace: true }) };
    assert.deepEqual(getContract(original).sections.map(s => s.id), getContract(updated).sections.map(s => s.id));
    assert.match(original.css, /red/); assert.doesNotMatch(updated.css, /red/);
    assert.equal(getContract(original).sections[0].source.versionId, 'v1');
    assert.equal(getContract(updated).sections[0].source.versionId, 'v2');
});

test('removed source fields and rules no longer demand obsolete required inputs', () => {
    const original = { ...blank, ...insertSection(blank, source, 'copy') };
    const nextSource = { ...source, bodyHtml: '<p>Reviewed</p>', settings: { contract: { parameters: [], sections: [] } } };
    const updated = { ...original, ...insertSection(original, nextSource, 'copy', { replace: true }) };
    assert.equal(getContract(updated).parameters.length, 0);
    assert.equal(prepareDocument(updated, {}).valid, true);
});
