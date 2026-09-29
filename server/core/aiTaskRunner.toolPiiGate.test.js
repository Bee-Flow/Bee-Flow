/**
 * BFSF-354 — the tool loop of a cowork / routine run without an agent
 * (executeTask) honours the Privacy Shield's tool block lists when the shield
 * applies to that path, i.e. when the org opted in through the cowork-shield
 * flag (core/entitlements/coworkShieldFlag.js, default OFF). A refused call is
 * never dispatched; what the model reads of a result has the forbidden
 * categories stripped. With the flag off the run stays exactly as it was: the
 * shield is not even resolved.
 *
 * The runner's collaborators are stubbed through testUtils/stubRequire (the
 * pattern of aiTaskRunner.coworkShield.test.js); coworkShield and the gate are
 * real, with the flag, the resolved shield and the detector injected. The
 * real orgShield classifies the tools. Test data is synthetic.
 *
 * Run: cd server && node --test core/aiTaskRunner.toolPiiGate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, REFUSED_FOR_EMAIL, injectEmailDetector, assertStripped, assertRefusalAudited,
} = require('../testUtils/toolPiiGateHarness');

const fx = {
    flag: false, shield: null, shieldCalls: 0, toolCall: null, dispatchResult: null,
    dispatched: [], guardrailRows: [], toolMessages: [], errors: [],
};

const fakeStore = {
    markRunning: async () => {},
    markCompleted: async () => {},
    markError: async (_id, err) => { fx.errors.push(err); },
    advanceSchedule: async () => {},
    updateTask: async () => {},
};

const aiAgentStub = {
    getAIConfig: async () => ({ piiDetectionEnabled: false }),
    getProviderForModel: async () => ({ providerType: 'stub', url: 'http://stub', apiKey: 'k' }),
};

const restore = installResolveStub({
    // — the runner —
    '../stores/aiTaskStore': fakeStore,
    '../db': { pool: { query: async () => ({ rows: [] }) } },
    '../stores/terminationStore': { logTermination: async () => {} },
    './llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        resolveEffectiveOrgId: async () => 'org-1',
        TIER_DEFAULTS: { fast: {}, thinking: {} },
    },
    './aiAgent': aiAgentStub,
    './providers': {
        getAdapter: () => ({
            // Round 1 asks for fx.toolCall; round 2 records the tool answer it read.
            chat: async (_key, _url, _model, messages) => {
                const toolMsgs = messages.filter(m => m.role === 'tool');
                if (toolMsgs.length === 0) {
                    return { content: '', toolCalls: [{ id: 'call_1', function: { name: fx.toolCall.name, arguments: JSON.stringify(fx.toolCall.args) } }] };
                }
                fx.toolMessages.push(...toolMsgs);
                return { content: 'Done.' };
            },
        }),
    },
    './integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: fx.toolCall.name, parameters: {} } }] }),
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../stores/notificationStore': { createNotification: async () => {} },
    '../stores/usageStore': { logUsage: async () => {} },
    '../utils/appPaths': { coworkTaskPath: (id) => `/app/cowork/${id}` },
    '../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    // — what coworkShield reaches —
    '../entitlements/coworkShieldFlag': { isCoworkShieldEnabled: async () => fx.flag },
    '../aiAgent': aiAgentStub,
    '../privacy/orgShield': { resolveShieldFor: async () => { fx.shieldCalls++; return fx.shield; } },
    '../privacy/piiDetection': { validateInputForPii: async () => null },
    // — the real orgShield, loaded by the gate for the tool classification —
    '../../stores/configStore': { getConfig: async () => null, getSecret: async () => '', getAllConfig: async () => ({}) },
});
test.after(() => restore());

injectEmailDetector(require('./privacy/toolPiiGate'));

const { executeTask } = require('./aiTaskRunner');

async function run({ flag = true, shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true } }) {
    Object.assign(fx, {
        flag, shield, shieldCalls: 0, toolCall, dispatchResult,
        dispatched: [], guardrailRows: [], toolMessages: [], errors: [],
    });
    await executeTask({ id: 'cw-1', userId: 'u1', modelTier: 'fast', title: 'Weekly', prompt: 'look it up' },
        { store: fakeStore, surface: 'cowork' });
    assert.deepStrictEqual(fx.errors, [], 'the run itself must not fail');
}

test('flag on: a tool whose arguments carry an own-server category is refused', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: `mail from ${SYNTH_EMAIL}` } } });
    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
    assertRefusalAudited(fx.guardrailRows, 'cowork');
    assert.strictEqual(fx.guardrailRows[0].organization_id, 'org-1');
});

test('flag on: an own-server category in a result is stripped before the model reads it', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: 'contact' } }, dispatchResult: { passage: `reach ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.dispatched.length, 1);
    assertStripped(fx.toolMessages[0].content);
});

test('flag off: the run is as before, and the shield is never resolved for the tools', async () => {
    await run({ flag: false, toolCall: { name: 'kb_search', args: { query: SYNTH_EMAIL } }, dispatchResult: { passage: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
    assert.strictEqual(fx.shieldCalls, 0);
    assert.deepStrictEqual(fx.guardrailRows, []);
});

test('flag on, outside tool: the own-server list does not reach it', async () => {
    await run({ toolCall: { name: 'agent_search', args: { query: SYNTH_EMAIL } }, dispatchResult: { hit: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
});
