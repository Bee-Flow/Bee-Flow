/**
 * The lean prompt may not teach a tool the core menu does not serve.
 *
 * `schemas.doctrine.test.js` already pins this for the few-shots ("every tool
 * the core few-shots call is in the core menu"). The prompt BODY had no such
 * check, and drifted: it names ten tools a `small`-profile build cannot call.
 * Grammar-constrained decoding cannot emit a name that is not in the menu, so
 * the model either substitutes a wrong tool or writes the call as text — where
 * the leak recovery rejects it as unknown_tool, because that check is against
 * the menu too. The recorded traces show both.
 *
 * This is a RATCHET, not a green field: the ten known gaps are listed below so
 * the suite stays honest about them while the fix (add the tool to the menu, or
 * take the section out of the prompt) is decided per tool. An eleventh gap
 * fails here immediately.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt.coreMenuDoctrine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');
const { CORE_TOOL_NAMES } = require('./builderModelProfiles');
const { buildLeanSystemPrompt } = require('./builderPrompt');

// Tools the lean prompt teaches that the core menu does not serve. EMPTY since
// 2026-09-17: the small-band diet took `## Flowlets`, `## Additional triggers`
// and the delegate half of `## Plan & delegate` out of buildLeanSystemPrompt,
// and with them the last nine names (builder_add_set, builder_add_form_page,
// builder_add_trigger, builder_add_call_layer, builder_add_switch,
// builder_set_layer_contract, builder_generate_layer[s], builder_create_layer)
// a core-menu build could read about and never call. The ratchet stays: a
// new gap fails the first test at once, and an entry added here must still
// pass the other three.
const KNOWN_PROMPT_MENU_GAPS = new Set([]);

const ALL_TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);

/** Tool names the lean prompt mentions by name. */
function toolsNamedByLeanPrompt() {
    const prompt = buildLeanSystemPrompt({ catalogText: '', batchTools: true });
    return ALL_TOOL_NAMES.filter((n) => prompt.includes(n));
}

test('the lean prompt teaches no NEW tool the core menu cannot serve', () => {
    const core = new Set(CORE_TOOL_NAMES);
    const gaps = toolsNamedByLeanPrompt().filter((n) => !core.has(n) && !KNOWN_PROMPT_MENU_GAPS.has(n));
    assert.deepStrictEqual(gaps, [],
        `the lean prompt names ${gaps.join(', ')}, which a core-menu build cannot call. `
        + 'Add it to CORE_TOOL_NAMES, or take the section out of buildLeanSystemPrompt.');
});

test('the known gaps are still gaps — a closed one must leave the list', () => {
    // Keeps the ratchet from rotting: once a tool is added to the menu, its
    // entry here is stale and the comment above lies about the cost.
    const core = new Set(CORE_TOOL_NAMES);
    const closed = [...KNOWN_PROMPT_MENU_GAPS].filter((n) => core.has(n));
    assert.deepStrictEqual(closed, [],
        `${closed.join(', ')} is in the core menu now — remove it from KNOWN_PROMPT_MENU_GAPS.`);
});

test('every name on the gap list is a real tool', () => {
    const unknown = [...KNOWN_PROMPT_MENU_GAPS].filter((n) => !ALL_TOOL_NAMES.includes(n));
    assert.deepStrictEqual(unknown, [], `not a tool: ${unknown.join(', ')}`);
});

test('the gap list does not silence a tool the prompt stopped naming', () => {
    const named = new Set(toolsNamedByLeanPrompt());
    const stale = [...KNOWN_PROMPT_MENU_GAPS].filter((n) => !named.has(n));
    assert.deepStrictEqual(stale, [],
        `the lean prompt no longer names ${stale.join(', ')} — remove it from KNOWN_PROMPT_MENU_GAPS.`);
});
