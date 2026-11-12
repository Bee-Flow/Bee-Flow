/**
 * An incognito agent chat (POST /agents/:id/chat/stream, `incognito: true`)
 * stores nothing of the conversation (core/conversation/incognito.mts).
 *
 * The real route behind testUtils/routeHarness (its recording database sees
 * every statement), and the real agent turn (chatWithAgentStream) through
 * core/agentRuntime/agentTurn.testkit.js: a scripted provider and the stores
 * as recorders, so a write that happens is a write the test sees.
 *
 * Pinned:
 *   - the refusals: a conversation id, a test chat and attachments are a 400
 *     with their code, before the agent is even looked up;
 *   - incognito is ephemeral: no conversation is created, no turn saved, no
 *     memory read or extracted, whatever the client sent for memory;
 *   - the memory and notebook tools are not offered;
 *   - `done` carries no conversation id; the usage row is still written and
 *     names no stored conversation (the in-memory `ephemeral-…` id of the
 *     session, the same as the embed chat's);
 *   - plain `ephemeral` without incognito keeps its attachments and its
 *     tools: incognito changed nothing for the embed chat;
 *   - control: the same turn without either still saves the conversation.
 *
 * Run: cd server && node --test routes/agents/chat.incognito.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { parseSse } = require('../../testUtils/builderStreamHarness');
const { installAgentTurnHarness, turnState, resetTurnState, fn } = require('../../core/agentRuntime/agentTurn.testkit');

const S = { ...turnState(), writes: [], usage: [], memoryReads: 0, extractions: 0, };

/** @param {string} name */
const recordWrite = (name, result) => async (...args) => { S.writes.push(name); return typeof result === 'function' ? result(...args) : result; };

const kit = installAgentTurnHarness(S, {
    stubs: {
        '../../stores/agentStore': {
            // The route's owner check passes for the harness user (u1).
            getAgent: async () => ({ id: 'agent-1', name: 'Test Agent', owner_id: 'u1', organization_id: null, is_published: false, config: S.agentConfig }),
            getConversationById: async () => null,
            createNewConversation: recordWrite('createNewConversation', { id: 'c-stored', messages: [] }),
            getOrCreateConversation: recordWrite('getOrCreateConversation', { id: 'c-stored', messages: [] }),
            updateConversation: recordWrite('updateConversation'),
            saveConversationTurn: recordWrite('saveConversationTurn'),
            updateConversationMeta: recordWrite('updateConversationMeta'),
            updateConversationTitle: recordWrite('updateConversationTitle'),
        },
        '../../stores/usageStore': { logUsage: async (row) => { S.usage.push(row); } },
        '../../stores/memoryStore': {
            findRelevantMemories: async () => { S.memoryReads++; return []; },
            formatMemoriesForPrompt: () => '',
        },
        '../../agents/memory/extractor': { extractFromConversation: async () => { S.extractions++; return []; } },
    },
});
test.after(() => kit.restore());

const { db, api } = h.routeUnderTest(test, '/agents', () => require('./chat'));
const post = (body) => api.call('POST', '/agents/agent-1/chat/stream', { body });

/** The SSE events of a response, in order. */
const eventsOf = (text) => parseSse(String(text || ''));

const CONTENT_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b[\s\S]*\b(agent_conversations|direct_conversations|conversation_messages|user_memories)\b/i;

/** Fire-and-forget writes (usage, extraction) get a moment to land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

const TOOLS = [fn('crm_lookup'), fn('memory_search'), fn('memory_remember'), fn('notebook_write')];

test.beforeEach(() => {
    resetTurnState(S, {
        tools: TOOLS,
        drive: (cb) => { cb('text', { text: 'Hello from the agent.' }); cb('done', { usage: { input_tokens: 9, output_tokens: 4 } }); },
    });
    S.writes.length = 0; S.usage.length = 0; S.memoryReads = 0; S.extractions = 0;
});

test('incognito refusals: a conversation id, a test chat and attachments are a 400 with their code', async () => {
    const cases = [
        [{ message: 'hi', incognito: true, conversationId: 'c-1' }, 'incognito_conversation_id'],
        [{ message: 'hi', incognito: true, test: true }, 'incognito_unsupported_mode'],
        [{ message: 'hi', incognito: true, attachments: [{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,AAAA' }] }, 'incognito_no_attachments'],
    ];
    for (const [body, code] of cases) {
        const res = await post(body);
        assert.strictEqual(res.status, 400, res.text);
        assert.strictEqual(res.body.code, code);
    }
    assert.deepStrictEqual(db.queries, [], 'refused before anything was read');
    assert.strictEqual(S.toolsOfferedPerRound.length, 0, 'no model was called');
});

test('incognito is a boolean: a word is refused by the schema', async () => {
    h.assertRefused(assert, await post({ message: 'hi', incognito: 'yes' }), 'body.incognito', /true or false/);
});

test('an incognito agent turn answers and stores nothing of the conversation', async () => {
    const res = await post({
        message: 'hi', incognito: true, testSessionId: 'a3c1e2f4-0b9d-4c8e-9f1a-2b3c4d5e6f70',
        history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
        memoryReadEnabled: true, memoryWriteEnabled: true,
    });
    await settled();
    assert.strictEqual(res.status, 200, res.text);
    const events = eventsOf(res.text);

    assert.deepStrictEqual(S.writes, [], 'a conversation was created or saved');
    assert.deepStrictEqual(db.queries.filter((q) => CONTENT_WRITE.test(q)), [], 'a content table was written');
    assert.strictEqual(S.memoryReads, 0, 'memories were read for an incognito turn');
    assert.strictEqual(S.extractions, 0, 'memory extraction ran on an incognito turn');
    assert.ok(!events.some((e) => e.event === 'title_generated'), 'an incognito turn was given a title');

    const done = events.find((e) => e.event === 'done');
    assert.ok(done, `no done event: ${res.text.slice(0, 400)}`);
    assert.ok(!('conversationId' in done.data), `done carries a conversation id: ${JSON.stringify(done.data)}`);

    const offered = S.toolsOfferedPerRound[0] || [];
    assert.ok(offered.includes('crm_lookup'), `the ordinary tools are still offered: ${offered}`);
    for (const name of ['memory_search', 'memory_remember', 'notebook_write']) {
        assert.ok(!offered.includes(name), `${name} was offered to an incognito turn`);
    }

    // The cost row is kept. Its conversation id is the session's in-memory
    // id, never a stored conversation.
    assert.ok(S.usage.length >= 1, 'no usage row was written');
    for (const row of S.usage) {
        assert.ok(row.conversation_id == null || String(row.conversation_id).startsWith('ephemeral-'), `usage names a stored conversation: ${row.conversation_id}`);
    }
});

test('plain ephemeral (the embed chat) is unchanged: its attachments are accepted and its tools offered', async () => {
    const res = await post({ message: 'hi', ephemeral: true, attachments: [{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,AAAA' }] });
    await settled();
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(S.writes, [], 'ephemeral still stores nothing');
    assert.ok((S.toolsOfferedPerRound[0] || []).includes('memory_search'), 'ephemeral without incognito lost its memory tools');
});

test('control: the same turn without incognito saves the conversation', async () => {
    const res = await post({ message: 'hi' });
    await settled();
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(S.writes.includes('createNewConversation'), `no conversation created: ${S.writes}`);
    assert.ok(S.writes.includes('saveConversationTurn') || S.writes.includes('updateConversation'), `the turn was not saved: ${S.writes}`);
    assert.ok(S.memoryReads > 0, 'without incognito the memories are read');
    const done = eventsOf(res.text).find((e) => e.event === 'done');
    assert.strictEqual(done.data.conversationId, 'c-stored');
});
