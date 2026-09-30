'use strict';

/**
 * Change counts between two states (core/versioning/stats.js).
 *
 * Pinned: the plain-text estimate counts added and removed words and changed
 * blocks for HTML and Markdown; an unchanged state counts nothing; the editor
 * bundle is used when present and a failing bundle falls back instead of
 * throwing; minor edits are recognised; the fingerprint ignores formatting
 * whitespace but not content.
 *
 * Run: cd server && node --test core/versioning/stats.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    versionStats, estimateStats, isMinorChange, addStats, contentHash, _setBundle,
} = require('./stats');

test.afterEach(() => _setBundle(undefined));

test('estimates added and removed words and changed blocks in Markdown', () => {
    _setBundle(null);
    const before = '# Plan\n\nWe launch in May.\n\nBudget is tight.';
    const after = '# Plan\n\nWe launch in June with partners.\n\nBudget is tight.\n\nNew risks listed.';
    const s = versionStats({ markdown: before }, { markdown: after });
    assert.deepStrictEqual(s, { wordsAdded: 6, wordsRemoved: 1, blocksChanged: 2 });
});

test('estimates for HTML the same way, through its text', () => {
    _setBundle(null);
    const s = versionStats('<h1>Plan</h1><p>We launch in May.</p>', '<h1>Plan</h1><p>We launch in May.</p><p>Two more words.</p>');
    assert.deepStrictEqual(s, { wordsAdded: 3, wordsRemoved: 0, blocksChanged: 1 });
});

test('counts nothing for an unchanged or empty state', () => {
    _setBundle(null);
    assert.deepStrictEqual(versionStats({ markdown: 'Same text.' }, { markdown: 'Same text.' }), { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 });
    assert.deepStrictEqual(versionStats(null, undefined), { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 });
});

test('compares whole-line bags when a document is too large to align', () => {
    const a = { markdown: Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n') };
    const b = { markdown: `${a.markdown}\nextra words here` };
    assert.deepStrictEqual(estimateStats({ html: '', markdown: a.markdown }, { html: '', markdown: b.markdown }), { wordsAdded: 3, wordsRemoved: 0, blocksChanged: 1 });
});

test('uses the editor bundle when there is one, and falls back when it fails', () => {
    const calls = [];
    _setBundle({
        markdownToAst: (md) => ({ md }),
        diffDocs: (a, b) => { calls.push([a.md, b.md]); return { blocks: [], stats: { wordsAdded: 7.2, wordsRemoved: -1, blocksChanged: 2 } }; },
    });
    assert.deepStrictEqual(versionStats({ markdown: 'a' }, { markdown: 'b' }), { wordsAdded: 7, wordsRemoved: 0, blocksChanged: 2 });
    assert.deepStrictEqual(calls, [['a', 'b']]);

    _setBundle({ markdownToAst: () => { throw new Error('parse'); }, diffDocs: () => ({}) });
    assert.deepStrictEqual(versionStats({ markdown: 'one' }, { markdown: 'one two' }), { wordsAdded: 1, wordsRemoved: 0, blocksChanged: 1 });
});

test('knows a minor edit, and adds counts', () => {
    assert.strictEqual(isMinorChange({ wordsAdded: 2, wordsRemoved: 1, blocksChanged: 1 }), true);
    assert.strictEqual(isMinorChange({ wordsAdded: 4, wordsRemoved: 1, blocksChanged: 1 }), false);
    assert.strictEqual(isMinorChange({ wordsAdded: 1, wordsRemoved: 0, blocksChanged: 2 }), false);
    assert.strictEqual(isMinorChange(null), false);
    assert.deepStrictEqual(addStats({ wordsAdded: 1, wordsRemoved: 2, blocksChanged: 1 }, { wordsAdded: 3 }), { wordsAdded: 4, wordsRemoved: 2, blocksChanged: 1 });
    assert.deepStrictEqual(addStats(null, undefined), { wordsAdded: 0, wordsRemoved: 0, blocksChanged: 0 });
});

test('fingerprints content, not formatting whitespace', () => {
    const a = contentHash({ html: '<p>Hi</p>\n  <p>there</p>' });
    const b = contentHash({ html: '<p>Hi</p><p>there</p>' });
    const c = contentHash({ html: '<p>Hi</p><p>there!</p>' });
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(contentHash({ markdown: 'x' }), contentHash({ html: 'x' }));
});

// The generated bundle (npm run build:editor-collab), when this checkout has it.
let hasBundle = false;
try { hasBundle = typeof require('../markdown/editorCollab.cjs').diffDocs === 'function'; } catch { hasBundle = false; }

test('counts through the real editor bundle, for Markdown and for HTML', { skip: !hasBundle && 'no editorCollab.cjs in this checkout' }, () => {
    _setBundle(undefined);
    assert.deepStrictEqual(
        versionStats({ markdown: '# Plan\n\nWe launch in May.\n\nBudget.' }, { markdown: '# Plan\n\nWe launch in June with partners.\n\nBudget.\n\nNew risks.' }),
        { wordsAdded: 5, wordsRemoved: 1, blocksChanged: 2 },
    );
    assert.deepStrictEqual(
        versionStats('<h1>Plan</h1><p>We launch in May.</p>', '<h1>Plan</h1><p>We launch in May.</p><p>Two more words.</p>'),
        { wordsAdded: 3, wordsRemoved: 0, blocksChanged: 1 },
    );
});
