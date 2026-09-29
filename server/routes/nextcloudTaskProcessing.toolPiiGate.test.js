/**
 * BFSF-354 — the Nextcloud Assistant's agent turn (runAgentTurn) honours the
 * Privacy Shield's tool block lists, as every other tool loop does: a tool
 * whose arguments carry a category on the "Outside tools" / "Own server" list
 * is refused, and what the model reads of a result has those categories
 * stripped. It did neither.
 *
 * The model, the tool catalog and the dispatcher are stubbed through
 * testUtils/stubRequire; the real gate runs with its detector injected, and
 * the real orgShield does the tool classification. Test data is synthetic.
 *
 * Run: cd server && node --test routes/nextcloudTaskProcessing.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, REFUSED_FOR_EMAIL, gateFixture, resetFixture, injectEmailDetector, assertStripped, assertRefusalAudited,
} = require('../testUtils/toolPiiGateHarness');

const fx = gateFixture({ dispatchResult: null, dispatched: [] });

const restore = installResolveStub({
    // The real orgShield (loaded by the gate for the tool classification)
    // reads its config here.
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
    '../core/integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: fx.toolCall.name, parameters: {} } }] }),
    },
    '../core/tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../core/llm/modelResolver': { resolveModelWithGlobalFallback: async () => 'model-1' },
    '../core/llm/llmClient': {
        // Round 1 asks for fx.toolCall; round 2 records the tool answer it read.
        chat: async (_model, messages) => {
            const toolMsgs = messages.filter(m => m.role === 'tool');
            if (toolMsgs.length === 0) {
                return { content: '', toolCalls: [{ id: 'call_1', function: { name: fx.toolCall.name, arguments: JSON.stringify(fx.toolCall.args) } }] };
            }
            fx.toolMessages.push(...toolMsgs);
            return { content: 'Done.' };
        },
    },
    '../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
});
test.after(() => restore());

const toolPiiGate = injectEmailDetector(require('../core/privacy/toolPiiGate'));

const { runAgentTurn } = require('./nextcloudTaskProcessing');

async function turn({ shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true } }) {
    resetFixture(fx, { shield, toolCall, dispatchResult });
    return runAgentTurn({ input: { input: 'look it up' }, org: { id: 'org-1' }, user: { id: 'u1' }, ncUid: 'alice' });
}

test('a tool whose arguments carry an own-server block category is refused', async () => {
    const out = await turn({ toolCall: { name: 'kb_search', args: { query: `mail from ${SYNTH_EMAIL}` } } });
    assert.strictEqual(out.output, 'Done.');
    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
    assert.strictEqual(fx.guardrailRows.length, 1);
    assertRefusalAudited(fx.guardrailRows, 'nextcloud_assistant');
    assert.strictEqual(fx.guardrailRows[0].organization_id, 'org-1');
});

test('a blocked category in an own-server result is stripped before the model reads it', async () => {
    await turn({ toolCall: { name: 'kb_search', args: { query: 'contact' } }, dispatchResult: { passage: `reach ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.dispatched.length, 1);
    assertStripped(fx.toolMessages[0].content);
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('an outside tool is not held to the own-server list, and no shield changes nothing', async () => {
    await turn({ toolCall: { name: 'agent_search', args: { query: SYNTH_EMAIL } }, dispatchResult: { hit: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));

    await turn({ shield: null, toolCall: { name: 'kb_search', args: { query: SYNTH_EMAIL } }, dispatchResult: { text: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
});

test('a block-action org whose guard is down refuses the call (fail-closed)', async () => {
    const detect = toolPiiGate._deps.detectPii;
    toolPiiGate._deps.detectPii = async () => ({ degraded: true, degradedReason: 'guard_unreachable: test', entities: [] });
    try {
        await turn({ shield: { ...OWN_SERVER_EMAIL, privacyAction: 'block' }, toolCall: { name: 'kb_search', args: { query: 'x' } } });
        assert.strictEqual(fx.dispatched.length, 0);
        assert.match(fx.toolMessages[0].content, /PII guard is unavailable/);
    } finally {
        toolPiiGate._deps.detectPii = detect;
    }
});
