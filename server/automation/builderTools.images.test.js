/**
 * The builder's `images` on ai_step and data_extraction: added and patched in
 * the shape the validator and the runner read (builderTools/imageBindings.mts),
 * offered in both tool schemas, and a data_extraction with images needs no
 * text source.
 *
 * Run: cd server && node --test automation/builderTools.images.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const { applyAddAi, applyAddDataExtraction } = require('./builderTools/stepBuilders');
const { applyUpdateStep } = require('./builderTools/stepEditing');
const { sanitizeImageBindings } = require('./builderTools/imageBindings.mts');

const HANDLE = { kind: 'ref', path: 'steps.read.output.sourceHandle' };
const draft = () => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'literal', value: '/R/a.png' } } }],
    edges: [{ from: 'trg', to: 'read' }],
});

test('both tool schemas offer images', () => {
    for (const name of ['builder_add_ai_step', 'builder_add_data_extraction']) {
        const t = TOOL_SCHEMAS.find((s) => s.function.name === name);
        assert.strictEqual(t.function.parameters.properties.images.type, 'array', name);
    }
});

test('sanitizeImageBindings: bindings kept, a bare path upgraded to a ref, anything else refused', () => {
    assert.deepStrictEqual(sanitizeImageBindings(undefined), { images: [] });
    assert.deepStrictEqual(sanitizeImageBindings(['steps.read.output.sourceHandle']).images, [HANDLE]);
    assert.deepStrictEqual(sanitizeImageBindings(HANDLE).images, [HANDLE]);
    assert.match(sanitizeImageBindings([{ path: 'x' }]).error, /images\[0\]: not a binding/);
});

test('ai_step: images ride on the added step; absent means no key', () => {
    const g = draft();
    const { added } = applyAddAi(g, { prompt: 'What is on the receipt?', afterStepId: 'read', images: [HANDLE] });
    assert.deepStrictEqual(added.images, [HANDLE]);
    const plain = applyAddAi(draft(), { prompt: 'p', afterStepId: 'read' }).added;
    assert.ok(!('images' in plain));
    assert.match(applyAddAi(draft(), { prompt: 'p', images: [42] }).error, /not a binding/);
});

test('data_extraction: images alone are enough, no source needed', () => {
    const r = applyAddDataExtraction(draft(), { afterStepId: 'read', images: [HANDLE], fields: [{ name: 'total', type: 'number' }] });
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r.added.images, [HANDLE]);
    assert.ok(!('source' in r.added));
});

test('a patch sets and clears images', () => {
    const g = draft();
    const { added } = applyAddAi(g, { prompt: 'p', afterStepId: 'read' });
    applyUpdateStep(g, { stepId: added.id, patch: { images: [HANDLE] } });
    assert.deepStrictEqual(g.steps.find((s) => s.id === added.id).images, [HANDLE]);
    applyUpdateStep(g, { stepId: added.id, patch: { images: [] } });
    assert.strictEqual(g.steps.find((s) => s.id === added.id).images, undefined);
});
