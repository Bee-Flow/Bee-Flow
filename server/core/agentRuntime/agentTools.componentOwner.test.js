/**
 * A component written by one organisation is listed for, and callable by,
 * that organisation only.
 *
 * components/ is ONE global directory. POST /ai/create-component wrote a
 * component.json that said nothing about who it belonged to, so a component a
 * member of org A had the model write showed up in org B's agent designer
 * catalogue (GET /agents/meta/components) and could be attached to, and run by,
 * org B's agents — receiving org B's inputs. The route now records
 * `owner: { orgId }` (or `{ userId }` for a creator without an org), and both
 * readers apply componentVisibleTo.
 *
 * What this file pins, through the real filters with the stores swapped in
 * through agentTools._setDepsForTests:
 *
 *   - unowned components (shipped, or written before owners existed): every
 *     caller, anonymous included, exactly as before;
 *   - an org-owned component: that org's users and agents, nobody else;
 *   - a user-owned component: that user and their agents only;
 *   - an owner that names nobody (malformed): nobody;
 *   - a caller or agent owner that cannot be resolved: unowned components only.
 *
 * Run: cd server && node --test core/agentRuntime/agentTools.componentOwner.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const USERS = {
    'u-a1': { id: 'u-a1', organizationId: 'org-a' },
    'u-a2': { id: 'u-a2', organizationId: 'org-a' },
    'u-b1': { id: 'u-b1', organizationId: 'org-b' },
    'u-solo': { id: 'u-solo', organizationId: null },
};

const AGENTS = {
    'agent-a': { id: 'agent-a', userId: 'u-a2', config: {} },
    'agent-b': { id: 'agent-b', userId: 'u-b1', config: {} },
    'agent-solo': { id: 'agent-solo', userId: 'u-solo', config: {} },
    'agent-ownerless': { id: 'agent-ownerless', userId: null, config: {} },
};

const COMPONENTS = [
    { id: 'shipped', definition: { name: 'Shipped', agentEnabled: true, inputs: {} } },
    { id: 'org-a-tool', definition: { name: 'A tool', agentEnabled: true, inputs: {}, owner: { orgId: 'org-a' } } },
    { id: 'solo-tool', definition: { name: 'Solo tool', agentEnabled: true, inputs: {}, owner: { userId: 'u-solo' } } },
    { id: 'nobody-tool', definition: { name: 'Nobody', agentEnabled: true, inputs: {}, owner: {} } },
    { id: 'org-a-off', definition: { name: 'A off', agentEnabled: false, inputs: {}, owner: { orgId: 'org-a' } } },
];
const ALL_IDS = COMPONENTS.map(c => c.id);

const state = { userStoreFails: false };
const { getAgentTools, getAvailableComponents, componentVisibleTo, _setDepsForTests } = require('./agentTools');

_setDepsForTests({
    componentManager: () => ({ getComponents: () => COMPONENTS.map(c => ({ ...c, definition: { ...c.definition } })) }),
    agentStore: () => ({
        getAgentTools: async () => ALL_IDS,
        getAgentToolsWithParams: async () => [],
        getForRuntime: async (id) => AGENTS[id] || null,
    }),
    workflowStore: () => ({ getAllWorkflows: async () => [] }),
    userStore: () => ({
        getUser: async (id) => {
            if (state.userStoreFails) throw new Error('db down');
            return USERS[id] ? { ...USERS[id] } : null;
        },
    }),
    entitlements: () => ({ resolveEntitlements: async () => ({ degraded: true }) }),
    integrationTools: () => ({
        appendMcpTools: async () => {},
        appendCustomIntegrationTools: async () => {},
    }),
});
test.after(() => _setDepsForTests());
test.afterEach(() => { state.userStoreFails = false; });

const idsOf = (list) => list.map(c => c.id).sort();
const toolNames = (tools) => tools.map(t => (t.function ? t.function.name : t.name)).sort();

// ── The catalogue (GET /agents/meta/components, /ai/tools) ───────────

test('the anonymous catalogue lists unowned components only', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents()), ['shipped']);
});

test('the creating org sees its component, colleagues included', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-a1' })), ['org-a-tool', 'shipped']);
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-a2' })), ['org-a-tool', 'shipped']);
});

test('another org does not see it', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-b1' })), ['shipped'],
        'org B was offered code a member of org A had the model write');
});

test('a user-owned component is listed for that user only', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-solo' })), ['shipped', 'solo-tool']);
});

test('a caller that does not resolve, or a failing lookup, sees unowned components only', async () => {
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-deleted' })), ['shipped']);
    state.userStoreFails = true;
    assert.deepStrictEqual(idsOf(await getAvailableComponents({ userId: 'u-a1' })), ['shipped']);
});

// ── The tools an agent is offered ────────────────────────────────────

test('an agent of the creating org is offered the component, as before', async () => {
    assert.deepStrictEqual(toolNames(await getAgentTools('agent-a')), ['org_a_tool', 'shipped']);
});

test('an agent of another org is not, even when configured with its id', async () => {
    assert.deepStrictEqual(toolNames(await getAgentTools('agent-b')), ['shipped']);
});

test('a user-owned component is offered to that user\'s agents only', async () => {
    assert.deepStrictEqual(toolNames(await getAgentTools('agent-solo')), ['shipped', 'solo_tool']);
});

test('an ownerless agent, or one whose owner lookup fails, gets unowned components only', async () => {
    assert.deepStrictEqual(toolNames(await getAgentTools('agent-ownerless')), ['shipped']);
    state.userStoreFails = true;
    assert.deepStrictEqual(toolNames(await getAgentTools('agent-a')), ['shipped']);
});

// ── The predicate itself ─────────────────────────────────────────────

test('componentVisibleTo: absent owner is global, a malformed one is nobody\'s', () => {
    assert.strictEqual(componentVisibleTo({}, {}), true);
    assert.strictEqual(componentVisibleTo({ owner: null }, {}), true);
    assert.strictEqual(componentVisibleTo({ owner: {} }, { userId: 'u', orgId: 'o' }), false);
    assert.strictEqual(componentVisibleTo({ owner: 'org-a' }, { orgId: 'org-a' }), false);
    assert.strictEqual(componentVisibleTo({ owner: { orgId: 'org-a' } }, { orgId: null }), false);
    assert.strictEqual(componentVisibleTo({ owner: { orgId: 'org-a' } }, { orgId: 'org-a' }), true);
    // An org-owned component is not reachable by a user id that happens to match nothing org-wise.
    assert.strictEqual(componentVisibleTo({ owner: { orgId: 'org-a' } }, { userId: 'u-a1', orgId: 'org-b' }), false);
});
