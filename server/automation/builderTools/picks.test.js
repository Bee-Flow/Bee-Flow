/**
 * picks.js: the v2 mapping the AI builder writes — labels, the `{{ }}` text
 * that becomes a compose, and the adapters that let the ref-path checks read
 * a pick.
 *
 * Run: cd server && node --test automation/builderTools/picks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    labelForSource, composeFromTemplate, textFieldValue, composeTextFields, canonicalMapping,
    isTextField, refPathOf, withRefPath,
} = require('./picks');
const { isCompose, isPick, textAsTemplate } = require('../../shared/mapping/index.mjs');
const bind = require('../bind');

const S = (...path) => ({ root: 'steps', id: 's1', path });

test('a label is the last key, humanised; an index is skipped; no key, no label', () => {
    assert.equal(labelForSource(S('replyText')), 'Reply text');
    assert.equal(labelForSource(S('factuur_nummer')), 'Factuur nummer');
    assert.equal(labelForSource(S('Klant', 'E-mail adres')), 'E-mail adres');
    assert.equal(labelForSource(S('items', 0)), 'Items');
    assert.equal(labelForSource(S('totalVAT')), 'Total VAT');
    // The rules of the core's humanizeKey (M3, shared/mapping/label.mjs).
    assert.equal(labelForSource(S('messageId')), 'Message ID');
    assert.equal(labelForSource(S('AFAS')), 'AFAS');
    assert.equal(labelForSource(S('Order ID')), 'Order ID');
    assert.equal(labelForSource(S()), undefined);
    assert.equal(labelForSource(null), undefined);
});

test('a template whose placeholders all read plain paths becomes a compose', () => {
    const c = composeFromTemplate('Beste {{trigger.output.naam}}, orders: {{steps.s1.output.items[*].product}}.', { stepType: 'notification', field: 'body' });
    assert.ok(isCompose(c), JSON.stringify(c));
    assert.deepEqual(c.parts, [
        'Beste ',
        { from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text', label: 'Naam' },
        ', orders: ',
        { from: S('items', 'product'), take: 'all', as: 'text', join: 'lines', label: 'Product' },
        '.',
    ]);
    assert.equal(textAsTemplate(c), 'Beste {{trigger.output.naam}}, orders: {{steps.s1.output.items.product}}.');
});

test('the slot decides the layout: comma in a one-line field, JSON-shaped in an HTTP body', () => {
    const title = composeFromTemplate('{{steps.s1.output.items[*].sku}}', { stepType: 'notification', field: 'title' });
    assert.equal(title.parts[0].join, 'comma');
    const body = composeFromTemplate('{"id": "{{steps.s1.output.id}}"}', { stepType: 'http_request', field: 'body' });
    assert.equal(body.parts[1].as, 'json');
    assert.equal(body.parts[1].join, undefined);
});

test('a text with a placeholder no pick can hold stays the template it is — nothing is half-converted', () => {
    const where = { stepType: 'notification', field: 'body' };
    for (const text of [
        'Key {{secrets.api}}',                              // no secrets root in a pick
        'Sum {{steps.s1.output.a + 1}}',                    // an expression, not a path
        'At {{trigger.date}} for {{trigger.output.naam}}',  // trigger.<x> without .output, not a run key
        'Plain text without values',
        '',
    ]) {
        assert.equal(composeFromTemplate(text, where), null, text);
        assert.equal(textFieldValue(text, where), text, text);
    }
});

// Review M5a: the v2 walker refuses `length` and does not index a string, so
// these placeholders rendered a value as a template and '' as a compose.
test('a placeholder a pick reads differently keeps the text a template, rendering as before', () => {
    const state = { steps: { s1: { output: { results: [1, 2], text: 'abc' } } } };
    const where = { stepType: 'notification', field: 'body' };
    for (const [text, rendered] of [
        ['Found {{steps.s1.output.results.length}} results', 'Found 2 results'],
        ['Starts with {{steps.s1.output.text[0]}}', 'Starts with a'],
        ['{{steps.s1.output.text.length}} chars of {{steps.s1.output.text}}', '3 chars of abc'],
    ]) {
        const stored = textFieldValue(text, where);
        assert.equal(stored, text, text);
        assert.equal(bind.interpolateTemplate(stored, state), rendered);
    }
    // The sole branch of a fill_document value too.
    const fill = { stepType: 'fill_document', field: 'values.n' };
    assert.equal(textFieldValue('{{steps.s1.output.results.length}}', fill), '{{steps.s1.output.results.length}}');
    assert.equal(textFieldValue('{{steps.s1.output.text[0]}}', fill), '{{steps.s1.output.text[0]}}');
});

// Review M5a: render.mjs's 'bullets' join does not open a markdown block the
// way listAsMarkdown does, so a slide's content stays a template.
test('a slide\'s content stays a template: its list renders as the bullet block it always did', () => {
    const text = 'Findings: {{steps.s1.output.points}} more';
    const stored = textFieldValue(text, { stepType: 'slide', field: 'content' });
    assert.equal(stored, text);
    const state = { steps: { s1: { output: { points: ['a', 'b'] } } } };
    assert.equal(bind.interpolateTemplate(stored, state, { listAsMarkdown: true }), 'Findings: \n\n- a\n- b\n more');
    const step = composeTextFields({ type: 'slide', title: '{{steps.s1.output.title}}', content: text });
    assert.equal(step.content, text);
    assert.ok(isCompose(step.title), 'the other text fields of a slide are composes');
});

test('a fill_document value that is one placeholder is a pick of the value itself: a list stays a list', () => {
    const v = textFieldValue('{{steps.s1.output.lines}}', { stepType: 'fill_document', field: 'values.lines' });
    assert.deepEqual(v, { kind: 'pick', v: 1, from: S('lines'), take: 'one', as: 'native', label: 'Lines' });
    const mixed = textFieldValue('Factuur {{steps.s1.output.nr}}', { stepType: 'fill_document', field: 'values.kop' });
    assert.ok(isCompose(mixed));
});

test('textFieldValue: an ai_step prompt stays a template; a compose the model wrote is expanded', () => {
    assert.equal(textFieldValue('Vat {{emails}} samen', { stepType: 'ai_step', field: 'prompt' }), 'Vat {{emails}} samen');
    assert.equal(textFieldValue('Over {{steps.s1.output.x}}', { stepType: 'ai_step', field: 'prompt' }), 'Over {{steps.s1.output.x}}');
    const c = textFieldValue({ compose: ['Over ', { pick: 'steps.s1.output.x' }] }, { stepType: 'ai_step', field: 'prompt' });
    assert.ok(isCompose(c));
});

test('textFieldValue: a pick in a text field is a compose of one part; a legacy binding object is read as its text', () => {
    const one = textFieldValue({ pick: 'steps.s1.output.items', take: 'all', join: 'bullets' }, { stepType: 'notification', field: 'body' });
    assert.deepEqual(one, { kind: 'compose', v: 1, parts: [{ from: S('items'), take: 'all', as: 'text', join: 'bullets', label: 'Items' }] });
    const ref = textFieldValue({ kind: 'ref', path: 'steps.s1.output.text' }, { stepType: 'knowledge_write', field: 'content' });
    assert.ok(isCompose(ref));
    assert.equal(textAsTemplate(ref), '{{steps.s1.output.text}}');
    assert.equal(textFieldValue({ kind: 'literal', value: 'ticket:1' }, { stepType: 'knowledge_write', field: 'sourceUri' }), 'ticket:1');
    assert.equal(textFieldValue(42, { stepType: 'notification', field: 'body', fallback: () => '' }), '');
});

test('textFieldValue: a field that takes plain text only gets the {{ }} text of a compose', () => {
    const v = textFieldValue({ compose: ['Hoi ', { pick: 'trigger.output.naam' }] }, { stepType: 'approval', field: 'approval.details' });
    assert.equal(v, 'Hoi {{trigger.output.naam}}');
    assert.equal(textFieldValue('Hoi {{trigger.output.naam}}', { stepType: 'return_to_app', field: 'toast.message' }), 'Hoi {{trigger.output.naam}}');
});

test('isTextField and composeTextFields follow the sites table', () => {
    assert.equal(isTextField('notification', 'body'), true);
    assert.equal(isTextField('notification', 'channels'), false);
    assert.equal(isTextField('data_extraction', 'source'), false, 'a source is one binding, sanitised on its own');
    assert.equal(isTextField('fill_document', 'values'), false, 'a map of texts, converted per value');
    const step = composeTextFields({
        type: 'notification', title: 'Hi {{trigger.output.naam}}', body: 'plain', channels: ['notification'],
    });
    assert.ok(isCompose(step.title));
    assert.equal(step.body, 'plain');
    const fill = composeTextFields({ type: 'fill_document', values: { a: '{{steps.s1.output.lines}}', b: 7 } });
    assert.ok(isPick(fill.values.a));
    assert.equal(fill.values.b, 7);
    const ex = composeTextFields({ type: 'data_extraction', source: { kind: 'ref', path: 'steps.s1.output.text' } });
    assert.deepEqual(ex.source, { kind: 'ref', path: 'steps.s1.output.text' }, 'a source binding is left to its sanitizer');
});

// Review M5a: a `[*]` in a compact pick's path means all of the list, as in
// a ref; the Source keeps no `[*]`, so without this it took the first only.
test('a compact pick whose path has [*] and no take takes all, resolving as the ref did', () => {
    const state = { steps: { x: { output: { items: [{ email: 'A' }, { email: 'B' }] } } } };
    const pick = canonicalMapping({ pick: 'steps.x.output.items[*].email' });
    assert.equal(pick.take, 'all');
    assert.deepEqual(bind.resolveValue(pick, state), ['A', 'B']);
    assert.deepEqual(bind.resolveValue({ kind: 'ref', path: 'steps.x.output.items[*].email' }, state), ['A', 'B']);
    assert.equal(canonicalMapping({ pick: 'steps.x.output.items[*].email', take: 'first' }).take, 'first', 'a take the model gave wins');
    const compose = canonicalMapping({ compose: ['To ', { pick: 'steps.x.output.items[*].email' }] });
    assert.equal(compose.parts[1].take, 'all');
    assert.equal(bind.resolveValue(compose, state), 'To A\nB');
});

test('canonicalMapping keeps a given version and stamps the compact forms', () => {
    assert.equal(canonicalMapping({ pick: 'trigger.output.a' }).v, 1);
    assert.equal(canonicalMapping({ compose: ['x'] }).v, 1);
    assert.equal(canonicalMapping({ kind: 'pick', from: S('a'), take: 'one', as: 'native' }).v, undefined, 'without a version it is no mapping to make live');
    assert.equal(canonicalMapping({ kind: 'compose', parts: ['x'] }).v, undefined);
    const keep = canonicalMapping({ kind: 'pick', v: 1, from: S('a'), take: 'one', as: 'native', label: 'Mijn naam' });
    assert.equal(keep.label, 'Mijn naam', 'a label the writer gave is kept');
});

test('refPathOf / withRefPath let a ref-path check read and repair a pick, in its own kind', () => {
    const pick = { kind: 'pick', v: 1, from: { root: 'loop', id: 'r', path: ['content'] }, take: 'one', as: 'native', label: 'Content' };
    assert.equal(refPathOf(pick), 'loop.r.content');
    assert.equal(refPathOf({ kind: 'ref', path: 'loop.r.x' }), 'loop.r.x');
    assert.equal(refPathOf({ kind: 'literal', value: 'x' }), null);
    const repaired = withRefPath(pick, 'loop.r.output.content');
    assert.deepEqual(repaired.from, { root: 'loop', id: 'r', path: ['output', 'content'] });
    assert.equal(repaired.label, 'Content');
    const relabelled = withRefPath(pick, 'loop.r.output.tekst');
    assert.equal(relabelled.label, 'Tekst', 'a derived label follows the key it reads');
    const own = withRefPath({ ...pick, label: 'Brieftekst' }, 'loop.r.output.tekst');
    assert.equal(own.label, 'Brieftekst', 'a label somebody chose is kept');
    assert.deepEqual(withRefPath({ kind: 'ref', path: 'a' }, 'loop.r.b'), { kind: 'ref', path: 'loop.r.b' });
});
