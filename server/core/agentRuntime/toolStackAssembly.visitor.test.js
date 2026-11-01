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
 * Same harness as toolStackAssembly.sandbox.test.js; the store returns the
 * pinned parameters this file hands it.
 *
 * Run: cd server && node --test core/agentRuntime/toolStackAssembly.visitor.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { tools: [], params: [] };

const MOCKS = {
    './agentTools': {
        getAgentTools: async () => fx.tools.map(t => ({ ...t })),
    },
    '../../stores/agentStore': {
        getConversationMeta: async () => ({}),
        getAgentToolsWithParams: async () => fx.params,
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:toolstack-visitor:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agentRuntime[\\/]toolStackAssembly\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { assembleToolStack } = require('./toolStackAssembly');
test.after(() => { Module._resolveFilename = originalResolve; });

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
