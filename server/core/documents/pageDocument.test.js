// @typecheck strict
'use strict';

/**
 * A page on paper (pageDocument.js): it prints through the same composer as
 * every document, with the page sheet in the stylesheet slot, under the
 * house style, and with its body sanitised on the way.
 *
 * Run: cd server && node --test core/documents/pageDocument.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { forCompose, isPage, PAGE_CSS } = require('./pageDocument');
const { composeDocument } = require('../../services/documentCompose');

test('a page is composed with the page sheet; any other document as it is', () => {
    const page = { docType: 'page', bodyHtml: '<h1>Minutes</h1>', css: 'body{color:red}' };
    assert.strictEqual(isPage(page), true);
    assert.strictEqual(forCompose(page).css, PAGE_CSS, 'a page never prints a stylesheet of its own');
    const letter = { docType: 'letter', bodyHtml: '<p>x</p>', css: '.a{}' };
    assert.strictEqual(forCompose(letter), letter);
});

test('the printed page carries the sheet, the house style layer and a sanitised body', () => {
    const html = composeDocument(forCompose({
        docType: 'page', name: 'Minutes',
        bodyHtml: '<h1>Minutes</h1><ul data-type="taskList"><li data-type="taskItem" data-checked="true">Done</li></ul><img src="https://tracker.example/p.gif"><script>x()</script>',
    }), { mode: 'print', houseStyleCss: ':root{--doc-accent:#123456}' });
    assert.match(html, /ul\[data-type="taskList"\]/);
    assert.match(html, /--doc-accent:#123456/);
    assert.match(html, /data-checked="true"/);
    assert.doesNotMatch(html, /tracker\.example|<script>x/);
    assert.doesNotMatch(html, /__beeflowDoc/, 'print mode carries no editing bridge');
});

test('a task prints its box and text on one line, a done one struck through', () => {
    assert.match(PAGE_CSS, /li\[data-type="taskItem"\] \{ display: flex;/);
    assert.match(PAGE_CSS, /li\[data-type="taskItem"\]\[data-checked="true"\] > div \{ text-decoration: line-through;/);
    assert.match(PAGE_CSS, /li\[data-type="taskItem"\] > label \{ display: none; \}/, 'the editor\'s checkbox label is not a second box');
});

test('a diagram prints as its source text under a caption, escaped', () => {
    const code = 'graph TD; A-->B["<b>é</b>"]';
    const b64 = Buffer.from(code, 'utf8').toString('base64');
    const out = forCompose({ docType: 'page', bodyHtml: `<p>x</p><div data-type="mermaid-diagram" data-code="${b64}"></div>` });
    assert.match(out.bodyHtml, /<figure class="doc-diagram"><figcaption>Diagram<\/figcaption><pre>graph TD; A--&gt;B\["&lt;b&gt;é&lt;\/b&gt;"\]<\/pre><\/figure>/);
    const html = composeDocument(out, { mode: 'print' });
    assert.match(html, /figure class="doc-diagram"/, 'the sanitiser keeps it');
});
