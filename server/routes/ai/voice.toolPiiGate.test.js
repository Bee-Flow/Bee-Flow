/**
 * The voice turn's tool loop honours the Privacy Shield's tool block lists
 * (routes/ai/voice.js, BFSF-354).
 *
 * The streaming agent loop refused a tool whose arguments carried a category
 * on the "Outside tools" / "Own server" list and stripped those categories out
 * of what the model read of a result; the voice loop did neither.
 *
 * A real server with multer in front of the route, as in
 * voice.validation.test.js; dependencies are stubbed through
 * testUtils/stubRequire and the real gate (core/privacy/toolPiiGate) runs with
 * its detector injected. Test data is synthetic.
 *
 * Run: cd server && node --test routes/ai/voice.toolPiiGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { installResolveStub } = require('../../testUtils/stubRequire');

const SYNTH_EMAIL = 'someone@example.test';
const pass = (req, res, next) => next();

const fx = { shield: null, toolCall: null, dispatchResult: null, dispatched: [], guardrailRows: [], toolMessages: [] };

const restore = installResolveStub({
    // voice.js reads its Mistral key here; the real orgShield (loaded by the
    // gate for classifyToolClass / isBlockedForTool) reads its config here too.
    '../../stores/configStore': {
        getSecret: async () => 'mistral-key',
        getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}),
    },
    '../../core/providers': {
        getAdapter: () => ({
            // Round 1 asks for fx.toolCall; round 2 records the tool answer it read.
            stream: async (_key, _url, _model, messages, _opts, cb) => {
                const toolMsgs = messages.filter(m => m.role === 'tool');
                if (toolMsgs.length === 0) {
                    cb('tool_use', { id: 'call_1', name: fx.toolCall.name, input: fx.toolCall.args });
                    return;
                }
                fx.toolMessages.push(...toolMsgs);
                cb('text', { text: 'Klaar.' });
            },
        }),
    },
    '../../core/voice/voxtralStt': { transcribe: async () => ({ text: 'zoek het op', language: 'nl', duration: 1 }) },
    '../../core/voice/voxtralTts': { synthesize: async () => ({ audioBase64: null }) },
    '../../core/integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [{ type: 'function', function: { name: 'tool', parameters: {} } }] }),
        buildToolHint: async () => '',
    },
    '../../core/tools/toolDispatcher': {
        executeTool: async (name, args) => { fx.dispatched.push({ name, args }); return fx.dispatchResult; },
    },
    '../../stores/agentStore': { getForRuntime: async () => null },
    '../../stores/guardrailEventStore': { logGuardrailEvent: async (row) => { fx.guardrailRows.push(row); } },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => fx.shield },
    '../../auth/permissions': { requireAuth: pass },
    '../../auth/audience': {
        resolveAudienceContext: async () => ({ userId: 'u1', orgIds: new Set(['orgA']), userGroups: [] }),
        canSeePublished: () => false,
    },
});

const toolPiiGate = require('../../core/privacy/toolPiiGate');
toolPiiGate._deps.detectPii = async (text, categories) => {
    const i = String(text).indexOf(SYNTH_EMAIL);
    if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
    return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
};

const express = require('express');
const router = require('./voice');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

let server;
let baseUrl;
test.before(async () => {
    const app = express();
    app.use((req, res, next) => { req.session = { user: { id: 'u1', organizationId: 'orgA' } }; next(); });
    app.use('/ai/voice', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/ai/voice`;
});
test.after(async () => {
    restore();
    await new Promise((resolve) => server.close(resolve));
});

const OWN_SERVER_EMAIL = {
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};

async function turn({ shield = OWN_SERVER_EMAIL, toolCall, dispatchResult = { ok: true } }) {
    Object.assign(fx, { shield, toolCall, dispatchResult, dispatched: [], guardrailRows: [], toolMessages: [] });
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('fake-opus')], { type: 'audio/webm' }), 'turn.webm');
    form.append('history', '[]');
    const res = await fetch(`${baseUrl}/turn`, { method: 'POST', body: form });
    return { status: res.status, body: await res.text() };
}

test('a voice tool whose arguments carry an own-server block category is refused', async () => {
    const res = await turn({ toolCall: { name: 'notebook_read', args: { note: `mail ${SYNTH_EMAIL}` } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fx.dispatched.length, 0, 'a refused tool must not be dispatched');
    assert.strictEqual(fx.toolMessages.length, 1);
    assert.match(fx.toolMessages[0].content, /was not called: its arguments contained Email Address/);
    assert.strictEqual(fx.guardrailRows.length, 1);
    assert.strictEqual(fx.guardrailRows[0].action_taken, 'tool_blocked');
    assert.strictEqual(fx.guardrailRows[0].source, 'voice');
});

test('a blocked category in an own-server result is stripped before the model reads it', async () => {
    await turn({ toolCall: { name: 'kb_search', args: { query: 'contact' } }, dispatchResult: { passage: `reach ${SYNTH_EMAIL}` } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(!fx.toolMessages[0].content.includes(SYNTH_EMAIL), 'the model still reads the blocked value');
    assert.match(fx.toolMessages[0].content, /\[blocked:email\]/);
    assert.ok(fx.guardrailRows.some(r => r.action_taken === 'tool_result_redacted'));
});

test('an outside tool is not held to the own-server list, and no shield changes nothing', async () => {
    await turn({ toolCall: { name: 'gmail_send', args: { to: SYNTH_EMAIL } }, dispatchResult: { sent: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));

    await turn({ shield: null, toolCall: { name: 'notebook_read', args: { note: SYNTH_EMAIL } }, dispatchResult: { text: SYNTH_EMAIL } });
    assert.strictEqual(fx.dispatched.length, 1);
    assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
});
