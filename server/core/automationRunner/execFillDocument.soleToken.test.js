/**
 * "A value that is exactly one `{{path}}` keeps its real type" — the rule
 * fill_document and the presentation steps share — read with the runner's
 * own quote-aware placeholder scanner.
 *
 * Both used `/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/`, which refuses any brace
 * inside the placeholder: `{{ steps.s1.output["a}b"] }}` fell through to
 * text interpolation, so a LIST bound under such a key arrived as a JSON
 * string and `{{#each}}` (or a deck's slides) rendered nothing; and the
 * Handlebars spelling `{{{ x }}}` did the same.
 *
 * Run: cd server && node --test core/automationRunner/execFillDocument.soleToken.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../../stores/automationStore': {},
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
});
after(() => restore());

const { soleTemplatePath, _test: fill } = require('./execFillDocument');
const { _test: deck } = require('./execPresentation');

const LINES = [{ description: 'Hours', amount: 120 }];
const RUN = { steps: { s1: { output: { 'line}items': LINES, lines: LINES, total: 120, slide: { title: 'A' } } } } };

test('soleTemplatePath: one placeholder and nothing else, quote-aware', () => {
    assert.strictEqual(soleTemplatePath('{{steps.s1.output.lines}}'), 'steps.s1.output.lines');
    assert.strictEqual(soleTemplatePath('  {{ steps.s1.output["line}items"] }}  '), 'steps.s1.output["line}items"]');
    assert.strictEqual(soleTemplatePath('{{{ steps.s1.output.lines }}}'), 'steps.s1.output.lines');
    assert.strictEqual(soleTemplatePath('Total {{steps.s1.output.total}}'), null);
    assert.strictEqual(soleTemplatePath('{{a}}{{b}}'), null);
    assert.strictEqual(soleTemplatePath('no placeholder'), null);
    assert.strictEqual(soleTemplatePath(42), null);
});

test('fill_document: a list under a key with a brace keeps its type', () => {
    assert.deepStrictEqual(fill.resolveBoundValue('{{ steps.s1.output["line}items"] }}', RUN), LINES);
    assert.strictEqual(fill.resolveBoundValue('{{{steps.s1.output.total}}}', RUN), 120);
    assert.strictEqual(fill.resolveBoundValue('Total: {{steps.s1.output.total}}', RUN), 'Total: 120');
});

test('presentation: the same rule for slides', () => {
    assert.deepStrictEqual(deck.resolveBound('{{ steps.s1.output["line}items"] }}', RUN), LINES);
    assert.strictEqual(deck.resolveSlidesInput(['{{ steps.s1.output["slide"] }}'], RUN)[0].title, 'A');
});
