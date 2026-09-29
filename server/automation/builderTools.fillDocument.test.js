/**
 * builder_add_fill_document — the AI/MCP route into the step that fills a
 * designed document, plus the validator rules behind it.
 *
 * The gate is the interesting part. A document id is the one thing the model
 * cannot invent (the person designed the document; nothing the builder does
 * creates one), so the tool checks it against the same catalog the prompt
 * renders — and answers the three cases differently: no catalog is permissive,
 * an EMPTY catalog refuses outright, and a wrong id names the real ones.
 *
 * The rest are registration canaries: a step type has to be in ADD_FOR_TYPE
 * for batch-add to accept it and in PATCHABLE_FIELDS for builder_update_step
 * to touch it. Miss either and the symptom is an "unknown type" or a silently
 * dropped patch, far from the cause.
 *
 * Run: node --test --test-force-exit automation/builderTools.fillDocument.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

const CATALOG = [{
    id: 'doc_1',
    name: 'Factuur',
    docType: 'invoice',
    placeholders: [
        { key: 'customer.name', kind: 'value' },
        { key: 'lines', kind: 'list', fields: ['description', 'amount'] },
    ],
}];

const freshWrap = (documents = CATALOG) => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
    _documents: documents,
});
const add = (dw, args) => applyToolCall('builder_add_fill_document', args, dw);
const only = (dw) => dw.def.steps[0];

test('the tool exists and asks for the one thing it cannot invent', () => {
    const schema = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_fill_document');
    assert.ok(schema, 'registered in TOOL_SCHEMAS');
    assert.deepStrictEqual(schema.function.parameters.required, ['documentId']);
});

test('an added step is valid on its own — no follow-up fixing required', async () => {
    const dw = freshWrap();
    const res = await add(dw, {
        documentId: 'doc_1',
        values: { 'customer.name': '{{trigger.output.naam}}', lines: '{{trigger.output.regels}}' },
    });
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.length, 1, 'the step really landed in the draft');
    const r = validateDefinition(dw.def);
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('defaults are filled in, so an author never meets an undefined field', async () => {
    const dw = freshWrap();
    await add(dw, { documentId: 'doc_1' });
    const step = only(dw);
    assert.strictEqual(step.type, 'fill_document');
    assert.deepStrictEqual(step.values, {});
    assert.strictEqual(step.fileName, '');
    assert.strictEqual(step.expiresInDays, 7);
    assert.strictEqual(step.saveCopy, undefined, 'the copy is opt-in and stays absent');
    assert.strictEqual(step.label, 'Fill a document');
});

// ── the id gate ────────────────────────────────────────────────────────────

test('a document id nobody has is refused, and the real ones are named', async () => {
    const res = await add(freshWrap(), { documentId: 'doc_made_up' });
    assert.match(res.error, /No document with id "doc_made_up"/);
    assert.match(res.error, /doc_1 \("Factuur"\)/, 'the model is told what it may pick instead');
});

test('an EMPTY catalog refuses and says where documents come from', async () => {
    // [] means "this user has none" — a different answer from "could not tell",
    // and the only one where retrying is pointless.
    const res = await add(freshWrap([]), { documentId: 'doc_1' });
    assert.match(res.error, /no designed documents/i);
    assert.match(res.error, /Studio → Documents/);
    assert.match(res.error, /Do not retry/);
});

test('NO catalog is permissive — an outage must not become a refusal', async () => {
    const dw = freshWrap(null);
    const res = await add(dw, { documentId: 'doc_whatever', values: { anything: 'x' } });
    assert.ok(!res.error, res.error);
    assert.strictEqual(only(dw).documentId, 'doc_whatever');
});

// ── the placeholder notes ──────────────────────────────────────────────────

test('a value bound to a placeholder that does not exist is a NOTE, not a refusal', async () => {
    // The document is hand-edited: a placeholder can appear or vanish a minute
    // after the catalog was read, and losing the whole build over a name would
    // cost more than the wrong key does.
    const dw = freshWrap();
    const res = await add(dw, { documentId: 'doc_1', values: { 'customer.name': '{{trigger.output.n}}', 'klant.naam': 'x', lines: '{{trigger.output.r}}' } });
    assert.ok(!res.error, res.error);
    assert.ok(res._warnings.some(w => w.includes('"klant.naam" is not a placeholder')), JSON.stringify(res._warnings));
    assert.strictEqual(only(dw).values['klant.naam'], 'x', 'it is still written — the run reports it as unused');
});

test('a placeholder left unbound is reported as printing blank', async () => {
    const res = await add(freshWrap(), { documentId: 'doc_1', values: { 'customer.name': '{{trigger.output.n}}' } });
    assert.ok(res._warnings.some(w => w.includes('"lines" has no value bound')), JSON.stringify(res._warnings));
});

// ── validator ──────────────────────────────────────────────────────────────

test('a step with no document is INCOMPLETE, not broken — the node lands before it is wired', () => {
    const def = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 'f1', type: 'fill_document', values: {} }], edges: [] };
    const r = validateDefinition(def);
    const codes = r.errors.map(e => e.code);
    assert.ok(codes.includes('fill_document.document_missing'), JSON.stringify(r.errors));
    const { COMPLETENESS_CODES } = require('./validate/completenessCodes');
    assert.ok(COMPLETENESS_CODES.has('fill_document.document_missing'), 'autosave must stay amber, not 400');
});

test('values must be a map, and an expiry outside 1..90 is refused', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'f1', type: 'fill_document', documentId: 'doc_1', values: ['nope'], expiresInDays: 400 }],
        edges: [],
    };
    const codes = validateDefinition(def).errors.map(e => e.code);
    assert.ok(codes.includes('fill_document.values_shape'), JSON.stringify(codes));
    assert.ok(codes.includes('fill_document.expiry_range'), JSON.stringify(codes));
});

test('a value pointing at a step that does not exist warns like any other bad ref', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'f1', type: 'fill_document', documentId: 'doc_1', values: { 'customer.name': '{{steps.ghost.output.x}}' } }],
        edges: [],
    };
    const r = validateDefinition(def);
    const all = [...(r.errors || []), ...(r.warnings || [])];
    assert.ok(all.some(i => JSON.stringify(i).includes('ghost')), JSON.stringify(all));
});

// ── registration canaries ──────────────────────────────────────────────────

test('builder_update_step can patch the step\'s own fields', async () => {
    const dw = freshWrap();
    await add(dw, { documentId: 'doc_1' });
    const res = await applyToolCall('builder_update_step', {
        stepId: only(dw).id,
        patch: { documentId: 'doc_1', fileName: 'Factuur {{trigger.output.nr}}', saveCopy: true, expiresInDays: 400 },
    }, dw);
    assert.ok(!res.error, res.error);
    const step = only(dw);
    assert.strictEqual(step.fileName, 'Factuur {{trigger.output.nr}}');
    assert.strictEqual(step.saveCopy, true);
    assert.strictEqual(step.expiresInDays, 90, 'the patch clamps exactly as the add path does');
});

test('the type is registered where batch-add and replace look it up', () => {
    const { ADD_FOR_TYPE } = require('./builderTools/stepBuilders');
    const { STEP_TYPES } = require('./builtinStepTools');
    assert.ok(typeof ADD_FOR_TYPE?.fill_document === 'function' || STEP_TYPES.has('fill_document'));
    assert.ok(STEP_TYPES.has('fill_document'), 'builtinStepTools must know the type');
});

// ── a presentation document ────────────────────────────────────────────────

test('format: pptx/pdf lands on the step for a presentation document, an unknown one is dropped on add and refused by the validator', async () => {
    const deckCatalog = [{ id: 'deck_1', name: 'Kwartaal', docType: 'presentation', placeholders: [{ key: 'title', kind: 'value' }] }];
    const dw = freshWrap(deckCatalog);
    await add(dw, { documentId: 'deck_1', format: 'pdf', values: { title: 'Q3' } });
    assert.strictEqual(only(dw).format, 'pdf');
    const dw2 = freshWrap(deckCatalog);
    await add(dw2, { documentId: 'deck_1', format: 'docx' });
    assert.strictEqual(only(dw2).format, undefined, 'not a format the step knows');
    const res = await applyToolCall('builder_update_step', { stepId: only(dw2).id, patch: { format: 'pptx' } }, dw2);
    assert.ok(!res.error, res.error);
    assert.strictEqual(only(dw2).format, 'pptx');
    const def = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 'f1', type: 'fill_document', documentId: 'deck_1', values: {}, format: 'odp' }], edges: [] };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'fill_document.format'));
    const schema = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_fill_document');
    assert.deepStrictEqual(schema.function.parameters.properties.format.enum, ['pptx', 'pdf']);
});
