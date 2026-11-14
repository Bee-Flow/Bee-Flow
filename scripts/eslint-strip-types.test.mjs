/**
 * scripts/eslint/stripTypes.cjs: the processor that lets ESLint read a
 * type-stripped TypeScript source with the package's JavaScript rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripTypes, strip } = require('./eslint/stripTypes.cjs');

const SOURCE = [
    "import type { Request } from 'express';",
    "import { helper } from './helper.mts';",
    '',
    'interface Options { limit: number; label?: string }',
    '',
    'export function run(req: Request, options: Options = { limit: 1 }): string {',
    '    const total: number = helper(req.params.id as string) + options.limit;',
    '    return String(total satisfies number);',
    '}',
].join('\n');

test('types are replaced by spaces: every line keeps its number and its code its column', () => {
    const out = strip(SOURCE);
    const before = SOURCE.split('\n');
    const after = out.split('\n');
    assert.equal(after.length, before.length);
    assert.equal(out.length, SOURCE.length);
    assert.equal(after[0].trim(), '', 'a type-only import is gone');
    assert.equal(after[1], before[1], 'a value import is untouched');
    assert.equal(after[3].trim(), '', 'an interface is gone');
    assert.equal(after[5].indexOf('run('), before[5].indexOf('run('));
    assert.equal(after[6].indexOf('helper('), before[6].indexOf('helper('));
    assert.doesNotMatch(out, /Request|Options|: number|as string|satisfies/);
});

test('preprocess hands ESLint one .mjs block and postprocess passes its messages through', () => {
    const blocks = stripTypes.preprocess(SOURCE, '/x/file.mts');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].filename, '0.mjs');
    assert.equal(blocks[0].text, strip(SOURCE));
    const message = { ruleId: 'no-undef', line: 7, column: 27, message: "'helper' is not defined." };
    assert.deepEqual(stripTypes.postprocess([[message]], '/x/file.mts'), [message]);
});

test('a source that cannot be stripped is one fatal message at line 1, not a crash', () => {
    const blocks = stripTypes.preprocess('enum Colour { Red, Green }\n', '/x/enum.mts');
    assert.deepEqual(blocks, [{ text: '', filename: '0.mjs' }]);
    const messages = stripTypes.postprocess([[]], '/x/enum.mts');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].fatal, true);
    assert.equal(messages[0].line, 1);
    assert.match(messages[0].message, /^The types could not be stripped: /);
    // The failure is spent: the same name lints clean once the file is fixed.
    stripTypes.preprocess('export const a = 1;\n', '/x/enum.mts');
    assert.deepEqual(stripTypes.postprocess([[]], '/x/enum.mts'), []);
});

test('the processor does not autofix: a fix computed on stripped text must not be written back', () => {
    assert.equal(stripTypes.supportsAutofix, false);
});
