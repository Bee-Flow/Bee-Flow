/**
 * Unit tests for the agent-callable automation helpers (trigger.kind === 'agent_call').
 *
 * Run: node --test automation/agentCallableTools.test.js
 *
 * Stub automationStore + automationRunner via require.cache so the module
 * loads without touching the database, and so dispatch is observable.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stub automationStore before requiring the module under test ──────────
const storePath = require.resolve('../stores/automationStore');
const fakeStore = {
    automations: [],
    // [automationId, agentId] pairs: the automation_agent_bindings table.
    bindings: [],
    getAutomation: async (id) => fakeStore.automations.find(a => a.id === id) || null,
    listAutomationsBoundToAgent: async (agentId) => fakeStore.bindings
        .filter(([, agt]) => agt === agentId)
        .map(([autoId]) => fakeStore.automations.find(a => a.id === autoId))
        .filter(Boolean),
    hasAgentBinding: async (automationId, agentId) => fakeStore.bindings.some(([a, g]) => a === automationId && g === agentId),
};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

// ── Stub the runner (lazy-required inside dispatch) ──────────────────────
const runnerPath = require.resolve('../core/automationRunner');
let lastRun = null;
require.cache[runnerPath] = {
    id: runnerPath, filename: runnerPath, loaded: true,
    exports: {
        executeAutomation: async (automation, opts) => {
            lastRun = { automationId: automation.id, opts };
            return { lastOutput: { ok: true, echoed: opts.triggerPayload } };
        },
    },
};

const {
    automationToTool,
    getAgentCallableTools,
    dispatchAgentCallableTool,
    dispatchAgentCallableByName,
    runnerTraceOptions,
} = require('./agentCallableTools');

// The agent and owner lookups the binding check makes, injected: the agent
// 'agt_1' is the owner's own, 'agt_other' belongs to nobody the owner can use.
const agents = {
    agt_1: { id: 'agt_1', owner_id: 'user_1', is_published: 1 },
    agt_2: { id: 'agt_2', owner_id: 'user_1', is_published: 1 },
    agt_foreign: { id: 'agt_foreign', owner_id: 'colleague', is_published: 0 },
    // Agents whose owner curated the automations section (config.tools.automations).
    agt_granted: { id: 'agt_granted', owner_id: 'user_1', is_published: 1, config: { tools: { automations: { auto_1: {} } } } },
    agt_other_grant: { id: 'agt_other_grant', owner_id: 'user_1', is_published: 1, config: { tools: { automations: { auto_9: {} } } } },
    agt_all_off: { id: 'agt_all_off', owner_id: 'user_1', is_published: 1, config: { tools: { automations: {} } } },
    agt_asks: { id: 'agt_asks', owner_id: 'user_1', is_published: 1, config: { tools: { automations: { auto_1: { confirm: 'ask' } } } } },
};
const world = {
    agentStore: { getForRuntime: async (id) => agents[id] || null },
    userStore: { getUser: async (id) => ({ id, organizationId: 'org_1', groups: [] }) },
};
const bindingDeps = { ...world, automationStore: fakeStore };

function agentAutomation(over = {}) {
    return {
        id: 'auto_1',
        userId: 'user_1',
        organizationId: 'org_1',
        title: 'Summarise inbox',
        isActive: true,
        definition: {
            trigger: {
                kind: 'agent_call',
                toolName: 'summarise_inbox',
                description: 'Summarise the unread inbox',
                parametersSchema: {
                    type: 'object',
                    properties: { limit: { type: 'number', description: 'how many' } },
                    required: ['limit'],
                },
            },
        },
        ...over,
    };
}

test('automationToTool renders the declared function schema', () => {
    const tool = automationToTool(agentAutomation());
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(tool.function.name, 'summarise_inbox');
    assert.strictEqual(tool.function.description, 'Summarise the unread inbox');
    assert.deepStrictEqual(tool.function.parameters.required, ['limit']);
    // routing metadata is present but not part of the function schema
    assert.deepStrictEqual(tool.__automation, { id: 'auto_1', userId: 'user_1', organizationId: 'org_1' });
});

test('automationToTool ignores non-agent_call triggers', () => {
    assert.strictEqual(automationToTool(agentAutomation({ definition: { trigger: { kind: 'schedule' } } })), null);
    assert.strictEqual(automationToTool({ id: 'x' }), null);
});

test('automationToTool defaults missing parametersSchema to an open object', () => {
    const a = agentAutomation();
    delete a.definition.trigger.parametersSchema;
    const tool = automationToTool(a);
    assert.strictEqual(tool.function.parameters.type, 'object');
    assert.strictEqual(tool.function.parameters.additionalProperties, true);
});

function reset(...autos) {
    fakeStore.automations = autos;
    fakeStore.bindings = [];
    lastRun = null;
}

test('automationToTool names the agent it was offered to, in the routing metadata only', () => {
    const tool = automationToTool(agentAutomation(), { agentId: 'agt_1' });
    assert.deepStrictEqual(tool.__automation, { id: 'auto_1', userId: 'user_1', organizationId: 'org_1', agentId: 'agt_1' });
    assert.strictEqual(JSON.stringify(tool.function).includes('agt_1'), false, 'the model never sees the agent id');
});

test('a bound agent is offered its automation, and only that one', async () => {
    reset(agentAutomation({ id: 'bound' }), agentAutomation({ id: 'unbound', definition: { trigger: { kind: 'agent_call', toolName: 'other_tool' } } }));
    fakeStore.bindings = [['bound', 'agt_1']];
    const tools = await getAgentCallableTools({ agentId: 'agt_1' }, bindingDeps);
    assert.deepStrictEqual(tools.map(t => t.__automation.id), ['bound']);
    assert.strictEqual(tools[0].__automation.agentId, 'agt_1');
});

test('an agent the automation is not bound to is offered nothing, however many it has', async () => {
    reset(agentAutomation({ id: 'bound' }));
    fakeStore.bindings = [['bound', 'agt_1']];
    assert.deepStrictEqual(await getAgentCallableTools({ agentId: 'agt_2' }, bindingDeps), []);
});

test('no agent, no tools: direct chat, Cowork, voice and /mcp pass none', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    assert.deepStrictEqual(await getAgentCallableTools({}, bindingDeps), []);
    assert.deepStrictEqual(await getAgentCallableTools({ agentId: null }, bindingDeps), []);
    assert.deepStrictEqual(await getAgentCallableTools(undefined, bindingDeps), []);
});

test('an inactive automation is not offered, nor one whose owner can no longer use the agent', async () => {
    reset(agentAutomation({ id: 'inactive', isActive: false }), agentAutomation({ id: 'active' }));
    fakeStore.bindings = [['inactive', 'agt_1'], ['active', 'agt_1']];
    const tools = await getAgentCallableTools({ agentId: 'agt_1' }, bindingDeps);
    assert.deepStrictEqual(tools.map(t => t.__automation.id), ['active']);

    // The same binding, an agent the owner may not use (someone else's draft).
    reset(agentAutomation({ id: 'active' }));
    fakeStore.bindings = [['active', 'agt_foreign']];
    assert.deepStrictEqual(await getAgentCallableTools({ agentId: 'agt_foreign' }, bindingDeps), []);
});

test('a binding lookup that fails offers nothing', async () => {
    const broken = { ...bindingDeps, automationStore: { listAutomationsBoundToAgent: async () => { throw new Error('db down'); } } };
    assert.deepStrictEqual(await getAgentCallableTools({ agentId: 'agt_1' }, broken), []);
});

test('the LIVE definition decides: a working copy that became an agent trigger is not offered before it is published', async () => {
    const draftOnly = agentAutomation({ liveVersion: 2 });
    Object.defineProperty(draftOnly, 'liveDefinition', { value: { trigger: { kind: 'manual' } }, enumerable: false });
    reset(draftOnly);
    fakeStore.bindings = [['auto_1', 'agt_1']];
    assert.deepStrictEqual(await getAgentCallableTools({ agentId: 'agt_1' }, bindingDeps), []);
    // ...and a dispatch of it is refused for the same reason.
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps),
        (e) => /no longer an agent tool/.test(e.message),
    );
});

test('dispatchAgentCallableTool runs the automation for a bound agent and returns its output', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    const out = await dispatchAgentCallableTool({ id: 'auto_1' }, { limit: 5 }, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps);
    assert.strictEqual(lastRun.automationId, 'auto_1');
    assert.strictEqual(lastRun.opts.triggerKind, 'agent_call');
    assert.deepStrictEqual(lastRun.opts.triggerPayload, { limit: 5 });
    assert.strictEqual(lastRun.opts.callerAgentId, 'agt_1');
    assert.deepStrictEqual(out, { ok: true, echoed: { limit: 5 } });
});

test('a colleague chatting with a bound agent starts it as the owner, and is recorded as the asker', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    // The asker has no relation to the automation: the binding is the agent\'s right.
    await dispatchAgentCallableTool({ id: 'auto_1' }, {}, {
        userId: 'colleague', askerUserId: 'colleague', agentId: 'agt_1', conversationId: 'conv_1',
    }, bindingDeps);
    assert.strictEqual(lastRun.opts.startedByUserId, 'colleague');
    assert.strictEqual(lastRun.opts.callerConversationId, 'conv_1');
    assert.strictEqual(lastRun.opts.callerAgentId, 'agt_1');
});

test('startedByUserId is recorded when a person asked without a conversation id (voice)', () => {
    assert.deepStrictEqual(
        runnerTraceOptions({ callerAgentId: 'a', callerConversationId: null, callerRunId: null }, { userId: 'person' }),
        { callerAgentId: 'a', callerConversationId: null, startedByUserId: 'person' },
    );
});

test('startedByUserId is not added for a call from inside an automation run', () => {
    const o = runnerTraceOptions({ callerAgentId: 'a', callerConversationId: null, callerRunId: 'r1' }, { userId: 'owner' });
    assert.ok(!('startedByUserId' in o));
});

test('startedByUserId is the asker, not an acting integration identity', () => {
    assert.deepStrictEqual(
        runnerTraceOptions({ callerAgentId: 'a', callerConversationId: 'c' }, { userId: 'operator', askerUserId: 'person' }),
        { callerAgentId: 'a', callerConversationId: 'c', startedByUserId: 'person' },
    );
});

test('dispatch refuses an agent the automation is not bound to, whatever was offered', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_2' }, bindingDeps),
        (e) => e.code === 'agent_not_allowed' && /not allowed/.test(e.message),
    );
    assert.strictEqual(lastRun, null, 'nothing ran');
});

test('dispatch refuses a call with no agent at all', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1' }, bindingDeps),
        (e) => e.code === 'agent_not_allowed',
    );
});

test('dispatch refuses once the binding is removed between offer and call', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    const offered = await getAgentCallableTools({ agentId: 'agt_1' }, bindingDeps);
    assert.strictEqual(offered.length, 1);
    fakeStore.bindings = [];
    await assert.rejects(
        () => dispatchAgentCallableTool(offered[0].__automation, {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps),
        (e) => e.code === 'agent_not_allowed',
    );
});

test('dispatch refuses an inactive automation', async () => {
    reset(agentAutomation({ isActive: false }));
    fakeStore.bindings = [['auto_1', 'agt_1']];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps),
        (e) => /not active/.test(e.message) && e.code === 'automation_inactive',
    );
});

test('dispatch refuses an automation that is no longer an agent trigger', async () => {
    reset(agentAutomation({ definition: { trigger: { kind: 'schedule' } } }));
    fakeStore.bindings = [['auto_1', 'agt_1']];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps),
        (e) => e.code === 'agent_not_allowed' && /no longer an agent tool/.test(e.message),
    );
});

test('dispatch refuses when the owner may no longer use the agent (unpublished, moved)', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_foreign']];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_foreign' }, bindingDeps),
        (e) => e.code === 'agent_not_allowed',
    );
});

test('dispatch fails closed when the binding lookup throws', async () => {
    reset(agentAutomation());
    const broken = { ...bindingDeps, automationStore: { ...fakeStore, hasAgentBinding: async () => { throw new Error('db down'); } } };
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, broken),
        (e) => e.code === 'agent_not_allowed',
    );
});

test('dispatchAgentCallableByName: an unbound name or a call with no agent is not handled', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    assert.deepStrictEqual(await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1' }, bindingDeps), { handled: false });
    assert.deepStrictEqual(await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1', agentId: 'agt_2' }, bindingDeps), { handled: false });
    assert.deepStrictEqual(await dispatchAgentCallableByName('not_a_tool', {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps), { handled: false });
    assert.strictEqual(lastRun, null);
});

test('dispatchAgentCallableByName starts a bound tool by its name, from the AI-step caller key too', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    const viaChat = await dispatchAgentCallableByName('summarise_inbox', { limit: 2 }, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps);
    assert.deepStrictEqual(viaChat, { handled: true, result: { ok: true, echoed: { limit: 2 } } });
    lastRun = null;
    const viaStep = await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1', callerAgentId: 'agt_1' }, bindingDeps);
    assert.strictEqual(viaStep.handled, true);
    assert.strictEqual(lastRun.opts.callerAgentId, 'agt_1');
});

test('dispatchAgentCallableByName turns a refusal into the tool result the model reads', async () => {
    reset(agentAutomation({ isActive: false }));
    fakeStore.bindings = [['auto_1', 'agt_1']];
    const out = await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps);
    assert.strictEqual(out.handled, true);
    assert.strictEqual(out.result.code, 'automation_inactive');
    assert.match(out.result.error, /not active/);
    assert.strictEqual(lastRun, null);
});

// ── The agent's own curation, decided again at dispatch ─────────────────
// Voice and the non-streaming chat dispatch any name the model emits, so a
// bound automation the owner switched off (or put on 'ask') must be refused here.

test('dispatch refuses a bound automation the agent\'s owner did not grant', async () => {
    reset(agentAutomation());
    for (const agentId of ['agt_other_grant', 'agt_all_off']) {
        fakeStore.bindings = [['auto_1', agentId]];
        await assert.rejects(
            () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId }, bindingDeps),
            (e) => e.code === 'agent_not_allowed',
            `${agentId}: bound but not granted`,
        );
        const byName = await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1', agentId }, bindingDeps);
        assert.strictEqual(byName.handled, true);
        assert.strictEqual(byName.result.code, 'agent_not_allowed');
    }
    assert.strictEqual(lastRun, null, 'nothing ran');
});

test('dispatch runs a bound automation the owner granted, and one on an uncurated agent', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_granted'], ['auto_1', 'agt_1']];
    await dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_granted' }, bindingDeps);
    assert.strictEqual(lastRun.opts.callerAgentId, 'agt_granted');
    lastRun = null;
    await dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, bindingDeps);
    assert.strictEqual(lastRun.opts.callerAgentId, 'agt_1');
});

test('a grant on "ask" runs only through a surface whose confirm layer stood in front of it', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_asks']];
    // Voice, the non-streaming chat, an unattended AI step: no confirm layer.
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_asks' }, bindingDeps),
        (e) => e.code === 'confirmation_required',
    );
    const refused = await dispatchAgentCallableByName('summarise_inbox', {}, { userId: 'user_1', agentId: 'agt_asks', confirmLayer: false }, bindingDeps);
    assert.strictEqual(refused.result.code, 'confirmation_required');
    assert.strictEqual(lastRun, null);
    // The streaming tool round (it held the call until the person approved).
    await dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_asks', confirmLayer: true }, bindingDeps);
    assert.strictEqual(lastRun.automationId, 'auto_1');
});

test('dispatch fails closed when the agent\'s config cannot be read', async () => {
    reset(agentAutomation());
    fakeStore.bindings = [['auto_1', 'agt_1']];
    let reads = 0;
    // The first read (the owner check) works, the grant read throws.
    const flaky = { ...bindingDeps, agentStore: { getForRuntime: async (id) => { if (++reads > 1) throw new Error('db down'); return agents[id]; } } };
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1' }, {}, { userId: 'user_1', agentId: 'agt_1' }, flaky),
        (e) => e.code === 'agent_not_allowed',
    );
});
