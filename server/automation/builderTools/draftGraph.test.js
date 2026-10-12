/**
 * draftGraph.appendAfter in a flowlet: the Return (`layer_output`) stays last.
 *
 * REGRESSION (flowlet "Get ticketlist", 2026-10-09): `afterStepId` naming the
 * step that feeds the Return left that step's edge into the Return in place,
 * so the new step became a branch BESIDE the Return (trg → out, trg → code).
 * The Return ran before the code step and the flowlet returned nothing.
 *
 * Run: cd server && node --test automation/builderTools/draftGraph.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { appendAfter } = require('./draftGraph');

const flowlet = () => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
    steps: [{ id: 'out', type: 'layer_output', fields: {} }],
    edges: [{ from: 'trg', to: 'out' }],
});
const sorted = edges => [...edges].map(e => `${e.from}→${e.to}${e.label ? `:${e.label}` : ''}`).sort();

test('after the step that feeds the Return: in between, not beside', () => {
    const g = flowlet();
    appendAfter(g, 'trg', { id: 'web', type: 'http_request' });
    appendAfter(g, 'web', { id: 'fmt', type: 'code' });
    assert.deepEqual(sorted(g.edges), ['fmt→out', 'trg→web', 'web→fmt']);
});

test('no anchor, or the Return itself as anchor: in front of the Return (unchanged)', () => {
    const g = flowlet();
    appendAfter(g, undefined, { id: 'a', type: 'code' });
    appendAfter(g, 'out', { id: 'b', type: 'code' });
    assert.deepEqual(sorted(g.edges), ['a→b', 'b→out', 'trg→a']);
});

test('a step that does not feed the Return, and a labelled edge into it, keep their meaning', () => {
    const g = flowlet();
    g.steps.push({ id: 'cond', type: 'condition', expr: 'true' }, { id: 'side', type: 'code' });
    g.edges = [{ from: 'trg', to: 'cond' }, { from: 'cond', to: 'out', label: 'then' }, { from: 'trg', to: 'side' }];
    appendAfter(g, 'side', { id: 'more', type: 'code' });
    appendAfter(g, 'cond', { id: 'alt', type: 'code' }, { branch: 'else' });
    assert.deepEqual(sorted(g.edges), ['cond→alt:else', 'cond→out:then', 'side→more', 'trg→cond', 'trg→side']);
});

test('a graph without a Return is not touched', () => {
    const g = { trigger: { id: 'trg' }, steps: [{ id: 'a', type: 'code' }, { id: 'b', type: 'code' }], edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }] };
    appendAfter(g, 'a', { id: 'c', type: 'code' });
    assert.deepEqual(sorted(g.edges), ['a→b', 'a→c', 'trg→a']);
});
