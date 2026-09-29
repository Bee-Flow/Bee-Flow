/**
 * Agent-callable routines vs. the per-agent grant list.
 *
 * `getIntegrationTools` hands an agent every active `agent_call` routine of
 * whoever happens to be CHATTING — the exposure is keyed to the asker, not to
 * the agent. `config.tools.automations` is the per-agent answer to that, and
 * this file pins what it may do: NARROW that set to the ids the agent's owner
 * granted, and nothing else.
 *
 * It used to SUPPRESS the whole set instead, on the theory that a curated set
 * was injected somewhere else. Nothing injected one. So the first person to
 * write `config.tools.automations` lost every routine their agent could call —
 * including the one they had just granted — and there was no error, no
 * warning, and nothing in the tool list to explain it. The regression test for
 * that is `a curated agent keeps the routine it granted`: if it ever returns
 * zero tools again, that trap is back.
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
// The routines capability the exposure is gated on.
ent.hasCapability = async () => true;

// The asker's own active routines. Two of them, so "narrowed" and "all" are
// different answers and a test cannot pass on both.
const routine = (name, id) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } },
    __automation: { id, userId: 'u1' },
});
const callable = require('../../automation/agentCallableTools');
callable.getAgentCallableToolsForUser = async () => [
    routine('automation_send_invoice', 'auto-1'),
    routine('automation_wipe_the_crm', 'auto-2'),
];
callable.getStepToolsForUser = async () => [];

const { getIntegrationTools } = require('./integrationTools');

const session = { user: { id: 'u1', role: 'user' } };
const routinesOf = (res) => res.tools.filter(t => t.__automation).map(t => t.function.name).sort();
const run = (agentConfig) => getIntegrationTools({ userId: 'u1', session, isAdmin: false, agentConfig });

test('an agent nobody curated is offered the caller\'s routines, as before', async () => {
    assert.deepStrictEqual(routinesOf(await run({ enabledIntegrations: ['gmail'] })),
        ['automation_send_invoice', 'automation_wipe_the_crm']);
});

test('direct chat (no agentConfig at all) is untouched', async () => {
    assert.deepStrictEqual(routinesOf(await getIntegrationTools({ userId: 'u1', session, isAdmin: false })),
        ['automation_send_invoice', 'automation_wipe_the_crm']);
});

test('a curated agent keeps the routine it granted — and only that one', async () => {
    const res = await run({ tools: { automations: { 'auto-1': { confirm: 'ask' } } } });

    assert.deepStrictEqual(routinesOf(res), ['automation_send_invoice'],
        'granting one routine must not cost the agent every routine: this exposure is the ONLY ' +
        'thing that offers them, so suppressing it here left the owner with nothing at all');
    assert.ok(!routinesOf(res).includes('automation_wipe_the_crm'),
        'and the point of the grant is that the asker\'s other routines stay out');
});

test('curating an APP does not touch the routines', async () => {
    // Only the automations section speaks about routines. A gmail grant is not
    // a statement about them, and reading it as one would take an agent's
    // routines away the moment someone ticked an action.
    assert.deepStrictEqual(routinesOf(await run({ tools: { gmail: { actions: ['gmail_search'] } } })),
        ['automation_send_invoice', 'automation_wipe_the_crm']);
});

test('a granted id that the asker does not own simply is not there', async () => {
    // The narrowing is an intersection, never a widening: a grant cannot
    // conjure a routine into a caller's list.
    assert.deepStrictEqual(routinesOf(await run({ tools: { automations: { 'auto-999': {} } } })), []);
});

test('a routine definition with no id is dropped from a curated agent', async () => {
    callable.getAgentCallableToolsForUser = async () => [
        { type: 'function', function: { name: 'automation_mystery', parameters: {} } },
    ];
    try {
        const res = await run({ tools: { automations: { 'auto-1': {} } } });
        assert.deepStrictEqual(res.tools.filter(t => t.function.name.startsWith('automation_')), [],
            'the grant is keyed on the automation id, so a definition that cannot show one ' +
            'cannot be matched against the owner\'s list — fail closed, not "probably fine"');
    } finally {
        callable.getAgentCallableToolsForUser = async () => [
            routine('automation_send_invoice', 'auto-1'),
            routine('automation_wipe_the_crm', 'auto-2'),
        ];
    }
});

test('with the grants unreadable, a curated agent gets no routines at all', async () => {
    // "I could not read the owner's list" is not permission to fall back on
    // the ASKER's whole list — which is the exposure the grant exists to
    // replace. An uncurated agent is unaffected: there is no list to read.
    const policy = require('../agentRuntime/toolPolicy');
    const real = policy.automationGrantsOf;
    policy.automationGrantsOf = () => { throw new Error('policy unavailable'); };
    try {
        assert.deepStrictEqual(routinesOf(await run({ tools: { automations: { 'auto-1': {} } } })), []);
        assert.deepStrictEqual(routinesOf(await run({ enabledIntegrations: ['gmail'] })),
            ['automation_send_invoice', 'automation_wipe_the_crm'],
            'and an agent with no automations section keeps what it has always been offered');
    } finally {
        policy.automationGrantsOf = real;
    }
});
