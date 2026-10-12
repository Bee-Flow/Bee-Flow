/**
 * The raw OpenAI-compatible SSE path (Scaleway, untyped or unknown
 * OpenAI-shaped endpoints) builds its own request body. No provider adapter
 * runs `stripInternalFields` behind it, so the only thing between a stored
 * history and the wire is `sanitizeMessages`. A tool message whose content was
 * revived as an OBJECT (an old history row) used to go out verbatim and come
 * back as:
 *
 *   400 Invalid type for 'messages[4].content': expected one of a string or
 *       array of objects, but got an object instead.
 *
 * on every later turn of that conversation. This drives one round with a
 * stubbed fetch, no DLP map, and checks the body that would have been sent.
 *
 * Run: cd server && node --test core/agentRuntime/chatStream/rawSseStream.test.js
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const { streamRawSseRound } = require('./rawSseStream');

/** What the OpenAI-compatible endpoints accept for `content`. */
function assertWireLegal(messages, where) {
    messages.forEach((m, i) => {
        const ok = typeof m.content === 'string' || Array.isArray(m.content) || m.content === null;
        assert.ok(ok, `${where}: messages[${i}] (role '${m.role}') has ${typeof m.content} content — this is the 400`);
    });
}

function sseResponse(frames) {
    const body = frames.map(f => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('a tool message with object content reaches the wire as a string', async (t) => {
    const sent = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return sseResponse([
            { choices: [{ delta: { content: 'Gemeld.' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
            '[DONE]',
        ]);
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'automation_a1b2c3', arguments: '{}' } }];
    const finalMessages = [
        { role: 'user', content: 'Stuur de mail via de automation' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        // The shape the old history reader produced: the JSON text parsed back.
        { role: 'tool', tool_call_id: 'call_1', content: { sent: true, runId: 'run_9f2c' } },
        { role: 'assistant', content: 'De mail is verstuurd.' },
        { role: 'user', content: 'Meld dit bij de servicedesk' },
    ];

    const events = [];
    const out = await streamRawSseRound({
        agent: { name: 'Servicedesk', organization_id: null },
        agentId: 'a1', userId: 'u1', messageMetadata: {},
        modelToUse: 'mistral-small-3.2-24b-instruct-2506',
        conversation: null, // no DLP token map
        tools: [], signal: undefined,
        onEvent: (type, data) => events.push({ type, data }),
        regexConfig: null, guardrailViolation: null, _forceFinalAnswer: false,
        effectiveSystemPrompt: 'You are helpful.', effectiveVolatilePrompt: '',
        finalMessages, tierSettings: {},
        headers: { 'Content-Type': 'application/json' },
        apiUrl: 'https://llm.invalid/v1',
        _streamCallStart: Date.now(), _thinking: '',
    });

    assert.strictEqual(sent.length, 1, 'one request, no retries');
    assert.strictEqual(sent[0].url, 'https://llm.invalid/v1/chat/completions');
    const { messages } = sent[0].body;
    assertWireLegal(messages, 'raw SSE request body');
    // messages[0] is the system prompt, so the tool result sits at [3].
    assert.strictEqual(messages[3].role, 'tool');
    assert.strictEqual(messages[3].content, '{"sent":true,"runId":"run_9f2c"}');
    assert.strictEqual(messages[3].tool_call_id, 'call_1');
    assert.strictEqual(messages[2].content, null, 'a pure tool_calls turn keeps its null');
    assert.deepStrictEqual(messages[2].tool_calls, toolCalls);

    assert.strictEqual(out.contentBuffer, 'Gemeld.');
    assert.ok(events.some(e => e.type === 'content' && e.data.text === 'Gemeld.'));
});
