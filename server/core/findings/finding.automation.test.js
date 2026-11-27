/**
 * The automation module's producer of the one Finding shape (./finding.js): the automation validator's draft/activate ladder
 * converts into Findings without a per-producer adapter. The shape itself is
 * finding.test.js.
 *
 * Run: node --test --test-force-exit core/findings/finding.automation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fromLegacy, isFinding } = require('./finding');

test('Automation validator: every record names the automation and, where the path has one, the step', () => {
    const { validateDefinitionStrict, validateDefinition } = require('../../automation/validate/definition');

    // A record about the graph itself: no step.
    const missing = validateDefinitionStrict({ steps: [], edges: [] }).errors.find((e) => e.code === 'trigger.missing');
    assert.equal(missing.kind, 'automation');
    assert.deepEqual(missing.targetRef, { kind: 'automation', id: null, path: 'trigger' });
    assert.equal(missing.severity, 'error', 'severity semantics are untouched');

    // A record about a top-level step: index path → step id.
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 's_first', type: 'set', assignments: [] }, { id: 's_odd', type: 'no_such_type' }],
        edges: [],
        layers: {
            enrich: {
                trigger: { id: 'ltrg', kind: 'layer_input', params: [] },
                steps: [{ id: 'l_odd', type: 'no_such_type' }],
                edges: [],
            },
        },
    };
    const strict = validateDefinitionStrict(def);
    const odd = strict.errors.find((e) => e.code === 'step.unknown_type' && e.path === 'steps[1].type');
    assert.ok(odd, 'the unknown step type is reported at its index');
    assert.equal(odd.targetRef.stepId, 's_odd', 'an index path resolves to the step id');

    // A record inside a layer keeps the full path and resolves the layer's step.
    const layerOdd = strict.errors.find((e) => e.code === 'step.unknown_type' && e.path.startsWith('layers.enrich.'));
    assert.ok(layerOdd, 'the layer step is reported');
    assert.equal(layerOdd.targetRef.path, 'layers.enrich.steps[0].type');
    assert.equal(layerOdd.targetRef.stepId, 'l_odd');

    // opts.target threads the automation's identity through validateGraph.
    // (validate/definition.js does not forward it yet — until it does, every
    // record from validateDefinition carries id null and the caller fills it
    // in via fromLegacy's third argument.)
    const { validateGraph } = require('../../automation/validate/graph');
    const direct = { errors: [], warnings: [] };
    validateGraph({ steps: [], edges: [] }, '', { ...direct, target: { id: 'auto_7', title: 'Kredietcheck' } });
    assert.equal(direct.errors[0].code, 'trigger.missing');
    assert.deepEqual(direct.errors[0].targetRef, { kind: 'automation', id: 'auto_7', title: 'Kredietcheck', path: 'trigger' });

    // The draft/activate ladder is intact and its verdict converts as blockedAt.
    const draft = validateDefinition({
        trigger: { id: 'trg', kind: 'schedule', schedule: {} }, steps: [], edges: [],
    }, { stage: 'draft' });
    const ladder = draft.warnings.find((w) => w.code === 'trigger.schedule_missing');
    assert.ok(ladder, 'a completeness code is a warning at draft stage');
    assert.equal(ladder.blockedAt, 'activate');
    assert.equal(ladder.targetRef.stepId, 'trg', 'the trigger path resolves to the trigger id');
    const f = fromLegacy('automation', ladder, { id: 'auto_7' });
    assert.equal(f.blockedAt, 'activate');
    assert.equal(f.severity, 'warning');

    // Every record of both runs is convertible — no per-code exceptions.
    for (const rec of [...strict.errors, ...strict.warnings, ...draft.errors, ...draft.warnings]) {
        assert.ok(isFinding(fromLegacy('automation', rec)), `${rec.code} converts`);
    }
});

test('Automation validator: a nested step is addressed by its own id, and edge paths name no step', () => {
    const { validateDefinitionStrict } = require('../../automation/validate/definition');
    const loop = (edges) => ({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'lp', type: 'loop', collection: 'trigger.items', body: [{ id: 'inner', type: 'no_such_type' }] }],
        edges,
    });
    // The per-step walk only runs once ids and edges are sound, so the two
    // cases need two definitions.
    const inner = validateDefinitionStrict(loop([{ from: 'trg', to: 'lp' }])).errors.find((e) => e.code === 'loop.body_item_type');
    assert.ok(inner, 'the body step is reported');
    // The container is addressed by ID here (the per-step walk knows it), the
    // body step too — a top-level record uses the index instead. Both forms
    // resolve.
    assert.equal(inner.path, 'steps[lp].body.steps[inner]');
    assert.equal(inner.targetRef.stepId, 'inner', 'the deepest addressed node wins over its loop');

    const edge = validateDefinitionStrict(loop([{ from: 'ghost', to: 'lp' }])).errors.find((e) => e.code === 'edge.unknown_from');
    assert.ok(edge);
    assert.equal('stepId' in edge.targetRef, false, 'an edge path addresses no step');
    assert.equal(edge.targetRef.path, 'edges[0].from');
});
