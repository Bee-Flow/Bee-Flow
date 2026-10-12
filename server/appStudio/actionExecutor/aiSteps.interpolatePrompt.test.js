/**
 * App Studio AI-step prompts: `{{form.x}}` / `{{vars.y}}` / `{{item.z}}` (or
 * a bare `{{name}}`, vars then form), read with the shared path grammar.
 *
 * The dialect (its roots, the bare-name fallback, "unresolved stays
 * verbatim") is App Studio's own and is kept. What changed is how a path is
 * read: `[\w.]+` split on dots, so a form input named "Cost center" or
 * "e-mail", a list position written `[0]`, or a key with a `}` in it could
 * not be put in a prompt; and the walk followed the prototype chain, so
 * `{{constructor}}` pasted a function's source text into the model's prompt.
 *
 * Run: cd server && node --test appStudio/actionExecutor/aiSteps.interpolatePrompt.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { interpolatePrompt } = require('./aiSteps');

const ctx = {
    formValues: { 'Cost center': 'CC-12', 'e-mail': 'a@b.nl', name: 'Ada' },
    vars: { order: { lines: [{ sku: 'A1' }, { sku: 'B2' }], 'a}b': 'odd' }, name: 'Var Ada' },
    item: { title: 'Ticket 7' },
};

test('the existing spellings keep their meaning', () => {
    assert.strictEqual(interpolatePrompt('Hi {{form.name}} / {{vars.name}} / {{item.title}} / {{name}}', ctx), 'Hi Ada / Var Ada / Ticket 7 / Ada');
    assert.strictEqual(interpolatePrompt('{{vars.order.lines.0.sku}}', ctx), 'A1');
    assert.strictEqual(interpolatePrompt('{{vars.order.lines}}', ctx), '[{"sku":"A1"},{"sku":"B2"}]');
});

test('awkward keys and list positions are readable', () => {
    assert.strictEqual(interpolatePrompt('CC {{ form["Cost center"] }}', ctx), 'CC CC-12');
    assert.strictEqual(interpolatePrompt('{{form.e-mail}}', ctx), 'a@b.nl');
    assert.strictEqual(interpolatePrompt('{{vars.order.lines[1].sku}} {{vars.order.lines[-1].sku}}', ctx), 'B2 B2');
    assert.strictEqual(interpolatePrompt('{{ vars.order["a}b"] }}', ctx), 'odd');
});

test('unresolved and non-path placeholders stay verbatim', () => {
    assert.strictEqual(interpolatePrompt('Keep {{form.missing}} and {{ not a path }}', ctx), 'Keep {{form.missing}} and {{ not a path }}');
    assert.strictEqual(interpolatePrompt('{{constructor}} {{form.toString}}', ctx), '{{constructor}} {{form.toString}}');
});
