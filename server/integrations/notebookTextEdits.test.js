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

test('insert after: exact text, whitespace-normalised line, and the append fallback', () => {
    assert.deepEqual(insertIntoContent('one two three', { position: 'after', afterText: 'two', insertContent: 'X' }), { newContent: 'one two\n\nX three' });
    assert.deepEqual(insertIntoContent('A\nFirst   para.\nB', { position: 'after', afterText: 'First para.', insertContent: 'X' }),
        { newContent: 'A\nFirst   para.\n\nX\nB' });
    assert.deepEqual(insertIntoContent('a\nb', { position: 'after', afterText: 'zzz', insertContent: 'X' }), { newContent: 'a\nb\n\nX' });
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
