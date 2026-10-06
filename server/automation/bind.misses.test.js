/**
 * A mapping that finds nothing says so.
 *
 * A ref that resolved to nothing and an expression that threw used to leave
 * no trace at all: the step got an empty value, the run was green, and the
 * person looking at it only saw "it doesn't always work". While a binding
 * log is open (the runner opens one around every step), every miss is
 * written down with the input it was for, the path it read, and WHERE the
 * walk stopped, so the run can say "input to read steps.http.output.data
 * .contact.e-mail: steps.http.output.data has no contact".
 *
 * Outside a log nothing is recorded and nothing changes.
 *
 * Run: node --test automation/bind.misses.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveInputs, resolveValue, interpolateTemplate, withBindingLog, describeBindingMiss,
} = require('./bind');

const state = () => ({
    trigger: { output: { subject: 'Hi' } },
    steps: {
        http: {
            output: {
                data: { name: 'Ann', contact: { email: 'a@x.nl' }, items: [{ title: 't1' }, { title: 't2' }], body: 'plain text' },
                empty: null,
            },
        },
    },
    vars: {},
    loop: {},
    secrets: {},
    _templateWarnings: [],
});

test('nothing is recorded outside a binding log', () => {
    const out = resolveInputs({ to: { kind: 'ref', path: 'steps.http.output.data.nope' } }, state());
    assert.deepEqual(out, { to: undefined });
});

test('a ref miss records the input, the path and where the walk stopped', () => {
    const log = [];
    withBindingLog(log, () => resolveInputs({
        to: { kind: 'ref', path: 'steps.http.output.data.contact.e-mail' },
        ok: { kind: 'ref', path: 'steps.http.output.data.contact.email' },
    }, state()));
    assert.equal(log.length, 1);
    assert.deepEqual(log[0], {
        field: 'to',
        kind: 'ref',
        path: 'steps.http.output.data.contact.e-mail',
        reason: 'missing',
        at: 'steps.http.output.data.contact',
        found: 'record',
        missing: 'e-mail',
        count: 1,
    });
    assert.match(describeBindingMiss(log[0]), /to.*steps\.http\.output\.data\.contact\.e-mail.*has no "e-mail"/);
});

test('reading into a list, text or an empty value says what was there instead', () => {
    const log = [];
    withBindingLog(log, () => resolveInputs({
        a: { kind: 'ref', path: 'steps.http.output.data.items.title' },
        b: { kind: 'ref', path: 'steps.http.output.data.body.text' },
        c: { kind: 'ref', path: 'steps.http.output.empty.x' },
    }, state()));
    assert.deepEqual(log.map(r => [r.field, r.found, r.at]), [
        ['a', 'list', 'steps.http.output.data.items'],
        ['b', 'text', 'steps.http.output.data.body'],
        ['c', 'empty', 'steps.http.output.empty'],
    ]);
    assert.match(describeBindingMiss(log[0]), /is a list of 2/);
    assert.match(describeBindingMiss(log[0]), /\[0\]|\[\*\]/);
});

test('a step that has not run is named as such', () => {
    const log = [];
    withBindingLog(log, () => resolveInputs({ x: { kind: 'ref', path: 'steps.later.output.v' } }, state()));
    assert.equal(log[0].reason, 'not_run');
    assert.match(describeBindingMiss(log[0]), /"later" has not run/);
});

test('an invalid path is a syntax miss', () => {
    const log = [];
    withBindingLog(log, () => resolveInputs({ x: { kind: 'ref', path: 'steps.http.output.data[' } }, state()));
    assert.equal(log[0].reason, 'syntax');
});

test('expressions: a parse error, an evaluation that finds nothing', () => {
    const log = [];
    const out = withBindingLog(log, () => resolveInputs({
        cc: { kind: 'expr', value: 'upper(steps.http.output.data.name' },
        body: { kind: 'expr', value: 'steps.http.output.data["first name"]' },
        good: { kind: 'expr', value: 'upper(steps.http.output.data.name)' },
    }, state()));
    assert.equal(out.good, 'ANN');
    assert.deepEqual(log.map(r => [r.field, r.kind, r.reason]), [
        ['cc', 'expr', 'syntax'],
        ['body', 'expr', 'missing'],
    ]);
    assert.ok(log[0].message, 'the parse error is kept');
    assert.equal(log[1].at, 'steps.http.output.data');
});

test('template misses are recorded with the field, and nested inputs name their path', () => {
    const log = [];
    const s = state();
    withBindingLog(log, () => {
        resolveInputs({ values: { Datum: { kind: 'template', value: 'On {{steps.http.output.data.date}}' } } }, s);
        interpolateTemplate('Dear {{steps.http.output.data.nam}}', s, { field: 'body' });
    });
    assert.deepEqual(log.map(r => [r.field, r.kind, r.path]), [
        ['values.Datum', 'template', 'steps.http.output.data.date'],
        ['body', 'template', 'steps.http.output.data.nam'],
    ]);
    // The old run-level channel still gets the bare path.
    assert.deepEqual(s._templateWarnings, ['steps.http.output.data.date', 'steps.http.output.data.nam']);
});

test('the same miss over many items is one entry with a count', () => {
    const log = [];
    withBindingLog(log, () => {
        for (let i = 0; i < 25; i++) resolveValue({ kind: 'ref', path: 'loop.item.x' }, { ...state(), loop: { item: {} } });
    });
    assert.equal(log.length, 1);
    assert.equal(log[0].count, 25);
});

test('null is a value, not a miss', () => {
    const log = [];
    withBindingLog(log, () => resolveInputs({ e: { kind: 'ref', path: 'steps.http.output.empty' } }, state()));
    assert.deepEqual(log, []);
});

test('the log follows async work and nested logs stay separate', async () => {
    const outer = [];
    const inner = [];
    await withBindingLog(outer, async () => {
        await new Promise(r => setTimeout(r, 1));
        resolveValue({ kind: 'ref', path: 'steps.http.output.a' }, state());
        await withBindingLog(inner, async () => {
            await Promise.resolve();
            resolveValue({ kind: 'ref', path: 'steps.http.output.b' }, state());
        });
    });
    assert.deepEqual(outer.map(r => r.path), ['steps.http.output.a']);
    assert.deepEqual(inner.map(r => r.path), ['steps.http.output.b']);
});

test('an index past the end, a match that finds nothing and [*] on a record say so plainly', () => {
    const log = [];
    const s = state();
    s.steps.http.output.data.headers = [{ name: 'From', value: 'x' }];
    withBindingLog(log, () => resolveInputs({
        a: { kind: 'ref', path: 'steps.http.output.data.items[5].title' },
        b: { kind: 'ref', path: 'steps.http.output.data.headers[name="Subject"].value' },
        c: { kind: 'ref', path: 'steps.http.output.data.contact[*].email' },
    }, s));
    const [a, b, c] = log.map(describeBindingMiss);
    assert.match(a, /is a list of 2, with no item \[5\]/);
    assert.match(b, /no item of steps\.http\.output\.data\.headers matches \[name="Subject"\]/);
    assert.match(c, /steps\.http\.output\.data\.contact is a record, not a list/);
});
