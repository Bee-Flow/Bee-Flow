/**
 * The AI builder and a step over a list inside a list: the outer items it
 * keeps (`forEach.parents`) are bound for its fields, and a forEach sent with
 * parents keeps the ones that still fit its list.
 *
 * Run: cd server && node --test automation/builderTools/bindings.forEachParents.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { unboundLoopVarError, sanitizeForEach } = require('./bindings');

const DEEP = {
    overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'attachment',
    parents: [{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }],
};
const inputs = {
    messageId: { kind: 'ref', path: 'loop.result.id' },
    attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' },
    title: { kind: 'template', value: 'Re: {{loop.result.subject}} #{{loop._index}}' },
};

test('reads of a kept outer item are bound', () => {
    assert.strictEqual(unboundLoopVarError(inputs, DEEP), null);
});

test('without the parent the same read is refused, naming the var', () => {
    const r = unboundLoopVarError(inputs, { overRef: DEEP.overRef, itemVar: 'attachment' });
    assert.match(r.error, /loop\.result/);
    // A parent that is not an outer part of the list binds nothing either.
    const off = unboundLoopVarError(inputs, { ...DEEP, parents: [{ itemVar: 'result', overRef: 'steps.other.output.x' }] });
    assert.match(off.error, /loop\.result/);
    // A var neither the item nor a parent is still refused.
    assert.match(unboundLoopVarError({ x: { kind: 'ref', path: 'loop.nope.a' } }, DEEP).error, /loop\.nope/);
});

test('sanitizeForEach keeps parents that fit the list and drops the rest', () => {
    const graph = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 'read', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'steps.s.output.results', itemVar: 'r' } }], edges: [] };
    const r = sanitizeForEach({ ...DEEP, parents: [...DEEP.parents, { itemVar: 'x', overRef: 'steps.zz.output.q' }, null] }, graph, {});
    assert.ifError(r.error);
    assert.deepStrictEqual(r.forEach.parents, DEEP.parents);
    const plain = sanitizeForEach({ overRef: 'steps.read.output.results', itemVar: 'r' }, graph, {});
    assert.strictEqual(plain.forEach.parents, undefined);
});
