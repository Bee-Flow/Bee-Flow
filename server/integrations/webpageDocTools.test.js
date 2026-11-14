// @typecheck
/**
 * executeWebpageDocTool dispatches by tool name over the in-memory slot
 * triple: an unknown name, an invalid slot, and each tool's answer.
 *
 * Run: cd server && node --test integrations/webpageDocTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeWebpageDocTool } = require('./webpageDocTools');

const files = () => ({ html: '<p>a</p>\n<p>a</p>\n<p>b</p>', css: '', js: 'let x =  1;' });

test('an unknown name, an invalid slot, read marks the slot as read', () => {
    assert.deepEqual(executeWebpageDocTool('webpage_nope', {}, files()), { error: 'Unknown webpage document tool: webpage_nope' });
    for (const tool of ['webpage_file_read', 'webpage_file_write', 'webpage_file_replace', 'webpage_file_patch']) {
        assert.deepEqual(executeWebpageDocTool(tool, { file: 'php', find_text: 'x' }, files()), { error: 'Invalid file "php" — must be one of: html, css, js.' }, tool);
    }
    const readSlots = new Set();
    assert.deepEqual(executeWebpageDocTool('webpage_file_read', { file: 'css' }, files(), { readSlots }), { content: '', message: 'style.css is currently empty.' });
    assert.deepEqual([...readSlots], ['css']);
});

test('write warns about a non-empty file; replace: once, ambiguous, all, whitespace; patch checks expected_text', () => {
    const write = executeWebpageDocTool('webpage_file_write', { file: 'js', content: 'y' }, files());
    assert.match(String(write.message), /^script\.js updated: "script\.js"\. Note: the file already had content/);
    assert.match(String(executeWebpageDocTool('webpage_file_replace', { file: 'html', find_text: '<p>a</p>' }, files()).error), /matches 2 places in index\.html \(lines 1, 2\)/);
    const all = executeWebpageDocTool('webpage_file_replace', { file: 'html', find_text: '<p>a</p>', replace_text: '<i/>', replace_all: true }, files(), { readSlots: new Set(['html']) });
    assert.deepEqual(all, { _action: 'webpage_doc_update', file: 'html', content: '<i/>\n<i/>\n<p>b</p>', message: 'index.html updated (2 replacements, lines 1, 2).' });
    const once = executeWebpageDocTool('webpage_file_replace', { file: 'html', find_text: '<p>b</p>' }, files(), { readSlots: new Set() });
    assert.match(String(once.message), /^index\.html text removed at line 3\. Note: you didn't call webpage_file_read/);
    const loose = executeWebpageDocTool('webpage_file_replace', { file: 'js', find_text: 'x = 1', replace_text: 'x = 2' }, files());
    assert.equal(loose.content, 'let x = 2;');
    assert.equal(executeWebpageDocTool('webpage_file_replace', { file: 'css', find_text: 'a' }, files()).error, 'style.css is empty. Use webpage_file_write to create content first.');
    assert.match(String(executeWebpageDocTool('webpage_file_patch', { file: 'html', start_line: 3, end_line: 3, expected_text: 'zzz', replacement: '' }, files()).error), /^expected_text does not match actual content of lines 3-3/);
    const patched = executeWebpageDocTool('webpage_file_patch', { file: 'html', start_line: 3, end_line: 3, expected_text: '<p>b</p>', replacement: '' }, files());
    assert.deepEqual([patched.content, patched.message], ['<p>a</p>\n<p>a</p>', 'index.html patched: replaced lines 3-3 (1 → 0 lines).']);
});
