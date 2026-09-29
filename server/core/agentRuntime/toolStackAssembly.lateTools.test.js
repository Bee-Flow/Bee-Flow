'use strict';

/**
 * Tools that arrive AFTER the stack was narrowed.
 *
 * `toolStackAssembly.sandbox.test.js` proves the drop happens when the stack is
 * assembled. This one is about the second door into that same array: when the
 * model activates a skill whose apps were not enabled at assembly time,
 * `onSkillsActivated` (chatStream.js) resolves fresh integration tools and
 * pushes them straight into the live `tools` list the loop re-reads each round.
 *
 * THE WOUND. Those late tools were never narrowed. The delta filter that guards
 * that path looks like protection and is not: it only keeps out names already
 * present, and a tool from an app the activation just released is by definition
 * a name nobody has seen. So a test-set run — the one run that must never send
 * anything — could pick up a sending tool halfway through the turn, long after
 * the sandbox had done its single pass.
 *
 * The fix was not another filter but one shared function, `narrowToolsForTurn`,
 * called at both application points. This file drives both halves:
 *
 *   • the rules hold over ANY list, including a list of two tools that shows up
 *     mid-turn (the real testSandbox and toolPolicy run);
 *   • the late path itself. `onSkillsActivated` used to be a closure inside the
 *     streaming turn, and this test read the source because of it; since the
 *     turn was split, `createSkillActivationHandler` builds that handler from
 *     its inputs, so the handler is called here with a live `tools` array and
 *     asked what it pushed onto it.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/toolStackAssembly.lateTools.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { narrowToolsForTurn } = require('./toolStackAssembly');

// The only thing the late path reaches outside itself: the integration
// catalog it re-resolves after an activation. Cut at the require seam so the
// handler can be handed a freshly "released" sending tool.
let FRESH_TOOLS = [];
const integrationToolsId = 'mock:late-tools:integrationTools';
require.cache[integrationToolsId] = {
    id: integrationToolsId, filename: integrationToolsId, loaded: true,
    exports: { getIntegrationTools: async () => ({ tools: FRESH_TOOLS }) },
};
const agentStoreId = 'mock:late-tools:agentStore';
require.cache[agentStoreId] = {
    id: agentStoreId, filename: agentStoreId, loaded: true,
    exports: { updateConversationMeta: async () => {} },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /chatStream[\\/]skillActivation\.js$/.test(parent.filename)) {
        if (request === '../../integrations/integrationTools') return integrationToolsId;
        if (request === '../../../stores/agentStore') return agentStoreId;
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const { createSkillActivationHandler } = require('./chatStream/skillActivation');

const tool = (name, extra = {}) => ({ type: 'function', function: { name }, ...extra });
const names = (tools) => tools.map(t => t.function && t.function.name);

const AGENT = { id: 'a1', owner_id: 'me', config: {} };
const narrow = (tools, messageMetadata) =>
    narrowToolsForTurn({ tools, agent: AGENT, agentId: 'a1', messageMetadata });

test('a sending tool that arrives mid-turn is still refused on a test run', () => {
    // Exactly the shape of the bug: this list is the DELTA, not the stack —
    // two tools nobody had seen when the sandbox ran its pass.
    const out = narrow([tool('gmail_search'), tool('gmail_compose')], { testSandbox: true });
    assert.deepStrictEqual(names(out.tools), ['gmail_search']);
    assert.deepStrictEqual(out.sandboxWithheld.map(w => [w.name, w.reason]), [['gmail_compose', 'sends']]);
});

test('a routine that arrives mid-turn is refused too — its behaviour lives elsewhere', () => {
    const out = narrow([tool('file_the_ticket', { __automation: { id: 'au-1' } })], { testSandbox: true });
    assert.deepStrictEqual(names(out.tools), []);
    assert.strictEqual(out.sandboxWithheld[0].reason, 'routine');
});

test('without the flag a late tool passes untouched — ordinary chat is unaffected', () => {
    const out = narrow([tool('gmail_search'), tool('gmail_compose')], {});
    assert.deepStrictEqual(names(out.tools), ['gmail_search', 'gmail_compose']);
    assert.deepStrictEqual(out.sandboxWithheld, []);
});

test('an empty or unusable list is not a crash, and is not a way through', () => {
    for (const junk of [[], null, undefined, 'tools', 42]) {
        const out = narrow(junk, { testSandbox: true });
        assert.deepStrictEqual(out.tools, [], 'nothing in must mean nothing out');
        assert.ok(Array.isArray(out.sandboxWithheld));
    }
});

test('a tool with no readable name is withheld, not passed on', () => {
    // "Unnamed" is unclassifiable, and unclassifiable must narrow. Letting it
    // through would be a tool the per-round gate then has to judge by a name
    // it does not have.
    const out = narrow([{ type: 'function' }, tool('gmail_search')], { testSandbox: true });
    assert.deepStrictEqual(names(out.tools), ['gmail_search']);
    assert.strictEqual(out.sandboxWithheld[0].reason, 'unnamed');
});

// ── The late path itself ─────────────────────────────────────────────

/**
 * A skill-activation handler wired the way the turn wires it, plus the live
 * `tools` array the agentic loop re-reads each round.
 */
function lateStack({ testSandbox = false, fresh = [] } = {}) {
    FRESH_TOOLS = fresh;
    const tools = [tool('kb_search')];
    const events = [];
    const handler = createSkillActivationHandler({
        agent: AGENT,
        agentId: 'a1',
        userId: 'u1',
        userAuth: { session: {} },
        messageMetadata: testSandbox ? { testSandbox: true } : {},
        onEvent: (name, payload) => events.push({ name, payload }),
        conversation: null,
        isEphemeral: true,
        tools,
        disableExternalTools: false,
        skillApps: { dynamicSkillApps: new Map([['sk1', ['gmail']]]), allowedApps: [] },
        activatedSkillIds: [],
        baseIntegrationToolNames: new Set(['kb_search']),
    });
    return { handler, tools, events };
}

test('a sending tool released by a mid-turn activation never reaches the live stack on a test run', async () => {
    const { handler, tools, events } = lateStack({
        testSandbox: true,
        fresh: [tool('gmail_search'), tool('gmail_compose')],
    });

    const result = await handler(['sk1']);

    assert.deepStrictEqual(result.addedTools, ['gmail_search'],
        'a sending tool must not be added halfway through the one run that may never send');
    assert.deepStrictEqual(names(tools), ['kb_search', 'gmail_search'],
        'the live array the loop re-reads must hold the narrowed list, never the raw delta');
    const notice = events.find(e => e.name === 'test_sandbox');
    assert.ok(notice, 'the run would show a sandbox notice missing exactly the tools that arrived late');
    assert.deepStrictEqual(notice.payload.withheld.map(w => [w.name, w.reason]), [['gmail_compose', 'sends']]);
});

test('without the flag the same activation adds both tools', async () => {
    const { handler, tools, events } = lateStack({ fresh: [tool('gmail_search'), tool('gmail_compose')] });

    const result = await handler(['sk1']);

    assert.deepStrictEqual(result.addedTools, ['gmail_search', 'gmail_compose']);
    assert.deepStrictEqual(names(tools), ['kb_search', 'gmail_search', 'gmail_compose']);
    assert.deepStrictEqual(events, [], 'ordinary chat gets no sandbox notice');
});

test('a tool already on the stack is not added twice, narrowed or not', async () => {
    const { handler, tools } = lateStack({ fresh: [tool('kb_search'), tool('gmail_search')] });
    await handler(['sk1']);
    assert.deepStrictEqual(names(tools), ['kb_search', 'gmail_search']);
});

test('both application points share one implementation — no second copy of the rules', async () => {
    // A copy would drift, and the drift would be invisible: the two paths are
    // exercised by different runs. So ask both for the same list and require
    // the same answer, rather than counting call sites in the source.
    const delta = [tool('gmail_search'), tool('gmail_compose'), tool('file_it', { __automation: { id: 'au-1' } }), { type: 'function' }];
    const direct = narrow(delta.map(t => ({ ...t })), { testSandbox: true });

    const { handler, tools } = lateStack({ testSandbox: true, fresh: delta.map(t => ({ ...t })) });
    const result = await handler(['sk1']);

    assert.deepStrictEqual(result.addedTools, names(direct.tools).filter(Boolean),
        'the late path must keep exactly what the assembly path keeps');
    assert.deepStrictEqual(names(tools).slice(1), names(direct.tools).filter(Boolean));
});
