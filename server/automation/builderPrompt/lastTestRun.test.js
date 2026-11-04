/**
 * The builder's memory of its last test run (lastTestRun.mts): what a dry run
 * showed per step survives into the next turn as a bounded record of hints
 * (no values) and comes back as the "## Last test run" block.
 *
 * Run: cd server && node --test automation/builderPrompt/lastTestRun.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hintsFromDryRun, mergeDryRunHints, renderLastTestRun, stepIdsOf, normaliseHint, LAST_TEST_RUN_MAX_BYTES,
} = require('./lastTestRun.mts');

// The compact model copy of a dry run (modelPayload.compactDryRunForModel).
const RUN = {
    run: { id: 'r1', status: 'success', stepCount: 3 },
    ok: false,
    steps: [
        { stepId: 'fetch', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['value'], shape: '{ value[*]: { id, subject, from: { emailAddress: { address } } } }' } },
        { stepId: 'ai', stepType: 'ai_step', status: 'error', error: 'model said: Jan de Vries <jan@example.com>', input: { text: 'secret body' }, _hint: { outputType: 'null', topKeys: null, shape: null } },
        { stepId: 'ok', stepType: 'approval', status: 'success', _hint: { outputType: 'object', topKeys: ['approved'], shape: '{ approved: boolean }', note: 'approval auto-approved (simulated)' } },
    ],
};

test('hints come from the step rows: type, shape, note, status and step type, never an error text or an input', () => {
    const h = hintsFromDryRun(RUN);
    assert.deepEqual(Object.keys(h), ['fetch', 'ai', 'ok']);
    assert.deepEqual(h.fetch, { outputType: 'object', shape: RUN.steps[0]._hint.shape, status: 'success', stepType: 'integration_action' });
    assert.deepEqual(h.ai, { outputType: 'null', status: 'error', stepType: 'ai_step' });
    assert.equal(h.ok.note, 'approval auto-approved (simulated)');
    assert.doesNotMatch(JSON.stringify(h), /jan@example|secret body|Jan de Vries/);
});

test('topKeys are kept only when there is no shape line', () => {
    assert.deepEqual(normaliseHint({ outputType: 'object', topKeys: ['a', 'b'] }), { outputType: 'object', topKeys: ['a', 'b'] });
    assert.ok(!('topKeys' in normaliseHint({ outputType: 'object', topKeys: ['a'], shape: '{ a }' })));
    assert.equal(normaliseHint({}), null);
    assert.equal(normaliseHint('x'), null);
});

test('a step that ran more than once keeps the row with a shape', () => {
    const h = hintsFromDryRun({ steps: [
        { stepId: 'body', status: 'error', _hint: { outputType: 'null' } },
        { stepId: 'body', status: 'success', _hint: { outputType: 'object', shape: '{ x }' } },
        { stepId: 'body', status: 'success', _hint: { outputType: 'object', shape: '{ y }' } },
    ] });
    assert.equal(h.body.shape, '{ x }');
});

test('nothing usable in, nothing out', () => {
    assert.deepEqual(hintsFromDryRun(null), {});
    assert.deepEqual(hintsFromDryRun({ error: 'refused' }), {});
    assert.deepEqual(hintsFromDryRun({ steps: [null, { status: 'success' }, { stepId: 'x' }] }), {}, 'no id, or an id with nothing known');
});

test('a merge keeps earlier steps, puts the newest run last and replaces a step it ran again', () => {
    const merged = mergeDryRunHints({ a: { outputType: 'string' }, b: { outputType: 'object', shape: '{ old }' } }, { b: { outputType: 'object', shape: '{ new }' }, c: { outputType: 'array' } });
    assert.deepEqual(Object.keys(merged), ['a', 'b', 'c']);
    assert.equal(merged.b.shape, '{ new }');
    const reordered = mergeDryRunHints({ b: { outputType: 'x' }, a: { outputType: 'y' } }, { b: { outputType: 'z' } });
    assert.deepEqual(Object.keys(reordered), ['a', 'b'], 'the step the newest run touched is the newest entry');
});

test('a step that left the draft is dropped', () => {
    const merged = mergeDryRunHints({ gone: { outputType: 'object' }, kept: { outputType: 'object' } }, {}, { keep: new Set(['kept']) });
    assert.deepEqual(Object.keys(merged), ['kept']);
});

test('the record stays under 4 KB, the oldest entries dropped first', () => {
    const prior = {};
    for (let i = 0; i < 40; i++) prior[`old${i}`] = { outputType: 'object', shape: `{ ${'k'.repeat(200)} }` };
    const merged = mergeDryRunHints(prior, { newest: { outputType: 'object', shape: '{ n }' } });
    assert.ok(JSON.stringify(merged).length <= LAST_TEST_RUN_MAX_BYTES);
    assert.ok('newest' in merged);
    assert.ok(!('old0' in merged), 'the oldest went first');
    assert.ok('old39' in merged);
});

test('long fields are cut, so one step cannot take the whole budget', () => {
    const h = normaliseHint({ outputType: 'object', shape: `{ ${'x'.repeat(5000)} }`, note: 'n'.repeat(1000) });
    assert.ok(h.shape.length <= 600);
    assert.ok(h.note.length <= 240);
});

test('stepIdsOf walks triggers, steps, loop bodies and flowlets', () => {
    const ids = stepIdsOf({
        trigger: { id: 't' }, triggers: [{ id: 't2' }],
        steps: [{ id: 's1' }, { id: 'loop', type: 'loop', body: [{ id: 'inner' }] }],
        layers: { fl: { trigger: { id: 'ft' }, steps: [{ id: 'fs' }] } },
    });
    assert.deepEqual([...ids].sort(), ['fs', 'ft', 'inner', 'loop', 's1', 't', 't2']);
});

test('the block: one plain line per step, with the path to bind and the note', () => {
    const text = renderLastTestRun(hintsFromDryRun(RUN));
    const lines = text.split('\n');
    assert.equal(lines[0], '## Last test run');
    assert.match(text, /no values/);
    assert.ok(lines.includes('- `fetch` (integration_action) worked; steps.fetch.output is { value[*]: { id, subject, from: { emailAddress: { address } } } }'));
    assert.ok(lines.includes('- `ai` (ai_step) failed; it returned nothing'));
    assert.ok(lines.includes('- `ok` (approval) worked; steps.ok.output is { approved: boolean } — approval auto-approved (simulated)'));
    assert.equal(lines.length, 5);
});

test('the block names top keys when there is no shape, and drops steps the draft no longer has', () => {
    const text = renderLastTestRun({ a: { outputType: 'object', topKeys: ['x', 'y'], status: 'success' }, gone: { outputType: 'string' } }, { keep: new Set(['a']) });
    assert.match(text, /- `a` worked; steps\.a\.output has x, y/);
    assert.doesNotMatch(text, /gone/);
});

test('no hints, no block', () => {
    assert.equal(renderLastTestRun(null), '');
    assert.equal(renderLastTestRun({}), '');
    assert.equal(renderLastTestRun({ a: { outputType: 'object' } }, { keep: new Set() }), '');
});
