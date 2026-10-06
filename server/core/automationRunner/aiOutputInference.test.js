/**
 * The output schema a schemaless AI step is asked for follows how later
 * steps READ it.
 *
 * The runner used to keep only the first name after `steps.<id>.output.`
 * and typed every field as "string". So a step read as
 * `steps.ai.output.customer.contacts[0].email`, looped over as
 * `steps.ai.output.line_items` and picked as `steps.ai.output["Story Points"]`
 * told the model `{"line_items":"string","customer":"string"}`: a model that
 * obeyed broke the loop ("did not resolve to a list") and the nested read,
 * and the bracket read inferred nothing at all. Whether the mapping worked
 * depended on the model disobeying the schema.
 *
 * Run: node --test core/automationRunner/aiOutputInference.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectAiStepOutputReads, inferAiStepOutputSchema } = require('./aiOutputInference');

const def = (steps) => ({ trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'ai', type: 'ai_step', prompt: 'Extract' }, ...steps] });
const S = (props) => ({ type: 'object', properties: props });
const STR = { type: 'string' };

test('nested reads become nested objects, index and [*] reads become lists', () => {
    const d = def([
        { id: 'mail', type: 'integration_action', tool: 'send', inputs: {
            to: { kind: 'ref', path: 'steps.ai.output.customer.contacts[0].email' },
            name: { kind: 'template', value: 'Dear {{steps.ai.output.customer.name}}' },
            skus: { kind: 'ref', path: 'steps.ai.output.line_items[*].sku' },
        } },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({
        customer: S({ contacts: { type: 'array', items: S({ email: STR }) }, name: STR }),
        line_items: { type: 'array', items: S({ sku: STR }) },
    }));
});

test('a list source (forEach, loop, arrayRef) is a list, and the items take the fields the body reads', () => {
    const d = def([
        { id: 'each', type: 'integration_action', tool: 'create', forEach: { overRef: 'steps.ai.output.line_items', itemVar: 'line' },
            inputs: { sku: { kind: 'ref', path: 'loop.line.sku' }, qty: { kind: 'expr', value: 'number(loop.line.qty) * 2' } } },
        { id: 'f', type: 'filter', arrayRef: 'steps.ai.output.tags' },
        { id: 'l', type: 'loop', overRef: 'steps.ai.output.people', itemVar: 'p', body: [
            { id: 'n', type: 'notification', title: 'Hi {{loop.p.first_name}}' },
        ] },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({
        line_items: { type: 'array', items: S({ sku: STR, qty: STR }) },
        tags: { type: 'array' },
        people: { type: 'array', items: S({ first_name: STR }) },
    }));
});

test('bracket-quoted keys and expression bindings are consumers too', () => {
    const d = def([
        { id: 'jira', type: 'integration_action', tool: 'jira', inputs: {
            points: { kind: 'expr', value: 'steps.ai.output["Story Points"]' },
            epic: { kind: 'expr', value: 'upper(steps.ai.output.issue["Epic Link"])' },
            n: { kind: 'expr', value: 'count(steps.ai.output.subtasks) > 0 ? "yes" : "no"' },
        } },
        { id: 'c', type: 'condition', expr: 'steps.ai.output.score > 5 && steps.ai.output["is-urgent"]' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({
        'Story Points': STR,
        issue: S({ 'Epic Link': STR }),
        subtasks: { type: 'array' },
        score: STR,
        'is-urgent': STR,
    }));
});

test('in a formula a hyphen is a minus; in a reference it is part of the name', () => {
    const d = def([
        { id: 'c', type: 'condition', expr: 'steps.ai.output.count-1 > 0' },
        { id: 'x', type: 'integration_action', tool: 't', inputs: {
            a: { kind: 'expr', value: 'steps.ai.output.total-steps.ai.output.discount' },
            b: { kind: 'ref', path: 'steps.ai.output.first-name' },
        } },
    ]);
    assert.deepEqual(Object.keys(inferAiStepOutputSchema(d, 'ai').schema.properties), ['count', 'total', 'discount', 'first-name']);
});

test('top-level field names keep first-seen order (the prose fallback wraps under the first text field)', () => {
    const d = def([
        { id: 'x', type: 'notification', title: '{{steps.ai.output.summary}}', body: '{{steps.ai.output.items[0].title}} {{steps.ai.output.summary.length}}' },
    ]);
    const r = inferAiStepOutputSchema(d, 'ai');
    assert.deepEqual(r.fields, ['summary', 'items']);
    assert.deepEqual(r.schema.properties.summary, STR, '`.length` of a field is not a property of it');
    assert.equal(r.textField, 'summary');
});

test('a per-item AI step is read through results[*].output and loop.<item>.output', () => {
    const d = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'ai', type: 'ai_step', prompt: 'Extract the invoice', forEach: { overRef: 'steps.files.output.items', itemVar: 'f' } },
            { id: 'w', type: 'integration_action', tool: 'row', forEach: { overRef: 'steps.ai.output.results', itemVar: 'e' },
                inputs: { Datum: { kind: 'ref', path: 'loop.e.output.datum' }, Totaal: { kind: 'ref', path: 'loop.e.output.lines[*].amount' } } },
            { id: 'sum', type: 'notification', title: '{{steps.ai.output.results[*].output.vendor.name}} {{steps.ai.output.succeeded}}' },
        ],
    };
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({
        datum: STR,
        lines: { type: 'array', items: S({ amount: STR }) },
        vendor: S({ name: STR }),
    }));
});

test('match segments read the list of records they search', () => {
    const d = def([
        { id: 'x', type: 'notification', title: '{{steps.ai.output.headers[name="Subject"].value}}' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({
        headers: { type: 'array', items: S({ name: STR, value: STR }) },
    }));
});

test('other steps, the step itself and literal data are not consumers', () => {
    const d = def([
        { id: 'x', type: 'notification', title: '{{steps.other.output.a}} {{steps.aim.output.b}}', inputs: { v: { kind: 'literal', value: 'steps.ai.output.nope' } } },
    ]);
    d.steps[0].prompt = 'Use {{steps.ai.output.self}}';
    const r = inferAiStepOutputSchema(d, 'ai');
    assert.equal(r.schema, null);
    assert.deepEqual(r.fields, []);
    assert.deepEqual(collectAiStepOutputReads(d, 'ai'), []);
});

test('a step id that needs brackets is found too', () => {
    const d = {
        trigger: { id: 't', kind: 'manual' },
        steps: [
            { id: 'ai-1', type: 'ai_step', prompt: 'x' },
            { id: 'y', type: 'notification', title: '{{steps["ai-1"].output.title}}' },
        ],
    };
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai-1').schema, S({ title: STR }));
});

// ── count() measures text too ──────────────────────────────────────────────
// count('abc') is 3 and count({a:1}) is 1, so count() alone hints at a list
// only when nothing else reads the field: a field also rendered whole stays
// text, a field also read as a record stays a record.

test('count() of a field that is also read whole keeps it text', () => {
    const d = def([
        { id: 'c', type: 'condition', expr: 'count(steps.ai.output.summary) > 20' },
        { id: 'n', type: 'notification', title: 'Summary', body: '{{steps.ai.output.summary}}' },
    ]);
    const r = inferAiStepOutputSchema(d, 'ai');
    assert.deepEqual(r.schema, S({ summary: STR }));
    assert.equal(r.textField, 'summary');
});

test('count() of a field that is also read as a record keeps it a record', () => {
    const d = def([
        { id: 'c', type: 'condition', expr: 'count(steps.ai.output.customer) > 0' },
        { id: 'n', type: 'notification', title: 'Hi {{steps.ai.output.customer.name}}' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({ customer: S({ name: STR }) }));
});

test('fields read straight off a field that is looped over describe its items', () => {
    const d = def([
        { id: 'each', type: 'integration_action', tool: 't', forEach: { overRef: 'steps.ai.output.people', itemVar: 'p' }, inputs: {} },
        { id: 'n', type: 'notification', title: '{{steps.ai.output.people.name}}' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').schema, S({ people: { type: 'array', items: S({ name: STR }) } }));
});

// ── Only real reads count ──────────────────────────────────────────────────
// A canvas note, a code step's source, extraction instructions, a system
// prompt (used verbatim) and parse_json's relative paths are read by nothing
// at run time (portability.js leaves them alone for the same reason). A
// `steps.ai.output.x` mentioned there must not change what the AI step is
// asked for: a sticky note would turn a free-text answer into JSON.

test('notes, code, instructions, a system prompt and parse_json paths are not reads', () => {
    const d = def([
        { id: 'n1', type: 'note', text: 'Later we want to route on steps.ai.output.category here.', title: '{{steps.ai.output.title_from_note}}' },
        { id: 'c1', type: 'code', code: '// reads steps.ai.output.confidence via inputs\nreturn inputs;', inputs: {} },
        { id: 'x1', type: 'data_extraction', instructions: 'Use steps.ai.output.lang as the language.', source: { kind: 'literal', value: 'x' } },
        { id: 'a2', type: 'ai_step', prompt: 'Classify', systemPrompt: 'Answer in the tone of steps.ai.output.tone' },
        { id: 'p1', type: 'parse_json', sourceRef: 'steps.other.output.body', itemsRef: 'steps.ai.output.rows', fields: [{ name: 'f', path: 'steps.ai.output.f' }] },
        { id: 'w', type: 'notification', title: 'Kind', body: 'Kind: {{steps.ai.output}}' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai'), { schema: null, fields: [], textField: null });
});

test('prose in a field that is not a template is not a read; a reference or placeholder there is', () => {
    const d = def([
        { id: 'f', type: 'form', pages: [{ intro: 'We will show steps.ai.output.sentiment later', heading: '{{steps.ai.output.heading}}', ref: 'steps.ai.output.whole' }] },
        { id: 'n', type: 'notification', title: 'See steps.ai.output.subject', body: 'x' },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').fields, ['heading', 'whole', 'subject']);
});

test('an input named id, type, label or description is a read like any other', () => {
    const d = def([
        { id: 'j', type: 'integration_action', tool: 'jira_update', inputs: {
            id: { kind: 'ref', path: 'steps.ai.output.ticketId' },
            description: { kind: 'template', value: '{{steps.ai.output.body}}' },
            type: { kind: 'ref', path: 'steps.ai.output.kind' },
            label: { kind: 'expr', value: 'steps.ai.output.tag' },
        } },
    ]);
    assert.deepEqual(inferAiStepOutputSchema(d, 'ai').fields, ['ticketId', 'body', 'kind', 'tag']);
});

// ── A per-item step nested in a loop body or a parallel branch ─────────────
// The runner hands every nested step the ROOT definition, so the step itself
// has to be found where it sits; a nested per-item step is read through its
// envelope exactly like a top-level one.

const nestedPerItem = (wrap) => {
    const summ = { id: 'summ', type: 'ai_step', prompt: 'Summarise', forEach: { overRef: 'loop.batch.mails', itemVar: 'm' } };
    const note = { id: 'n', type: 'notification', title: 'x', body: '{{ steps.summ.output.results[*].output.summary }}' };
    return { trigger: { id: 't', kind: 'manual' }, steps: [{ id: 'src', type: 'code', code: 'return {}' }, wrap([summ, note])] };
};
const inLoop = (body) => ({ id: 'lp', type: 'loop', overRef: 'steps.src.output.batches', itemVar: 'batch', body });
const inParallel = (steps) => ({ id: 'par', type: 'parallel', branches: [steps, []] });

test('a per-item AI step inside a loop body or a parallel branch is read through its envelope', () => {
    for (const wrap of [inLoop, inParallel]) {
        const r = inferAiStepOutputSchema(nestedPerItem(wrap), 'summ');
        assert.deepEqual(r.schema, S({ summary: STR }));
        assert.equal(r.textField, 'summary');
    }
});

test('collectAiStepOutputReads returns the reads as written, envelope included', () => {
    const reads = collectAiStepOutputReads(nestedPerItem(inLoop), 'summ').map(r => r.path);
    assert.deepEqual(reads, ['results[*].output.summary']);
});
