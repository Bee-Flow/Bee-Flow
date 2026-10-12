/**
 * Follow the route on the AI builder's draft (W8): the shared rewrites
 * applied in place, and said as notes.
 *
 * Demo shape: "Read many" (rm) lists Fabrikam / Contoso mails, "Read
 * attachment" (ra) runs once per attachment of each mail. A Condition put
 * between them must make ra read what the Condition keeps — otherwise the
 * canvas says "kept 3 of 4" while all 11 attachments are read.
 *
 * Run: cd server && node --test automation/builderTools/routeFollowDraft.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { followAddedSteps, followPatchedRoute, followReplacedRoute } = require('./routeFollowDraft');

const readAttachment = (overRef, parent) => ({
    id: 'ra',
    type: 'integration_action',
    tool: 'gmail_read_attachment',
    label: 'Read attachment',
    forEach: { overRef, itemVar: 'att', ...(parent ? { parents: [{ itemVar: 'msg', overRef: parent }] } : {}) },
    inputs: { attachmentId: { kind: 'ref', path: 'loop.att.id' }, note: { kind: 'literal', value: 'steps.rm.output.messages' } },
});

function draft(route, successor, edgeLabel = null) {
    const edge = { from: route.id, to: successor.id };
    if (edgeLabel) { edge.label = `case:${edgeLabel}`; edge.caseName = edgeLabel; }
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'rm', type: 'integration_action', tool: 'gmail_read_many', label: 'Read many' }, route, successor],
        edges: [{ from: 'trg', to: 'rm' }, { from: 'rm', to: route.id }, edge],
    };
}

const stepOf = (graph, id) => graph.steps.find(s => s.id === id);

test('a filter put between Read many and Read attachment re-points the successor, in place', () => {
    const filter = { id: 'filt_x', type: 'filter', arrayRef: 'steps.rm.output.messages', expr: 'contains(item.from, "fabrikam")' };
    const graph = draft(filter, readAttachment('steps.rm.output.messages[*].attachments', 'steps.rm.output.messages'));
    const steps = graph.steps;
    const notes = followAddedSteps(graph, ['filt_x']);
    const ra = stepOf(graph, 'ra');
    assert.strictEqual(ra.forEach.overRef, 'steps.filt_x.output.items[*].attachments');
    assert.deepStrictEqual(ra.forEach.parents, [{ itemVar: 'msg', overRef: 'steps.filt_x.output.items' }]);
    assert.strictEqual(ra.inputs.note.value, 'steps.rm.output.messages', 'a literal is never rewritten');
    assert.strictEqual(graph.steps, steps, 'the draft keeps its own steps array');
    assert.deepStrictEqual(notes, [
        'Re-pointed ra to read what filt_x keeps: steps.filt_x.output.items[*].attachments (it read steps.rm.output.messages).',
    ]);
});

test('a step added after output "pdf" reads that output, not another one (W2)', () => {
    const sw = {
        id: 'sw_x', type: 'switch', arrayRef: 'steps.rm.output.messages[*].attachments',
        cases: [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }, { name: 'word', expr: 'equals(fileType(item), "word")' }],
    };
    const graph = draft(sw, readAttachment('steps.sw_x.output.matchesByCase.word'), 'pdf');
    const notes = followAddedSteps(graph, ['ra']);
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.sw_x.output.matchesByCase.pdf');
    assert.match(notes[0], /^Re-pointed ra to read what sw_x sends down output "pdf": steps\.sw_x\.output\.matchesByCase\.pdf/);
});

test('a step on Otherwise reads matchesByCase.default', () => {
    const sw = { id: 'sw_x', type: 'switch', arrayRef: 'steps.rm.output.messages', cases: [{ name: 'fabrikam', expr: 'contains(item.from, "fabrikam")' }] };
    const graph = draft(sw, readAttachment('steps.rm.output.messages[*].attachments'), 'default');
    const notes = followAddedSteps(graph, ['ra']);
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.sw_x.output.matchesByCase.default[*].attachments');
    assert.match(notes[0], /sends to "Otherwise"/);
});

test('nothing to follow: a whole-run condition, an unknown id, a step reading something else', () => {
    const cond = { id: 'cond_x', type: 'condition', expr: 'isEmpty(steps.rm.output.messages)' };
    const graph = draft(cond, readAttachment('steps.rm.output.messages[*].attachments'));
    const before = JSON.stringify(graph);
    assert.deepStrictEqual(followAddedSteps(graph, ['cond_x', 'ra', 'nope', 7]), []);
    assert.strictEqual(JSON.stringify(graph), before);
});

test('renaming an output moves its readers (W4)', () => {
    const previous = { id: 'sw_x', type: 'switch', arrayRef: 'steps.rm.output.messages', cases: [{ name: 'pdf', expr: 'true' }] };
    const graph = draft({ ...previous, cases: [{ name: 'invoices', expr: 'true' }] }, readAttachment('steps.sw_x.output.matchesByCase.pdf[*].attachments'), 'invoices');
    const notes = followPatchedRoute(graph, previous, 'sw_x');
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.sw_x.output.matchesByCase.invoices[*].attachments');
    assert.deepStrictEqual(notes, ['Re-pointed ra from steps.sw_x.output.matchesByCase.pdf to steps.sw_x.output.matchesByCase.invoices: the outputs of sw_x changed.']);
});

test('a list one level deeper collapses the readers and prunes their parents (W5)', () => {
    const previous = { id: 'filt_x', type: 'filter', arrayRef: 'steps.rm.output.messages', expr: 'true' };
    const now = { ...previous, arrayRef: 'steps.rm.output.messages[*].attachments' };
    const graph = draft(now, readAttachment('steps.filt_x.output.items[*].attachments', 'steps.filt_x.output.items'));
    followPatchedRoute(graph, previous, 'filt_x');
    const ra = stepOf(graph, 'ra');
    assert.strictEqual(ra.forEach.overRef, 'steps.filt_x.output.items');
    assert.ok(!('parents' in ra.forEach), 'the parent is no longer an outer list of the step');
});

test('an unrelated change of list rewrites nothing', () => {
    const previous = { id: 'filt_x', type: 'filter', arrayRef: 'steps.rm.output.messages', expr: 'true' };
    const graph = draft({ ...previous, arrayRef: 'steps.rm.output.threads' }, readAttachment('steps.filt_x.output.items[*].attachments'));
    assert.deepStrictEqual(followPatchedRoute(graph, previous, 'filt_x'), []);
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.filt_x.output.items[*].attachments');
});

test('a filter replaced by a list switch keeps its connection on the first output (W3)', () => {
    const previous = { id: 'r', type: 'filter', arrayRef: 'steps.rm.output.messages', expr: 'true' };
    const graph = draft({ id: 'r', type: 'switch', arrayRef: 'steps.rm.output.messages', cases: [{ name: 'pdf', expr: 'true' }, { name: 'word', expr: 'true' }] },
        readAttachment('steps.r.output.items[*].attachments'));
    const notes = followReplacedRoute(graph, previous, 'r');
    assert.deepStrictEqual(graph.edges.find(e => e.from === 'r'), { from: 'r', to: 'ra', label: 'case:pdf', caseName: 'pdf' });
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.r.output.matchesByCase.pdf[*].attachments');
    assert.strictEqual(notes.length, 1);
});

test('a list switch replaced by a filter hands its first output back to items', () => {
    const previous = { id: 'r', type: 'switch', arrayRef: 'steps.rm.output.messages', cases: [{ name: 'pdf', expr: 'true' }] };
    const graph = draft({ id: 'r', type: 'filter', arrayRef: 'steps.rm.output.messages', expr: 'true' }, readAttachment('steps.r.output.matchesByCase.pdf'));
    followReplacedRoute(graph, previous, 'r');
    assert.strictEqual(stepOf(graph, 'ra').forEach.overRef, 'steps.r.output.items');
    assert.deepStrictEqual(followReplacedRoute(graph, { id: 'r', type: 'condition', expr: 'true' }, 'nope'), []);
});
