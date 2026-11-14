// @typecheck
'use strict';

/**
 * "n test conversations", against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js, with the usage store's own schema).
 *
 * A test chat deliberately writes NO row to `agent_conversations`, which keeps
 * it out of the history, the footer card and the Used-by tab. It does cost
 * money, so it IS in `ai_usage_log`, under its own source. Both halves of the
 * count can break on their own:
 *
 *   • the SOURCE can be renamed on one side, and the count silently reads zero;
 *   • the UNIT can shift: counting model calls instead of conversations turns
 *     three test conversations into twelve.
 *
 * Run: cd server && node --test stores/usageStore.testChats.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, query, close } = usePglitePool();
const usageStore = require('./usageStore');
const testChat = require('../core/agentRuntime/testChat');

const db = /** @type {any} */ ({ query });

test.before(async () => {
    await usageStore.initDB();
    const rows = [
        // a1: three test conversations, the first with four model calls.
        ['a1', 'c1', 'agent_test_chat'], ['a1', 'c1', 'agent_test_chat'], ['a1', 'c1', 'agent_test_chat'], ['a1', 'c1', 'agent_test_chat'],
        ['a1', 'c2', 'agent_test_chat'], ['a1', 'c3', 'agent_test_chat'],
        // An ordinary chat, and a test-chat row nobody can attribute.
        ['a1', 'c4', 'chat'], ['a1', null, 'agent_test_chat'],
        ['other', 'c9', 'agent_test_chat'],
    ];
    for (const [agentId, conversationId, source] of rows) {
        await pg.query(
            `INSERT INTO ai_usage_log (timestamp, user_id, agent_id, model, prompt_tokens, completion_tokens, total_tokens, source, conversation_id)
             VALUES (NOW(), 'u1', $1, 'm', 1, 1, 2, $2, $3)`,
            [agentId, source, conversationId],
        );
    }
});
test.after(close);

test('the store and the runtime name the SAME source', () => {
    // Written out literally in both files, so a store does not pull from the runtime:
    // renaming one side turns red here instead of silently counting zero.
    assert.strictEqual(usageStore.TEST_CHAT_SOURCE, testChat.TEST_CHAT_USAGE_SOURCE);
    assert.strictEqual(usageStore.TEST_CHAT_SOURCE, 'agent_test_chat');
});

test('a conversation counts once however many model calls it made; only the test-chat source with a conversation counts', async () => {
    const out = await usageStore.getTestChatCounts(['a1', 'a2'], { db });
    assert.strictEqual(out.get('a1'), 3, 'an ordinary chat and an unattributed row never round it up');
    assert.strictEqual(out.get('a2'), 0, 'an agent nobody test-chatted is a fact, not a gap');
});

test('the default path reads the same through db.js', async () => {
    assert.strictEqual((await usageStore.getTestChatCounts(['a1'])).get('a1'), 3);
});

test('an empty or junk id list answers an empty map', async () => {
    for (const ids of [[], null, undefined, [null, '', false]]) {
        assert.strictEqual((await usageStore.getTestChatCounts(/** @type {any} */ (ids), { db })).size, 0);
    }
});

test('an agent nobody asked about stays out, and duplicate ids are answered once', async () => {
    assert.deepStrictEqual([...(await usageStore.getTestChatCounts(['a1', 'a1', 'a1'], { db })).entries()], [['a1', 3]]);
});
