/**
 * The code assistant's edit tools (codeAssistTools.js): what each tool does to
 * the code, what the client's `edit` event says, and the two small-model
 * mistakes the tools forgive (line numbers copied from code_read, a Markdown
 * fence around a whole write).
 *
 * Run: cd server && node --test routes/ai/automationBuilder/codeAssistTools.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    CODE_TOOLS, CODE_TOOL_NAMES, MAX_CODE_CHARS, executeCodeTool,
    numberLines, stripLineNumbers, stripFence, changedLineRange,
} = require('./codeAssistTools');

const CODE = [
    '/**',
    ' * Adds VAT.',
    ' * @param {number} inputs.amount - The amount',
    ' */',
    'async function main(inputs, ctx) {',
    '  const rate = 21;',
    '  return { total: inputs.amount * (1 + rate / 100) };',
    '}',
].join('\n');

test('the tool set is the four edit tools, each with a summary on the ones that change code', () => {
    assert.deepStrictEqual([...CODE_TOOL_NAMES], ['code_read', 'code_replace', 'code_patch', 'code_write']);
    for (const t of CODE_TOOLS) {
        if (t.function.name === 'code_read') continue;
        assert.ok(t.function.parameters.properties.summary, `${t.function.name} asks for a summary`);
        assert.ok(t.function.parameters.required.includes('summary'));
    }
});

test('code_read numbers the lines and can read a range; it never changes the code', () => {
    const all = executeCodeTool('code_read', {}, CODE);
    assert.strictEqual(all.code, CODE);
    assert.strictEqual(all.edit, null);
    assert.match(all.result.content, /^1 \| \/\*\*/);
    assert.match(all.result.content, /\n8 \| \}$/);
    const part = executeCodeTool('code_read', { start_line: 6, end_line: 7 }, CODE);
    assert.strictEqual(part.result.lines, '6-7 of 8');
    assert.strictEqual(part.result.content, '6 |   const rate = 21;\n7 |   return { total: inputs.amount * (1 + rate / 100) };');
    const empty = executeCodeTool('code_read', {}, '');
    assert.match(empty.result.message, /empty/);
});

test('code_replace changes one exact piece and reports where it landed', () => {
    const r = executeCodeTool('code_replace', { find_text: 'const rate = 21;', replace_text: 'const rate = inputs.vatRate;', summary: 'Rate from the input' }, CODE);
    assert.ok(r.code.includes('const rate = inputs.vatRate;'));
    assert.deepStrictEqual(r.edit, { op: 'replace', summary: 'Rate from the input', startLine: 6, endLine: 6 });
    assert.strictEqual(r.result.ok, true);
    assert.match(r.result.around, /6 \|   const rate = inputs\.vatRate;/, 'the model sees what landed');
});

test('code_replace with an empty replacement is a delete', () => {
    const r = executeCodeTool('code_replace', { find_text: '  const rate = 21;\n', replace_text: '', summary: 'Removed the fixed rate' }, CODE);
    assert.ok(!r.code.includes('const rate'));
    assert.strictEqual(r.edit.op, 'delete');
    assert.strictEqual(r.edit.startLine, 6);
    assert.strictEqual(r.edit.endLine, 6);
});

test('code_replace refuses an ambiguous match unless replace_all, and a missing one', () => {
    const code = 'a();\nb();\na();';
    const amb = executeCodeTool('code_replace', { find_text: 'a();', replace_text: 'c();', summary: 's' }, code);
    assert.match(amb.result.error, /matches 2 places/);
    assert.strictEqual(amb.code, code, 'nothing changed');
    assert.strictEqual(amb.edit, null);
    const all = executeCodeTool('code_replace', { find_text: 'a();', replace_text: 'c();', replace_all: true, summary: 's' }, code);
    assert.strictEqual(all.code, 'c();\nb();\nc();');
    assert.deepStrictEqual([all.edit.startLine, all.edit.endLine], [1, 3]);
    const miss = executeCodeTool('code_replace', { find_text: 'nope()', replace_text: 'x', summary: 's' }, code);
    assert.match(miss.result.error, /Could not find/);
});

test('a find_text copied with its line numbers still lands', () => {
    const copied = '6 |   const rate = 21;\n7 |   return { total: inputs.amount * (1 + rate / 100) };';
    const r = executeCodeTool('code_replace', {
        find_text: copied,
        replace_text: '6 |   const rate = 9;\n7 |   return { total: inputs.amount * (1 + rate / 100) };',
        summary: 'Lower rate',
    }, CODE);
    assert.ok(!r.result.error, r.result.error);
    assert.ok(r.code.includes('  const rate = 9;\n  return'), 'the numbers never reach the code');
    assert.ok(!/\d \| /.test(r.code));
});

test('code_patch replaces a line range guarded by expected_text', () => {
    const r = executeCodeTool('code_patch', {
        start_line: 6, end_line: 7,
        expected_text: '  const rate = 21;\n  return { total: inputs.amount * (1 + rate / 100) };',
        replacement: '  return { total: inputs.amount * 1.21 };',
        summary: 'Simpler sum',
    }, CODE);
    assert.strictEqual(r.edit.op, 'patch');
    assert.deepStrictEqual([r.edit.startLine, r.edit.endLine], [6, 6]);
    assert.strictEqual(r.code.split('\n').length, 7);
});

test('code_patch refuses a stale expected_text and shows the real lines', () => {
    const r = executeCodeTool('code_patch', { start_line: 6, end_line: 6, expected_text: 'const rate = 99;', replacement: 'x', summary: 's' }, CODE);
    assert.match(r.result.error, /does not match lines 6-6/);
    assert.match(r.result.error, /6 \|   const rate = 21;/);
    assert.strictEqual(r.code, CODE);
    const past = executeCodeTool('code_patch', { start_line: 7, end_line: 20, expected_text: '', replacement: '', summary: 's' }, CODE);
    assert.match(past.result.error, /past the end/);
    const bad = executeCodeTool('code_patch', { start_line: 3, end_line: 2, expected_text: '', replacement: '', summary: 's' }, CODE);
    assert.match(bad.result.error, /start_line <= end_line/);
});

test('code_patch with an empty replacement deletes the lines', () => {
    const r = executeCodeTool('code_patch', { start_line: 6, end_line: 6, expected_text: '  const rate = 21;', replacement: '', summary: 'Removed the rate' }, CODE);
    assert.strictEqual(r.edit.op, 'delete');
    assert.strictEqual(r.code.split('\n').length, 7);
});

test('code_write replaces everything, minus a Markdown fence and line numbers', () => {
    const r = executeCodeTool('code_write', { code: '```js\nasync function main() {\n  return 1;\n}\n```', summary: 'Started over' }, CODE);
    assert.strictEqual(r.code, 'async function main() {\n  return 1;\n}');
    assert.deepStrictEqual(r.edit, { op: 'write', summary: 'Started over', startLine: 1, endLine: 3 });
    const numbered = executeCodeTool('code_write', { code: '1 | const a = 1;\n2 | return a;', summary: 's' }, '');
    assert.strictEqual(numbered.code, 'const a = 1;\nreturn a;');
});

test('an edit without a summary gets an English fallback with an i18n key', () => {
    const w = executeCodeTool('code_write', { code: 'return 1;' }, '');
    assert.deepStrictEqual(
        { summary: w.edit.summary, summaryKey: w.edit.summaryKey },
        { summary: 'Rewrote the code', summaryKey: 'code_step.assist.edit.write' },
    );
    const one = executeCodeTool('code_replace', { find_text: 'const rate = 21;', replace_text: 'const rate = 9;' }, CODE);
    assert.strictEqual(one.edit.summaryKey, 'code_step.assist.edit.changed_line');
    assert.deepStrictEqual(one.edit.summaryParams, { line: 6 });
    const many = executeCodeTool('code_patch', { start_line: 5, end_line: 6, expected_text: 'async function main(inputs, ctx) {\n  const rate = 21;', replacement: 'async function main(inputs) {\n  const rate = 9;' }, CODE);
    assert.strictEqual(many.edit.summaryKey, 'code_step.assist.edit.changed_lines');
    assert.deepStrictEqual(many.edit.summaryParams, { start: 5, end: 6 });
    const del = executeCodeTool('code_replace', { find_text: '  const rate = 21;\n', replace_text: '' }, CODE);
    assert.strictEqual(del.edit.summaryKey, 'code_step.assist.edit.removed');
});

test('an edit that changes nothing sends no edit event', () => {
    const r = executeCodeTool('code_replace', { find_text: 'const rate = 21;', replace_text: 'const rate = 21;', summary: 's' }, CODE);
    assert.strictEqual(r.edit, null);
    assert.match(r.result.message, /Nothing changed/);
});

test('no edit may grow the code past the step limit', () => {
    const r = executeCodeTool('code_write', { code: 'x'.repeat(MAX_CODE_CHARS + 1), summary: 's' }, CODE);
    assert.match(r.result.error, /at most/);
    assert.strictEqual(r.code, CODE);
    assert.strictEqual(r.edit, null);
});

test('an unknown tool and missing arguments are refusals, never throws', () => {
    assert.match(executeCodeTool('code_delete', {}, CODE).result.error, /Unknown tool/);
    assert.match(executeCodeTool('code_replace', {}, CODE).result.error, /find_text is required/);
    assert.match(executeCodeTool('code_write', {}, CODE).result.error, /code is required/);
    assert.strictEqual(executeCodeTool('code_read', null, CODE).code, CODE);
});

test('the helpers: numbering, stripping and the changed range', () => {
    assert.strictEqual(numberLines('a\nb', { from: 2 }), '2 | b');
    assert.strictEqual(numberLines(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), { from: 9 }), ' 9 | l8\n10 | l9');
    assert.strictEqual(stripLineNumbers('1 | a\n\n2 | b'), 'a\n\nb');
    assert.strictEqual(stripLineNumbers('1 | a\nb'), '1 | a\nb', 'one numbered-looking line among others is code');
    assert.strictEqual(stripFence('```\nx\n```'), 'x');
    assert.strictEqual(stripFence('x = "```"'), 'x = "```"');
    assert.strictEqual(changedLineRange('a\nb', 'a\nb'), null);
    assert.deepStrictEqual(changedLineRange('a\nb\nc', 'a\nB\nc'), { startLine: 2, endLine: 2 });
    assert.deepStrictEqual(changedLineRange('a\nb\nc', 'a\nc'), { startLine: 2, endLine: 2 });
    assert.deepStrictEqual(changedLineRange('a\nb', 'a'), { startLine: 1, endLine: 1 }, 'a delete at the end points at the last line');
    assert.deepStrictEqual(changedLineRange('a', 'a\nb\nc'), { startLine: 2, endLine: 3 });
});
