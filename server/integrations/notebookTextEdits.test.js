'use strict';

/**
 * The matching strategies behind notebook_insert / notebook_replace, pinned on
 * their own (the tool tests only reach the common paths).
 *
 * Run: cd server && node --test integrations/notebookTextEdits.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { insertIntoContent, replaceInContent } = require('./notebookTextEdits');

const DOC = '# Title\n\nFirst   para.\n\n## Part\n\n**Bold** line\nsecond line';

test('insert: start, end, an empty document, and an invalid position', () => {
    assert.deepEqual(insertIntoContent('a', { position: 'start', insertContent: 'X' }), { newContent: 'X\n\na' });
    assert.deepEqual(insertIntoContent('a', { position: 'end', insertContent: 'X' }), { newContent: 'a\n\nX' });
    assert.deepEqual(insertIntoContent('  ', { position: 'end', insertContent: 'X' }), { newContent: '  X' });
    assert.deepEqual(insertIntoContent('a', { position: 'middle', insertContent: 'X' }), { error: 'Invalid position: middle. Use "start", "end", or "after".' });
});

test('insert after: exact text, whitespace-normalised line, and not found (no append)', () => {
    assert.deepEqual(insertIntoContent('one two three', { position: 'after', afterText: 'two', insertContent: 'X' }), { newContent: 'one two\n\nX three' });
    assert.deepEqual(insertIntoContent('A\nFirst   para.\nB', { position: 'after', afterText: 'First para.', insertContent: 'X' }),
        { newContent: 'A\nFirst   para.\n\nX\nB' });
    assert.match(insertIntoContent('a\nb', { position: 'after', afterText: 'zzz', insertContent: 'X' }).error, /Could not find the specified text/);
    assert.deepEqual(insertIntoContent('a', { position: 'after', insertContent: 'X' }), { error: 'after_text is required when position is "after".' });
});

test('replace: exact, narrowed to a section, whitespace-normalised, markdown-stripped, and not found', () => {
    assert.equal(replaceInContent('a b c', { findText: 'b', replaceText: 'X' }).newContent, 'a X c');
    assert.equal(replaceInContent('a b c', { findText: 'b', replaceText: '' }).newContent, 'a  c');
    assert.equal(replaceInContent(DOC, { findText: 'line', replaceText: 'LINE', sectionHeading: 'part' }).newContent, DOC.replace('line', 'LINE'));
    assert.equal(replaceInContent('A\nFirst   para.\nB', { findText: 'First para.', replaceText: 'Done.' }).newContent, 'A\nDone.\nB');
    assert.equal(replaceInContent('x\n**Bold** line\ny', { findText: 'Bold line', replaceText: 'R' }).newContent, 'x\nR\ny');
    assert.match(replaceInContent('abc', { findText: 'nope', replaceText: 'X' }).error, /^Could not find the specified text in the notebook\./);
});

test('#544: a find text that is not there fails instead of editing a blank line', () => {
    const doc = '# Title\n\nSome text here.\n\nMore.';
    const r = replaceInContent(doc, { findText: 'nonexistent words', replaceText: 'NEW' });
    assert.equal(r.newContent, undefined);
    assert.match(r.error, /Nothing was changed.*notebook_read/);
    const i = insertIntoContent(doc, { position: 'after', afterText: 'nothing like this', insertContent: 'INS' });
    assert.equal(i.newContent, undefined);
    assert.match(i.error, /after_text/);
});

test('#544: replacement text is literal, not a String.replace pattern', () => {
    assert.equal(replaceInContent('a b', { findText: 'b', replaceText: "x$&y$'z$`w$$" }).newContent, "a x$&y$'z$`w$$");
});

test('#544: a short line inside the find text is no match, a nearly complete one is', () => {
    assert.ok(replaceInContent('Hi\nother', { findText: 'Hi there, long sentence', replaceText: 'X' }).error);
    assert.equal(replaceInContent('Hello wor\nother', { findText: 'Hello world', replaceText: 'X' }).newContent, 'X\nother');
});

test('#544: fuzzy matches still work (extra spaces, CRLF, bold, heading, bullet)', () => {
    assert.equal(replaceInContent('a\n\nfoo   bar\nb', { findText: 'foo bar', replaceText: 'X' }).newContent, 'a\n\nX\nb');
    assert.equal(replaceInContent('a\nl1  x\nl2\nb', { findText: 'l1 x\r\nl2', replaceText: 'X' }).newContent, 'a\nX\nb');
    assert.equal(replaceInContent('a\n## Heading here\nb', { findText: '## **Heading** here', replaceText: 'X' }).newContent, 'a\nX\nb');
    assert.equal(replaceInContent('a\n- item **one**\nb', { findText: 'item one', replaceText: 'X' }).newContent, 'a\nX\nb');
    assert.equal(insertIntoContent('a\n\n- item **one**\nb', { position: 'after', afterText: 'item  **one**', insertContent: 'X' }).newContent, 'a\n\n- item **one**\n\nX\nb');
});
