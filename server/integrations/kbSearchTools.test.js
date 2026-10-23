const test = require('node:test');
const assert = require('node:assert');

function withModules(mods, fn) {
    const saved = new Map();
    for (const [spec, exports] of Object.entries(mods)) {
        const id = require.resolve(spec);
        saved.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const toolId = require.resolve('./kbSearchTools');
    delete require.cache[toolId];
    return (async () => {
        try {
            return await fn(require('./kbSearchTools'));
        } finally {
            for (const [id, mod] of saved) { if (mod) require.cache[id] = mod; else delete require.cache[id]; }
            delete require.cache[toolId];
        }
    })();
}

const CHUNK = {
    id: '11111111-2222-3333-4444-555555555555', chunk_id: 0, document_id: 'doc-1', source_id: 'src-1',
    title: 'Handbook', source_uri: 'handbook.pdf', content: 'Leave requests go through the HR portal within five days.', score: 0.9,
};

test('kb_search results carry the chunk id kb_fetch resolves, and the source uri', async () => {
    const mods = {
        '../stores/agentStore': { getForRuntime: async () => ({ config: { knowledge_base_ids: ['kb1'] } }) },
        '../core/agentRuntime/testAs': { visibleKbIdsFor: async (ids) => ids },
        '../core/kb/resolveProvider': { resolveKbProvider: async () => 'local' },
        '../core/kb/localKBIngest': { searchLocally: async () => Object.assign([{ ...CHUNK }], { _orphanFiltered: true }) },
    };
    await withModules(mods, async (tool) => {
        const ctx = { userId: 'u1', agentId: 'a1', conversationId: 'conv-kbsearch-test' };
        const res = await tool.executeKbSearchTool('kb_search', { query: 'how do leave requests work' }, ctx);
        assert.strictEqual(res.results.length, 1);
        assert.strictEqual(res.results[0].chunk_id, CHUNK.id, 'the row id, not the per-document ordinal');
        assert.strictEqual(res._sources[0].chunkId, CHUNK.id);
        assert.strictEqual(res._sources[0].documentId, 'doc-1');

        const fetched = await tool.executeKbSearchTool('kb_fetch', { chunk_ids: [res.results[0].chunk_id] }, ctx);
        assert.ok(fetched.chunks, `kb_fetch resolved nothing: ${JSON.stringify(fetched)}`);
        assert.strictEqual(fetched.chunks[0].content, CHUNK.content);

        const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
        assert.strictEqual(kbQueryCache.getChunk(ctx.conversationId, CHUNK.id).source_uri, 'handbook.pdf');
    });
});
