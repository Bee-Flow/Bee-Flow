/**
 * A data_extraction `source` that is a bare string, read the way the
 * validator says it is read (validate/refPaths: hasPlaceholder,
 * isBareRefString).
 *
 * The runner decided "is this a template" with `/\{\{[^}]+\}\}/`, so a
 * placeholder whose quoted key holds a `}` (`{{ steps.read.output["a}b"] }}`)
 * was not one: the step extracted from the literal words of the placeholder,
 * while the validator — which reads templates quote-aware — called it a
 * template.
 *
 * Run: cd server && node --test core/automationRunner/execDataExtraction.source.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSourceText } = require('./execDataExtraction');

const RUN = { steps: { read: { output: { 'a}b': 'Invoice 42', text: 'Body text', files: [{ content: 'File text' }] } } } };

test('a placeholder with a brace inside a quoted key is a template', () => {
    assert.strictEqual(resolveSourceText('{{ steps.read.output["a}b"] }}', RUN), 'Invoice 42');
    assert.strictEqual(resolveSourceText('Text: {{steps.read.output.text}}', RUN), 'Text: Body text');
});

test('a bare reference path is walked, with brackets in its tail', () => {
    assert.strictEqual(resolveSourceText('steps.read.output.files[0].content', RUN), 'File text');
    assert.strictEqual(resolveSourceText('  steps.read.output.text ', RUN), 'Body text');
});

test('anything else is literal text, as before', () => {
    assert.strictEqual(resolveSourceText('Please read steps carefully', RUN), 'Please read steps carefully');
    assert.strictEqual(resolveSourceText('secrets.apiKey', RUN), 'secrets.apiKey');
});
