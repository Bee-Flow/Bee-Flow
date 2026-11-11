// @typecheck
/**
 * kb_search's per-conversation cache: the same question asked again by the
 * same person is answered from the cache, and never from another asker's
 * results, in a thread several people share.
 *
 * Run: cd server && node --test integrations/kbSearchTools.cache.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const agentStore = require('../stores/agentStore');
const testAs = require('../core/agentRuntime/testAs');
const resolveProvider = require('../core/kb/resolveProvider');
const localKBIngest = require('../core/kb/localKBIngest');
const tool = require('./kbSearchTools');

const chunk = (id, content) => ({ id, chunk_id: 0, document_id: `doc-${id}`, knowledge_base_id: id.replace(/-chunk$/, ''), title: 'Handbook', source_uri: 'handbook.pdf', content, score: 0.9 });

/**
 * The agent has kb-shared and kb-hr; `access` says which of them each asker
 * may read. The search answers one chunk per base it was asked for.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string[]>} access
 */
function arrange(t, access) {
    /** @type {Array<{ userId: string, kbIds: string[] }>} */
    const searches = [];
    t.mock.method(agentStore, 'getForRuntime', async () => ({ config: { knowledge_base_ids: ['kb-shared', 'kb-hr'] } }));
    t.mock.method(testAs, 'visibleKbIdsFor', async (ids, { userId }) => ids.filter((id) => access[userId].includes(id)));
    t.mock.method(resolveProvider, 'resolveKbProvider', async () => 'local');
    t.mock.method(localKBIngest, 'searchLocally', async (userId, kbIds) => {
        searches.push({ userId, kbIds });
        return Object.assign(kbIds.map((kb) => chunk(`${kb}-chunk`, `content of ${kb}`)), { _orphanFiltered: true });
    });
    return searches;
}

const ask = (userId, conversationId, query = 'how do leave requests work') =>
    tool.executeKbSearchTool('kb_search', { query }, { userId, agentId: 'a1', conversationId });

test('the same question from the same asker is served from the cache', async (t) => {
    const searches = arrange(t, { anna: ['kb-shared'] });
    const first = await ask('anna', 'conv-cache-hit');
    const second = await ask('anna', 'conv-cache-hit');
    assert.equal(searches.length, 1, 'the second ask did not search again');
    assert.deepEqual(second.results, first.results);

    await ask('anna', 'conv-cache-hit', 'another question entirely');
    await ask('anna', 'conv-other');
    assert.equal(searches.length, 3, 'another question, and another conversation, search');
});

test('an asker with other bases never gets the first asker\'s cached results', async (t) => {
    const searches = arrange(t, { hr: ['kb-shared', 'kb-hr'], guest: ['kb-shared'] });
    const forHr = await ask('hr', 'conv-shared-thread');
    assert.deepEqual(forHr.results.map((r) => r.chunk_id), ['kb-shared-chunk', 'kb-hr-chunk']);

    const forGuest = await ask('guest', 'conv-shared-thread');
    assert.equal(searches.length, 2, 'the guest got a search of their own');
    assert.deepEqual(searches[1], { userId: 'guest', kbIds: ['kb-shared'] });
    assert.deepEqual(forGuest.results.map((r) => r.chunk_id), ['kb-shared-chunk']);
    assert.equal(JSON.stringify(forGuest).includes('content of kb-hr'), false);
});

test('two askers with the same bases still keep a cache each', async (t) => {
    const searches = arrange(t, { anna: ['kb-shared'], ben: ['kb-shared'] });
    await ask('anna', 'conv-same-bases');
    await ask('ben', 'conv-same-bases');
    assert.deepEqual(searches.map((s) => s.userId), ['anna', 'ben']);
});

test('kb_fetch resolves only chunks the asker\'s own search returned', async (t) => {
    arrange(t, { hr: ['kb-shared', 'kb-hr'], guest: ['kb-shared'] });
    await ask('hr', 'conv-fetch');
    await ask('guest', 'conv-fetch');
    const fetch = (userId) => tool.executeKbSearchTool('kb_fetch', { chunk_ids: ['kb-hr-chunk'] }, { userId, agentId: 'a1', conversationId: 'conv-fetch' });

    assert.equal((await fetch('hr')).chunks[0].content, 'content of kb-hr');
    const refused = await fetch('guest');
    assert.ok(refused.error, 'a chunk of a base the guest may not read is not served');
    assert.equal(JSON.stringify(refused).includes('content of kb-hr'), false);
});

test('kb_fetch no longer serves a cached chunk once its base is not visible to the asker', async (t) => {
    /** @type {Record<string, string[]>} */
    const access = { hr: ['kb-shared', 'kb-hr'] };
    arrange(t, access);
    await ask('hr', 'conv-withdrawn');
    const fetch = () => tool.executeKbSearchTool('kb_fetch', { chunk_ids: ['kb-hr-chunk', 'kb-shared-chunk'] }, { userId: 'hr', agentId: 'a1', conversationId: 'conv-withdrawn' });

    const before = await fetch();
    assert.deepEqual(before.chunks.map((c) => c.chunk_id), ['kb-hr-chunk', 'kb-shared-chunk']);

    access.hr = ['kb-shared'];
    const after = await fetch();
    assert.deepEqual(after.chunks.map((c) => c.chunk_id), ['kb-shared-chunk']);
    assert.equal(JSON.stringify(after).includes('content of kb-hr'), false);

    access.hr = [];
    const none = await fetch();
    assert.ok(none.error, 'with no visible base every id is not found');
});
