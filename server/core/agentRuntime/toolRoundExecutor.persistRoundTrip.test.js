/**
 * The reported defect, end to end across the seam that caused it.
 *
 * An agent called a Bee Flow routine exposed as a tool (`automation_<id>`).
 * `dispatchAgentCallableTool` returns the run's `lastOutput` — an object —
 * which `buildLLMToolContent` serializes to `'{"sent":true,…}'` and the runtime
 * persists as the `role:'tool'` message. The store then JSON-parsed everything
 * it read back and kept whatever was not a string, so on the NEXT turn that
 * message came out of the database as an OBJECT. Nothing between the store and
 * the provider narrowed it again, so every later turn died on:
 *
 *   400 Invalid type for 'messages[4].content': expected one of a string or
 *       array of objects, but got an object instead.
 *
 * The index stayed fixed because the broken message sat in the HISTORY: the
 * conversation could never recover, whatever the user typed next.
 *
 * This drives the three real modules that meet at that seam — no DB, no
 * provider — and asserts the shape survives a full turn-to-turn round-trip.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/toolRoundExecutor.persistRoundTrip.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildLLMToolContent } = require('./toolRoundExecutor');
const { messagesToRows, rowToMessage } = require('../../stores/agent/conversationMessages');
const { PLAINTEXT_CONTEXT } = require('../../stores/agent/messageCrypto');
const { sanitizeMessages, stripInternalFields } = require('../../utils/messageUtils');

const CONV = 'conv-automation-roundtrip';
const ENCRYPTED = { key: require('crypto').createHash('sha256').update('dek').digest(), encryptMessages: true, encryptMeta: true, tier: 'managed' };

/** Persist a transcript and read it back, exactly as the next turn would. */
function reload(messages, ctx) {
    return messagesToRows(CONV, 'agent', messages, ctx).map(r => rowToMessage(r, ctx));
}

/** What the OpenAI-compatible adapters accept for `content`. */
function assertWireLegal(messages, where) {
    messages.forEach((m, i) => {
        const ok = typeof m.content === 'string' || Array.isArray(m.content) || m.content === null;
        assert.ok(ok, `${where}: messages[${i}] (role '${m.role}') has ${typeof m.content} content — this is the 400`);
    });
}

// The routine's final step output, as the runner hands it back.
const LAST_OUTPUT = { sent: true, runId: 'run_9f2c', to: '[email_1]', subject: 'Storing gemeld' };

function turnOneTranscript() {
    return [
        { role: 'user', content: 'Wil je een mail sturen naar [email_1] via de automation?' },
        {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'automation_a1b2c3', arguments: '{"to":"[email_1]"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: buildLLMToolContent(LAST_OUTPUT) },
        { role: 'assistant', content: 'De mail is verstuurd naar [email_1].' },
    ];
}

test('buildLLMToolContent serializes an object routine result to a string', () => {
    const content = buildLLMToolContent(LAST_OUTPUT);
    assert.strictEqual(typeof content, 'string');
    assert.ok(content.startsWith('{'), 'it is JSON text — which is exactly what used to be re-parsed');
});

test('a routine tool result survives the turn-to-turn round-trip as a string', () => {
    for (const ctx of [PLAINTEXT_CONTEXT, ENCRYPTED]) {
        const back = reload(turnOneTranscript(), ctx);
        const toolMsg = back.find(m => m.role === 'tool');
        assert.strictEqual(typeof toolMsg.content, 'string', 'the tool result must not be revived as an object');
        assert.strictEqual(toolMsg.content, buildLLMToolContent(LAST_OUTPUT));
        assert.strictEqual(toolMsg.tool_call_id, 'call_1', 'the id pairing the result to its call survives');
    }
});

test('the reloaded history is wire-legal all the way to the adapter', () => {
    const back = reload(turnOneTranscript(), ENCRYPTED);
    // Turn 2: the user asks something else and the whole history is replayed.
    const turnTwo = [...back, { role: 'user', content: 'Wil je dit probleem melden bij de servicedesk' }];
    const layout = [{ role: 'system', content: 'You are helpful.' }, ...sanitizeMessages(turnTwo)];

    assertWireLegal(layout, 'after sanitizeMessages');
    assertWireLegal(stripInternalFields(layout), 'after stripInternalFields');
    // messages[4] in the report — the slot the tool result lands in.
    assert.strictEqual(layout[3].role, 'tool');
    assert.strictEqual(typeof layout[3].content, 'string');
});

test('a routine that returns nothing does not put null on a tool message', () => {
    // dispatchAgentCallableTool returns `lastOutput ?? null`.
    const content = buildLLMToolContent(null);
    const back = reload([{ role: 'tool', tool_call_id: 'call_2', content }], ENCRYPTED);
    assert.strictEqual(typeof back[0].content, 'string', 'a tool message may not be null — only an assistant turn may');
    assert.strictEqual(back[0].content, 'null');
});

test('an assistant turn of pure tool_calls keeps its null through the round-trip', () => {
    const back = reload(turnOneTranscript(), ENCRYPTED);
    const assistant = back.find(m => m.role === 'assistant' && m.tool_calls);
    assert.strictEqual(assistant.content, null);
    assert.strictEqual(assistant.tool_calls[0].id, 'call_1');
});

test('multimodal history still reloads as content blocks', () => {
    const blocks = [{ type: 'text', text: 'kijk' }, { type: 'image_url', image_url: { url: 'https://x/y' } }];
    const back = reload([{ role: 'user', content: blocks }], ENCRYPTED);
    assert.deepStrictEqual(back[0].content, blocks, 'narrowing the parse must not break real block arrays');
});
