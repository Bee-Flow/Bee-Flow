/**
 * swarmRuntime — a swarm worker's tool calls honour the Privacy Shield's tool
 * block lists (BFSF-354).
 *
 * Workers dispatch the direct-chat tool stack through their own loop, which
 * neither refused a tool whose arguments carried a category on the "Outside
 * tools" / "Own server" list nor stripped those categories out of what the
 * worker's model read of a result.
 *
 * Runs the built-in research swarm (three researchers, one synthesiser) with
 * every dependency stubbed through testUtils/stubRequire; the real gate
 * (core/privacy/toolPiiGate) runs with its detector injected. Synthetic data.
 *
 * Run: cd server && node --test core/swarms/swarmRuntime.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const SYNTH_EMAIL = 'someone@example.test';

const fx = { shield: null, toolCall: null, dispatchResult: null, dispatched: [], guardrailRows: [], toolMessages: [] };

// A worker's first round asks for fx.toolCall; once it has a tool answer it
// writes its output. Records every tool message a worker's model read.
const adapter = {
    stream: async (_key, _url, _model, messages, _opts, cb) => {
        const toolMsgs = messages.filter(m => m.role === 'tool');
        if (toolMsgs.length === 0) {
            await cb('tool_use', { id: `call_${Math.random().toString(36).slice(2, 8)}`, name: fx.toolCall.name, input: fx.toolCall.args });
            return;
        }
        fx.toolMessages.push(...toolMsgs);
        await cb('text', { text: 'finding' });
    },
};

const restore = installResolveStub({
    '../llm/modelResolver': { resolveModelForTier: async () => 'test-model' },
    '../aiAgent': { getProviderForModel: async () => ({ providerType: 'openai', url: 'http://llm.invalid', apiKey: 'test-key' }) },
    '../providers': { getAdapter: () => adapter },
    '../tools/directChatToolStack': {
        buildDirectChatToolStack: async () => ({ tools: [{ type: 'function', function: { name: 'tool', parameters: {} } }], n8nOrgId: null }),
    },
    '../tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../dlp/dlpRunner': { getConversationTokenMap: () => ({}) },
    '../dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../dlp/applyTokenMapToOutbound': { applyTokenMapToMessages: ({ messages }) => messages },
    '../privacy/orgShield': { resolveShieldFor: async () => fx.shield },
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

const { runSwarmTurn } = require('./swarmRuntime');

const OWN_SERVER_EMAIL = {
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};

function run({ shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true } }) {
    Object.assign(fx, { shield, toolCall, dispatchResult, dispatched: [], guardrailRows: [], toolMessages: [] });
    return runSwarmTurn({
        swarmId: 'builtin:research_swarm', message: 'research this', send: () => {},
        userId: 'user-1', fallbackModelId: 'test-model', organizationId: 'org-1', conversationId: 'conv-1',
    });
}

test('a worker tool whose arguments carry an own-server block category is refused', async () => {
    await run({ toolCall: { name: 'notebook_read', args: { note: `mail ${SYNTH_EMAIL}` } } });
    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.strictEqual(fx.toolMessages.length, 4, 'every worker got an answer for its call');
    for (const m of fx.toolMessages) {
        assert.match(JSON.parse(m.content).error, /was not called: its arguments contained Email Address/);
    }
    assert.ok(fx.guardrailRows.length > 0 && fx.guardrailRows.every(r => r.action_taken === 'tool_blocked' && r.source === 'swarm'));
});

test('a blocked category in an own-server result is stripped before a worker reads it', async () => {
    await run({ toolCall: { name: 'kb_search', args: { query: 'contact' } }, dispatchResult: { passage: `reach ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.dispatched.length, 4);
    for (const m of fx.toolMessages) {
        assert.ok(!m.content.includes(SYNTH_EMAIL), 'a worker still reads the blocked value');
        assert.match(m.content, /\[blocked:email\]/);
    }
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('an outside tool is not held to the own-server list, and no shield changes nothing', async () => {
    await run({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { sent: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 4);
    assert.ok(fx.toolMessages.every(m => m.content.includes(SYNTH_EMAIL)));

    await run({ shield: null, toolCall: { name: 'notebook_read', args: { note: SYNTH_EMAIL } }, dispatchResult: { text: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 4);
    assert.ok(fx.toolMessages.every(m => m.content.includes(SYNTH_EMAIL)));
});
