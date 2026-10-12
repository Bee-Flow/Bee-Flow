/**
 * Built-in step-type detection, and the drift guard that keeps STEP_TYPES in
 * step with ADD_FOR_TYPE.
 *
 * Run: cd server && node --test --test-force-exit automation/builtinStepTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { STEP_TYPES, isBuiltinStepType, builderToolForStepType } = require('./builtinStepTools');

test('STEP_TYPES matches ADD_FOR_TYPE exactly — the two must never drift', () => {
    const { ADD_FOR_TYPE } = require('./builderTools/stepBuilders');
    assert.deepStrictEqual(
        [...STEP_TYPES].sort(),
        Object.keys(ADD_FOR_TYPE).sort(),
        'builtinStepTools.STEP_TYPES is a hand-copy of ADD_FOR_TYPE (stepBuilders requires this '
        + 'module, so it cannot import it). A step type was added or removed on one side only.',
    );
});

test('every builder tool this module names actually exists', () => {
    const { TOOL_SCHEMAS } = require('./builderTools');
    const real = new Set(TOOL_SCHEMAS.map(t => t.function.name));
    for (const type of STEP_TYPES) {
        const tool = builderToolForStepType(type);
        if (tool === null) continue;            // guard/tokenize have no add tool
        assert.ok(real.has(tool), `builderToolForStepType(${type}) returned "${tool}", which is not a real tool`);
    }
});

test('the reported failure: http_request is a step type, not a tool', () => {
    assert.strictEqual(isBuiltinStepType('http_request'), true);
    assert.strictEqual(builderToolForStepType('http_request'), 'builder_add_http_request');
});

test('array ops point at the unified tool small models are given', () => {
    for (const t of ['filter', 'limit', 'dedupe', 'aggregate', 'summarize']) {
        assert.strictEqual(builderToolForStepType(t), 'builder_add_array_op', `${t} should route to the unified tool`);
    }
});

test('the two irregular names map to their real tools', () => {
    assert.strictEqual(builderToolForStepType('integration_action'), 'builder_add_action');
    assert.strictEqual(builderToolForStepType('code'), 'builder_add_code_step');
});

test('guard and tokenize are step types with no add tool', () => {
    for (const t of ['guard', 'tokenize']) {
        assert.strictEqual(isBuiltinStepType(t), true, `${t} is a step type`);
        assert.strictEqual(builderToolForStepType(t), null, `${t} has no dedicated add tool`);
    }
});

test('aliases a model reaches for resolve to the right tool', () => {
    assert.strictEqual(builderToolForStepType('webhook'), 'builder_add_http_request');
    assert.strictEqual(builderToolForStepType('api_call'), 'builder_add_http_request');
    assert.strictEqual(builderToolForStepType('array_op'), 'builder_add_array_op');
});

test('real integration tool names are NOT claimed as step types', () => {
    // The whole point of the narrow map: anything it does not recognise stays
    // allowed, because MCP / custom / automation tools cannot be enumerated here.
    for (const name of ['gmail_search', 'nextcloud_deck_create_card', 'browse_web',
        'workspace_read', 'agent_search', 'some_mcp_tool', 'fetch']) {
        assert.strictEqual(isBuiltinStepType(name), false, `${name} must not be treated as a step type`);
        assert.strictEqual(builderToolForStepType(name), null);
    }
});

test('junk input never throws', () => {
    for (const v of [null, undefined, '', 0, {}, [], true]) {
        assert.strictEqual(isBuiltinStepType(v), false);
        assert.strictEqual(builderToolForStepType(v), null);
    }
});
