/**
 * App Studio over MCP — the tool surface and the call envelope.
 *
 * What is worth pinning here is not that the builder tools work (builderTools's
 * own suites cover that) but the three things this layer alone is responsible
 * for: the gate is really a gate, the shared TOOL_SCHEMAS constant is not
 * mutated while appId is spliced in, and a call cannot reach a builder tool
 * without an app to act on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');
const { TOOL_SCHEMAS, MUTATING_TOOLS } = require('./builderTools');

function withEnv(value, fn) {
    const prev = process.env.STUDIO_MCP_ENABLED;
    if (value === undefined) delete process.env.STUDIO_MCP_ENABLED;
    else process.env.STUDIO_MCP_ENABLED = value;
    try { return fn(); } finally {
        if (prev === undefined) delete process.env.STUDIO_MCP_ENABLED;
        else process.env.STUDIO_MCP_ENABLED = prev;
    }
}

test('the endpoint is off unless the flag is exactly "1"', () => {
    withEnv(undefined, () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('0', () => assert.equal(mcpBuilder.isEnabled(), false));
    // Deliberately strict: a surface that authors application logic from a
    // static token should not switch itself on for "true"/"yes"/"on".
    withEnv('true', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('yes', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('1', () => assert.equal(mcpBuilder.isEnabled(), true));
});

test('splicing appId into the schemas never mutates the shared constant', () => {
    // TOOL_SCHEMAS is sent on every in-product builder turn and its byte
    // stability is what keeps the prompt cache warm (schemas.js says so). If
    // this layer mutated it, enabling MCP would silently change the cache key
    // of every builder turn on the instance.
    const before = JSON.stringify(TOOL_SCHEMAS);
    mcpBuilder.buildToolList();
    mcpBuilder.buildToolList();
    assert.equal(JSON.stringify(TOOL_SCHEMAS), before);
});

test('every app_* tool requires an appId; the entry points do not', () => {
    const tools = mcpBuilder.buildToolList();
    assert.ok(tools.length > 25, 'the whole builder surface should be advertised');

    for (const tool of tools) {
        const required = tool.inputSchema.required || [];
        if (mcpBuilder.APPLESS_TOOLS.has(tool.name)) {
            assert.ok(!required.includes('appId'), `${tool.name} should not demand an appId`);
            assert.ok(!tool.inputSchema.properties.appId, `${tool.name} should not offer an appId`);
        } else {
            assert.ok(required.includes('appId'), `${tool.name} must require an appId`);
            assert.equal(tool.inputSchema.properties.appId.type, 'string');
        }
    }
});

test('a tool schema keeps its own required fields when appId is added', () => {
    // app_add_components has real required args; the envelope must not replace
    // them, only prepend to them.
    const add = mcpBuilder.buildToolList().find((t) => t.name === 'app_add_components');
    const source = TOOL_SCHEMAS.find((t) => t.function.name === 'app_add_components').function;
    for (const key of (source.parameters.required || [])) {
        assert.ok(add.inputSchema.required.includes(key), `lost required arg ${key}`);
    }
    for (const key of Object.keys(source.parameters.properties || {})) {
        assert.ok(add.inputSchema.properties[key], `lost property ${key}`);
    }
});

test('route-only tools are not advertised', () => {
    const names = new Set(mcpBuilder.buildToolList().map((t) => t.name));
    // app_propose_plan is finished by the SSE route and app_mark_phase drives a
    // progress bar; neither half exists here.
    assert.ok(!names.has('app_propose_plan'));
    assert.ok(!names.has('app_mark_phase'));
    assert.ok(names.has('app_add_components'), 'the real work must still be there');
    assert.ok(names.has('studio_get_guide'));
    assert.ok(names.has('studio_list_apps'));
    assert.ok(names.has('studio_create_app'));
});

test('write tools are advertised as writes', () => {
    const tools = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
    for (const name of MUTATING_TOOLS) {
        if (!tools.has(name)) continue;
        assert.equal(tools.get(name).annotations.readOnlyHint, false, `${name} must not claim to be read-only`);
    }
    assert.equal(tools.get('app_get_draft').annotations.readOnlyHint, true);
    assert.equal(tools.get('app_dry_run').annotations.readOnlyHint, true);
    assert.equal(tools.get('studio_list_apps').annotations.readOnlyHint, true);
    assert.equal(tools.get('app_remove_screen').annotations.destructiveHint, true);
});

test('an unknown tool is refused without touching the store', async () => {
    const { result } = await mcpBuilder.callTool('app_definitely_not_a_tool', {}, { userId: 'u1' });
    assert.match(result.error, /Unknown tool/);
});

test('an app_* call without an appId is refused before any load', async () => {
    // No DB is configured in this suite, so reaching the store at all would
    // throw — the assertion is really "the guard runs first".
    const { result } = await mcpBuilder.callTool('app_add_screen', { name: 'Home' }, { userId: 'u1' });
    assert.match(result.error, /needs an appId/);
    const blank = await mcpBuilder.callTool('app_add_screen', { appId: '   ' }, { userId: 'u1' });
    assert.match(blank.result.error, /needs an appId/);
});

test('the guide is the same one the in-product builder gets', async () => {
    const { result } = await mcpBuilder.callTool('studio_get_guide', {}, { userId: 'u1' });
    assert.ok(typeof result.guide === 'string');
    // It must carry the component catalog — that is the whole reason the tool
    // exists, since the tool descriptions teach the protocol and not the
    // vocabulary.
    assert.ok(result.guide.length > 20000, 'the guide should include the rendered catalog');
    assert.match(result.guide, /app_add_components/);
    // This channel has no per-turn user message, so the guide must send the
    // agent to the list tools — never to an OWNER CONTEXT note it will not get.
    assert.ok(!result.guide.includes('OWNER CONTEXT'), 'the guide never points at the note');
    assert.match(result.guide, /call `app_list_automations` for the owner's routines/);
});

test('the screenshot budget is per user and refills', () => {
    const { takeScreenshotBudget, SHOT_MAX_PER_WINDOW, _shotBudget } = mcpBuilder._test;
    _shotBudget.clear();
    for (let i = 0; i < SHOT_MAX_PER_WINDOW; i++) {
        assert.equal(takeScreenshotBudget('shot-user'), true, `call ${i + 1} should be allowed`);
    }
    // Reloading the draft per call resets the tool's own per-turn counter, so
    // without this a stateless endpoint would have no screenshot ceiling at all.
    assert.equal(takeScreenshotBudget('shot-user'), false);
    assert.equal(takeScreenshotBudget('other-user'), true, 'budgets do not leak between users');

    _shotBudget.set('shot-user', { count: SHOT_MAX_PER_WINDOW, resetAt: Date.now() - 1 });
    assert.equal(takeScreenshotBudget('shot-user'), true, 'an expired window refills');
    _shotBudget.clear();
});

test('row counts are keyed by table id whichever key the store used', () => {
    const model = { tables: [{ id: 'tbl_a', key: 'alpha' }, { id: 'tbl_b', key: 'beta' }] };
    assert.deepEqual(mcpBuilder.normalizeRowCounts(model, { tbl_a: 3, beta: '7' }), { tbl_a: 3, tbl_b: 7 });
    assert.deepEqual(mcpBuilder.normalizeRowCounts(model, null), {});
    assert.deepEqual(mcpBuilder.normalizeRowCounts(null, { tbl_a: 3 }), {});
});
