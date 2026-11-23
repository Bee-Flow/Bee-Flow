'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { designCss } = require('./documentDesign');
const { composeDocument } = require('../../services/documentCompose');

test('a document on the implicit neutral preset follows the house style', () => {
    for (const design of [{ preset: 'neutral' }, {}, { preset: 'neutral', accent: '#334155', ink: '#172033', font: 'sans', fontSize: 11 }]) {
        const css = designCss(design);
        assert.doesNotMatch(css, /--doc-(accent|ink|font):/, JSON.stringify(design));
        assert.doesNotMatch(css, /\.doc-logo \{ width/, 'the house logo width stands');
        assert.match(css, /h1,h2,h3 \{ color:var\(--doc-accent\); \}/);
    }
});

test('a chosen preset or value overrides the house style', () => {
    assert.match(designCss({ preset: 'formal' }), /--doc-accent:#1e3a5f; --doc-ink:#172033; --doc-font:Georgia, serif;/);
    const own = designCss({ preset: 'neutral', accent: '#abc', font: 'mono', logoWidth: 30 });
    assert.match(own, /:root \{ --doc-accent:#abc; --doc-font:monospace; \}/);
    assert.match(own, /\.doc-logo \{ width:30mm;/);
    assert.doesNotMatch(designCss({ accent: 'red;}body{x' }), /--doc-accent:/);
});

test('composed: the house accent reaches a neutral document, a chosen accent beats it', () => {
    const house = ':root { --doc-accent: #ff0000; }';
    const neutral = composeDocument({ bodyHtml: '<h1>x</h1>', settings: { design: { preset: 'neutral' } } }, { houseStyleCss: house });
    assert.ok(!/--doc-accent:#/.test(neutral.slice(neutral.indexOf('#ff0000'))), 'nothing redeclares the accent after the house style');
    const chosen = composeDocument({ bodyHtml: '<h1>x</h1>', settings: { design: { accent: '#00ff00' } } }, { houseStyleCss: house });
    assert.ok(chosen.indexOf('--doc-accent:#00ff00') > chosen.indexOf('#ff0000'));
});
