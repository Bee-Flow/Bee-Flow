/**
 * The AI builder's `knowledge_write` tool.
 *
 * The properties worth pinning:
 *   - the model is told the fields are template STRINGS, but it has seen a
 *     thousand builder tools that take binding objects and will hand one over
 *     anyway. A binding is flattened back rather than stored in a second shape
 *     the editor cannot render;
 *   - re-pointing a write at a DIFFERENT base is not a patch. That is the one
 *     field the save-time permission check looks at, and a patch is the only
 *     path that could change it without the step being rebuilt;
 *   - filling a blank one IS allowed, because export deliberately blanks it.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools.knowledgeWrite.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { TOOL_SCHEMAS } = require('./builderTools');
const { applyAddKnowledgeWrite, bindingToTemplate, ADD_FOR_TYPE } = require('./builderTools/stepBuilders');
const { applyUpdateStep } = require('./builderTools/stepEditing');

const draft = () => ({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] });

// ── the tool surface ────────────────────────────────────────────────────────

test('the tool is offered, and requires the two things without which it does nothing', () => {
    const t = TOOL_SCHEMAS.find(x => x.function.name === 'builder_add_knowledge_write');
    assert.ok(t, 'builder_add_knowledge_write is on the tool surface');
    assert.deepStrictEqual(t.function.parameters.required, ['knowledgeBaseId', 'content']);
});

test('the tool can iterate — one article per item is the shape it exists for', () => {
    const t = TOOL_SCHEMAS.find(x => x.function.name === 'builder_add_knowledge_write');
    assert.ok(t.function.parameters.properties.forEach, 'forEach is injected like every other capable tool');
});

test('the description tells the model it cannot invent a knowledge base id', () => {
    // The one instruction that keeps it from confidently writing into nothing.
    const t = TOOL_SCHEMAS.find(x => x.function.name === 'builder_add_knowledge_write');
    assert.match(t.function.description, /never invent an id/i);
    assert.match(t.function.description, /MANAGE/);
});

// ── building ────────────────────────────────────────────────────────────────

test('a built step carries the fields the runner reads', () => {
    const d = draft();
    const { added } = applyAddKnowledgeWrite(d, {
        knowledgeBaseId: 'kb1', content: '{{steps.a.output.text}}',
        title: '{{steps.a.output.title}}', sourceUri: 'ticket:{{trigger.output.id}}',
    });
    assert.strictEqual(added.type, 'knowledge_write');
    assert.strictEqual(added.knowledgeBaseId, 'kb1');
    assert.strictEqual(added.content, '{{steps.a.output.text}}');
    assert.strictEqual(added.sourceUri, 'ticket:{{trigger.output.id}}');
    assert.strictEqual(d.steps.length, 1, 'and it lands on the graph');
});

test('a binding OBJECT is flattened back to a template string', () => {
    const { added } = applyAddKnowledgeWrite(draft(), {
        knowledgeBaseId: 'kb1',
        content: { kind: 'ref', path: 'steps.a.output.text' },
        title: { kind: 'template', value: 'Ticket {{trigger.output.id}}' },
        sourceUri: { kind: 'literal', value: 'ticket:1' },
    });
    assert.strictEqual(added.content, '{{steps.a.output.text}}');
    assert.strictEqual(added.title, 'Ticket {{trigger.output.id}}');
    assert.strictEqual(added.sourceUri, 'ticket:1');
});

test('bindingToTemplate survives anything a definition can carry', () => {
    assert.strictEqual(bindingToTemplate(undefined), '');
    assert.strictEqual(bindingToTemplate(null), '');
    assert.strictEqual(bindingToTemplate('plain'), 'plain');
    assert.strictEqual(bindingToTemplate({ kind: 'expr', value: 'a > 1' }), '', 'an expr has no template form');
    assert.strictEqual(bindingToTemplate({ kind: 'literal', value: 42 }), '42');
    assert.strictEqual(bindingToTemplate([1, 2]), '');
});

test("'skip' stays implicit, so a built step matches a stored one", () => {
    const plain = applyAddKnowledgeWrite(draft(), { knowledgeBaseId: 'kb1', content: 'x' }).added;
    assert.ok(!('nearDuplicateStrategy' in plain));
    const merged = applyAddKnowledgeWrite(draft(), { knowledgeBaseId: 'kb1', content: 'x', nearDuplicateStrategy: 'merge' }).added;
    assert.strictEqual(merged.nearDuplicateStrategy, 'merge');
});

test('a strategy nothing implements is dropped, not stored', () => {
    const { added } = applyAddKnowledgeWrite(draft(), { knowledgeBaseId: 'kb1', content: 'x', nearDuplicateStrategy: 'obliterate' });
    assert.ok(!('nearDuplicateStrategy' in added), 'a stored value nothing reads looks configured and does nothing');
});

test('the type is in ADD_FOR_TYPE, so builder_replace_step can build one', () => {
    assert.strictEqual(ADD_FOR_TYPE.knowledge_write, applyAddKnowledgeWrite);
});

// ── patching ────────────────────────────────────────────────────────────────

/** applyUpdateStep patches the GRAPH in place; it takes no wrapper. */
function graphWith(step) {
    return { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [step], edges: [{ from: 'trg', to: step.id }] };
}

test('the text, the title and the reference are ordinary patches', () => {
    const g = graphWith({ id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'old' });
    const res = applyUpdateStep(g, { stepId: 'w1', patch: { content: 'new', sourceUri: 'ticket:1', title: 'T' } });
    assert.ok(!res.error, res.error);
    const step = g.steps[0];
    assert.strictEqual(step.content, 'new');
    assert.strictEqual(step.sourceUri, 'ticket:1');
});

test('a patch may FILL a blank base — that is how an import is repaired', () => {
    const g = graphWith({ id: 'w1', type: 'knowledge_write', knowledgeBaseId: '', content: 'x' });
    const res = applyUpdateStep(g, { stepId: 'w1', patch: { knowledgeBaseId: 'kb1' } });
    assert.ok(!res.error, res.error);
    assert.strictEqual(g.steps[0].knowledgeBaseId, 'kb1');
});

test('a patch may NOT re-point a write at a different base', () => {
    // That is the field the save-time permission check looks at, and a patch
    // is the one path that could change it without the step being rebuilt.
    const g = graphWith({ id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'x' });
    const res = applyUpdateStep(g, { stepId: 'w1', patch: { knowledgeBaseId: 'kb_other' } });
    assert.match(res.error || '', /builder_replace_step/);
    assert.strictEqual(g.steps[0].knowledgeBaseId, 'kb1', 'and nothing moved');
});

test('a patched step is byte-identical to a freshly built one', () => {
    const g = graphWith({ id: 'w1', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'x' });
    applyUpdateStep(g, { stepId: 'w1', patch: { content: { kind: 'ref', path: 'steps.a.output.text' } } });
    assert.strictEqual(g.steps[0].content, '{{steps.a.output.text}}');
});
