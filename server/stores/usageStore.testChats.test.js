'use strict';

/**
 * "n testgesprekken" (A4).
 *
 * Een testchat schrijft met opzet GEEN rij in `agent_conversations` — dat is
 * wat hem uit de historie, uit de kaartvoet (A5) en uit de Used-by-tab houdt.
 * Hij kost wel geld, dus hij staat wél in `ai_usage_log`, onder een eigen
 * bron. Deze twee dingen samen zijn de hele telling, en beide kunnen los
 * kapot:
 *
 *   • de BRON kan aan één kant hernoemd worden (de runtime schrijft
 *     'agent_test_chat', de query zoekt iets anders) — dan telt hij stil op
 *     nul en ziet niemand dat er iets mis is;
 *   • de EENHEID kan verschuiven — modelaanroepen tellen in plaats van
 *     gesprekken maakt van drie testgesprekken er twaalf.
 *
 * Run: cd server && node --test stores/usageStore.testChats.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const usageStore = require('./usageStore');
const testChat = require('../core/agentRuntime/testChat');

test('the store and the runtime name the SAME source', () => {
    // De constante staat in beide bestanden letterlijk, zodat een store niets
    // uit de runtime hoeft te trekken. Deze assertie is de prijs daarvan: één
    // kant hernoemen wordt hier rood in plaats van stil.
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
