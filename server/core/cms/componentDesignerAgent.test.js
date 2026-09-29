/**
 * The Component Studio's designer agent: one instance per browser session,
 * a chat round against an OpenAI-compatible endpoint, and the component JSON
 * it lifts out of the answer.
 *
 * Run: node --test --test-force-exit core/cms/componentDesignerAgent.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const designer = { systemPrompt: null, model: null, toolIds: [] };
const restore = installResolveStub({
    '../../stores/agentStore': {
        getAgentTools: async () => designer.toolIds,
        getSystemAgent: async () => (designer.systemPrompt
            ? { system_prompt: designer.systemPrompt, model: designer.model }
            : null),
    },
    '../llm/providerConfig': {
        getAIConfig: async () => ({ url: 'https://llm.example/', model: 'configured-model', apiKey: 'k-1' }),
    },
    '../agentRuntime': {
        componentToTool: (c) => ({ type: 'function', function: { name: c.id } }),
        SYSTEM_TOOLS: [{ type: 'function', function: { name: 'execute_component' } }],
        executeComponentTool: async (name, args) => ({ ran: name, args }),
    },
    './componentManager': {
        getComponents: () => [
            { id: 'http-fetch', definition: { agentEnabled: true } },
            { id: 'private-thing', definition: { agentEnabled: false } },
        ],
    },
});
test.after(() => restore());

const { ComponentDesignerAgent, getOrCreateAgent, clearConversation } = require('./componentDesignerAgent');

const requests = [];
function stubChat(t, answers) {
    let i = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        const message = answers[Math.min(i++, answers.length - 1)];
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
    });
}

test.beforeEach(() => {
    requests.length = 0;
    designer.systemPrompt = null;
    designer.model = null;
    designer.toolIds = [];
});

// ─── The session store ───────────────────────────────────────────────────────

test('one agent per session id, the same one on every call', () => {
    const a = getOrCreateAgent('sess-1');
    assert.ok(a instanceof ComponentDesignerAgent);
    assert.strictEqual(getOrCreateAgent('sess-1'), a);
    assert.notStrictEqual(getOrCreateAgent('sess-2'), a);
});

test('clearConversation empties the session\'s history and tool calls but keeps the instance', async (t) => {
    stubChat(t, [{ role: 'assistant', content: 'Sure.' }]);
    const a = getOrCreateAgent('sess-clear');
    await a.chat('hello');
    assert.strictEqual(a.getHistory().length, 2);

    clearConversation('sess-clear');
    assert.deepStrictEqual(a.getHistory(), []);
    assert.deepStrictEqual(a.getToolCalls(), []);
    assert.strictEqual(getOrCreateAgent('sess-clear'), a);

    clearConversation('never-seen');   // no session, nothing to do, no throw
});

// ─── A chat round ────────────────────────────────────────────────────────────

test('a plain answer is appended to the history and returned with no component', async (t) => {
    stubChat(t, [{ role: 'assistant', content: 'What should the component do?' }]);
    const a = new ComponentDesignerAgent();

    const out = await a.chat('make me a component', null, {}, null);

    assert.strictEqual(out.message, 'What should the component do?');
    assert.strictEqual(out.component, null);
    assert.deepStrictEqual(out.toolCalls, []);
    assert.strictEqual(out.conversationLength, 2);
    assert.deepStrictEqual(a.getHistory().map(m => m.role), ['user', 'assistant']);

    const req = requests[0];
    assert.strictEqual(req.url, 'https://llm.example/v1/chat/completions', 'trailing slash dropped, /v1 added');
    assert.strictEqual(req.headers.Authorization, 'Bearer k-1');
    assert.strictEqual(req.body.model, 'configured-model');
    assert.strictEqual(req.body.messages[0].role, 'system');
    assert.match(req.body.messages[0].content, /component designer/i, 'the built-in fallback prompt when no system agent exists');
    // System tools are always offered, even with no components enabled.
    assert.deepStrictEqual(req.body.tools.map(tl => tl.function.name), ['execute_component']);
});

test('the system agent from the store overrides the fallback prompt and the model, and the context adds the component being edited', async (t) => {
    stubChat(t, [{ role: 'assistant', content: 'ok' }]);
    designer.systemPrompt = 'You design for Bee Flow.';
    designer.model = 'designer-model';
    const a = new ComponentDesignerAgent();

    await a.chat('tweak it', null, { componentId: 'http-fetch' });

    const req = requests[0];
    assert.strictEqual(req.body.model, 'designer-model');
    assert.match(req.body.messages[0].content, /^You design for Bee Flow\./);
    assert.match(req.body.messages[0].content, /editing component with ID: "http-fetch"/);
});

test('a tool call round trip: the tool runs, its result joins the history, and the loop asks again', async (t) => {
    stubChat(t, [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'http-fetch', arguments: '{"url":"https://x"}' } }] },
        { role: 'assistant', content: 'Done.\n```json\n{"id":"my-comp","name":"My comp","code":"module.exports = 1"}\n```' },
    ]);
    const a = new ComponentDesignerAgent();
    const progress = [];

    const out = await a.chat('fetch x', ['http-fetch', 'private-thing'], {}, (p) => progress.push(p.type));

    assert.strictEqual(requests.length, 2);
    // Only the agent-enabled component is offered, next to the system tools.
    assert.deepStrictEqual(requests[0].body.tools.map(tl => tl.function.name), ['http-fetch', 'execute_component']);
    assert.deepStrictEqual(out.toolCalls, [{ name: 'http-fetch', args: { url: 'https://x' }, result: { ran: 'http-fetch', args: { url: 'https://x' } } }]);
    assert.deepStrictEqual(a.getHistory().map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.strictEqual(a.getHistory()[2].tool_call_id, 'call-1');
    assert.deepStrictEqual(out.component, { id: 'my-comp', name: 'My comp', code: 'module.exports = 1' });
    assert.deepStrictEqual(progress, ['thinking', 'tool', 'thinking', 'finalizing']);
});

test('an empty answer is replaced by a fallback line rather than stored empty', async (t) => {
    stubChat(t, [{ role: 'assistant', content: '   ' }]);
    const a = new ComponentDesignerAgent();
    const out = await a.chat('...');
    assert.match(out.message, /ready to help/);
});

test('a non-2xx answer from the endpoint is thrown, with the status', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 503 }));
    const a = new ComponentDesignerAgent();
    await assert.rejects(() => a.chat('hi'), /503 - nope/);
});

// ─── extractComponentData ────────────────────────────────────────────────────

test('extractComponentData reads a json block in any of the three shapes, and only when it looks like a component', () => {
    const a = new ComponentDesignerAgent();
    const comp = { id: 'c', name: 'C', code: 'x' };
    const json = JSON.stringify(comp);

    assert.deepStrictEqual(a.extractComponentData('Here:\n```json\n' + json + '\n```\ndone'), comp);
    assert.deepStrictEqual(a.extractComponentData('```json' + json + '```'), comp);
    assert.deepStrictEqual(a.extractComponentData('```\n' + json + '\n```'), comp);

    assert.strictEqual(a.extractComponentData('```json\n{"id":"c","name":"C"}\n```'), null, 'no code, not a component');
    assert.strictEqual(a.extractComponentData('```json\n{not json\n```'), null);
    assert.strictEqual(a.extractComponentData('no block at all'), null);
    assert.strictEqual(a.extractComponentData(null), null);
});
