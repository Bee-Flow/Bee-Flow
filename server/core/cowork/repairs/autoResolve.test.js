/**
 * The deciding part of the automatic fix of a reference (./autoResolve.mts): the shape it reads (no values), the
 * candidate by name or as the one list, a patch that changes only that reference, and the proof that it reaches
 * exactly what the plan reaches.
 *
 * Run: cd server && node --test core/cowork/repairs/autoResolve.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { listPathsOf, deterministicCandidate, patchRef, sameReach, unresolvedFactOf } = require('./autoResolve.mts');
const { shapeOf } = require('../../../usecases/coworkAutoResolve.mts');
const { fakeLookups } = require('../plan/plan.testkit');

const lookups = fakeLookups();
const MARKER = 'MARKER-in-a-value';
const fact = (ref = 'steps.list.output.transcripts') => ({ stepId: 'sums', field: 'forEach.overRef', ref, sourceStepId: 'list', found: 'nothing' });
const plan = (overRef = 'steps.list.output.transcripts', tool = 'fireflies_get_summary') => ({
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'schedule' },
    steps: [
        { id: 'list', type: 'integration_action', label: 'List meetings', tool: 'fireflies_list_transcripts', inputs: {} },
        { id: 'other', type: 'integration_action', label: 'List more', tool: 'fireflies_list_transcripts', inputs: {} },
        { id: 'sums', type: 'integration_action', label: 'Get summaries', tool, forEach: { overRef, itemVar: 't' }, inputs: { transcriptId: { kind: 'ref', path: 'loop.t.id' } } },
    ],
    edges: [],
});

test('the shape is keys and types: a value never reaches it', () => {
    const shape = shapeOf({ data: { transcripts: [{ id: 't1', title: MARKER }] }, count: 1 });
    assert.ok(!JSON.stringify(shape).includes(MARKER));
    assert.deepStrictEqual(listPathsOf(shape), [{ keys: ['data', 'transcripts'] }]);
});

test('a list whose last name is the missing one is the candidate: data.transcripts', () => {
    const shape = shapeOf({ data: { transcripts: [{ id: 't1' }] }, items: [] });
    assert.deepStrictEqual(deterministicCandidate(fact(), shape), { ref: 'steps.list.output.data.transcripts', rule: 'same_name' });
});

test('without a name that fits, the one list near the top: results (the Fireflies tool)', () => {
    const shape = shapeOf({ results: [{ id: 't1' }], count: 1, message: 'Found 1 transcript(s).' });
    assert.deepStrictEqual(deterministicCandidate(fact(), shape), { ref: 'steps.list.output.results', rule: 'only_list' });
});

test('two lists and no name that fits: no deterministic candidate, the lists for the model', () => {
    const shape = shapeOf({ results: [{ id: 't1' }], exactMatches: [{ id: 't1' }] });
    const c = deterministicCandidate(fact(), shape);
    assert.deepStrictEqual([c.ref, c.lists.map((l) => l.keys.join('.'))], [null, ['results', 'exactMatches']]);
});

test('the patch changes that reference only, and reaches exactly what the plan reaches', () => {
    const before = plan();
    const after = patchRef(before, fact(), 'steps.list.output.results');
    assert.strictEqual(after.steps[2].forEach.overRef, 'steps.list.output.results');
    assert.strictEqual(before.steps[2].forEach.overRef, 'steps.list.output.transcripts', 'the approved plan is not touched');
    assert.strictEqual(sameReach(before, after, fact(), 'steps.list.output.results', lookups), true);
});

test('a patch that changes a tool, or reads another step, does not reach the same: it is never applied', () => {
    const before = plan();
    const otherTool = patchRef(plan('steps.list.output.transcripts', 'fireflies_get_transcript'), fact(), 'steps.list.output.results');
    assert.strictEqual(sameReach(before, otherTool, fact(), 'steps.list.output.results', lookups), false);
    const otherStep = patchRef(before, fact(), 'steps.other.output.results');
    assert.strictEqual(sameReach(before, otherStep, fact(), 'steps.other.output.results', lookups), false);
    const outside = patchRef(before, fact(), 'steps.nowhere.output.results');
    assert.strictEqual(sameReach(before, outside, fact(), 'steps.nowhere.output.results', lookups), false);
    assert.strictEqual(patchRef(before, { stepId: 'missing', field: 'arrayRef' }, 'steps.list.output.results'), null);
});

test('only a run that ended incomplete names a reference to fix', () => {
    const incomplete = { runId: 'r1', status: 'incomplete', planId: 'p1', automationRunId: 'a1', startedAt: null, outcome: { kind: 'incomplete', unresolved: [fact()] } };
    assert.deepStrictEqual(unresolvedFactOf(incomplete), fact());
    assert.strictEqual(unresolvedFactOf({ ...incomplete, status: 'success', outcome: { kind: 'nothing_to_do' } }), null);
    assert.strictEqual(unresolvedFactOf({ ...incomplete, outcome: { kind: 'incomplete', unresolved: [{ ...fact(), field: 'body' }] } }), null);
});
