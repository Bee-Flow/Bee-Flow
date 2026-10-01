/**
 * aiSteps.mjs: the steps whose output shape the author declares.
 *
 * A data_extraction step's declared `fields` ARE its output shape. This is
 * what makes drag-and-drop binding work: the moment the author names a field,
 * a downstream step's variable tree lists `steps.<id>.output.<name>`, no
 * schema and no run needed. Placeholders are typed so the kind badges and the
 * mismatch box tell a date from an amount.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeUpstreamGroups, describeNode } from './index.mjs';

const step = {
    id: 'ex_1', type: 'data_extraction', label: 'Read the invoice',
    source: { kind: 'ref', path: 'steps.read.output.content' },
    fields: [
        { name: 'datum', type: 'date', description: 'Invoice date', required: true },
        { name: 'totaal', type: 'number' },
        { name: 'betaald', type: 'boolean' },
        { name: 'leverancier', type: 'string' },
        { name: '', type: 'string' },              // the panel's blank seed row
        { name: 'datum', type: 'string' },         // a duplicate, not yet renamed
    ],
};

test('data_extraction: describeNode lists exactly the named fields, typed, at steps.<id>.output.<name>', () => {
    const g = describeNode(step, { steps: [step], edges: [] }, new Map(), {});
    assert.equal(g.kind, 'data_extraction');
    assert.equal(g.label, 'Read the invoice');
    assert.equal(g.basePath, 'steps.ex_1.output');
    assert.deepStrictEqual(g.fields.map(f => f.key), ['datum', 'totaal', 'betaald', 'leverancier']);
    assert.deepStrictEqual(g.fields.map(f => f.path), [
        'steps.ex_1.output.datum', 'steps.ex_1.output.totaal', 'steps.ex_1.output.betaald', 'steps.ex_1.output.leverancier',
    ]);
    assert.deepStrictEqual(g.sample, { datum: '2026-01-15', totaal: 0, betaald: false, leverancier: '<string>' });
});

test('data_extraction: nothing named yet contributes an empty group, never a crash or a fake field', () => {
    const g = describeNode({ id: 'ex_2', type: 'data_extraction', fields: [{ name: '' }] }, { steps: [], edges: [] }, new Map(), {});
    assert.equal(g.label, 'Extract data');
    assert.deepStrictEqual(g.fields, []);
    assert.deepStrictEqual(g.sample, {});
});

test('data_extraction: a downstream step sees the fields in its variable groups', () => {
    const next = { id: 'n1', type: 'notification', title: '', body: '' };
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [step, next],
        edges: [{ from: 'trg', to: 'ex_1' }, { from: 'ex_1', to: 'n1' }],
    };
    const mine = computeUpstreamGroups(definition, 'n1', null).find(g => g.id === 'ex_1');
    assert.ok(mine);
    assert.ok(mine.fields.map(f => f.path).includes('steps.ex_1.output.totaal'));
});

test('data_extraction: a fan-out (forEach) reshapes the fields into results[*].output.<name>', () => {
    const fanned = { ...step, forEach: { overRef: 'steps.read.output.results', itemVar: 'f', maxIterations: 100 }, source: { kind: 'ref', path: 'loop.f.output.content' } };
    const next = { id: 'n1', type: 'notification', title: '', body: '' };
    const definition = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [{ id: 'read', type: 'code', code: 'return {results: []}' }, fanned, next],
        edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'ex_1' }, { from: 'ex_1', to: 'n1' }],
    };
    const mine = computeUpstreamGroups(definition, 'n1', null).find(g => g.id === 'ex_1');
    assert.equal(mine.forEach, true);
    const paths = mine.fields.map(f => f.path);
    assert.ok(paths.includes('steps.ex_1.output.results[*].output.totaal'));
    assert.ok(paths.includes('steps.ex_1.output.iterations'));
});

// Picker truth (node-audit C21): every offered path must exist at run time.
const AI_CATALOG = { triggerOutputs: { __manual: { fields: [], sample: {} } } };
const aiDef = (ai) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [ai, { id: 'n1', type: 'notification', title: 't' }],
    edges: [{ from: 'trg', to: 'ai1' }, { from: 'ai1', to: 'n1' }],
});

test('ai_step without a schema offers ONE honest leaf binding the whole output, no phantom text/toolCalls', () => {
    const g = computeUpstreamGroups(aiDef({ id: 'ai1', type: 'ai_step', prompt: 'p' }), 'n1', AI_CATALOG).find(x => x.id === 'ai1');
    assert.equal(g.fields.length, 1);
    assert.equal(g.fields[0].path, 'steps.ai1.output');
    assert.ok(!g.fields.some(f => f.key === 'text' || f.key === 'toolCalls'));
});

test('ai_step with a declared schema offers the schema fields', () => {
    const g = computeUpstreamGroups(aiDef({
        id: 'ai1', type: 'ai_step', prompt: 'p', outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
    }), 'n1', AI_CATALOG).find(x => x.id === 'ai1');
    assert.ok(g.fields.some(f => f.path === 'steps.ai1.output.verdict'));
});
