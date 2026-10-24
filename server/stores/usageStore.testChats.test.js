'use strict';

/**
 * "n test conversations" (A4).
 *
 * A test chat deliberately writes NO row to `agent_conversations` — that is what keeps it out
 * of the history, out of the footer card (A5) and out of the Used-by tab. It does cost money,
 * so it IS in `ai_usage_log`, under its own source. These two things together are the whole
 * count, and both can break independently:
 *
 *   • the SOURCE can be renamed on one side (the runtime writes 'agent_test_chat', the query
 *     looks for something else) — then it silently counts zero and nobody sees that anything
 *     is wrong;
 *   • the UNIT can shift — counting model calls instead of conversations turns three test
 *     conversations into twelve.
 *
 * Run: cd server && node --test stores/usageStore.testChats.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const usageStore = require('./usageStore');
const testChat = require('../core/agentRuntime/testChat');

test('the store and the runtime name the SAME source', () => {
    // The constant is written out literally in both files, so that a store does not have to pull
    // anything out of the runtime. This assertion is the price of that: renaming one side turns
    // red here instead of silently.
    assert.strictEqual(usageStore.TEST_CHAT_SOURCE, testChat.TEST_CHAT_USAGE_SOURCE);
    assert.strictEqual(usageStore.TEST_CHAT_SOURCE, 'agent_test_chat');
});

function fakeDb(rows, capture = []) {
    return {
        async query(sql, params) { capture.push({ sql, params }); return { rows }; },
    };
}

test('one ephemeral conversation counts as ONE test chat, not one per model call', async () => {
    const seen = [];
    const db = fakeDb([{ agent_id: 'a1', test_chats: 3 }], seen);
    const out = await usageStore.getTestChatCounts(['a1', 'a2'], { db });

    assert.strictEqual(out.get('a1'), 3);
    assert.strictEqual(out.get('a2'), 0, 'an agent nobody test-chatted is a fact, not a gap');
    assert.match(seen[0].sql, /COUNT\(DISTINCT conversation_id\)/,
        'a test chat is many usage rows — counting rows would multiply the answer');
    assert.deepStrictEqual(seen[0].params, [['a1', 'a2'], 'agent_test_chat']);
});

test('only the test-chat source is counted, and only rows that name a conversation', async () => {
    const seen = [];
    await usageStore.getTestChatCounts(['a1'], { db: fakeDb([], seen) });
    assert.match(seen[0].sql, /source = \$2/, 'an ordinary chat may never land in this number');
    assert.match(seen[0].sql, /conversation_id IS NOT NULL/,
        'a row that cannot be attributed to a conversation must not round the count up');
});

test('an empty or junk id list asks the database nothing', async () => {
    const seen = [];
    const db = fakeDb([], seen);
    for (const ids of [[], null, undefined, [null, '', false]]) {
        const out = await usageStore.getTestChatCounts(ids, { db });
        assert.strictEqual(out.size, 0);
    }
    assert.strictEqual(seen.length, 0);
});

test('a row for an agent nobody asked about is ignored', async () => {
    const db = fakeDb([
        { agent_id: 'a1', test_chats: 2 },
        { agent_id: 'other', test_chats: 99 },
    ]);
    const out = await usageStore.getTestChatCounts(['a1'], { db });
    assert.deepStrictEqual([...out.entries()], [['a1', 2]]);
});

test('duplicate ids are asked once and answered once', async () => {
    const seen = [];
    await usageStore.getTestChatCounts(['a1', 'a1', 'a1'], { db: fakeDb([], seen) });
    assert.deepStrictEqual(seen[0].params[0], ['a1']);
});
