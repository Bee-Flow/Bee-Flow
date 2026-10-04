/**
 * parse_json retirement contract (authoring removed, legacy alive).
 *
 * The step's ability moved into the set ("Edit data") step — the parseJson()
 * expression + list mode — so NO tool can create a parse_json step anymore.
 * But saved automations still carry them, so the runtime, validator, and the
 * builder_update_step patch path must keep working on legacy steps.
 *
 * Run: node --test automation/builderTools.parseJson.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

/** A definition already carrying a parse_json step, as saved automations do. */
function legacyWrap() {
    const dw = freshWrap();
    dw.def.trigger = { id: 'trg', kind: 'manual' };
    dw.def.steps = [
        { id: 'h1', type: 'http_request', url: 'https://api.example.com/x', method: 'GET', blockPrivateTargets: true, label: 'HTTP Request' },
        { id: 'parse_1', type: 'parse_json', sourceRef: 'steps.h1.output.body', itemsRef: '', mode: 'paths', fields: [{ name: 'old_field', path: 'a' }], label: 'Parse JSON' },
    ];
    dw.def.edges = [{ from: 'trg', to: 'h1' }, { from: 'h1', to: 'parse_1' }];
    return dw;
}

test('registration: the add tool is GONE from every authoring surface', () => {
    assert.ok(!TOOL_SCHEMAS.some(t => t.function?.name === 'builder_add_parse_json'), 'schema removed');
    assert.ok(!MUTATING_TOOLS.has('builder_add_parse_json'));
    assert.ok(!SCOPED_GRAPH_TOOLS.has('builder_add_parse_json'));
});

test('calling the retired tool fails as an unknown tool, adding nothing', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_parse_json', { fields: [{ name: 'a', path: 'x' }] }, dw);
    assert.ok(res.error, 'must error');
    assert.strictEqual(dw.def.steps.length, 0);
});

test('builder_add_steps batch: type "parse_json" gets the guidance error, not a bare unknown-type', async () => {
    const dw = freshWrap();
    const res = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'h', type: 'http_request', spec: { url: 'https://api.example.com/x' } },
            { tempId: 'p', type: 'parse_json', spec: { sourceRef: 'steps.$h.output.body', fields: [{ name: 'a', path: 'x' }] } },
        ],
    }, dw);
    assert.match(res.error, /parseJson\(/, 'error teaches the set-step replacement');
    // The retired type is caught by the batch-level pre-validation, which
    // applies nothing — entry 0 (a valid http_request) is NOT built. (The
    // built-prefix rule only starts once every entry has passed that check.)
    assert.strictEqual(dw.def.steps.length, 0, 'batch-level pre-validation applies nothing');
    assert.strictEqual(res.added, undefined, 'no partial result: nothing was applied');
});

test('builder_replace_step refuses to replace INTO parse_json with the same guidance', async () => {
    const dw = legacyWrap();
    const res = await applyToolCall('builder_replace_step', {
        stepId: 'h1', newType: 'parse_json', spec: { fields: [{ name: 'a', path: 'x' }] },
    }, dw);
    assert.match(res.error, /can no longer be added/);
});

test('LEGACY steps stay patchable: builder_update_step still works on an existing parse_json', async () => {
    const dw = legacyWrap();
    const res = await applyToolCall('builder_update_step', {
        stepId: 'parse_1',
        patch: { sourceRef: 'steps.h1.output.body', mode: 'ai', fields: [{ name: 'new_field', path: 'b', description: 'The b' }] },
    }, dw);
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.updated.mode, 'ai');
    assert.deepStrictEqual(res.updated.fields, [{ name: 'new_field', path: 'b', description: 'The b' }]);

    // The fields array still goes through the sanitizer — an empty patch is
    // rejected, not silently dropped by the bindKey merge.
    const invalid = await applyToolCall('builder_update_step', {
        stepId: 'parse_1', patch: { fields: [] },
    }, dw);
    assert.ok(invalid.error, 'an empty fields patch is rejected, not silently dropped');
});

test('a legacy definition with a parse_json step still validates clean', () => {
    const dw = legacyWrap();
    const v = validateDefinition(dw.def);
    assert.deepStrictEqual(v.errors, []);
    assert.ok(!v.warnings.some(w => w.code === 'step.unknown_type'));
});
