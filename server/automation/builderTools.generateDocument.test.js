/**
 * builder_add_generate_document — the AI/MCP route into the new step.
 *
 * Several of these are registration canaries rather than behaviour tests: a
 * step type has to be in ADD_FOR_TYPE for batch-add to accept it, and in
 * PATCHABLE_FIELDS for builder_update_step to touch it. Miss either and the
 * symptom is a confusing "unknown type" or a patch that is silently dropped,
 * far from the code that caused it.
 *
 * Run: node --test automation/builderTools.generateDocument.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

// applyToolCall(name, args, draftWrap) — async, mutates draftWrap.def in place.
const freshWrap = () => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
});
const add = (dw, args) => applyToolCall('builder_add_generate_document', args, dw);
const only = (dw) => dw.def.steps[0];

test('the tool exists and asks for the one thing it cannot invent', () => {
    const schema = TOOL_SCHEMAS.find(t => t.function.name === 'builder_add_generate_document');
    assert.ok(schema, 'registered in TOOL_SCHEMAS');
    assert.deepStrictEqual(schema.function.parameters.required, ['content']);
    assert.deepStrictEqual(schema.function.parameters.properties.format.enum, ['pdf', 'docx']);
});

test('an added step is valid on its own — no follow-up fixing required', async () => {
    const dw = freshWrap();
    const res = await add(dw, { content: '{{trigger.output.text}}', title: 'Offerte', format: 'pdf' });
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.length, 1, 'the step really landed in the draft');
    const r = validateDefinition(dw.def);
    assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('defaults are filled in, so an author never meets an undefined field', async () => {
    const dw = freshWrap();
    await add(dw, { content: '{{trigger.output.text}}' });
    const step = only(dw);
    assert.strictEqual(step.type, 'generate_document');
    assert.strictEqual(step.format, 'pdf');
    assert.strictEqual(step.contentFormat, 'markdown');
    assert.strictEqual(step.expiresInDays, 7);
    assert.strictEqual(step.label, 'Make a document');
});

test('the default label matches the canvas — nodeDefs.serverLabels.test.js compares them', async () => {
    const dw = freshWrap();
    await add(dw, { content: 'x' });
    assert.strictEqual(only(dw).label, 'Make a document');
});

test('content is required, and the message says how to bind it', async () => {
    const res = await add(freshWrap(), { title: 'Zonder inhoud' });
    assert.ok(res.error, 'refused');
    assert.match(res.error, /\{\{steps/, 'the error shows the shape of a binding');
});

test('the retention window is clamped, not rejected, on the way in', async () => {
    const dw = freshWrap();
    await add(dw, { content: 'x', expiresInDays: 9999 });
    assert.strictEqual(only(dw).expiresInDays, 90);

    const dw2 = freshWrap();
    await add(dw2, { content: 'x', expiresInDays: 0 });
    assert.strictEqual(only(dw2).expiresInDays, 1);
});

test('it carries no forEach — the validator would reject one', async () => {
    // FOREACH_ALLOWED in validate.js does not include this type, so accepting a
    // forEach here would mint a step that fails validation immediately.
    const dw = freshWrap();
    await add(dw, { content: 'x', forEach: { overRef: 'trigger.output.rows', itemVar: 'row' } });
    assert.strictEqual(only(dw).forEach, undefined);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});

test('batch add accepts the type — ADD_FOR_TYPE registration', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_steps', {
        steps: [{ type: 'generate_document', spec: { content: '{{trigger.output.text}}', format: 'docx' } }],
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(only(dw).format, 'docx');
});

test('an update patches in place and leaves the other fields alone', async () => {
    const dw = freshWrap();
    await add(dw, { content: '{{trigger.output.text}}', title: 'Eerste', format: 'pdf' });
    const id = only(dw).id;

    const res = await applyToolCall('builder_update_step', { stepId: id, patch: { format: 'docx' } }, dw);
    assert.ok(!res.error, res.error);
    const step = only(dw);
    assert.strictEqual(step.id, id, 'the id survives — downstream bindings keep working');
    assert.strictEqual(step.format, 'docx');
    assert.strictEqual(step.title, 'Eerste', 'the title was not wiped');
    assert.strictEqual(step.content, '{{trigger.output.text}}');
});

test('a patched clamp matches the one applied on add', async () => {
    const dw = freshWrap();
    await add(dw, { content: 'x' });
    await applyToolCall('builder_update_step', { stepId: only(dw).id, patch: { expiresInDays: 500 } }, dw);
    assert.strictEqual(only(dw).expiresInDays, 90);
    assert.deepStrictEqual(validateDefinition(dw.def).errors, []);
});
