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
    assert.ok(!result.guide.includes('listed in the OWNER CONTEXT note'), 'the guide never points at the note');
    assert.match(result.guide, /call `app_list_automations` for the owner's automations/);
});

test('the guide opens with what differs over MCP: no injected draft state, no plan tools, its own screenshot budget', async () => {
    const { result } = await mcpBuilder.callTool('studio_get_guide', {}, { userId: 'u1' });
    const { MCP_GUIDE_PREAMBLE } = require('./mcpGuide/preamble.mts');
    assert.ok(result.guide.startsWith('## Reading this guide over MCP\n') && result.guide.startsWith(MCP_GUIDE_PREAMBLE));
    // The claims of the in-product prompt that do not hold here are each answered.
    const inProduct = require('./builderPrompt').buildSystemPrompt({ toolset: 'full' });
    assert.match(inProduct, /is injected into the conversation each turn/);
    assert.match(MCP_GUIDE_PREAMBLE, /NO DRAFT STATE IS SENT TO YOU.*call app_get_draft/);
    assert.match(inProduct, /bundle app_set_plan\(\{todos\}\)/);
    assert.match(MCP_GUIDE_PREAMBLE, /app_set_plan is accepted and does nothing/);
    assert.match(MCP_GUIDE_PREAMBLE, /app_propose_plan and app_mark_phase do not exist here/);
    const { SHOT_MAX_PER_WINDOW } = mcpBuilder._test;
    assert.ok(MCP_GUIDE_PREAMBLE.includes(`the budget is ${SHOT_MAX_PER_WINDOW} per 10 minutes`));
    // It names only tools this surface serves.
    const served = new Set(mcpBuilder.TOOL_NAMES);
    for (const tool of MCP_GUIDE_PREAMBLE.match(/\bapp_[a-z_]+/g)) {
        assert.ok(served.has(tool) || ['app_propose_plan', 'app_mark_phase'].includes(tool), `${tool} is served over MCP`);
    }
    // The in-product prompt does not carry it.
    assert.ok(!inProduct.includes('Reading this guide over MCP'));
});

test('the guide appends the MCP-only sections; the in-product prompt does not carry them', async () => {
    const { buildSystemPrompt } = require('./builderPrompt');
    const { result } = await mcpBuilder.callTool('studio_get_guide', {}, { userId: 'u1' });
    const inProduct = buildSystemPrompt({ toolset: 'full' });
    assert.match(result.guide, /## Testing actions \(MCP\)/);
    assert.ok(result.guide.includes(`\n\n${inProduct}\n\n## Testing actions (MCP)`), 'the builder prompt is in it, unchanged, before the MCP sections');
    assert.equal(inProduct.includes('Testing actions'), false);
    assert.equal(buildSystemPrompt().includes('Testing actions'), false);
    assert.match(result.guide, /app_save_test/);
    assert.match(result.guide, /app_run_tests/);
});

test('the saved-test tools are advertised as writes with appId required', () => {
    const tools = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
    for (const name of ['app_save_test', 'app_run_tests']) {
        const tool = tools.get(name);
        assert.ok(tool, `${name} is listed`);
        assert.equal(tool.annotations.readOnlyHint, false, `${name} is a write`);
        assert.ok(tool.inputSchema.required.includes('appId'));
    }
    assert.deepEqual(tools.get('app_save_test').inputSchema.required, ['appId', 'actionId', 'name']);
});

test('app_save_test and app_run_tests never reach the draft loader without an appId', async () => {
    const { result } = await mcpBuilder.callTool('app_run_tests', {}, { userId: 'u1' });
    assert.match(result.error, /needs an appId/);
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

test('app_set_plan over MCP succeeds as a no-op instead of failing', async () => {
    const { result } = await mcpBuilder.callTool('app_set_plan', { appId: 'app_x', todos: [{ text: 'a' }] }, { userId: 'u1' });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    const tool = mcpBuilder.buildToolList().find((t) => t.name === 'app_set_plan');
    assert.match(tool.description, /no-op/);
});

test('the MCP draft loads linked tables and shows their live row counts', async () => {
    const appStore = require('../stores/studioAppStore');
    const dataStore = require('../stores/studioAppDataStore');
    const linked = require('./linkedTables');
    const model = { tables: [{ id: 'tbl_l1', key: 'invoices', fields: [] }] };
    const restore = [];
    const stub = (mod, key, value) => { restore.push([mod, key, mod[key]]); mod[key] = value; };
    const seen = [];
    try {
        stub(appStore, 'getStudioApp', async () => ({ id: 'app_1', name: 'A', definition: {}, definitionVersion: 1, organizationId: null }));
        stub(appStore, 'canWriteStudioApp', () => true);
        stub(dataStore, 'getDataModel', async () => ({ model, modelVersion: 3, rowCounts: { tbl_l1: 0 } }));
        stub(dataStore, 'listDatasets', async () => []);
        stub(linked, 'attachLinkedTables', async (wrap, owner) => {
            seen.push(owner);
            wrap.linkedTables = new Map([['tbl_l1', { rowCount: 57, mode: 'read' }]]);
            wrap.rowCounts = { tbl_l1: 57 };
        });
        const { draftWrap, error } = await mcpBuilder.loadDraft('app_1', 'u_1');
        assert.ok(!error, error);
        assert.deepEqual(seen, ['u_1'], 'the owner is passed through');
        assert.equal(draftWrap.rowCounts.tbl_l1, 57);
        assert.ok(draftWrap.linkedTables instanceof Map);
    } finally {
        for (const [mod, key, prev] of restore.reverse()) mod[key] = prev;
    }
});
