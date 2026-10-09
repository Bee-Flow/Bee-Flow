/**
 * The availability gate: the builder may only propose tools this user can run.
 *
 * The incident this locks down: a local small model added
 * `{type:'integration_action', tool:'gmail_search'}` for an org with zero
 * connected integrations. Nothing refused it — the add-time guard's first test
 * was "does the catalog know this tool's SCHEMA", which is a question about the
 * product, not about the user. The step was built, saved, validated clean and
 * finalised; the first component able to object was the runner, which failed
 * the run with "you no longer have permission", sending the user to an admin
 * who had nothing to toggle.
 *
 * `_availableToolNames` is the per-request resolved set — the same answer
 * execAi authorises against. Its ABSENCE means "we were not told", which is
 * deliberately different from "the user does not have it": the MCP surface
 * attaches no catalog, and refusing everything there would break a working
 * integration outright.
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall } = require('./builderTools');
const { emptyDefinition } = require('./builderTools/draftGraph');

/** A wrap that HAS resolved the user's tools: one nextcloud action, nothing else. */
function wrapWithAvailability(extra = {}) {
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        // Deliberately still carries gmail_search's schema — that is the exact
        // shape of the bug. The catalog knowing a schema must not read as the
        // user having the tool.
        _inputSchemasByTool: {
            gmail_search: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            nextcloud_files_list: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
        },
        _availableToolNames: new Set(['nextcloud_files_list']),
        _inspectedTools: new Set(),
        ...extra,
    };
}

const addAction = (dw, tool) => applyToolCall('builder_add_action', { tool, inputs: {} }, dw);

test('a real tool the user has NOT connected is refused, and named as its app', async () => {
    const dw = wrapWithAvailability();
    const r = await addAction(dw, 'gmail_search');
    assert.ok(r.error, 'refused');
    assert.match(r.error, /Gmail/, 'names the app, not just the tool');
    assert.match(r.error, /not connected/);
    assert.equal(dw.def.steps.length, 0, 'no step was created');
});

test('the refusal carries its own _fixHint — applyToolCall would otherwise misdirect', async () => {
    const dw = wrapWithAvailability();
    const r = await addAction(dw, 'gmail_search');
    assert.ok(r._fixHint, 'has a hint');
    // applyToolCall stamps every hint-less error with "invalid input binding",
    // which would send the model off fixing a binding it got right.
    assert.doesNotMatch(r._fixHint, /invalid input binding/i);
    assert.match(r._fixHint, /connect Gmail/i, 'says what would actually fix it');
});

test('an entirely unknown name is refused differently — no existence oracle', async () => {
    const dw = wrapWithAvailability();
    const r = await addAction(dw, 'gmial_search');
    assert.ok(r.error);
    assert.match(r.error, /no tool called/i);
    assert.doesNotMatch(r.error, /Gmail/, 'a typo must not be told which app it nearly hit');
});

test('a tool the user DOES have still works', async () => {
    const dw = wrapWithAvailability();
    const r = await applyToolCall('builder_add_action', { tool: 'nextcloud_files_list', inputs: {} }, dw);
    assert.ok(!r.error, r.error);
    assert.equal(dw.def.steps.length, 1);
    assert.equal(dw.def.steps[0].tool, 'nextcloud_files_list');
});

test('the resolved set is the authority, not the schema map', async () => {
    // An MCP / org-custom / automation / Step tool owns no TOOL_REGISTRY entry and
    // has no catalog schema, but the user can genuinely run it. Gating on the
    // schema map would refuse it.
    const dw = wrapWithAvailability({ _availableToolNames: new Set(['mcp:srv__do_thing']) });
    const r = await addAction(dw, 'mcp:srv__do_thing');
    assert.ok(!r.error, r.error);
    assert.equal(dw.def.steps.length, 1);
});

test('a resolved-but-empty set refuses every integration action', async () => {
    const dw = wrapWithAvailability({ _availableToolNames: new Set() });
    const r = await addAction(dw, 'gmail_search');
    assert.ok(r.error);
    assert.match(r._fixHint, /no integrations connected/i);
});

test('NO set attached → today\'s behaviour, with no availability refusal added', async () => {
    // The MCP surface attaches no catalog. Refusing there would break a working
    // integration; "we were not told" is not "the user does not have it".
    // gmail_search still meets the §B3 inspect gate here — that is unchanged
    // pre-existing behaviour, and the point is that it is NOT the new refusal.
    const dw = wrapWithAvailability({ _availableToolNames: undefined });
    const r = await addAction(dw, 'gmail_search');
    assert.doesNotMatch(String(r.error || ''), /not connected|no tool called/i,
        'availability must stay inert when the set was never attached');
    assert.ok(r._needsInspect, 'the pre-existing inspect gate is what speaks');
    // Bind the required param and it goes straight through — no availability veto.
    const ok = await applyToolCall('builder_add_action',
        { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'x' } } }, dw);
    assert.ok(!ok.error, ok.error);
    assert.equal(dw.def.steps.length, 1);
});

test('a built-in step type still gets the step-type message, not "not connected"', async () => {
    // Two different mistakes with two different fixes; the more useful message
    // must keep winning.
    const dw = wrapWithAvailability();
    const r = await addAction(dw, 'http_request');
    assert.ok(r.error);
    assert.match(r.error, /built-in step type/);
    assert.match(r._fixHint, /builder_add_http_request/);
});

test('builder_add_action({tool:"datatable"}) names builder_add_datatable and, for an existing step, builder_replace_step', async () => {
    const dw = wrapWithAvailability();
    const r = await addAction(dw, 'datatable');
    assert.match(r._fixHint, /builder_add_datatable/);
    assert.match(r._fixHint, /builder_replace_step\(\{stepId, newType:"datatable", spec\}\)/);
});

test('builder_update_step cannot smuggle an unavailable tool in through a patch', async () => {
    const dw = wrapWithAvailability();
    const ok = await applyToolCall('builder_add_action', { tool: 'nextcloud_files_list', inputs: {} }, dw);
    assert.ok(!ok.error, ok.error);
    const id = dw.def.steps[0].id;
    const r = await applyToolCall('builder_update_step', { stepId: id, patch: { tool: 'gmail_search' } }, dw);
    assert.ok(r.error, 'refused');
    assert.match(r.error, /not connected/);
    assert.equal(dw.def.steps[0].tool, 'nextcloud_files_list', 'the step kept its old tool');
});

test('builder_add_steps refuses too, and its _fixHint survives the batch wrapper', async () => {
    const dw = wrapWithAvailability();
    const r = await applyToolCall('builder_add_steps', {
        steps: [{ type: 'integration_action', spec: { tool: 'gmail_search', inputs: {} } }],
    }, dw);
    assert.ok(r.error);
    assert.ok(r._fixHint, 'the hint reached the model through the batch failure');
    assert.doesNotMatch(r._fixHint, /invalid input binding/i);
    assert.equal(dw.def.steps.length, 0);
});

test('builder_inspect_tool refuses an unavailable tool and does NOT mark it inspected', async () => {
    const dw = wrapWithAvailability();
    const r = await applyToolCall('builder_inspect_tool', { tool: 'gmail_search' }, dw);
    assert.ok(r.error, 'refused instead of returning a confident schema');
    assert.equal(dw._inspectedTools.has('gmail_search'), false,
        'marking would have disarmed the §B3 gate for the rest of the session');
    // And the add is still refused afterwards — the refusal did not soften it.
    const add = await addAction(dw, 'gmail_search');
    assert.ok(add.error);
});

test('builder_inspect_tool still answers for a tool the user has', async () => {
    const dw = wrapWithAvailability();
    const r = await applyToolCall('builder_inspect_tool', { tool: 'nextcloud_files_list' }, dw);
    assert.ok(!r.error, r.error);
    assert.equal(dw._inspectedTools.has('nextcloud_files_list'), true);
});
