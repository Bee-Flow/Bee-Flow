/**
 * A run of a plan as a person reads it (./planTrace.mts): previews, the last attempt, and when a run is over. The
 * step-by-step reading is exercised through its two callers (usecases/coworkPlanTry.test.js, coworkRunTrace.test.js).
 *
 * Run: cd server && node --test core/cowork/plan/planTrace.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { previewOf, runIsOver, traceSteps } = require('./planTrace.mts');
const { fakeLookups, supplierRadar } = require('./plan.testkit');

test('history gets the integration and documented script purpose from the executed plan', () => {
    const plan = supplierRadar();
    plan.steps.push({ id: 'thread', type: 'code', label: 'Group mail by thread', inputs: { messages: {} },
        code: '/** Brings related messages together. */\nasync function main(inputs) { return inputs.messages; }' });
    const steps = traceSteps(plan, [], { done: true, simulated: false }, fakeLookups());
    assert.ok(steps.find((s) => s.id === 'mail').app);
    const script = steps.find((s) => s.id === 'thread');
    assert.deepStrictEqual([script.title, script.description, script.type, script.inputNames],
        ['Group mail by thread', 'Brings related messages together.', 'code', ['messages']]);
});

test('a preview is short text: long values are cut, empty ones are nothing', () => {
    assert.strictEqual(previewOf('  hello  '), 'hello');
    assert.strictEqual(previewOf({ a: 1 }), '{\n "a": 1\n}');
    assert.strictEqual(previewOf('x'.repeat(700)).length, 601);
    assert.ok(previewOf('x'.repeat(700)).endsWith('…'));
    for (const empty of [null, undefined, '', '   ', {}, []]) assert.strictEqual(previewOf(empty), null);
    const circular = {};
    circular.self = circular;
    assert.strictEqual(previewOf(circular), null);
});

test('a run is over once it no longer works by itself: finished, failed, cancelled, or waiting for a person', () => {
    assert.deepStrictEqual(['queued', 'running', undefined, null].map(runIsOver), [false, false, false, false]);
    assert.deepStrictEqual(['success', 'error', 'cancelled', 'awaiting_approval'].map(runIsOver), [true, true, true, true]);
});

test('only a try-out holds steps back: in a real run the same step is not held, and still shows what went into it', () => {
    const rows = [{ stepId: 'draft', attempts: 1, status: 'success', input: { to: 'orders@hoekstra-staal.example' }, output: { id: 'AAMk-1' } }];
    const draftOf = (simulated) => traceSteps(supplierRadar(), rows, { done: true, simulated }, fakeLookups()).find((s) => s.id === 'draft');
    assert.deepStrictEqual([draftOf(true).held, draftOf(false).held], [true, false]);
    for (const step of [draftOf(true), draftOf(false)]) assert.match(step.preview, /hoekstra-staal/);
});

test('a result for the owner shows its message: what it delivered, or in a try-out what it would deliver', () => {
    const digestOf = (rows, simulated) => traceSteps(supplierRadar(), rows, { done: true, simulated }, fakeLookups()).find((s) => s.id === 'digest');
    const sent = digestOf([{ stepId: 'digest', attempts: 1, status: 'success', input: null, output: { title: 'Supplier radar', body: '3 orders are overdue', channels: ['notification'] } }], false);
    assert.match(sent.preview, /3 orders are overdue/);
    const tried = digestOf([{ stepId: 'digest', attempts: 1, status: 'success', output: { _dryRun: true, wouldNotify: { title: 'Supplier radar', body: '3 orders are overdue' } } }], true);
    assert.deepStrictEqual([tried.held, /3 orders are overdue/.test(tried.preview), /_dryRun/.test(tried.preview)], [true, true, false]);
});

test('a step that acted without recorded inputs shows its real answer, and in a try-out nothing: a simulated answer is made up', () => {
    const rows = [{ stepId: 'draft', attempts: 1, status: 'success', input: {}, output: { id: 'sample-draft-id' } }];
    const draftOf = (simulated) => traceSteps(supplierRadar(), rows, { done: true, simulated }, fakeLookups()).find((s) => s.id === 'draft');
    assert.match(draftOf(false).preview, /sample-draft-id/);
    assert.strictEqual(draftOf(true).preview, null);
});

test('a time that cannot be right is not shown: a missing end, an end before the start', () => {
    const rows = [
        { stepId: 'mail', attempts: 1, status: 'success', startedAt: '2026-11-23T09:14:02.000Z', finishedAt: '2026-11-23T09:14:01.000Z' },
        { stepId: 'orders', attempts: 1, status: 'running', startedAt: '2026-11-23T09:14:02.000Z' },
    ];
    const steps = traceSteps(supplierRadar(), rows, { done: false, simulated: false }, fakeLookups());
    assert.deepStrictEqual(steps.slice(0, 2).map((s) => s.durationMs), [null, null]);
});
