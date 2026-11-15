/**
 * `images` on ai_step and data_extraction (validate/stepRules/imageRules.mts):
 * the shape is integrity, a model that cannot read images is refused with the
 * fix (completeness: a draft still saves, go-live does not), and without the
 * caller's fact nothing is said.
 *
 * Run: node --test automation/validate.images.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');
const { imageModelsFor, imageStepTypes } = require('./imageModelsFact.mts');

const HANDLE = { kind: 'ref', path: 'steps.read.output.sourceHandle' };

const def = (step) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'literal', value: '/R/a.png' } } },
        step,
    ],
    edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: step.id }],
});
const AI = { id: 'ask', type: 'ai_step', prompt: 'What is the total?', images: [HANDLE] };
const EXTRACT = { id: 'ex', type: 'data_extraction', images: [HANDLE], fields: [{ name: 'total', type: 'number', description: 'Total' }] };

const codes = (d, opts) => {
    const r = validateDefinition(d, opts);
    return { errors: r.errors.map((e) => e.code), warnings: (r.warnings || []).map((e) => e.code), r };
};

test('images bound to a read step validate clean without a model fact', () => {
    assert.deepStrictEqual(codes(def(AI)).errors, []);
    // With images, data_extraction needs no text source.
    assert.deepStrictEqual(codes(def(EXTRACT)).errors, []);
});

test('the shape: not a list, or an entry that is not a binding, is refused at every stage', () => {
    assert.ok(codes(def({ ...AI, images: 'steps.read.output' }), { stage: 'draft' }).errors.includes('ai_step.images_invalid'));
    assert.ok(codes(def({ ...EXTRACT, images: [{ path: '/R/a.png' }] }), { stage: 'draft' }).errors.includes('data_extraction.images_invalid'));
});

test('a tier whose model cannot read images is refused, with the tiers that can as the fix', () => {
    const fact = { tiers: { fast: false, standard: true }, dataExtraction: null };
    const { errors, r } = codes(def({ ...AI, modelTier: 'fast' }), { imageModels: fact });
    assert.deepStrictEqual(errors, ['ai_step.images_model_no_vision']);
    assert.match(r.errors[0].hint, /standard/);
    // Completeness: a draft still saves (a warning there), go-live is blocked.
    assert.deepStrictEqual(codes(def({ ...AI, modelTier: 'fast' }), { imageModels: fact, stage: 'draft' }).errors, []);
    assert.deepStrictEqual(codes(def({ ...AI, modelTier: 'standard' }), { imageModels: fact }).errors, []);
});

test('auto: an error when no tier sees, a warning when only some do', () => {
    assert.deepStrictEqual(codes(def(AI), { imageModels: { tiers: { fast: false }, dataExtraction: null } }).errors, ['ai_step.images_model_no_vision']);
    const mixed = codes(def(AI), { imageModels: { tiers: { fast: false, standard: true }, dataExtraction: null } });
    assert.deepStrictEqual(mixed.errors, []);
    assert.ok(mixed.warnings.includes('ai_step.images_model_auto'));
});

test('data_extraction on an extraction model without vision is refused', () => {
    assert.deepStrictEqual(codes(def(EXTRACT), { imageModels: { tiers: {}, dataExtraction: false } }).errors, ['data_extraction.images_model_no_vision']);
    assert.deepStrictEqual(codes(def(EXTRACT), { imageModels: { tiers: {}, dataExtraction: true } }).errors, []);
});

test('the fact is only built for a definition with images, from the owner\'s tiers', async () => {
    assert.deepStrictEqual([...imageStepTypes(def(AI))], ['ai_step']);
    assert.strictEqual(await imageModelsFor(def({ ...AI, images: [] }), { userId: 'u', orgId: 'o' }, { getUserTierMap: async () => { throw new Error('must not be asked'); } }), null);
    const fact = await imageModelsFor(def(AI), { userId: 'u', orgId: 'o' }, {
        getUserTierMap: async () => ({ fast: { modelId: 'small' }, standard: { modelId: 'seeing' }, empty: {} }),
        modelAcceptsImages: async (m) => m === 'seeing',
    });
    assert.deepStrictEqual(fact, { tiers: { fast: false, standard: true }, dataExtraction: null });
    const broken = await imageModelsFor(def(AI), { userId: 'u', orgId: 'o' }, { getUserTierMap: async () => { throw new Error('db'); } });
    assert.strictEqual(broken, null, 'a failed lookup never blocks');
});
