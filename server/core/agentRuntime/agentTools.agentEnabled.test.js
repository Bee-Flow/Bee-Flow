/**
 * "Agent-callable" is a decision someone made, not the absence of a field.
 *
 * A component is a directory of caller-authored code that
 * core/executionEngine.js spawns with the server's environment, and
 * `components/` is ONE GLOBAL UNTENANTED directory — every org's agents see
 * every component in it. The agent-tool filters nevertheless read
 * `agentEnabled !== false`, so a component.json with no agentEnabled key was
 * callable by every agent everywhere.
 *
 * That was not hypothetical. POST /ai/create-component wrote component.json
 * with name/description/category/inputs/outputs and NO agentEnabled key, so a
 * component the model had just authored — unreviewed, untested — went straight
 * into every agent's tool list because nobody had said otherwise.
 *
 * The sibling flag directChatEnabled has always been `=== true`
 * (core/tools/directChatToolStack.js). This pins the pair to the same rule, by
 * putting one component that says yes, one that says no and one that says
 * nothing through all three filters and looking at what comes out.
 *
 * The LAST test reads a file. POST /ai/create-component writes
 * component.json into the server's one real components/ directory, derived
 * from a module constant, so driving it in a unit test would either create a
 * component in the checkout or require rewriting the route to take a path.
 * What it must do is name the key rather than lean on a default — a statement
 * about that literal — so that is what the test says.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/agentTools.agentEnabled.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// ── The three filters under test, RUN ───────────────────────────────
// getAgentTools reaches the component manager, the agent store and the
// workflow store on the way to its filter; each is cut at the require seam so
// the predicate itself is what answers.

/** One global untenanted directory, as the component manager reports it. */
const COMPONENTS = [
    { id: 'says_yes', definition: { name: 'Says yes', agentEnabled: true, directChatEnabled: true, inputs: {} } },
    { id: 'says_no', definition: { name: 'Says no', agentEnabled: false, directChatEnabled: false, inputs: {} } },
    // What POST /ai/create-component used to write: no answer at all.
    { id: 'says_nothing', definition: { name: 'Says nothing', inputs: {} } },
];

// The component directory is replaced wholesale rather than per caller: Node
// caches a relative resolution per (directory, request), so a sibling in
// core/tools/ that asks for it first would hand directChatToolStack the real
// one behind a parent-scoped stub's back.
const componentManagerStub = { getComponents: () => COMPONENTS.map(c => ({ ...c, definition: { ...c.definition } })) };
const cmPath = require.resolve('../cms/componentManager');
require.cache[cmPath] = { id: cmPath, filename: cmPath, loaded: true, exports: componentManagerStub };

const MOCKS = {
    '../../stores/agentStore': {
        getAgentTools: async () => COMPONENTS.map(c => c.id),
        getAgentToolsWithParams: async () => COMPONENTS.map(c => ({ componentId: c.id, params: {} })),
    },
    '../../stores/workflowStore': { getAllWorkflows: async () => [] },
};
const DIRECT_CHAT_MOCKS = {
    '../../stores/configStore': { getConfig: async () => null },
    '../integrations/integrationTools': { getIntegrationTools: async () => ({ tools: [], n8nOrgId: null }) },
};
const idFor = {};
for (const [tag, map] of [['agent-tools', MOCKS], ['direct-chat', DIRECT_CHAT_MOCKS]]) {
    idFor[tag] = {};
    for (const [request, exportsObj] of Object.entries(map)) {
        const id = `mock:agent-enabled:${tag}:${request}`;
        idFor[tag][request] = id;
        require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
    }
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agentRuntime[\\/]agentTools\.js$/.test(parent.filename) && idFor['agent-tools'][request]) {
        return idFor['agent-tools'][request];
    }
    if (parent && /tools[\\/]directChatToolStack\.js$/.test(parent.filename) && idFor['direct-chat'][request]) {
        return idFor['direct-chat'][request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const { getAgentTools, getAvailableComponents } = require('./agentTools');
const { buildDirectChatToolStack } = require('../tools/directChatToolStack');

const nameOf = (t) => (t.function ? t.function.name : t.name);

test('a component that states no answer is callable from no agent', async () => {
    const tools = await getAgentTools('a1');
    const offered = tools.map(nameOf);
    assert.ok(offered.includes('says_yes'), 'a component that said yes must still be callable');
    assert.ok(!offered.includes('says_nothing'),
        'a component.json with no agentEnabled key is reachable by every agent in every org again');
    assert.ok(!offered.includes('says_no'));
});

test('the component LIST the model is shown fails closed the same way', async () => {
    const listed = (await getAvailableComponents()).map(c => c.id);
    assert.deepStrictEqual(listed, ['says_yes'],
        'the second filter is the one an agent reads to discover what it may call');
});

test('agentEnabled and directChatEnabled are governed by the same rule', async () => {
    // The two flags gate the same kind of thing — whether caller-authored code
    // is reachable from a chat surface — so they must not drift apart again.
    const { tools } = await buildDirectChatToolStack({ userId: 'u1', session: {} });
    const offered = tools.map(nameOf);
    assert.ok(offered.includes('says_yes'));
    assert.ok(!offered.includes('says_nothing'), 'direct chat must not admit a component by the absence of a field');
    assert.ok(!offered.includes('says_no'));
});

// ── The shipped catalog ─────────────────────────────────────────────

test('every shipped component states its own answer', () => {
    // Fail-closed only keeps today's behaviour because the components that
    // relied on the old default now declare it. A new component added without
    // the key would be silently unreachable, which is the safe direction but
    // still a surprise — so it is pinned here rather than discovered later.
    const dir = path.resolve(__dirname, '../../../components');
    if (!fs.existsSync(dir)) return; // not checked out in every deployment
    const missing = [];
    for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name, 'component.json');
        if (!fs.existsSync(file)) continue;
        let def;
        try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        if (typeof def.agentEnabled !== 'boolean') missing.push(name);
    }
    assert.deepStrictEqual(missing, [],
        'these components declare no agentEnabled — under the fail-closed filter they are '
        + 'unreachable from every agent. Add "agentEnabled": true|false to their component.json.');
});

// ── Source-level, and why: see the file header ──────────────────────

test('the AI creator writes the key instead of leaving it to a default', () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'ai', 'agentChat.js'), 'utf8');
    const body = routeSrc.slice(routeSrc.indexOf('const componentJson = {'));
    assert.match(body.slice(0, 1200), /agentEnabled:/,
        'POST /ai/create-component must write agentEnabled explicitly — omitting it is how a '
        + 'model-authored component became callable everywhere without anyone choosing it');
});
