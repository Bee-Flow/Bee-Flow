/**
 * What a `{{path}}` looks like inside human text (notification, e-mail and chat
 * bodies, documents), and what it must NOT touch.
 *
 * Observed in the live product: a code step returned
 * `{ text, number, yes, tags: ['red','green','blue'], lines: [{sku, qty, price}] }`
 * and the delivered notification read
 * `Hello world42true["red","green","blue"][{"qty":2,"sku"...` — a list as raw
 * JSON and the record's keys reordered. These tests pin the text rules
 * (templateText, shared with the editor's preview) and that a binding of kind
 * 'ref' keeps the typed value.
 *
 * Run: node --test automation/bind.templateText.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { interpolateTemplate, resolveValue, resolveInputs } = require('./bind');

const out = {
    text: 'Hello world',
    number: 42,
    yes: true,
    no: false,
    tags: ['red', 'green', 'blue'],
    lines: [{ sku: 'A1', qty: 2, price: 9.95 }, { sku: 'B2', qty: 1, price: 24.5 }],
    date: '2026-10-04',
    nothing: null,
    empty: [],
    customer: { name: 'Acme BV', address: { city: 'Utrecht' } },
};
const state = () => ({ steps: { s1: { output: { result: out } } }, trigger: { output: {} }, vars: {}, secrets: {} });
const P = 'steps.s1.output.result';
const tpl = (t, opts) => interpolateTemplate(t, state(), opts);

test('the observed notification body reads as prose', () => {
    const body = tpl(`{{${P}.text}}{{${P}.number}}{{${P}.yes}}|{{${P}.tags}}|{{${P}.date}}`);
    assert.equal(body, 'Hello world42true|red, green, blue|2026-10-04');
});

test('a list of plain values is comma separated, not JSON', () => {
    assert.equal(tpl(`Tags: {{${P}.tags}}`), 'Tags: red, green, blue');
});

test('an empty list is empty text', () => {
    assert.equal(tpl(`[{{${P}.empty}}]`), '[]');
});

test('a table reads one row per line, keys in the author\'s order (sku, qty, price)', () => {
    assert.equal(tpl(`{{${P}.lines}}`), 'sku: A1, qty: 2, price: 9.95\nsku: B2, qty: 1, price: 24.5');
});

test('a record reads as "key: value", a nested one in brackets, in the author\'s order', () => {
    assert.equal(tpl(`{{${P}.customer}}`), 'name: Acme BV, address: (city: Utrecht)');
});

test('a data slot (listAs json) keeps records and tables as JSON, in the author\'s key order', () => {
    assert.equal(tpl(`{{${P}.lines}}`, { listAs: 'json' }), '[{"sku":"A1","qty":2,"price":9.95},{"sku":"B2","qty":1,"price":24.5}]');
    assert.equal(tpl(`{{${P}.customer}}`, { listAs: 'json' }), '{"name":"Acme BV","address":{"city":"Utrecht"}}');
});

test('null renders as empty text, not "null"', () => {
    assert.equal(tpl(`[{{${P}.nothing}}]`), '[]');
    assert.ok(!tpl(`{{${P}.nothing}}`).includes('null'));
});

test('an unknown path renders as empty text and is recorded as a warning', () => {
    const s = state();
    s._templateWarnings = [];
    assert.equal(interpolateTemplate(`a{{${P}.missing}}b`, s), 'ab');
    assert.deepEqual(s._templateWarnings, [`${P}.missing`]);
});

test('false and 0 are written, not blanked', () => {
    assert.equal(tpl(`{{${P}.no}}`), 'false');
    assert.equal(interpolateTemplate('{{x}}', { x: 0 }), '0');
});

test("listAs: 'json' keeps a list as JSON, for a slot that carries data (an http body)", () => {
    assert.equal(tpl(`{"tags": {{${P}.tags}}}`, { listAs: 'json' }), '{"tags": ["red","green","blue"]}');
    assert.equal(tpl(`{{${P}.nothing}}`, { listAs: 'json' }), '');
});

test('the markdown form page still gets bullets', () => {
    assert.equal(tpl(`{{${P}.tags}}`, { listAsMarkdown: true }), '\n\n- red\n- green\n- blue\n');
    assert.equal(tpl(`{{${P}.tags}}`, { listAs: 'markdown' }), '\n\n- red\n- green\n- blue\n');
});

test("a binding of kind 'template' writes text, and listAs reaches it through resolveValue", () => {
    const binding = { kind: 'template', value: `Tags: {{${P}.tags}}` };
    assert.equal(resolveValue(binding, state()), 'Tags: red, green, blue');
    assert.equal(resolveValue(binding, state(), { listAs: 'json' }), 'Tags: ["red","green","blue"]');
    assert.deepEqual(resolveInputs({ body: binding }, state()), { body: 'Tags: red, green, blue' });
});

test("a binding of kind 'ref' keeps the typed value: number, boolean, list, record", () => {
    const ref = (p) => resolveValue({ kind: 'ref', path: `${P}.${p}` }, state());
    assert.strictEqual(ref('number'), 42);
    assert.strictEqual(ref('yes'), true);
    assert.strictEqual(ref('no'), false);
    assert.strictEqual(ref('nothing'), null);
    assert.deepEqual(ref('tags'), ['red', 'green', 'blue']);
    assert.ok(Array.isArray(ref('tags')));
    assert.deepEqual(Object.keys(ref('lines')[0]), ['sku', 'qty', 'price']);
    assert.deepEqual(ref('customer'), out.customer);
    const typed = resolveInputs({
        n: { kind: 'ref', path: `${P}.number` },
        b: { kind: 'ref', path: `${P}.yes` },
        l: { kind: 'ref', path: `${P}.tags` },
    }, state());
    assert.strictEqual(typed.n, 42);
    assert.strictEqual(typed.b, true);
    assert.deepEqual(typed.l, ['red', 'green', 'blue']);
});
