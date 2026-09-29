/**
 * chatWithAgent — the non-streaming agent tool loop honours the Privacy
 * Shield's tool block lists (BFSF-354).
 *
 * The streaming agent loop refused a tool whose arguments carried a category
 * on the "Outside tools" / "Own server" list and stripped those categories out
 * of what the model read of a result; this loop (the support responder and the
 * non-streaming agent route) did neither.
 *
 * Every dependency the loop touches is stubbed through testUtils/stubRequire;
 * the real gate (core/privacy/toolPiiGate) runs with its detector injected.
 * Test data is synthetic.
 *
 * Run: cd server && node --test core/agentRuntime/chatWithAgent.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const SYNTH_EMAIL = 'someone@example.test';

const fx = {
    shield: null,
    toolCall: null,
    dispatched: [],
    dispatchResult: null,
    guardrailRows: [],
    modelTurns: [],
};

// Round 1 asks for fx.toolCall; round 2 answers. Records what the model read.
const adapter = {
    chat: async (_key, _url, _model, messages) => {
        fx.modelTurns.push(messages);
        if (fx.modelTurns.length === 1) {
            return {
                content: null,
                toolCalls: [{ id: 'call_1', type: 'function', function: { name: fx.toolCall.name, arguments: JSON.stringify(fx.toolCall.args) } }],
            };
        }
        return { content: 'done', toolCalls: [] };
    },
};

const restore = installResolveStub({
    '../aiAgent': {
        getAIConfig: async () => ({}),
        getProviderForModel: async () => ({ apiKey: 'test-key', url: 'http://llm.invalid', providerType: 'openai', providerName: 'test' }),
    },
    '../providers': { getAdapter: () => adapter },
    '../../stores/agentStore': {
        getForRuntime: async (id) => ({ id, name: 'Test agent', organization_id: 'org-1', owner_id: 'owner-1', config: {} }),
        getAgentToolsWithParams: async () => [],
        getOrCreateConversation: async () => ({ id: 'conv-1', messages: [] }),
        updateConversation: async () => {},
    },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../utils/sanitize': { sanitizeToolResult: (r) => r },
    '../../utils/messageUtils': { sanitizeMessages: (m) => m },
    '../../utils/unicodeSanitizer': { sanitizeMessagesUnicode: () => ({ smugglingDetected: false }) },
    '../tools/toolExecution': {},
    '../tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../integrations/connectionResolution': { isLendingEnabled: () => false },
    './modelResolver': { resolveAgentModelWithTier: async () => ({ modelId: 'test-model', tierKey: 'fast' }) },
    '../llm/modelResolver': { getEUAwareTiers: async () => ({}), TIER_DEFAULTS: {}, findTierKeyForModel: () => null },
    './agentTools': { getAgentTools: async () => [{ type: 'function', function: { name: 'tool', parameters: {} } }] },
    './toolPolicy': { mayLendOwnerConnection: () => false },
    '../llm/promptUtils': { processSystemPrompt: (s) => s },
    '../privacy/piiDetection': { validateInputForPii: async () => null },
    '../privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../dlp/dlpRunner': { getConversationTokenMap: () => ({}), mergeTokenMap: () => {} },
    '../dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../dlp/applyTokenMapToOutbound': { applyTokenMapToOutbound: ({ systemPrompt, messages }) => ({ systemPrompt, messages }) },
    '../../telemetry/metrics': { recordAgentRun: () => {} },
    // The gate loads the REAL orgShield (classifyToolClass / isBlockedForTool);
    // only its config store is stubbed.
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
});
test.after(() => restore());

const toolPiiGate = require('../privacy/toolPiiGate');
toolPiiGate._deps.detectPii = async (text, categories) => {
    const i = String(text).indexOf(SYNTH_EMAIL);
    if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
    return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
};

const { chatWithAgent } = require('./chatWithAgent');

const OWN_SERVER_EMAIL = {
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};

function reset({ shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true } }) {
    fx.shield = shield;
    fx.toolCall = toolCall;
    fx.dispatchResult = dispatchResult;
    fx.dispatched = [];
    fx.guardrailRows = [];
    fx.modelTurns = [];
}

/** What the model read as the tool's answer in round 2. */
function toolMessageSeen() {
    return fx.modelTurns[1].find(m => m.role === 'tool');
}

test('an own-server block category in the arguments refuses the tool', async () => {
    reset({ toolCall: { name: 'notebook_read', args: { note: `mail ${SYNTH_EMAIL}` } } });
    const out = await chatWithAgent('agent-1', 'user-1', 'look it up');

    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.match(JSON.parse(toolMessageSeen().content).error, /was not called: its arguments contained Email Address/);
    assert.match(out.toolCalls[0].result, /arguments contain sensitive information \(Email Address\)/);
    assert.strictEqual(fx.guardrailRows.length, 1);
    assert.strictEqual(fx.guardrailRows[0].action_taken, 'tool_blocked');
    assert.strictEqual(fx.guardrailRows[0].source, 'agent_chat');
});

test('a blocked category in an own-server result is stripped before the model reads it', async () => {
    reset({ toolCall: { name: 'kb_search', args: { query: 'contact' } }, dispatchResult: { passage: `reach ${SYNTH_EMAIL}` } });
    await chatWithAgent('agent-1', 'user-1', 'who is the contact?');

    assert.strictEqual(fx.dispatched.length, 1);
    const seen = toolMessageSeen().content;
    assert.ok(!seen.includes(SYNTH_EMAIL), 'the model still reads the blocked value');
    assert.match(seen, /\[blocked:email\]/);
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('an outside tool is not held to the own-server list, and no shield changes nothing', async () => {
    reset({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { sent: SYNTH_EMAIL } });
    await chatWithAgent('agent-1', 'user-1', 'send it');
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(toolMessageSeen().content.includes(SYNTH_EMAIL));

    reset({ shield: null, toolCall: { name: 'notebook_read', args: { note: SYNTH_EMAIL } }, dispatchResult: { text: SYNTH_EMAIL } });
    await chatWithAgent('agent-1', 'user-1', 'read it');
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(toolMessageSeen().content.includes(SYNTH_EMAIL));
});

test('a fail-closed org refuses the tool when the scan cannot run', async () => {
    const real = toolPiiGate._deps.detectPii;
    toolPiiGate._deps.detectPii = async () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable: test' });
    try {
        reset({ shield: { ...OWN_SERVER_EMAIL, privacyAction: 'block' }, toolCall: { name: 'notebook_read', args: { note: 'x' } } });
        await chatWithAgent('agent-1', 'user-1', 'read it');
        assert.strictEqual(fx.dispatched.length, 0);
        assert.match(JSON.parse(toolMessageSeen().content).error, /PII guard is unavailable/);
    } finally {
        toolPiiGate._deps.detectPii = real;
    }
});
