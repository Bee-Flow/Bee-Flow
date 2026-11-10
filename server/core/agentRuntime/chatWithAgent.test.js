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

// The REAL token map (in memory) and the REAL outbound guard and argument
// restorer, loaded before the stubs go in: the Privacy Shield cases below run
// the helpers the streaming route runs.
const tokenMaps = require('../dlp/dlpTokenMaps');
const realOutbound = require('../dlp/applyTokenMapToOutbound');
const { restoreTokens } = require('../privacy/piiDetection/tokenRestore');

const SYNTH_EMAIL = 'someone@example.test';

const fx = {
    shield: null,
    toolCall: null,
    dispatched: [],
    dispatchResult: null,
    guardrailRows: [],
    modelTurns: [],
    /** @type {Record<string, unknown>[]} the stored history getOrCreateConversation hands out */
    history: [],
    /** @type {[string, ...unknown[]][]} every conversation write, by store function */
    writes: [],
    /** @type {string[] | null} the tool names offered this turn (null: the one the round asks for) */
    offered: null,
    /** @type {((messages: Array<{ content: string }>) => unknown) | null} the input-side privacy pass (null: finds nothing) */
    validateInput: null,
    /** @type {string | null} the model's final answer (null: 'done') */
    answer: null,
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
        return { content: fx.answer ?? 'done', toolCalls: [] };
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
        getOrCreateConversation: async () => ({ id: 'conv-1', messages: fx.history.map(m => ({ ...m })) }),
        updateConversation: async (...args) => { fx.writes.push(['updateConversation', ...args]); },
        saveConversationTurn: async (...args) => { fx.writes.push(['saveConversationTurn', ...args]); },
    },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../utils/sanitize': { sanitizeToolResult: (r) => r },
    '../../utils/messageUtils': { sanitizeMessages: (m) => m },
    '../../utils/unicodeSanitizer': { sanitizeMessagesUnicode: () => ({ smugglingDetected: false }) },
    '../tools/toolExecution': {},
    '../tools/toolDispatcher': {
        executeTool: async (name, args, context) => { fx.dispatched.push({ name, args, context }); return fx.dispatchResult; },
    },
    '../integrations/connectionResolution': { isLendingEnabled: () => false },
    './modelResolver': { resolveAgentModelWithTier: async () => ({ modelId: 'test-model', tierKey: 'fast' }) },
    '../llm/modelResolver': { getEUAwareTiers: async () => ({}), TIER_DEFAULTS: {}, findTierKeyForModel: () => null },
    // The tool the round asks for is offered, unless a test names the offer.
    './agentTools': { getAgentTools: async () => (fx.offered || [fx.toolCall.name]).map((name) => ({ type: 'function', function: { name, parameters: {} } })) },
    './toolPolicy': { mayLendOwnerConnection: () => false },
    '../llm/promptUtils': { processSystemPrompt: (s) => s },
    '../privacy/piiDetection': { validateInputForPii: async (messages) => (fx.validateInput ? fx.validateInput(messages) : null), restoreTokens },
    '../privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../dlp/dlpRunner': { getConversationTokenMap: tokenMaps.getConversationTokenMap, mergeTokenMap: (id, map) => tokenMaps._mergeIntoTokenMap(id, map) },
    '../dlp/tokenPreservationPrompt': { buildTokenPreservationAddendum: () => '' },
    '../dlp/applyTokenMapToOutbound': realOutbound,
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

function reset({ shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true }, history = [], offered = null }) {
    fx.offered = offered;
    fx.history = history;
    fx.writes = [];
    fx.shield = shield;
    fx.toolCall = toolCall;
    fx.dispatchResult = dispatchResult;
    fx.dispatched = [];
    fx.guardrailRows = [];
    fx.modelTurns = [];
    fx.validateInput = null;
    fx.answer = null;
    tokenMaps.clearConversationState('conv-1', { ephemeral: true });
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

test('KB query log: a caller with a synthetic user id names its real asker (or nobody) for the log', async () => {
    reset({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { ok: true } });
    await chatWithAgent('agent-1', 'support-ai:inbox:t1', 'look it up', { queryLogAsker: { userId: 'u-requester' } });
    assert.strictEqual(fx.dispatched[0].context.queryLog.asker, 'u-requester');
    reset({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { ok: true } });
    await chatWithAgent('agent-1', 'support-ai:inbox:t1', 'look it up', { queryLogAsker: { userId: null } });
    assert.strictEqual(fx.dispatched[0].context.queryLog.asker, null, 'an external requester has no account: logged as nobody');
    reset({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { ok: true } });
    await chatWithAgent('agent-1', 'user-1', 'look it up');
    assert.ok(!('asker' in fx.dispatched[0].context.queryLog), 'an ordinary turn keeps the asker the dispatcher derives');
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

// ── Saving the turn (issue #419) ────────────────────────────────────────────

test('the turn saves only its own rows, after the last stored message it was asked on', async () => {
    // A full replace of the history this turn read deleted any turn that
    // finished on the conversation in the meantime (a second tab or device).
    reset({
        shield: null,
        toolCall: { name: 'notebook_read', args: { note: 'x' } },
        history: [{ id: 'h1', role: 'user', content: 'earlier' }, { id: 'h2', role: 'assistant', content: 'reply' }],
    });
    await chatWithAgent('agent-1', 'user-1', 'read it');

    assert.deepStrictEqual(fx.writes.map(([fn]) => fn), ['saveConversationTurn']);
    const [, convId, { rows, anchorId }] = /** @type {[string, string, { rows: Record<string, unknown>[], anchorId: string }]} */ (fx.writes[0]);
    assert.strictEqual(convId, 'conv-1');
    assert.strictEqual(anchorId, 'h2');
    assert.deepStrictEqual(rows.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.strictEqual(rows[0].content, 'read it');
    assert.ok(rows.every(m => typeof m.id === 'string' && m.id), 'every row carries an id');
});

test('a tool name the model was not offered this turn is refused, not dispatched', async () => {
    reset({ shield: null, toolCall: { name: 'memory_search', args: { query: 'x' } }, offered: ['kb_search'] });
    const out = await chatWithAgent('agent-1', 'user-1', 'what do you know?');
    assert.strictEqual(fx.dispatched.length, 0, 'not dispatched');
    assert.match(JSON.parse(toolMessageSeen().content).error, /not available and was not called/);
    assert.deepStrictEqual(out.toolCalls[0].result, { error: 'tool not offered' });
});

// ── A tokenising Privacy Shield (the reply and the tool arguments) ──────────

/** The input pass of a shield that tokenises: the address in the last message becomes [email_1]. */
const tokeniseEmail = (messages) => {
    const last = messages[messages.length - 1];
    if (!String(last.content).includes(SYNTH_EMAIL)) return null;
    return { tokenizedText: String(last.content).split(SYNTH_EMAIL).join('[email_1]'), tokenMap: { '[email_1]': SYNTH_EMAIL } };
};
const TOKENISING = { enabled: true, privacyAction: 'redact', toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } } };
const everythingTheProviderRead = () => JSON.stringify(fx.modelTurns);

test('a tokenised turn: the provider reads tokens only, the caller and the stored turn get the real value back', async () => {
    reset({ shield: TOKENISING, toolCall: { name: 'gmail_send', args: { to: '[email_1]', body: 'Hello [email_1]' } }, dispatchResult: { sent: true } });
    fx.validateInput = tokeniseEmail;
    fx.answer = 'I wrote to [email_1] as you asked.';

    const out = await chatWithAgent('agent-1', 'user-1', `Mail ${SYNTH_EMAIL} about the invoice`);

    assert.strictEqual(out.message, `I wrote to ${SYNTH_EMAIL} as you asked.`, 'the reply carries the real value');
    assert.ok(!everythingTheProviderRead().includes(SYNTH_EMAIL), 'the provider never saw the real value');
    assert.ok(everythingTheProviderRead().includes('[email_1]'));

    const [, , { rows }] = /** @type {[string, string, { rows: Array<{ role: string, content: string }> }]} */ (fx.writes[0]);
    assert.strictEqual(rows[rows.length - 1].content, `I wrote to ${SYNTH_EMAIL} as you asked.`, 'the stored reply is the one the person reads');
});

test('a tokenised turn: the tool is dispatched with the real arguments, and the gate judges those', async () => {
    reset({ shield: TOKENISING, toolCall: { name: 'gmail_send', args: { to: '[email_1]', cc: ['[email_1]'], options: { note: 'for [email_1]' }, count: 2 } }, dispatchResult: { sent: true } });
    fx.validateInput = tokeniseEmail;
    const out = await chatWithAgent('agent-1', 'user-1', `Mail ${SYNTH_EMAIL}`);

    assert.deepStrictEqual(fx.dispatched[0].args, { to: SYNTH_EMAIL, cc: [SYNTH_EMAIL], options: { note: `for ${SYNTH_EMAIL}` }, count: 2 });
    assert.deepStrictEqual(out.toolCalls[0].args.to, SYNTH_EMAIL);
    // The assistant's own tool call goes back to the provider as it wrote it: with the token.
    assert.ok(!everythingTheProviderRead().includes(SYNTH_EMAIL));

    // The own-server block list is applied to the REAL arguments, not to a placeholder it cannot read.
    reset({ shield: { ...TOKENISING, toolPiiPolicy: OWN_SERVER_EMAIL.toolPiiPolicy }, toolCall: { name: 'notebook_read', args: { note: 'about [email_1]' } } });
    fx.validateInput = tokeniseEmail;
    await chatWithAgent('agent-1', 'user-1', `Look up ${SYNTH_EMAIL}`);
    assert.strictEqual(fx.dispatched.length, 0, 'a blocked category behind a token is still refused');
});

test('a real value a tool returns goes back to the provider as its token', async () => {
    reset({ shield: TOKENISING, toolCall: { name: 'gmail_send', args: { to: '[email_1]' } }, dispatchResult: { sentTo: SYNTH_EMAIL } });
    fx.validateInput = tokeniseEmail;
    await chatWithAgent('agent-1', 'user-1', `Mail ${SYNTH_EMAIL}`);
    assert.ok(!toolMessageSeen().content.includes(SYNTH_EMAIL));
    assert.ok(toolMessageSeen().content.includes('[email_1]'));
});

test('without a token map the reply and the arguments pass through untouched', async () => {
    reset({ shield: null, toolCall: { name: 'gmail_send', args: { to: '[email_1]' } }, dispatchResult: { ok: true } });
    fx.answer = 'Sent to [email_1].';
    const out = await chatWithAgent('agent-1', 'user-1', 'send it');
    assert.strictEqual(out.message, 'Sent to [email_1].');
    assert.deepStrictEqual(fx.dispatched[0].args, { to: '[email_1]' });
});
