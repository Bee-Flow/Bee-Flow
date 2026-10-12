/**
 * Agent-callable automations vs. the agent they are bound to, and the
 * per-agent grant list.
 *
 * `getIntegrationTools` offers an `agent_call` automation ONLY through the agent
 * it is bound to (automation_agent_bindings): it asks the binding lookup for
 * `agentId` and for nothing else. Direct chat, Cowork / AI tasks, plain voice
 * and the /mcp endpoint pass no agent and are offered none.
 *
 * `config.tools.automations` is the per-agent grant list on top of that, and
 * this file pins what it may do: NARROW the bound set to the ids the agent's
 * owner granted, and nothing else. It used to SUPPRESS the whole set instead,
 * so the first person to write it lost every automation their agent could call,
 * including the one they had just granted. The regression test for that is
 * `a curated agent keeps the automation it granted`.
 *
 * DB-free: the same monkeypatch harness as integrationTools.extraApps.test.js
 * — the module under test lazy-requires its data sources, so overwriting the
 * exports of the real modules is enough.
 *
 * Run: cd server && node --test --test-force-exit core/integrations/integrationTools.agentAutomations.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Patch destructure-at-load deps BEFORE requiring the module ──────
const permissions = require('../../auth/permissions');
permissions.hasPermission = async () => true;

const betaFeatures = require('../entitlements/betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

// ── Patch the lazy-required data sources ────────────────────────────
const configStore = require('../../stores/configStore');
configStore.getConfig = async () => null;
configStore.getSecret = async () => null;

const userStore = require('../../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;
userStore.getOrgEnabledIntegrations = async () => [];

try {
    const mcpManager = require('../mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

const ent = require('../entitlements/entitlements');
ent.resolveEntitlements = async () => ({
    degraded: false,
    tier: 'enterprise',
    ceiling: { core: [], integration: [], beta: [] },
    effective: { core: [], integration: [], beta: [] },
});
// The automations capability the exposure is gated on.
ent.hasCapability = async () => true;

// The automations bound to the agent 'agt-bound'. Two of them, so "narrowed"
// and "all" are different answers and a test cannot pass on both.
const automation = (name, id) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
    __automation: { id, userId: 'u1' },
});
const BOUND = () => [
    automation('automation_send_invoice', 'auto-1'),
    automation('automation_wipe_the_crm', 'auto-2'),
];
const callable = require('../../automation/agentCallableTools');
const lookups = [];
let boundTools = BOUND;
callable.getAgentCallableTools = async ({ agentId } = {}) => {
    lookups.push(agentId);
    return agentId === 'agt-bound' ? boundTools() : [];
};
callable.getStepToolsForUser = async () => [];

const { getIntegrationTools } = require('./integrationTools');

const session = { user: { id: 'u1', role: 'user' } };
const automationsOf = (res) => res.tools.filter(t => t.__automation).map(t => t.function.name).sort();
const run = (agentConfig, agentId = 'agt-bound') => getIntegrationTools({ userId: 'u1', session, isAdmin: false, agentConfig, agentId });

test('an agent nobody curated is offered the automations bound to it', async () => {
    assert.deepStrictEqual(automationsOf(await run({ enabledIntegrations: ['gmail'] })),
        ['automation_send_invoice', 'automation_wipe_the_crm']);
});

test('an agent with nothing bound to it is offered none', async () => {
    assert.deepStrictEqual(automationsOf(await run({ enabledIntegrations: ['gmail'] }, 'agt-unbound')), []);
});

test('no agent, no automation tools: direct chat, Cowork, voice and /mcp ask for none and the lookup never runs', async () => {
    lookups.length = 0;
    assert.deepStrictEqual(automationsOf(await getIntegrationTools({ userId: 'u1', session, isAdmin: false })), []);
    assert.deepStrictEqual(automationsOf(await getIntegrationTools({ userId: 'u1', session, isAdmin: false, agentConfig: { tools: {} } })), []);
    assert.deepStrictEqual(lookups, [], 'there was nothing to look up');
});

test('a curated agent keeps the automation it granted — and only that one', async () => {
    const res = await run({ tools: { automations: { 'auto-1': { confirm: 'ask' } } } });

    assert.deepStrictEqual(automationsOf(res), ['automation_send_invoice'],
        'granting one automation must not cost the agent every bound automation');
    assert.ok(!automationsOf(res).includes('automation_wipe_the_crm'),
        'and the point of the grant is that the other bound automations stay out');
});

test('an EMPTY automations section is a choice: all switched off', async () => {
    assert.deepStrictEqual(automationsOf(await run({ tools: { automations: {} } })), []);
});

test('curating an APP does not touch the automations', async () => {
    // Only the automations section speaks about automations. A gmail grant is not
    // a statement about them, and reading it as one would take an agent's
    // automations away the moment someone ticked an action.
    assert.deepStrictEqual(automationsOf(await run({ tools: { gmail: { actions: ['gmail_search'] } } })),
        ['automation_send_invoice', 'automation_wipe_the_crm']);
});

test('a granted id that is not bound to the agent simply is not there', async () => {
    // The narrowing is an intersection, never a widening: a grant cannot
    // conjure an automation into an agent's list, and a grant written before the
    // bindings existed cannot widen anything.
    assert.deepStrictEqual(automationsOf(await run({ tools: { automations: { 'auto-999': {} } } })), []);
});

test('an automation definition with no id is dropped from a curated agent', async () => {
    boundTools = () => [{ type: 'function', function: { name: 'automation_mystery', parameters: {} } }];
    try {
        const res = await run({ tools: { automations: { 'auto-1': {} } } });
        assert.deepStrictEqual(res.tools.filter(t => t.function.name.startsWith('automation_')), [],
            'the grant is keyed on the automation id, so a definition that cannot show one ' +
            'cannot be matched against the owner\'s list — fail closed, not "probably fine"');
    } finally {
        boundTools = BOUND;
    }
});

test('with the grants unreadable, a curated agent gets no automations at all', async () => {
    // "I could not read the owner's list" is not permission to fall back on
    // the whole bound set. An uncurated agent is unaffected: there is no list
    // to read.
    const policy = require('../agentRuntime/toolPolicy');
    const real = policy.automationGrantsOf;
    policy.automationGrantsOf = () => { throw new Error('policy unavailable'); };
    try {
        assert.deepStrictEqual(automationsOf(await run({ tools: { automations: { 'auto-1': {} } } })), []);
        assert.deepStrictEqual(automationsOf(await run({ enabledIntegrations: ['gmail'] })),
            ['automation_send_invoice', 'automation_wipe_the_crm'],
            'and an agent with no automations section keeps what is bound to it');
    } finally {
        policy.automationGrantsOf = real;
    }
});
