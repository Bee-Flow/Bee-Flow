'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { countMediaRefs, mediaWarningFor, MEDIA_WARNING } = require('./localeMedia');

test('countMediaRefs counts non-empty media addresses at any depth', () => {
    const tree = { blocks: { b1: { content: { src: 'cms/a.png', items: [{ poster: 'cms/p.png' }, { src: '  ' }], title: 'src' } } } };
    assert.strictEqual(countMediaRefs(tree), 2);
    assert.strictEqual(countMediaRefs(null), 0);
});

test('mediaWarningFor warns only when the saved override holds fewer addresses', () => {
    const sent = { content: { src: 'javascript:x', poster: 'cms/p.png' } };
    assert.strictEqual(mediaWarningFor(sent, { content: { poster: 'cms/p.png' } }), MEDIA_WARNING);
    assert.strictEqual(mediaWarningFor(sent, sent), undefined);
    assert.strictEqual(mediaWarningFor(sent, undefined), undefined);
});
