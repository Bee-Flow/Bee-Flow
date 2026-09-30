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
