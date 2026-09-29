/**
 * Anonymous callers get no memories extracted for them.
 *
 * The memory ROUTES now require auth, but that alone does not close this hole:
 * `POST /agents/:id/chat` and `/chat/stream` (routes/agents/chat.js) carry no
 * auth middleware BY DESIGN — they serve the public embed widget — and both
 * resolve a caller through `getEffectiveUserId`, which mints `guest_<random>`
 * rather than returning 401. Every anonymous turn against a published agent
 * therefore reached the extractor and wrote personal data under an id no data
 * subject can ever exercise access or erasure against.
 *
 * The guard sits above the agentStore and llmClient calls on purpose:
 * extraction is an LLM call, so anonymous traffic was a cost amplifier as well
 * as a GDPR problem. The assertion that matters is therefore "the model was
 * never called", not merely "nothing was written".
 *
 * Run: cd server && node --test agents/memory/extractor.guest.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const calls = { llm: 0, agentStore: 0, created: [] };

function stub(request, exportsObj) {
    const p = require.resolve(request);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stub('../../stores/memoryStore', {
    createMemory: async (...args) => { calls.created.push(args); return 'id'; },
    findByKey: async () => null,
    findSimilarMemory: async () => null,
    updateMemoryValue: async () => {},
    confirmMemory: async () => {},
    addMemorySource: async () => {},
});
stub('../../stores/agentStore', {
    getAgent: async () => { calls.agentStore++; return null; },
    getSystemAgent: async () => { calls.agentStore++; return { model: 'm', config: {} }; },
});
stub('../../core/llm/modelResolver', {
    resolveModelWithGlobalFallback: async () => { calls.llm++; return 'model-x'; },
});
stub('../../core/llm/llmClient', {
    chat: async () => { calls.llm++; return { content: '{"memories":[]}' }; },
});

const { extractFromConversation } = require('./extractor');

beforeEach(() => { calls.llm = 0; calls.agentStore = 0; calls.created.length = 0; });

const MESSAGES = [{ role: 'user', content: 'I always want my answers in Dutch, please remember that.' }];

test('a guest id extracts nothing and never calls the model', async () => {
    const out = await extractFromConversation('guest_9f2c1a', null, MESSAGES);

    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls.llm, 0, 'no LLM call — this is a cost guard, not just a data guard');
    assert.strictEqual(calls.agentStore, 0, 'and no store round trip either');
    assert.deepStrictEqual(calls.created, [], 'nothing written');
});

test('a missing or malformed user id is equally inert', async () => {
    for (const bad of [null, undefined, '', 42]) {
        const out = await extractFromConversation(bad, null, MESSAGES);
        assert.deepStrictEqual(out, [], `${JSON.stringify(bad)} must extract nothing`);
    }
    assert.strictEqual(calls.llm, 0);
});

test('a real user still gets past the guard', async () => {
    // The control. Without it the guard could be over-broad and nobody would
    // notice until memory quietly stopped working for everyone.
    await extractFromConversation('usr_42', null, MESSAGES);
    assert.ok(calls.llm > 0, 'the extraction path actually ran for a real account');
});
