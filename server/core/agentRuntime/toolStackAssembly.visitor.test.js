'use strict';

/**
 * A visitor of a public embed and the tools the owner configured.
 *
 * A component tool whose parameters the owner pinned (`agent_tools.params`)
 * runs with the owner's values: a key, an address, a mailbox. Those values
 * were set for the owner's colleagues; a visitor who found the public page
 * gets the agent, not the owner's standing. So `assembleToolStack` leaves such
 * a tool OUT of a visitor's stack and forgets its parameters, unless the owner
 * opened that for this agent (`config.tools.publicVisitorsMayCallAutomations`).
 *
 * The agent's tools and the store's pinned parameters are patched on the real
 * modules; everything else is the shipped code.
 *
 * Run: cd server && node --test core/agentRuntime/toolStackAssembly.visitor.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const fx = { tools: [], params: [] };

// The two collaborators the stack reads, patched on the real modules before
// toolStackAssembly binds them: the agent's own tools, and the store that
// holds the parameters the owner pinned.
const agentTools = require('./agentTools');
const agentStore = require('../../stores/agentStore');
const originals = { getAgentTools: agentTools.getAgentTools, getAgentToolsWithParams: agentStore.getAgentToolsWithParams, getConversationMeta: agentStore.getConversationMeta };
agentTools.getAgentTools = async () => fx.tools.map(t => ({ ...t }));
agentStore.getAgentToolsWithParams = async () => fx.params;
agentStore.getConversationMeta = async () => ({});
test.after(() => { Object.assign(agentTools, { getAgentTools: originals.getAgentTools }); Object.assign(agentStore, { getAgentToolsWithParams: originals.getAgentToolsWithParams, getConversationMeta: originals.getConversationMeta }); });

const { assembleToolStack } = require('./toolStackAssembly');

const tool = (name) => ({ type: 'function', function: { name } });
const names = (tools) => tools.map(t => t.function && t.function.name).sort();

const GUEST = 'guest_0123456789abcdef01234567';

async function assemble(userId, config = {}) {
    return assembleToolStack({
        agent: { id: 'a1', owner_id: 'me', config: { disableExternalTools: true, ...config } },
        agentId: 'a1', userId, userAuth: { session: {} }, messageMetadata: {},
    });
}

test.beforeEach(() => {
    fx.tools = [tool('send_sms'), tool('lookup_order')];
    fx.params = [
        { componentId: 'send-sms', params: { apiKey: 'owner-secret', from: '+3161234' } },
        { componentId: 'lookup-order', params: {} },
    ];
});

test('a visitor is not offered the tool the owner pinned parameters on, and its parameters are gone', async () => {
    const out = await assemble(GUEST);
    assert.ok(!names(out.tools).includes('send_sms'), 'the owner\'s key must not act for a stranger');
    assert.ok(names(out.tools).includes('lookup_order'), 'a tool with no pinned values stays');
    assert.deepStrictEqual(Object.keys(out.toolParamsMap), ['lookup_order'],
        'the dispatcher must not be able to look the owner\'s values up either');
});

test('a signed-in person keeps the same stack, and so does a run with no session (a schedule, an AI task)', async () => {
    const out = await assemble('u1');
    assert.ok(names(out.tools).includes('send_sms'));
    assert.deepStrictEqual(out.toolParamsMap.send_sms, { apiKey: 'owner-secret', from: '+3161234' });
    const headless = await assembleToolStack({
        agent: { id: 'a1', owner_id: 'me', config: { disableExternalTools: true } },
        agentId: 'a1', userId: 'me', userAuth: { userId: 'me' }, messageMetadata: { unattended: true },
    });
    assert.ok(names(headless.tools).includes('send_sms'), 'the owner\'s own unattended run is not a visitor');
});

test('the owner can open the configured tools to visitors for this one agent', async () => {
    const out = await assemble(GUEST, { tools: { publicVisitorsMayCallAutomations: true } });
    assert.ok(names(out.tools).includes('send_sms'));
    assert.ok('send_sms' in out.toolParamsMap);
});
