/**
 * An incognito direct chat (POST /ai/chat/direct/stream, `incognito: true`)
 * stores nothing of the conversation (core/conversation/incognito.mts).
 *
 * The real route, the real turn pipeline and the real stores, on a real
 * Postgres (the boot ladder's schema on PGlite, testUtils/routeHarness `pg`):
 * every statement the turn sends is recorded AND run, so "no row in
 * direct_conversations" is read off the database and off what was asked of it.
 * Swapped on their module objects: the provider (a fake adapter that answers
 * and reports usage), the tool stack builder (so the memory tools are on
 * offer) and the memory extractor (counted).
 *
 * Pinned:
 *   - the three refusals, a 400 with their code before anything is read;
 *   - an incognito turn writes no conversation, no message, no title, no
 *     memory and reads no stored history or memory; the SSE stream has no
 *     `conversation_created` and `done` carries no conversation id;
 *   - the memory and notebook tools are not offered, whatever the client sent;
 *   - the usage row IS written, without a conversation id;
 *   - a tokenised message: the model gets the token preservation note and the
 *     stream restores the token live, from the turn's own map (there is no
 *     conversation map to read);
 *   - the same turn without `incognito` still creates its conversation (the
 *     control: the recorder sees writes when there are writes).
 *
 * Run: cd server && node --test routes/ai/directChat/streamTurn.incognito.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../testUtils/routeHarness');
const { makeSwaps } = require('../../../testUtils/swaps');
const { parseSse } = require('../../../testUtils/builderStreamHarness');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');

/** What the fake provider saw, per stream call; every memory extraction asked for. */
const seen = { streams: [], extractions: 0 };
/** The chunks the fake provider streams back; a test may set its own. */
const reply = { chunks: ['Hello from the model.'] };

const fakeAdapter = {
    name: 'fake',
    async stream(_key, _url, _model, messages, options, cb) {
        seen.streams.push({ messages, tools: (options?.tools || []).map((t) => t.function?.name || t.name) });
        for (const text of reply.chunks) cb('text', { text });
        cb('done', { usage: { input_tokens: 11, output_tokens: 5 } });
    },
    async chat() { return { content: 'Hello from the model.' }; },
};

/** @param {string} name */
const tool = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

const swaps = makeSwaps();
test.after(() => swaps.restore());

/**
 * Swapped on the shared module objects (testUtils/swaps), after the database
 * is recorded and BEFORE the route loads: the turn's modules destructure
 * these when they are required.
 */
function swapSeams() {
    const aiAgent = require('../../../core/aiAgent');
    swaps.swap(aiAgent, 'getAIConfig', async () => ({ model: 'fake-model', piiDetectionEnabled: false }));
    swaps.swap(aiAgent, 'getProviderForModel', async () => ({ providerType: 'fake', providerName: 'Fake', url: 'http://fake.invalid', apiKey: 'k', model: 'fake-model' }));
    swaps.swap(require('../../../core/providers'), 'getAdapter', () => fakeAdapter);
    swaps.swap(require('../../../core/tools/directChatToolStack'), 'buildDirectChatToolStack', async () => ({
        tools: [tool('agent_search'), tool('memory_search'), tool('memory_remember'), tool('notebook_read')],
        n8nOrgId: null,
    }));
    // The extractor makes its own model call; counted, never run.
    swaps.swap(require('../../../agents/memory/extractor'), 'extractFromConversation', async () => { seen.extractions++; return []; });
}

const pg = ladderPglite();
const { db, api } = h.routeUnderTest(test, '/ai', () => { swapSeams(); return require('./streamTurn'); }, { pg });
/** @param {string} sql */
const count = async (sql) => Number((await pg.query(sql)).rows[0].n);
const post = (body) => api.call('POST', '/ai/chat/direct/stream', { body });

/** The SSE events of a response, in order. */
const eventsOf = (text) => parseSse(String(text || ''));

const WRITE = /^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i;
const CONTENT_TABLES = /\b(direct_conversations|agent_conversations|conversation_messages|user_memories|message_feedback|project_conversations)\b/i;
/** Statements that wrote to a table holding conversation content. */
const contentWrites = () => db.queries.filter((q) => WRITE.test(q) && CONTENT_TABLES.test(q));
/** Statements that read a stored conversation or memory. */
const contentReads = () => db.queries.filter((q) => /^\s*SELECT\b/i.test(q) && /\b(direct_conversations|conversation_messages|user_memories)\b/i.test(q));

/** Usage rows are written fire-and-forget; give them a moment to land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 200));

test.beforeEach(() => { seen.streams.length = 0; seen.extractions = 0; reply.chunks = ['Hello from the model.']; });

test('incognito refusals: a conversation id, attachments and Swarm are a 400 with their code, before anything is read', async () => {
    const cases = [
        [{ message: 'hi', incognito: true, conversationId: 'c-1' }, 'incognito_conversation_id'],
        [{ message: 'hi', incognito: true, attachments: [{ name: 'a.txt', type: 'text/plain', content: 'aGk=' }] }, 'incognito_no_attachments'],
        [{ message: 'hi', incognito: true, modelTier: 'swarm' }, 'incognito_unsupported_mode'],
    ];
    for (const [body, code] of cases) {
        const res = await post(body);
        assert.strictEqual(res.status, 400, res.text);
        assert.strictEqual(res.body.code, code);
    }
    assert.deepStrictEqual(db.queries, []);
    assert.strictEqual(seen.streams.length, 0, 'no model was called');
});

test('an incognito turn answers and stores nothing of the conversation', async () => {
    const res = await post({
        message: 'What is the capital of France?', incognito: true, modelTier: 'fast',
        history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
        // The client asking for memory changes nothing: incognito switches it off.
        memoryReadEnabled: true, memoryWriteEnabled: true,
    });
    await settled();
    assert.strictEqual(res.status, 200, res.text);
    const events = eventsOf(res.text);
    assert.ok(events.some((e) => e.event === 'content'), `no answer streamed: ${res.text.slice(0, 500)}`);

    assert.ok(!events.some((e) => e.event === 'conversation_created'), 'an incognito turn announced a conversation');
    assert.ok(!events.some((e) => e.event === 'title'), 'an incognito turn was given a title');
    const done = events.find((e) => e.event === 'done');
    assert.ok(done, 'no done event');
    assert.ok(!('conversationId' in done.data) || done.data.conversationId == null, `done carries a conversation id: ${JSON.stringify(done.data)}`);

    assert.deepStrictEqual(contentWrites(), [], 'a conversation, message or memory was written');
    assert.deepStrictEqual(contentReads(), [], 'a stored conversation or memory was read');
    assert.strictEqual(seen.extractions, 0, 'memory extraction ran on an incognito turn');

    // The model got the history from the request, and no memory tool.
    assert.strictEqual(seen.streams.length, 1);
    const [{ messages, tools }] = seen.streams;
    const texts = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    assert.ok(texts.includes('Earlier question') && texts.includes('Earlier answer'), 'the client history did not reach the model');
    assert.ok(tools.includes('agent_search'), `the ordinary tools are still offered: ${tools}`);
    for (const name of ['memory_search', 'memory_remember', 'notebook_read']) {
        assert.ok(!tools.includes(name), `${name} was offered to an incognito turn`);
    }

    // The cost row is kept, and it names no conversation.
    const { rows: usage } = await pg.query("SELECT conversation_id FROM ai_usage_log WHERE user_id = 'u1'");
    assert.strictEqual(usage.length, 1, 'expected one usage row');
    assert.strictEqual(usage[0].conversation_id, null, 'the usage row names a conversation');
    assert.strictEqual(await count('SELECT COUNT(*) AS n FROM direct_conversations'), 0, 'no conversation row');
});

test('an incognito turn whose message is tokenised tells the model about the tokens and restores them while streaming', async () => {
    // The Privacy Shield tokenises the message; the guard call itself is the seam.
    const turnSwaps = makeSwaps();
    try {
        turnSwaps.swap(require('../../../core/privacy/orgShield'), 'resolveShieldFor', async () => ({
            enabled: true, dlpEnabled: false, piiDetectionAction: 'tokenize',
        }));
        turnSwaps.swap(require('../../../core/privacy/piiDetection'), 'validateInputForPii', async () => ({
            entities: [{ label: 'person', category: 'person' }],
            tokenMap: { '[person_1]': 'Ada Example' },
            tokenizedText: 'Write a greeting for [person_1].',
        }));
        // The token arrives split over two chunks, as a provider may send it.
        reply.chunks = ['Dear [pers', 'on_1], welcome.'];

        const res = await post({ message: 'Write a greeting for Ada Example.', incognito: true, modelTier: 'fast' });
        await settled();
        assert.strictEqual(res.status, 200, res.text);
        const events = eventsOf(res.text);

        // The model was told to keep the placeholder.
        assert.strictEqual(seen.streams.length, 1);
        const system = seen.streams[0].messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
        assert.ok(system.includes('PII TOKEN PRESERVATION') && system.includes('`[person_1]`'), 'the token preservation note is missing from the prompt');
        const userText = seen.streams[0].messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
        assert.ok(userText.includes('[person_1]') && !userText.includes('Ada Example'), 'the model got the untokenised message');

        // The live stream (the `content` frames, before any final replace) carries the value, not the token.
        const streamed = events.filter((e) => e.event === 'content').map((e) => e.data.text).join('');
        assert.strictEqual(streamed, 'Dear Ada Example, welcome.');

        assert.deepStrictEqual(contentWrites(), [], 'a conversation, message or memory was written');
        assert.strictEqual(await count('SELECT COUNT(*) AS n FROM direct_conversations'), 0, 'no conversation row');
    } finally {
        turnSwaps.restore();
    }
});

test('control: the same turn without incognito creates its conversation', async () => {
    const res = await post({ message: 'What is the capital of France?', modelTier: 'fast' });
    await settled();
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(await count("SELECT COUNT(*) AS n FROM direct_conversations WHERE user_id = 'u1'"), 1, 'the conversation row exists');
    assert.ok(contentWrites().length > 0, 'the recorder sees writes when there are writes');
    assert.ok(seen.streams[0].tools.includes('memory_search'), 'without incognito the memory tools are offered');
    assert.strictEqual(seen.extractions, 1, 'without incognito the turn goes to memory extraction');
    assert.ok(contentReads().some((q) => /\buser_memories\b/i.test(q)), 'without incognito the memories are read for the prompt');
});
