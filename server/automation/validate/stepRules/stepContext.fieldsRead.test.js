/**
 * Which fields of a step's output later steps read (`fieldsReadFromStep`).
 *
 * It was a dotted-identifier regex over JSON.stringify of every later step:
 * a bracket read (`output["Total (EUR)"]`, `steps["ex1"]…`) was never seen,
 * so a data_extraction did not warn that nobody extracts the field a later
 * step reads, a label or description that merely mentioned a path counted as
 * a read, and `results[*].output.<f>` (how the hint itself says to read a
 * per-item step) was not counted as served. It now reads the same reads the
 * runner infers a schemaless step's schema from
 * (aiOutputInference.collectAiStepOutputReads), so the two cannot disagree.
 *
 * Run: cd server && node --test automation/validate/stepRules/stepContext.fieldsRead.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createStepContext } = require('./stepContext');
const { validateDefinition } = require('../../validate');

const read = (graph, id) => {
    const r = createStepContext({ graph }).fieldsReadFromStep(id);
    return { all: [...r.all].sort(), viaLoop: [...r.viaLoop].sort() };
};

function graph(extract, consumers) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [extract, ...consumers],
        edges: [{ from: 'trg', to: extract.id }, ...consumers.map(c => ({ from: extract.id, to: c.id }))],
    };
}
const EX = { id: 'ex1', type: 'data_extraction', source: { kind: 'ref', path: 'trigger.output.text' }, fields: [{ name: 'totaal', type: 'number', description: 'total' }] };

test('bracket reads and a bracketed step id are reads', () => {
    const g = graph(EX, [
        { id: 'n1', type: 'notification', title: 'x', body: '{{steps.ex1.output["Total (EUR)"]}} {{ steps["ex1"].output.leverancier }}' },
    ]);
    assert.deepStrictEqual(read(g, 'ex1').all, ['Total (EUR)', 'leverancier']);
});

test('a formula reads `count` minus one, a path reads the field "count-1"', () => {
    const g = graph(EX, [
        { id: 'n1', type: 'notification', title: 'x', body: 'b', inputs: { a: { kind: 'expr', value: 'steps.ex1.output.count-1' }, b: { kind: 'ref', path: 'steps.ex1.output.net-total' } } },
    ]);
    assert.deepStrictEqual(read(g, 'ex1').all, ['count', 'net-total']);
});

test('prose in a label or description is not a read', () => {
    const g = graph(EX, [
        { id: 'n1', type: 'notification', label: 'uses steps.ex1.output.ghost', description: 'see steps.ex1.output.phantom', title: 'x', body: 'b' },
    ]);
    assert.deepStrictEqual(read(g, 'ex1').all, []);
});

test('a per-item step: the fan-out reads are served, a direct field read is not', () => {
    const perItem = { ...EX, forEach: { overRef: 'trigger.output.files', itemVar: 'f' }, source: { kind: 'ref', path: 'loop.f.text' } };
    const g = graph(perItem, [
        { id: 'n1', type: 'notification', title: 'x', body: '{{loop.r.output.totaal}}', forEach: { overRef: 'steps.ex1.output.results', itemVar: 'r' } },
        { id: 'n2', type: 'notification', title: 'x', body: '{{steps.ex1.output.results[0].output.btw}} {{steps.ex1.output.direct}} {{steps.ex1.output.succeeded}}' },
    ]);
    const r = read(g, 'ex1');
    assert.deepStrictEqual(r.viaLoop, ['btw', 'totaal']);
    assert.deepStrictEqual(r.all, ['btw', 'direct', 'totaal'], 'the wrapper key `succeeded` is not a field');
});

test('validator: a bracket read of an undeclared field warns', () => {
    const g = graph(EX, [{ id: 'n1', type: 'notification', title: 'x', body: '{{steps.ex1.output["Total (EUR)"]}} {{steps.ex1.output.totaal}}' }]);
    const w = validateDefinition(g).warnings.find(x => x.code === 'data_extraction.field_not_declared');
    assert.ok(w, 'warned');
    assert.match(w.message, /Total \(EUR\)/);
    assert.doesNotMatch(w.message, /`totaal`/);
});
