import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interpolateTemplate, walkPath } from './legacy.mjs';
import { createResolver } from './resolve.mjs';
import { pickForLegacyPath, templateToCompose } from './template.mjs';

const { resolveValue } = createResolver({ evaluate: () => undefined });

const state = {
    trigger: { output: { subject: 'Hello team', tags: ['a', 'b'], matrix: [[1, 2], [3, 4]] } },
    steps: {
        s1: { output: { items: [{ email: 'A', tags: ['x', 'y'] }, { email: 'B', tags: ['z'] }], text: 'abc', body: 'hello', results: [{ attachments: [1, 2] }, { attachments: [3] }] } },
    },
};

test('a plain path lifts to a pick of one, a [*] followed by a key to a pick of all', () => {
    assert.deepEqual(pickForLegacyPath('steps.s1.output.text'), { from: { root: 'steps', id: 's1', path: ['text'] }, take: 'one' });
    assert.deepEqual(pickForLegacyPath('steps.s1.output.items[*].email'), { from: { root: 'steps', id: 's1', path: ['items', 'email'] }, take: 'all' });
    assert.deepEqual(pickForLegacyPath('trigger.firedAt'), { from: { root: 'run', path: ['firedAt'] }, take: 'one' });
    assert.equal(pickForLegacyPath('secrets.k'), null);
    assert.equal(pickForLegacyPath('a + b'), null);
});

test('every lifted path reads what the legacy walk read', () => {
    for (const path of ['steps.s1.output.text', 'steps.s1.output.items[*].email', 'steps.s1.output.items[*].tags', 'steps.s1.output.results[*].attachments', 'trigger.output.subject']) {
        const lifted = pickForLegacyPath(path);
        assert.ok(lifted, path);
        const pick = { kind: 'pick', v: 1, from: lifted.from, take: lifted.take, as: 'native' };
        assert.deepEqual(resolveValue(pick, state), walkPath(path, state), path);
    }
});

test('a path the two walks read differently is not lifted', () => {
    // `length` is the count / the number of characters in the legacy walk.
    assert.equal(pickForLegacyPath('steps.s1.output.items.length'), null);
    assert.equal(pickForLegacyPath('trigger.output.subject.length'), null);
    // An index reads a character of a string in the legacy walk.
    assert.equal(pickForLegacyPath('steps.s1.output.text[0]'), null);
    assert.equal(pickForLegacyPath('steps.s1.output.items["0"]'), null);
    // The legacy walk flattens at a [*] that ends the path or precedes an index.
    assert.equal(pickForLegacyPath('trigger.output.matrix[*]'), null);
    assert.equal(pickForLegacyPath('trigger.output.matrix[*][0]'), null);
    assert.equal(pickForLegacyPath('trigger.output.matrix[*][*]'), null);
    assert.equal(pickForLegacyPath('steps.s1.output.constructor'), null);
});

test('a text lifts to a compose whose parts read the same values', () => {
    const compose = templateToCompose('To {{steps.s1.output.items[*].email}} about {{trigger.output.subject}}', { stepType: 'notification', field: 'body' });
    assert.equal(compose.kind, 'compose');
    assert.deepEqual(compose.parts[1], { from: { root: 'steps', id: 's1', path: ['items', 'email'] }, take: 'all', as: 'text', join: 'lines' });
    assert.equal(resolveValue(compose, state), 'To A\nB about Hello team');
    // A one-line field joins a list with commas.
    const title = templateToCompose('{{steps.s1.output.items[*].email}}', { stepType: 'notification', field: 'title' });
    assert.equal(title.parts[0].join, 'comma');
});

test('one placeholder that does not lift keeps the whole text a template', () => {
    for (const text of [
        'Found {{steps.s1.output.items.length}} items',
        '{{trigger.output.subject.length}}',
        'First {{steps.s1.output.text[0]}} of {{steps.s1.output.text}}',
        'Key {{secrets.k}}',
        'Rows {{trigger.output.matrix[*][0]}}',
    ]) {
        assert.equal(templateToCompose(text, { stepType: 'notification', field: 'body' }), null, text);
    }
    // What those texts keep rendering, as the template always did.
    assert.equal(interpolateTemplate('Found {{steps.s1.output.items.length}} items', state), 'Found 2 items');
    assert.equal(templateToCompose('no placeholders', { stepType: 'notification', field: 'body' }), null);
});

test('sole: one placeholder is a pick of the value itself, under the same rule', () => {
    const pick = templateToCompose('{{steps.s1.output.items[*].email}}', { stepType: 'fill_document', field: 'values.to', sole: true });
    assert.deepEqual(pick, { kind: 'pick', v: 1, from: { root: 'steps', id: 's1', path: ['items', 'email'] }, take: 'all', as: 'native' });
    assert.deepEqual(resolveValue(pick, state), ['A', 'B']);
    assert.equal(templateToCompose('{{steps.s1.output.items.length}}', { stepType: 'fill_document', field: 'values.n', sole: true }), null);
    assert.equal(templateToCompose('{{steps.s1.output.text[0]}}', { stepType: 'fill_document', field: 'values.c', sole: true }), null);
});
