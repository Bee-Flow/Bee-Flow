/**
 * automationGraph — the definition reading every AI-Act signal shares.
 * Run: node --test --test-force-exit server/automation/automationGraph.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { walkSteps: sharedWalk } = require('./stepContract');
const g = require('./automationGraph');

// A routine with an AI step inside a loop body, a parallel with two branches
// (one holding a data_extraction), a summarize step (NOT AI) and two
// documents: one that references the loop's AI step, one that only comes
// after it. Plus a layer with its own AI step and document.
const FIXTURE = {
    trigger: { id: 't', kind: 'form', form: { fields: [] } },
    steps: [
        { id: 'read', type: 'integration_action', tool: 'drive_read' },
        {
            id: 'each', type: 'loop', items: 'steps.read.output.items',
            body: [
                { id: 'ai_1', type: 'ai_step', prompt: 'Summarise {{loop.item}}' },
                { id: 'sum', type: 'summarize', op: 'count' },
            ],
        },
        {
            id: 'par', type: 'parallel',
            branches: [
                [{ id: 'extract', type: 'data_extraction', source: { kind: 'ref', path: 'steps.read.output.text' } }],
                [{ id: 'note', type: 'notification', text: 'done' }],
            ],
        },
        { id: 'doc_ref', type: 'generate_document', content: '# Report\n{{steps.ai_1.output.text}}', title: 'Report', fileName: 'report' },
        { id: 'doc_after', type: 'generate_document', content: 'Fixed text {{steps.read.output.count}}', title: 'Plain' },
        { id: 'page', type: 'form_page', mode: 'ending', form: { fields: [] } },
    ],
    edges: [],
    layers: {
        helper: {
            trigger: { id: 'lt', kind: 'layer_input', params: [] },
            steps: [
                { id: 'l_ai', type: 'ai_tool', prompt: 'x' },
                { id: 'l_doc', type: 'generate_document', content: { kind: 'template', value: 'Out: {{steps.l_ai.output.text}}' } },
                { id: 'l_out', type: 'layer_output', fields: {} },
            ],
            edges: [],
        },
    },
};

test('isAiStep: ai_step, data_extraction and ai_tool are AI; summarize and the rest are not', () => {
    assert.deepStrictEqual([...g.AI_STEP_TYPES], ['ai_step', 'data_extraction', 'ai_tool']);
    assert.ok(Object.isFrozen(g.AI_STEP_TYPES));
    for (const type of g.AI_STEP_TYPES) assert.ok(g.isAiStep({ id: 'x', type }), type);
    for (const type of ['summarize', 'aggregate', 'integration_action', 'generate_document', 'code', 'loop']) {
        assert.strictEqual(g.isAiStep({ id: 'x', type }), false, `${type} must not count as AI`);
    }
    assert.strictEqual(g.isAiStep(null), false);
    assert.strictEqual(g.isAiStep('ai_step'), false);
});

test('walkSteps visits every step incl. loop bodies, parallel branches and layers, parents first', () => {
    const seen = [];
    g.walkSteps(FIXTURE, (s, ctx) => seen.push([s.id, ctx.path, ctx.parentId, ctx.layer]));
    assert.deepStrictEqual(seen, [
        ['read', 'steps[0]', null, null],
        ['each', 'steps[1]', null, null],
        ['ai_1', 'steps[1].body.steps[ai_1]', 'each', null],
        ['sum', 'steps[1].body.steps[sum]', 'each', null],
        ['par', 'steps[2]', null, null],
        ['extract', 'steps[2].branches[0].steps[extract]', 'par', null],
        ['note', 'steps[2].branches[1].steps[note]', 'par', null],
        ['doc_ref', 'steps[3]', null, null],
        ['doc_after', 'steps[4]', null, null],
        ['page', 'steps[5]', null, null],
        ['l_ai', 'layers[helper].steps[0]', null, 'helper'],
        ['l_doc', 'layers[helper].steps[1]', null, 'helper'],
        ['l_out', 'layers[helper].steps[2]', null, 'helper'],
    ]);
});

test('walkSteps agrees with the shared automation walker on the set of root steps', () => {
    // The nesting rule is the shared one — this pins that the two never drift.
    const shared = [];
    sharedWalk(FIXTURE.steps, (s) => shared.push(s.id));
    const ours = [];
    g.walkSteps(FIXTURE, (s, ctx) => { if (ctx.layer === null) ours.push(s.id); });
    assert.deepStrictEqual(ours, shared);
});

test('walkSteps descends into a loop nested in a parallel branch', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [{
            id: 'par', type: 'parallel',
            branches: [[{ id: 'inner_loop', type: 'loop', body: [{ id: 'deep_ai', type: 'ai_step' }] }]],
        }],
    };
    const seen = g.listSteps(def).map(x => [x.step.id, x.parentId, x.path]);
    assert.deepStrictEqual(seen, [
        ['par', null, 'steps[0]'],
        ['inner_loop', 'par', 'steps[0].branches[0].steps[inner_loop]'],
        ['deep_ai', 'inner_loop', 'steps[0].branches[0].steps[inner_loop].body.steps[deep_ai]'],
    ]);
    assert.deepStrictEqual(g.aiSteps(def).map(x => x.step.id), ['deep_ai']);
});

test('walkSteps tolerates junk shapes', () => {
    const calls = [];
    g.walkSteps(null, () => calls.push(1));
    g.walkSteps({}, () => calls.push(1));
    g.walkSteps({ steps: 'nope', layers: 'nope' }, () => calls.push(1));
    g.walkSteps({ steps: [null, 'x', 4, { id: 'ok', type: 'set' }], layers: { a: null } }, (s) => calls.push(s.id));
    assert.deepStrictEqual(calls, ['ok']);
    assert.deepStrictEqual(g.listSteps(undefined), []);
});

test('aiSteps lists the model-calling steps across nesting and layers, summarize excluded', () => {
    assert.deepStrictEqual(g.aiSteps(FIXTURE).map(x => x.step.id), ['ai_1', 'extract', 'l_ai']);
});

test('generatingStepsDownstreamOfAi: a template reference is the strongest signal, walk order the fallback', () => {
    const out = g.generatingStepsDownstreamOfAi(FIXTURE);
    const byId = Object.fromEntries(out.map(x => [x.step.id, x]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['doc_after', 'doc_ref', 'l_doc']);

    assert.strictEqual(byId.doc_ref.signal, 'reference');
    assert.deepStrictEqual(byId.doc_ref.aiStepIds, ['ai_1']);

    assert.strictEqual(byId.doc_after.signal, 'downstream');
    // Every AI step of the root graph that precedes it, in walk order.
    assert.deepStrictEqual(byId.doc_after.aiStepIds, ['ai_1', 'extract']);

    // The layer's document references the layer's ai_tool via a binding object.
    assert.strictEqual(byId.l_doc.signal, 'reference');
    assert.deepStrictEqual(byId.l_doc.aiStepIds, ['l_ai']);
    assert.strictEqual(byId.l_doc.layer, 'helper');
});

test('generatingStepsDownstreamOfAi: a document before any AI step is not a subject', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'doc', type: 'generate_document', content: 'static' },
            { id: 'ai', type: 'ai_step' },
        ],
    };
    assert.deepStrictEqual(g.generatingStepsDownstreamOfAi(def), []);
});

test('generatingStepsDownstreamOfAi: a reference wins even when the document comes first', () => {
    // A later AI step referenced in the title — the graph order is edges, not
    // the array; the reference is what says the model wrote it.
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'doc', type: 'generate_document', content: 'x', title: '{{steps.ai.output.title}}' },
            { id: 'ai', type: 'ai_step' },
        ],
    };
    const [hit] = g.generatingStepsDownstreamOfAi(def);
    assert.strictEqual(hit.step.id, 'doc');
    assert.strictEqual(hit.signal, 'reference');
});

test('generatingStepsDownstreamOfAi: `steps.ai_1` does not match `steps.ai_10`', () => {
    const def = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'ai_10', type: 'ai_step' },
            { id: 'doc', type: 'generate_document', content: '{{steps.ai_1.output.text}}' },
        ],
    };
    const [hit] = g.generatingStepsDownstreamOfAi(def);
    assert.strictEqual(hit.signal, 'downstream', 'no exact reference → falls back to walk order');
    assert.deepStrictEqual(hit.aiStepIds, ['ai_10']);
});

test('generatingStepsDownstreamOfAi: a routine without AI steps has no subjects', () => {
    const def = { trigger: { id: 't', kind: 'manual' }, steps: [
        { id: 'sum', type: 'summarize' },
        { id: 'doc', type: 'generate_document', content: '{{steps.sum.output}}' },
    ] };
    assert.deepStrictEqual(g.generatingStepsDownstreamOfAi(def), [], 'summarize output in a document is not model output');
});

test('templateText reads strings and the binding shapes the builder flattens', () => {
    assert.strictEqual(g.templateText('a {{b}}'), 'a {{b}}');
    assert.strictEqual(g.templateText({ kind: 'template', value: 'v' }), 'v');
    assert.strictEqual(g.templateText({ kind: 'ref', path: 'steps.x.output' }), 'steps.x.output');
    assert.strictEqual(g.templateText(null), '');
    assert.strictEqual(g.templateText(42), '');
});

test('formTriggersOf and hasFormPage', () => {
    assert.strictEqual(g.formTriggersOf(FIXTURE).length, 1);
    assert.strictEqual(g.hasFormPage(FIXTURE), true);

    const multi = { trigger: { id: 't', kind: 'schedule' }, triggers: [{ id: 't2', kind: 'form' }, { id: 't3', kind: 'webhook' }], steps: [] };
    assert.deepStrictEqual(g.formTriggersOf(multi).map(t => t.id), ['t2']);
    assert.strictEqual(g.hasFormPage(multi), true);

    const pageOnly = { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'l', type: 'loop', body: [{ id: 'p', type: 'form_page', mode: 'input' }] }] };
    assert.deepStrictEqual(g.formTriggersOf(pageOnly), []);
    assert.strictEqual(g.hasFormPage(pageOnly), true, 'a nested form_page still makes the routine customer-facing');

    const none = { trigger: { id: 't', kind: 'schedule' }, steps: [{ id: 'a', type: 'ai_step' }] };
    assert.strictEqual(g.hasFormPage(none), false);
    assert.strictEqual(g.hasFormPage(null), false);
});

// M5: the AI builder (and the editor) store a document's text as a compose,
// and a deck's slides may be a pick. Both hold the AI step's id as data, not
// as `steps.<id>` text — the reference signal must still see it.
test('generatingStepsDownstreamOfAi: a compose or a pick that reads the AI step is a reference', () => {
    const part = (id, field) => ({ from: { root: 'steps', id, path: [field] }, take: 'one', as: 'text' });
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'ai_9', type: 'ai_step', prompt: 'write' },
            { id: 'doc', type: 'generate_document', content: { kind: 'compose', v: 1, parts: ['# Rapport\n', part('ai_9', 'text')] } },
            { id: 'fill', type: 'fill_document', values: { body: { kind: 'pick', v: 1, from: { root: 'steps', id: 'ai_9', path: ['text'] }, take: 'one', as: 'native' } } },
            { id: 'deck', type: 'presentation', slides: { kind: 'pick', v: 1, from: { root: 'steps', id: 'ai_9', path: ['outline'] }, take: 'one', as: 'native' } },
        ],
        edges: [],
    };
    const out = Object.fromEntries(g.generatingStepsDownstreamOfAi(def).map(x => [x.step.id, x]));
    for (const id of ['doc', 'fill', 'deck']) {
        assert.strictEqual(out[id].signal, 'reference', id);
        assert.deepStrictEqual(out[id].aiStepIds, ['ai_9'], id);
    }
    assert.strictEqual(g.templateText(def.steps[1].content), '# Rapport\n{{steps.ai_9.output.text}}');
});
