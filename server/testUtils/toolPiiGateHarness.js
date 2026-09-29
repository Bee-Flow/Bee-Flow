/**
 * Shared scaffolding for the tests that pin the Privacy Shield's tool block
 * lists in a tool loop (BFSF-354, core/privacy/toolPiiGate.js).
 *
 * Each of those tests drives the REAL gate with its detector replaced, plants
 * one synthetic e-mail address, and uses a shield whose "Own server" list
 * blocks it. What they have in common lives here: the value, the shield, the
 * detector, a model that asks for one tool call and records what it read
 * back, a mounted router, the assertions every loop shares, and the cases the
 * notebook and webpage builder chats share (kbChatGateTests).
 *
 *   const restore = installResolveStub({ '../../core/providers': streamingToolCallProvider(fx), ... });
 *   const toolPiiGate = injectEmailDetector(gate);   // gate = the test's own core/privacy/toolPiiGate; after the stubs, before the module under test
 *   const baseUrl = serveRouter(test, require('./x'), { prefix: '/ai', session: SIGNED_IN, restore });
 */

'use strict';

const assert = require('node:assert');
const http = require('node:http');

/** The synthetic value every gate test plants and looks for. */
const SYNTH_EMAIL = 'someone@example.test';

/** A resolved shield whose "Own server" list blocks e-mail addresses. */
const OWN_SERVER_EMAIL = {
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};

/** A signed-in session for a mounted router. */
const SIGNED_IN = { user: { id: 'u1', organizationId: 'org-1' } };

/** What the model reads instead of a refused call's result. */
const REFUSED_FOR_EMAIL = /was not called: its arguments contained Email Address/;

/** `core/aiAgent` for a route that resolves one model on a test provider. */
const AI_AGENT_STUB = {
    getAIConfig: async () => ({ model: 'model-1' }),
    getProviderForModel: async () => ({ providerType: 'test', url: 'http://model.invalid', apiKey: 'k' }),
};

/**
 * `stores/configStore` for the real orgShield the gate loads (it reads its
 * config at call time), and for the few keys a route reads: `values`.
 */
function configStoreStub(values = {}) {
    return {
        getConfig: async (key) => values[key] ?? null,
        getSecret: async () => null, setConfig: async () => true, getAllConfig: async () => ({}),
    };
}

/**
 * A test's recording fixture: the shield and the tool call the next turn
 * uses, the guardrail rows and tool answers it records, plus `extra`.
 */
function gateFixture(extra = {}) {
    return { shield: null, toolCall: null, guardrailRows: [], toolMessages: [], ...extra };
}

/** Before a turn: empty every array `fx` records into, then set `values`. */
function resetFixture(fx, values) {
    for (const [key, value] of Object.entries(fx)) {
        if (Array.isArray(value)) fx[key] = [];
    }
    return Object.assign(fx, values);
}

/**
 * Replace the gate's detector: every SYNTH_EMAIL in a text is an 'Email'
 * entity whenever that category is asked for. Call it after the file's stubs
 * are installed (the gate loads its own dependencies). The caller passes the
 * gate module in: testUtils/ is a platform layer and may not require core/
 * (layering.test.js). Returns the gate.
 */
function injectEmailDetector(toolPiiGate) {
    toolPiiGate._deps.detectPii = async (text, categories) => {
        const found = [];
        const haystack = String(text);
        for (let at = haystack.indexOf(SYNTH_EMAIL); at >= 0 && categories.includes('Email'); at = haystack.indexOf(SYNTH_EMAIL, at + 1)) {
            found.push({ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: at, length: SYNTH_EMAIL.length });
        }
        return { hasPii: found.length > 0, entities: found };
    };
    return toolPiiGate;
}

/**
 * `core/providers` for a streamed tool loop. Round 1 asks for `fx.toolCall`
 * (and records the system prompt when `fx.systemPrompts` is an array); the
 * round after it records the tool answers the model read in `fx.toolMessages`
 * and ends the turn.
 */
function streamingToolCallProvider(fx, reply = 'Done.') {
    const stream = async (_key, _url, _model, messages, _opts, cb) => {
        const answers = messages.filter(m => m.role === 'tool');
        if (answers.length > 0) {
            fx.toolMessages.push(...answers);
            cb('text', { text: reply });
        } else {
            if (Array.isArray(fx.systemPrompts)) fx.systemPrompts.push(messages[0].content);
            cb('tool_use', { id: 'call_1', name: fx.toolCall.name, input: fx.toolCall.args });
        }
    };
    return { getAdapter: () => ({ stream }) };
}

/**
 * Serve `router` under `prefix` on a real server for this file's tests, as
 * `session` (a fresh copy per request) when one is given. After the tests the
 * server closes and `restore` runs. Returns a getter for the base URL.
 */
function serveRouter(test, router, { prefix, session = null, restore = null }) {
    const express = require('express');
    let server = null;
    let baseUrl = null;
    test.before(async () => {
        const app = express();
        app.use(express.json());
        if (session) app.use((req, _res, next) => { req.session = structuredClone(session); next(); });
        app.use(prefix, router);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
    });
    test.after(async () => {
        if (restore) restore();
        await new Promise((resolve) => server.close(resolve));
    });
    return () => baseUrl;
}

/** POST a JSON body; the status and the whole response (an SSE stream) as text. */
async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
}

/** What the model read has the planted value replaced by the gate's marker. */
function assertStripped(content) {
    assert.ok(!content.includes(SYNTH_EMAIL), 'the model still reads the blocked value');
    assert.match(content, /\[blocked:email\]/);
}

/** A refused call wrote one tool_blocked row, filed under `source`. */
function assertRefusalAudited(rows, source) {
    assert.strictEqual(rows[0].action_taken, 'tool_blocked');
    assert.strictEqual(rows[0].source, source);
}

/**
 * The cases every chat shares that offers a knowledge search (`kbTool`) and
 * the web search (agent_search), and injects knowledge-base passages into its
 * prompt without a tool call: the notebook and webpage builder chats.
 *
 * `turn({ shield?, toolCall })` runs one turn, the file's own shield when none
 * is given, and returns the streamed body. The file's stubs answer a knowledge
 * search and the injected passages with "billing: SYNTH_EMAIL" and a web search
 * with SYNTH_EMAIL; `fx` records kbSearches, webSearches, systemPrompts,
 * toolMessages and guardrailRows. `source` is the audit rows' label.
 */
function kbChatGateTests(test, { fx, turn, kbTool, source }) {
    test('a knowledge search whose query carries an own-server category is refused, never run', async () => {
        const body = await turn({ toolCall: { name: kbTool, args: { query: `mail from ${SYNTH_EMAIL}` } } });
        assert.deepStrictEqual(fx.kbSearches, [], 'a refused tool must not run');
        assert.match(fx.toolMessages[0].content, REFUSED_FOR_EMAIL);
        assert.match(body, /Tool blocked — arguments contain sensitive information/);
        assertRefusalAudited(fx.guardrailRows, source);
    });

    test('an own-server category in a tool result is stripped before the model reads it', async () => {
        await turn({ toolCall: { name: kbTool, args: { query: 'billing' } } });
        assert.strictEqual(fx.kbSearches.length, 1);
        assertStripped(fx.toolMessages[0].content);
    });

    test('the passages injected without a tool call are stripped too', async () => {
        await turn({ toolCall: { name: kbTool, args: { query: 'billing' } } });
        assert.ok(!fx.systemPrompts[0].includes(SYNTH_EMAIL), 'the blocked value reached the prompt');
        assert.ok(fx.systemPrompts[0].includes('billing: [blocked:email]'));
    });

    test('an outside tool is not held to the own-server list, and no shield changes nothing', async () => {
        await turn({ toolCall: { name: 'agent_search', args: { query: SYNTH_EMAIL } } });
        assert.strictEqual(fx.webSearches.length, 1);
        assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));

        await turn({ shield: null, toolCall: { name: kbTool, args: { query: SYNTH_EMAIL } } });
        assert.strictEqual(fx.kbSearches.length, 1);
        assert.ok(fx.toolMessages[0].content.includes(SYNTH_EMAIL));
        assert.ok(fx.systemPrompts[0].includes(`billing: ${SYNTH_EMAIL}`));
    });
}

module.exports = {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, SIGNED_IN, REFUSED_FOR_EMAIL, AI_AGENT_STUB,
    configStoreStub, gateFixture, resetFixture,
    injectEmailDetector, streamingToolCallProvider, serveRouter, postJson,
    assertStripped, assertRefusalAudited, kbChatGateTests,
};
