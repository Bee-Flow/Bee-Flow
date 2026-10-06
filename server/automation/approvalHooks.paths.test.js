/**
 * The on_decided hook's `{{path}}` templates, read with the shared grammar.
 *
 * The hook reads its own scope (the decided approval row: decision, reason,
 * answers.<question>, context.<key>), not a run's steps, and that stays its
 * dialect. What changed is how a path into it is read: `[a-zA-Z0-9_.]+` and a
 * split on dots, so an answer keyed "Cost center" or "po-number" could not be
 * written at all (the placeholder stayed in the record verbatim), and a walk
 * through the prototype chain turned `{{answers.constructor}}` into the source
 * text of a function.
 *
 * Run: cd server && node --test automation/approvalHooks.paths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { _hooksTest } = require('./approvalHooks');

const { resolveTemplate, hookScope } = _hooksTest;
const scope = hookScope({
    status: 'approved', id: 'apr_1', decidedByName: 'Fleur',
    answers: { 'Cost center': 'CC-12', 'po-number': '4471', lines: [{ sku: 'A1' }, { sku: 'B2' }], urgent: true },
    context: { 'invoice.id': 'INV-9' },
});

test('answers with spaces, hyphens or dots in their key are readable in brackets', () => {
    assert.strictEqual(resolveTemplate('{{answers["Cost center"]}}', scope), 'CC-12');
    assert.strictEqual(resolveTemplate('PO {{ answers["po-number"] }}', scope), 'PO 4471');
    assert.strictEqual(resolveTemplate('{{answers.po-number}}', scope), '4471');
    assert.strictEqual(resolveTemplate('{{context["invoice.id"]}}', scope), 'INV-9');
});

test('an exact placeholder keeps the raw type, also with an index', () => {
    assert.strictEqual(resolveTemplate('{{ answers["urgent"] }}', scope), true);
    assert.strictEqual(resolveTemplate('{{answers.lines[1].sku}}', scope), 'B2');
    assert.strictEqual(resolveTemplate('{{answers.lines[-1].sku}}', scope), 'B2');
});

test('only the row\'s own fields: never the prototype chain', () => {
    assert.strictEqual(resolveTemplate('{{answers.constructor}}', scope), null);
    assert.strictEqual(resolveTemplate('x{{answers.toString}}y', scope), 'xy');
});

test('text that is not a path stays as written, as before', () => {
    assert.strictEqual(resolveTemplate('Hello {{ first name }}!', scope), 'Hello {{ first name }}!');
    assert.strictEqual(resolveTemplate('{{decidedByName}} decided', scope), 'Fleur decided');
});
