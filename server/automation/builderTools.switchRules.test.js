/**
 * A switch case may carry its OWN rule, and neither the add path nor the patch
 * path may throw it away.
 *
 * A case is `{ name, value }` — compared against the step-level expr — or
 * `{ name, expr }`, carrying its own condition. The validator states that in
 * its own hint ("Each case needs { name, value } or { name, expr }"), parses
 * `c.expr` through the restricted grammar, and the runtime evaluates it
 * (execControl.switchCaseRule). It is the shape the canvas editor writes for
 * every rule-style router — one output per rule.
 *
 * Both builder paths nevertheless rebuilt a case as `{ name: c.name,
 * value: c.value }`, which DROPPED `expr`:
 *   - applyAddSwitch, so the AI could not build a rule-style switch at all —
 *     every case arrived as `{name, value: undefined}`, which then matches by
 *     loose `undefined == undefined` at run time;
 *   - stepEditing's patch normaliser, so ANY builder_update_step touching
 *     `cases` silently erased the author's expressions, with no warning and
 *     no undo.
 *
 * That is the same class of loss BFSF-356 fixed on the client, where
 * routeModel.js now persists `routeStyle` rather than deriving it — the note
 * there ("deriving it silently destroyed work") describes this bug's twin.
 * Nothing pinned the server half, so it survived the client fix.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools.switchRules.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');

const freshWrap = () => ({
    userId: 'u_test',
    def: { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
});
const lastStep = (dw) => dw.def.steps[dw.def.steps.length - 1];

// The three-output file-type router the canvas editor produces: every output
// carries its own rule, so there is no step-level value to compare against.
const RULE_CASES = [
    { name: 'pdf', expr: "endsWith(lower(item.name), '.pdf')" },
    { name: 'word', expr: "endsWith(lower(item.name), '.doc') || endsWith(lower(item.name), '.docx')" },
    { name: 'powerpoint', expr: "endsWith(lower(item.name), '.ppt') || endsWith(lower(item.name), '.pptx')" },
];

test('builder_add_switch keeps each case rule instead of flattening it to {name, value}', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_switch', { expr: 'item', cases: RULE_CASES }, dw);
    assert.ok(!res.error, res.error);

    const step = lastStep(dw);
    assert.strictEqual(step.type, 'switch');
    assert.deepStrictEqual(step.cases.map(c => c.name), ['pdf', 'word', 'powerpoint']);
    for (const [i, c] of step.cases.entries()) {
        assert.strictEqual(c.expr, RULE_CASES[i].expr, `case ${c.name} lost its rule`);
    }
});

test('a rule-only case does not gain a phantom `value` key', async () => {
    // `value: undefined` is not harmless: switchValueMatches compares with
    // loose equality, so an undefined cell would match an undefined case and
    // the first output would swallow every row.
    const dw = freshWrap();
    await applyToolCall('builder_add_switch', { expr: 'item', cases: RULE_CASES }, dw);
    for (const c of lastStep(dw).cases) {
        assert.ok(!('value' in c), `case ${c.name} carries a phantom value key`);
    }
});

test('value-style cases are untouched — including a falsy value', async () => {
    const dw = freshWrap();
    const cases = [{ name: 'zero', value: 0 }, { name: 'empty', value: '' }, { name: 'no', value: false }];
    const res = await applyToolCall('builder_add_switch', { expr: 'trigger.output.n', cases }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(lastStep(dw).cases, cases);
});

test('builder_update_step does not erase the rules it is not changing', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_add_switch', { expr: 'item', cases: RULE_CASES }, dw);
    const id = lastStep(dw).id;

    // Rename one output. The other two must come back with their rules intact
    // — this is the patch that used to wipe all three.
    const renamed = RULE_CASES.map(c => (c.name === 'word' ? { ...c, name: 'document' } : c));
    const res = await applyToolCall('builder_update_step', { stepId: id, patch: { cases: renamed } }, dw);
    assert.ok(!res.error, res.error);

    const cases = dw.def.steps.find(s => s.id === id).cases;
    assert.deepStrictEqual(cases.map(c => c.name), ['pdf', 'document', 'powerpoint']);
    for (const c of cases) assert.ok(c.expr && c.expr.length > 0, `case ${c.name} lost its rule on patch`);
});

test('the add and patch paths agree — one sanitizer, so they cannot drift', async () => {
    const added = freshWrap();
    await applyToolCall('builder_add_switch', { expr: 'item', cases: RULE_CASES }, added);

    const patched = freshWrap();
    await applyToolCall('builder_add_switch', { expr: 'item', cases: [{ name: 'placeholder', value: 'x' }] }, patched);
    const id = lastStep(patched).id;
    await applyToolCall('builder_update_step', { stepId: id, patch: { cases: RULE_CASES } }, patched);

    assert.deepStrictEqual(
        patched.def.steps.find(s => s.id === id).cases,
        lastStep(added).cases,
        'a patched switch is no longer byte-identical to a freshly added one',
    );
});

test('the tool schema lets a model express a per-case rule at all', () => {
    // Without this the fix is inert: llama.cpp compiles the schema into the
    // decoding grammar, so an undeclared key is not just undocumented — a
    // small model is physically unable to emit it.
    const sw = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_add_switch');
    assert.ok(sw, 'builder_add_switch is gone');
    const item = sw.function.parameters.properties.cases.items;
    assert.ok(item.properties.expr, 'a case cannot declare its own rule');
    assert.deepStrictEqual(item.required, ['name'], 'name is the only required key on a case');
    assert.match(sw.function.description, /\{ name, expr \}/, 'the description never teaches the rule-style shape');
});

// ── A1/A2: a switch that works through a list ────────────────────────────────

const LIST_ARGS = {
    arrayRef: 'trigger.output.files',
    cases: [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }, { name: 'word', expr: 'equals(fileType(item), "word")' }],
};

test('A1: builder_add_switch keeps arrayRef, matchMode "all" and maxItems, and writes routeStyle', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_switch', { ...LIST_ARGS, matchMode: 'all', maxItems: 50 }, dw);
    assert.ok(!res.error, res.error);
    const step = lastStep(dw);
    assert.strictEqual(step.arrayRef, 'trigger.output.files');
    assert.strictEqual(step.matchMode, 'all');
    assert.strictEqual(step.maxItems, 50);
    assert.strictEqual(step.routeStyle, 'rules');
    assert.ok(!('expr' in step), 'a list switch needs no step-level expr');
});

test('A1: matchMode "first", a bad maxItems and a value-style switch write nothing extra', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_add_switch', { ...LIST_ARGS, matchMode: 'first', maxItems: 0 }, dw);
    const step = lastStep(dw);
    assert.ok(!('matchMode' in step) && !('maxItems' in step));
    const value = freshWrap();
    await applyToolCall('builder_add_switch', { expr: 'trigger.output.priority', cases: [{ name: 'urgent', value: 'high' }], maxItems: 5 }, value);
    const v = lastStep(value);
    assert.ok(!('routeStyle' in v) && !('arrayRef' in v) && !('maxItems' in v), JSON.stringify(v));
});

test('A1: the list goes through the same arrayRef sanitizer as a filter, notes included', async () => {
    const dw = freshWrap();
    dw.def.steps.push({ id: 'rm', type: 'integration_action', tool: 'gmail_read_many', inputs: {},
        pinnedOutput: { messages: [{ id: 'm1', attachments: [{ filename: 'invoice.pdf' }] }] } });
    dw.def.edges.push({ from: 'trg', to: 'rm' });
    const res = await applyToolCall('builder_add_switch', { ...LIST_ARGS, afterStepId: 'rm', arrayRef: 'steps.rm.output.messages.attachments' }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.added.arrayRef, 'steps.rm.output.messages[*].attachments');
    assert.ok(res._warnings.some(w => w.startsWith('arrayRef: read "steps.rm.output.messages.attachments"')), JSON.stringify(res._warnings));
});

test('A1: the schema offers arrayRef/matchMode/maxItems and requires only cases', () => {
    const sw = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_add_switch').function;
    const p = sw.parameters.properties;
    assert.strictEqual(p.arrayRef.type, 'string');
    assert.deepStrictEqual(p.matchMode.enum, ['first', 'all']);
    assert.strictEqual(p.maxItems.type, 'integer');
    assert.deepStrictEqual(sw.parameters.required, ['cases']);
    assert.match(p.cases.description, /first match wins unless matchMode is 'all'/);
});

test('A3: no Condition tool teaches lower()/upper(), and each carries the rule shapes', () => {
    const { CONDITION_RULES_HINT } = require('./builderTools/ruleExamples');
    for (const name of ['builder_add_condition', 'builder_add_switch', 'builder_add_filter', 'builder_add_array_op']) {
        const fn = TOOL_SCHEMAS.find(t => t.function?.name === name).function;
        const text = JSON.stringify(fn);
        assert.ok(!/(lower|upper)\(item|(lower|upper)\(trigger|(lower|upper)\(steps/.test(text), `${name} still wraps a field in lower()/upper()`);
        assert.ok(fn.description.includes(CONDITION_RULES_HINT), `${name} lacks the rule shapes`);
    }
});

test('A2: builder_update_step patches arrayRef/matchMode/maxItems on a switch, maxItems on a filter', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_add_switch', { ...LIST_ARGS }, dw);
    const id = lastStep(dw).id;
    let res = await applyToolCall('builder_update_step', { stepId: id, patch: { matchMode: 'all', maxItems: 20, arrayRef: 'trigger.output.attachments' } }, dw);
    assert.ok(!res.error, res.error);
    let step = dw.def.steps.find(s => s.id === id);
    assert.deepStrictEqual([step.matchMode, step.maxItems, step.arrayRef], ['all', 20, 'trigger.output.attachments']);
    res = await applyToolCall('builder_update_step', { stepId: id, patch: { matchMode: 'first', maxItems: null } }, dw);
    assert.ok(!res.error, res.error);
    step = dw.def.steps.find(s => s.id === id);
    assert.ok(!('matchMode' in step) && !('maxItems' in step), JSON.stringify(step));

    const filt = await applyToolCall('builder_add_filter', { arrayRef: 'trigger.output.files', expr: 'true' }, dw);
    res = await applyToolCall('builder_update_step', { stepId: filt.added.id, patch: { maxItems: 10 } }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.find(s => s.id === filt.added.id).maxItems, 10);
});

test('W4 through the builder: renaming an output re-points the step on it', async () => {
    const dw = freshWrap();
    const sw = await applyToolCall('builder_add_switch', { ...LIST_ARGS }, dw);
    const id = sw.added.id;
    const note = await applyToolCall('builder_add_notification', {
        afterStepId: id, caseName: 'pdf', title: 'PDF', body: '{{steps.' + id + '.output.matchesByCase.pdf[0].name}}',
    }, dw);
    assert.ok(!note.error, note.error);
    const res = await applyToolCall('builder_update_step', {
        stepId: id, patch: { cases: [{ name: 'invoices', expr: LIST_ARGS.cases[0].expr }, LIST_ARGS.cases[1]] },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(dw.def.steps.find(s => s.id === note.added.id).body, `{{steps.${id}.output.matchesByCase.invoices[0].name}}`);
    assert.ok(res._warnings.some(w => w.includes(`to steps.${id}.output.matchesByCase.invoices`)), JSON.stringify(res._warnings));
});

// ── BFSF-485 F4: a condition that reads a whole list ─────────────────────────

test('F4: a condition reading list[*] is built, with a note that it decides once and how to filter', async () => {
    const dw = freshWrap();
    // The issue's own example: "only the sheets named Reiskosten".
    const res = await applyToolCall('builder_add_condition', { expr: 'contains(trigger.output.results[*].name, "Reiskosten")' }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res._warnings.length, 1);
    assert.match(res._warnings[0], /reads the whole list trigger\.output\.results and decides ONCE for the whole run/);
    assert.match(res._warnings[0], /builder_add_array_op\(\{op:"filter", arrayRef:"trigger\.output\.results"/);
});

test('F4: no note for a plain condition or a whole-list emptiness check', async () => {
    for (const expr of ['trigger.output.amount > 1000', 'isEmpty(trigger.output.results[*].name)', 'len(trigger.output.results[*]) > 0']) {
        const dw = freshWrap();
        const res = await applyToolCall('builder_add_condition', { expr }, dw);
        assert.ok(!res.error, res.error);
        assert.ok(!res._warnings, `${expr}: ${JSON.stringify(res._warnings)}`);
    }
});

test('W3 through the builder: a filter replaced by a list switch keeps its connection on the first output', async () => {
    const dw = freshWrap();
    dw.def.steps.push(
        { id: 'f', type: 'filter', arrayRef: 'trigger.output.files', expr: 'true' },
        { id: 'n', type: 'notification', title: 'Files', body: '{{steps.f.output.items[0].name}}' },
    );
    dw.def.edges.push({ from: 'trg', to: 'f' }, { from: 'f', to: 'n' });
    const res = await applyToolCall('builder_replace_step', { stepId: 'f', newType: 'switch', spec: { ...LIST_ARGS } }, dw);
    assert.ok(!res.error, res.error);
    assert.deepStrictEqual(dw.def.edges.find(e => e.from === 'f'), { from: 'f', to: 'n', label: 'case:pdf', caseName: 'pdf' });
    assert.strictEqual(dw.def.steps.find(s => s.id === 'n').body, '{{steps.f.output.matchesByCase.pdf[0].name}}');
    assert.ok(!res.rewired, 'no "unlabelled outgoing edges" note: the edge is on the first output');
    assert.deepStrictEqual(res._warnings, ['Re-pointed n from steps.f.output.items to steps.f.output.matchesByCase.pdf: the outputs of f changed.']);
});
