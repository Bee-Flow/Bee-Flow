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
