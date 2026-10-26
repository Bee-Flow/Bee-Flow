// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stripHtmlToText } = require('./emailTextUtils');

const SIZE = 200 * 1024;
const timed = (/** @type {string} */ input) => {
    const t = Date.now();
    stripHtmlToText(input);
    return Date.now() - t;
};

test('hostile shapes at 200 KB stay linear', () => {
    const shapes = {
        lessThanOnly: '<'.repeat(SIZE),
        lessThanLetter: '<x'.repeat(SIZE / 2),
        spaceRun: `<p>${' '.repeat(SIZE)}`,
        unclosedHead: '<head'.repeat(SIZE / 5),
        unclosedScript: '<script>'.repeat(SIZE / 8),
        unclosedBold: '<b>'.repeat(SIZE / 3),
        unclosedLink: '<a>'.repeat(SIZE / 3),
        textLessThan: 'a<b'.repeat(SIZE / 3),
        closeNoGt: '<script>'.repeat(10) + '</script '.repeat(SIZE / 9),
    };
    for (const [name, input] of Object.entries(shapes)) {
        const ms = timed(input);
        assert.ok(ms < 500, `${name} took ${ms} ms`);
    }
});

test('script, style and comment content never leaks', () => {
    assert.strictEqual(stripHtmlToText('a<script>evil()</script >b'), 'ab');
    assert.strictEqual(stripHtmlToText('a<SCRIPT>evil() and never closed'), 'a');
    assert.strictEqual(stripHtmlToText('a<style>x{}</style\n>b'), 'ab');
    assert.strictEqual(stripHtmlToText('a<!-- x > y -->b'), 'ab');
    assert.strictEqual(stripHtmlToText('<title>t</title><noscript>n</noscript>b'), 'b');
});

test('numeric and common named entities are decoded, bad ones left alone', () => {
    assert.strictEqual(stripHtmlToText('caf&eacute; &#233; &#xE9; &euro;5 &amp;lt;'), 'café é é €5 &lt;');
    assert.strictEqual(stripHtmlToText('&#0; &#99999999; &#xD800; &bogus;'), '&#0; &#99999999; &#xD800; &bogus;');
});

test('ordinary markup still reads as text', () => {
    assert.strictEqual(stripHtmlToText('<p>Hi <b>you</b> <a href="x">link</a></p><ul><li>one</li></ul>'), 'Hi **you** link\n\n- one');
});
